import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { emitKeypressEvents } from "node:readline";
import { type BackendInfo, probe } from "./backend.js";
import { type Delegation, readDelegation } from "./delegation.js";
import { orderStatus } from "./forge.js";
import { MONITOR_CLIENT, MONITOR_HTML } from "./monitor-page.js";
import type { OrderStatus, Task } from "./types.js";

export const ACTIVE = new Set<OrderStatus>(["queued", "dispatching", "executing"]);
export const PROBLEMS = new Set<OrderStatus>(["failed", "blocked", "uncertain"]);
export type Filter = "all" | "active" | "problems";

export interface MonitorTask {
  id: string;
  orderId?: string;
  orderStatus: OrderStatus;
  title: string;
  worker: string;
  model: string;
  permission?: string;
  agentId?: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  elapsedMs: number;
  turns: number;
  latest: string;
  estimateMs?: number;
  /** Active, but no backend answers: its real state is unknown until one does. */
  stale: boolean;
}

export interface MonitorAgent {
  id: string;
  worker: string;
  model: string;
  tasks: number;
  latestTask: string;
  latestTitle: string;
  latestStatus: OrderStatus;
}

export interface Snapshot {
  generatedAt: string;
  home: string;
  delegation: Delegation;
  corrupt?: string;
  backend: { online: boolean; pid?: number; port?: number; version?: string; startedAt?: string };
  summary: { total: number; active: number; completed: number; problems: number; cancelled: number };
  agents: MonitorAgent[];
  tasks: MonitorTask[];
  warnings: string[];
}

const clean = (value: unknown) => String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
const epoch = (value: string | undefined) => (value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : undefined);

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** Reads the task files as they are: never creates the data folder, starts a backend, or changes a task. */
function readTasks(home: string, warnings: string[]): Task[] {
  const dir = path.join(home, "tasks");
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const tasks: Task[] = [];
  for (const file of files) {
    try {
      tasks.push(JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as Task);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`Task ${file.slice(0, -5)} unreadable: ${(err as Error).message}`);
    }
  }
  return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

function latestLine(task: Task): string {
  const turn = task.turns.at(-1);
  const text = turn?.error || turn?.result || task.steps.at(-1)?.text || turn?.prompt || "";
  return clean(text).trim().slice(0, 300);
}

export async function monitorSnapshot(home: string, { limit = 30, now = Date.now() } = {}): Promise<Snapshot> {
  const warnings: string[] = [];
  const { settings: delegation, corrupt } = readDelegation(home, "cursor");
  if (corrupt) warnings.push(`Board settings unreadable (${corrupt}); auto-dispatch reads as off.`);
  const info: BackendInfo | undefined = await probe(home);
  const backend = info ? { online: true, ...info } : { online: false };

  const tasks = readTasks(home, warnings).map((task): MonitorTask => {
    const status = orderStatus(task);
    const start = epoch(task.createdAt) ?? now;
    const end = ACTIVE.has(status) ? now : (epoch(task.updatedAt) ?? start);
    return {
      id: task.id,
      orderId: task.orderId,
      orderStatus: status,
      title: clean(task.title),
      worker: task.worker,
      model: task.model,
      permission: task.permission,
      agentId: task.agentId,
      cwd: task.cwd,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      elapsedMs: Math.max(0, end - start),
      turns: task.turns.length,
      latest: latestLine(task),
      estimateMs: task.estimate?.ms,
      stale: ACTIVE.has(status) && !backend.online,
    };
  });

  const summary = { total: tasks.length, active: 0, completed: 0, problems: 0, cancelled: 0 };
  for (const t of tasks) {
    if (ACTIVE.has(t.orderStatus)) summary.active++;
    else if (t.orderStatus === "completed") summary.completed++;
    else if (PROBLEMS.has(t.orderStatus)) summary.problems++;
    else if (t.orderStatus === "cancelled") summary.cancelled++;
  }

  const agents = new Map<string, MonitorAgent>();
  for (const t of tasks) {
    if (!t.agentId) continue;
    const key = `${t.worker}:${t.agentId}`;
    const agent = agents.get(key) ?? { id: t.agentId, worker: t.worker, model: t.model, tasks: 0, latestTask: t.id, latestTitle: t.title, latestStatus: t.orderStatus };
    agent.tasks++;
    agents.set(key, agent);
  }

  return { generatedAt: new Date(now).toISOString(), home, delegation, corrupt, backend, summary, agents: [...agents.values()], tasks: tasks.slice(0, limit), warnings };
}

function charWidth(char: string): number {
  if (/\p{Mark}/u.test(char)) return 0;
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Extended_Pictographic}]/u.test(char) ? 2 : 1;
}

/** Pads or cuts to a display width, counting wide characters as two cells. */
export function fit(value: string, width: number): string {
  const text = clean(value);
  if (width < 1) return "";
  const full = [...text].reduce((n, c) => n + charWidth(c), 0);
  if (full <= width) return text + " ".repeat(width - full);
  let out = "";
  let used = 0;
  for (const c of text) {
    const w = charWidth(c);
    if (used + w > width - 1) break;
    out += c;
    used += w;
  }
  return `${out}…${" ".repeat(width - used - 1)}`;
}

export function filterTasks(tasks: MonitorTask[], filter: Filter): MonitorTask[] {
  if (filter === "active") return tasks.filter((t) => ACTIVE.has(t.orderStatus));
  if (filter === "problems") return tasks.filter((t) => PROBLEMS.has(t.orderStatus));
  return tasks;
}

export function renderTerminal(s: Snapshot, { width = 110, height = 35, selected = 0, filter = "all" as Filter, live = false } = {}): string {
  width = Math.max(45, Math.min(200, width));
  const rows: string[] = [];
  const add = (text: string) => rows.push(fit(text, width).trimEnd());
  const d = s.delegation;
  add(`AgentForge  |  backend ${s.backend.online ? `online (pid ${s.backend.pid}, v${s.backend.version})` : "offline"}  |  read-only monitor`);
  add(`Auto-dispatch ${d.enabled ? "ON" : "OFF"} · ${d.executor} · ${d.route?.model ?? "default model"}${d.effort ? ` · effort ${d.effort}` : ""}${d.permission ? ` · ${d.permission}` : ""} · SDD ${d.sdd.enabled ? "on" : "off"}`);
  add(`Tasks ${s.summary.total}   active ${s.summary.active}   completed ${s.summary.completed}   need attention ${s.summary.problems}   cancelled ${s.summary.cancelled}`);
  add("");
  add(`Agent conversations (${s.agents.length})`);
  if (!s.agents.length) add("  None yet; they appear once a task is dispatched.");
  for (const a of s.agents.slice(0, 4)) add(`  ${a.worker} · ${a.id.slice(0, 18)}  ${a.model}  ${a.tasks} task(s), latest ${a.latestStatus}`);
  if (s.agents.length > 4) add(`  ${s.agents.length - 4} more: agentforge monitor --json`);
  add("");
  add(`Tasks  [${filter}]`);
  const list = filterTasks(s.tasks, filter);
  const capacity = Math.max(1, height - rows.length - (live ? 9 : 7));
  const index = Math.max(0, Math.min(selected, list.length - 1));
  const start = Math.max(0, index - capacity + 1);
  if (!list.length) add("  No matching tasks.");
  const titleWidth = Math.max(10, width - 60);
  for (const [offset, t] of list.slice(start, start + capacity).entries()) {
    const marker = live && offset + start === index ? ">" : " ";
    add(`${marker} ${fit(t.id, 18)} ${fit(t.orderStatus, 11)} ${fit(t.title, titleWidth)} ${fit(t.model, 14)} ${elapsed(t.elapsedMs)}${t.stale ? " *" : ""}`);
  }
  const current = list[index];
  if (current) {
    add("");
    add(`Task: ${current.title}`);
    add(`Order: ${current.orderId ?? "—"}  agent: ${current.agentId ?? "not created yet"}  turns: ${current.turns}`);
    add(`Latest: ${current.latest || "no result yet"}`);
    add(`Updated: ${current.updatedAt}${current.stale ? "  * no backend answers; state unknown" : ""}`);
  }
  if (s.warnings.length) add(`Warning: ${s.warnings[0]}`);
  if (live) {
    add("");
    add("↑↓ / j k select   f filter   r refresh   q quit");
  }
  return rows.slice(0, Math.max(12, height)).join("\n");
}

export async function monitorTerminal(home: string, { once = false, json = false, interval = 1000, limit = 30 } = {}): Promise<void> {
  const input = process.stdin;
  const output = process.stdout;
  if (once || json || !input.isTTY || !output.isTTY) {
    const s = await monitorSnapshot(home, { limit });
    output.write(`${json ? JSON.stringify(s, null, 2) : renderTerminal(s, { width: output.columns ?? 110, height: 100 })}\n`);
    return;
  }
  emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  output.write("\x1b[?1049h\x1b[?25l");
  await new Promise<void>((resolve) => {
    let stopped = false;
    let busy = false;
    let selected = 0;
    let filter: Filter = "all";
    let snapshot: Snapshot | undefined;
    const redraw = () => {
      if (snapshot && !stopped) output.write(`\x1b[H\x1b[2J${renderTerminal(snapshot, { width: output.columns ?? 110, height: output.rows ?? 35, selected, filter, live: true })}`);
    };
    const refresh = async () => {
      if (stopped || busy) return;
      busy = true;
      try {
        snapshot = await monitorSnapshot(home, { limit });
        redraw();
      } catch (err) {
        if (!stopped) output.write(`\x1b[H\x1b[2JRead failed: ${clean((err as Error).message)}`);
      } finally {
        busy = false;
      }
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      input.off("keypress", keypress);
      output.off("resize", redraw);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
      output.write("\x1b[?25h\x1b[?1049l");
      resolve();
    };
    const keypress = (_text: string, key: { name?: string; ctrl?: boolean } = {}) => {
      if (key.name === "q" || (key.ctrl && key.name === "c")) return stop();
      const size = filterTasks(snapshot?.tasks ?? [], filter).length;
      if (key.name === "down" || key.name === "j") selected = Math.min(Math.max(0, size - 1), selected + 1);
      if (key.name === "up" || key.name === "k") selected = Math.max(0, selected - 1);
      if (key.name === "f") {
        filter = ({ all: "active", active: "problems", problems: "all" } as const)[filter];
        selected = 0;
      }
      if (key.name === "r") void refresh();
      redraw();
    };
    const timer = setInterval(() => void refresh(), interval);
    input.on("keypress", keypress);
    output.on("resize", redraw);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    void refresh();
  });
}

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

/** A read-only page on 127.0.0.1: GET only, local Host and Origin only; settings change on the board, not here. */
export async function monitorWeb(home: string, { port = 18862, limit = 50 } = {}): Promise<{ url: string; close: () => Promise<void> }> {
  let bound = 0;
  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const allowed = [`127.0.0.1:${bound}`, `localhost:${bound}`];
    const origin = req.headers.origin;
    if (!allowed.includes(req.headers.host ?? "") || req.headers["sec-fetch-site"] === "cross-site" || (origin && !allowed.some((a) => origin === `http://${a}`))) {
      res.writeHead(403).end("Local access only.");
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { Allow: "GET" }).end("Read-only monitor.");
      return;
    }
    try {
      const route = new URL(req.url ?? "/", "http://local").pathname;
      if (route === "/") res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(MONITOR_HTML);
      else if (route === "/monitor.js") res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" }).end(MONITOR_CLIENT);
      else if (route === "/api/snapshot") res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(await monitorSnapshot(home, { limit })));
      else res.writeHead(404).end("Not found.");
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  bound = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${bound}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeIdleConnections();
      }),
  };
}
