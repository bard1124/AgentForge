import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { type ApiContext, handleApi } from "./api.js";
import type { ForgeConfig } from "./config.js";
import { Forge } from "./forge.js";
import { openInEditor } from "./progress.js";
import { createServer } from "./server.js";
import { TaskStore } from "./store.js";
import { Updater } from "./updater.js";
import { packageRoot, packageVersion } from "./version.js";
import { loadWorkers } from "./workers/registry.js";

export const BACKEND_TITLE = "agentforge-backend";
export const CWD_HEADER = "x-agentforge-cwd";

export interface BackendInfo {
  pid: number;
  port: number;
  version: string;
  startedAt: string;
}

export { packageRoot, packageVersion };

const files = (home: string) => ({
  info: path.join(home, "backend.json"),
  token: path.join(home, "backend.token"),
  lock: path.join(home, "backend.lock"),
  log: path.join(home, "backend.log"),
});

export function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function readToken(home: string): string | undefined {
  try {
    return fs.readFileSync(files(home).token, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Kept across restarts so open boards and forwarders keep working; readable by this user only. */
function ensureToken(home: string): string {
  const existing = readToken(home);
  const file = files(home).token;
  if (existing) {
    fs.chmodSync(file, 0o600);
    return existing;
  }
  const token = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

/** The running backend for this home, confirmed over HTTP; undefined when none answers. */
export async function probe(home: string, timeoutMs = 1500): Promise<BackendInfo | undefined> {
  const info = readJson<BackendInfo>(files(home).info);
  if (!info || !isAlive(info.pid)) return undefined;
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = (await res.json()) as { pid?: number };
    return res.ok && body.pid === info.pid ? info : undefined;
  } catch {
    return undefined;
  }
}

/** Starts the backend detached when none is running and waits until it answers. */
export async function ensureBackend(home: string, waitMs = 20_000): Promise<{ info: BackendInfo; token: string }> {
  let info = await probe(home);
  if (!info) {
    fs.mkdirSync(home, { recursive: true });
    const log = fs.openSync(files(home).log, "a");
    const child = spawn(process.execPath, [path.join(packageRoot(), "dist", "cli.js"), "backend", "run"], {
      cwd: home,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, AGENTFORGE_HOME: home, NODE_NO_WARNINGS: "1" },
    });
    child.unref();
    fs.closeSync(log);
    const deadline = Date.now() + waitMs;
    while (!(info = await probe(home)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    if (!info) throw new Error(`AgentForge backend did not start within ${waitMs / 1000}s; see ${files(home).log}`);
  }
  const token = readToken(home);
  if (!token) throw new Error(`AgentForge backend token missing at ${files(home).token}`);
  return { info, token };
}

/** Authenticated JSON request to the running backend. */
export async function backendRequest<T>(home: string, method: string, route: string, body?: unknown): Promise<T> {
  const info = await probe(home);
  const token = readToken(home);
  if (!info || !token) throw new Error("AgentForge backend is not running.");
  const res = await fetch(`http://127.0.0.1:${info.port}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(payload.error ?? `HTTP ${res.status}`);
  return payload;
}

export async function stopBackend(home: string, waitMs = 15_000): Promise<number | undefined> {
  const info = readJson<BackendInfo>(files(home).info);
  if (!info || !isAlive(info.pid)) return undefined;
  const asked = await backendRequest(home, "POST", "/api/backend/stop").then(
    () => true,
    () => false,
  );
  if (!asked) process.kill(info.pid, "SIGTERM");
  const deadline = Date.now() + waitMs;
  while (isAlive(info.pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  if (isAlive(info.pid)) throw new Error(`Backend pid ${info.pid} did not exit within ${waitMs / 1000}s.`);
  return info.pid;
}

/** One backend per home: the lock file holds the owner's pid; a dead owner's lock is taken over. */
function acquireLock(home: string): boolean {
  const file = files(home).lock;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: "wx" });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const owner = Number.parseInt(fs.readFileSync(file, "utf8"), 10);
      if (isAlive(owner) && owner !== process.pid) return false;
      fs.rmSync(file, { force: true });
    }
  }
  return false;
}

function bearerOk(req: http.IncomingMessage, token: string): boolean {
  const given = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req: http.IncomingMessage, limit = 4 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Request body too large"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
}

export async function runBackend(config: ForgeConfig): Promise<void> {
  const home = config.home;
  fs.mkdirSync(home, { recursive: true });
  if (!acquireLock(home)) {
    console.error(`Another AgentForge backend owns ${home}; exiting.`);
    process.exit(0);
  }
  process.title = BACKEND_TITLE;
  const token = ensureToken(home);
  const version = packageVersion();
  const store = new TaskStore(home);
  const forge = new Forge(config, store, await loadWorkers(config));
  const editor = config.openProgress;
  if (editor) {
    forge.onDispatched = (task) => {
      if (!openInEditor(editor, store.progressFile(task.id))) console.error(`${new Date().toISOString()} progress page for ${task.id} not opened: editor "${editor}" not found`);
    };
  }
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const startedAt = new Date().toISOString();
  const cli = path.join(packageRoot(), "dist", "cli.js");
  const running = () => forge.list().filter((t) => t.status === "running" || t.status === "queued").map((t) => t.id);
  const updater = new Updater({
    root: packageRoot(),
    home,
    running,
    restart: () => restart(),
    reinstall: async () => {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [cli, "install"], { cwd: home, stdio: "ignore", windowsHide: true, env: { ...process.env, AGENTFORGE_HOME: home } });
        child.on("error", reject);
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`agentforge install exited with ${code}`))));
      });
    },
  });
  let shutdown: () => Promise<void> = async () => undefined;
  const restart = () => {
    // The successor waits for this process to exit before it takes the lock.
    const child = spawn(process.execPath, [cli, "backend", "start", "--after", String(process.pid)], {
      cwd: home,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, AGENTFORGE_HOME: home },
    });
    child.unref();
    setTimeout(() => void shutdown(), 200);
  };
  const stop = () => void setTimeout(() => void shutdown(), 100);
  const commit = await updater.head();
  const ctx: ApiContext = { config, forge, store, updater, version, commit, startedAt, sessions: () => sessions.size, restart, stop };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const host = (req.headers.host ?? "").replace(/:\d+$/, "");
      if (host !== "127.0.0.1" && host !== "localhost") return sendJson(res, 403, { error: "Forbidden host" });
      if (url.pathname === "/api/health") return sendJson(res, 200, { ok: true, pid: process.pid, version, startedAt });
      if (!bearerOk(req, token)) return sendJson(res, 401, { error: "Unauthorized" });

      if (url.pathname === "/mcp") {
        const sessionId = req.headers["mcp-session-id"];
        const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
        if (req.method !== "POST") {
          if (!existing) return sendJson(res, 404, { error: "Unknown MCP session" });
          return existing.handleRequest(req, res);
        }
        const body = JSON.parse((await readBody(req)) || "null") as unknown;
        if (existing) return existing.handleRequest(req, res, body);
        if (!isInitializeRequest(body)) return sendJson(res, 404, { jsonrpc: "2.0", error: { code: -32001, message: "Unknown MCP session" }, id: null });
        const cwdHeader = req.headers[CWD_HEADER];
        const defaultCwd = typeof cwdHeader === "string" && path.isAbsolute(cwdHeader) ? cwdHeader : home;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (id) => void sessions.set(id, transport),
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        await createServer(forge, defaultCwd, config).connect(transport);
        return transport.handleRequest(req, res, body);
      }

      if (url.pathname.startsWith("/api/")) {
        const raw = req.method === "GET" || req.method === "HEAD" ? "" : await readBody(req);
        const body = raw ? (JSON.parse(raw) as unknown) : undefined;
        const answer = await handleApi(ctx, req.method ?? "GET", url, body);
        return sendJson(res, answer.status, answer.body);
      }
      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: (err as Error).message });
      else res.end();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const info: BackendInfo = { pid: process.pid, port, version, startedAt };
  fs.writeFileSync(files(home).info, `${JSON.stringify(info, null, 2)}\n`);
  console.error(`${new Date().toISOString()} ${BACKEND_TITLE} ${version} pid ${process.pid} listening on 127.0.0.1:${port}`);
  let monitor: { url: string; close: () => Promise<void> } | undefined;
  if (config.monitorPort > 0) {
    try {
      const { monitorWeb } = await import("./monitor.js");
      monitor = await monitorWeb(home, { port: config.monitorPort });
      console.error(`${new Date().toISOString()} monitor page on ${monitor.url}`);
    } catch (err) {
      console.error(`${new Date().toISOString()} monitor page not started on port ${config.monitorPort}: ${(err as Error).message}`);
    }
  }

  shutdown = async () => {
    server.close();
    await monitor?.close().catch(() => undefined);
    for (const transport of sessions.values()) await transport.close().catch(() => undefined);
    await forge.shutdown();
    if (readJson<BackendInfo>(files(home).info)?.pid === process.pid) fs.rmSync(files(home).info, { force: true });
    fs.rmSync(files(home).lock, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
