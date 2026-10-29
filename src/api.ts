import fs from "node:fs";
import type { ForgeConfig } from "./config.js";
import {
  applyChange,
  defaultDelegation,
  type Delegation,
  type DelegationChange,
  DelegationError,
  type ExecutorFacts,
  heartbeatFile,
  layoutOnly,
  readDelegation,
  writeDelegation,
} from "./delegation.js";
import { elapsedMs } from "./estimate.js";
import { type Forge, ForgeError, orderStatus } from "./forge.js";
import { savingsSummary } from "./savings.js";
import { SddError, SddStore } from "./sdd.js";
import type { Updater } from "./updater.js";
import { packageVersion } from "./version.js";
import type { TaskStore } from "./store.js";
import type { Task } from "./types.js";

export interface ApiContext {
  config: ForgeConfig;
  forge: Forge;
  store: TaskStore;
  updater: Updater;
  version: string;
  /** Commit of the checkout when this backend started; differs from the checkout's HEAD after an update. */
  commit?: string;
  startedAt: string;
  sessions: () => number;
  /** Replaces this backend with a fresh one running the installed code. */
  restart: () => void;
  /** Shuts this backend down cleanly; Windows has no catchable SIGTERM, so stop goes through here. */
  stop: () => void;
}

export interface ApiAnswer {
  status: number;
  body: unknown;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Handler = (ctx: ApiContext, body: unknown, url: URL, params: Record<string, string>) => unknown | Promise<unknown>;

const routes = new Map<string, Handler>();
const patterns: { method: string; parts: string[]; handler: Handler }[] = [];

/** Registers `METHOD /api/path`; `:name` segments match one path segment. The handler's return value is sent as JSON. */
export function route(method: string, pathname: string, handler: Handler): void {
  if (pathname.includes("/:")) patterns.push({ method, parts: pathname.split("/"), handler });
  else routes.set(`${method} ${pathname}`, handler);
}

function match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | undefined {
  const exact = routes.get(`${method} ${pathname}`);
  if (exact) return { handler: exact, params: {} };
  const parts = pathname.split("/");
  for (const p of patterns) {
    if (p.method !== method || p.parts.length !== parts.length) continue;
    const params: Record<string, string> = {};
    const hit = p.parts.every((seg, i) => {
      if (!seg.startsWith(":")) return seg === parts[i];
      params[seg.slice(1)] = decodeURIComponent(parts[i]!);
      return parts[i] !== "";
    });
    if (hit) return { handler: p.handler, params };
  }
  return undefined;
}

export async function handleApi(ctx: ApiContext, method: string, url: URL, body: unknown): Promise<ApiAnswer> {
  let found;
  try {
    found = match(method, url.pathname);
  } catch {
    return { status: 400, body: { error: `Malformed path ${url.pathname}` } };
  }
  if (!found) return { status: 404, body: { error: `No route ${method} ${url.pathname}` } };
  try {
    return { status: 200, body: await found.handler(ctx, body, url, found.params) };
  } catch (err) {
    if (err instanceof ApiError) return { status: err.status, body: { error: err.message } };
    return { status: 500, body: { error: (err as Error).message } };
  }
}

export function runningTasks(ctx: ApiContext): string[] {
  return ctx.forge
    .list()
    .filter((t) => t.status === "running" || t.status === "queued")
    .map((t) => t.id);
}

export interface HookHealth {
  state: "active" | "pending";
  lastRunAt?: string;
  detail: string;
}

/** Whether the prompt hook has run since the settings last changed; it reads them on every message. */
export function hookHealth(home: string, settings: Delegation): HookHealth {
  let beat: { at?: string } | undefined;
  try {
    beat = JSON.parse(fs.readFileSync(heartbeatFile(home), "utf8"));
  } catch {
    beat = undefined;
  }
  if (!beat?.at) return { state: "pending", detail: "The prompt hook has not run yet. Send a message in a Claude Code session started after installing the plugin." };
  if (settings.updatedAt && beat.at < settings.updatedAt) {
    return { state: "pending", lastRunAt: beat.at, detail: "Saved; takes effect from the next message." };
  }
  return { state: "active", lastRunAt: beat.at, detail: "The prompt hook applied the current settings." };
}

async function executorFacts(ctx: ApiContext, only?: string): Promise<Record<string, ExecutorFacts>> {
  const { executors } = await ctx.forge.runtimeInfo(only);
  return Object.fromEntries(Object.entries(executors).map(([name, e]) => [name, { models: e.online ? e.models : undefined, permissions: e.permissions }]));
}

route("GET", "/api/board", (ctx) => {
  const read = readDelegation(ctx.config.home, ctx.config.worker);
  return {
    settings: read.settings,
    corrupt: read.corrupt,
    executors: ctx.forge.workerNames(),
    hook: hookHealth(ctx.config.home, read.settings),
    backend: { pid: process.pid, version: ctx.version },
    running: runningTasks(ctx).length,
  };
});

route("GET", "/api/savings", (ctx) => savingsSummary(ctx.config.home, ctx.forge.list(), new Date()));

route("GET", "/api/runtime", (ctx, _body, url) => ctx.forge.runtimeInfo(url.searchParams.get("executor") ?? undefined));

route("POST", "/api/settings", async (ctx, body) => {
  const change = (body ?? {}) as DelegationChange & { reset?: boolean };
  const home = ctx.config.home;
  const read = readDelegation(home, ctx.config.worker);
  if (read.corrupt && !change.reset) throw new ApiError(409, `Settings file is unreadable (${read.corrupt}); everything reads as off. Reset it to defaults to edit.`);
  const base = read.corrupt ? defaultDelegation(home, ctx.config.worker) : read.settings;
  const needsCatalog = change.model || change.effort;
  const facts: Record<string, ExecutorFacts> = needsCatalog ? await executorFacts(ctx, change.executor ?? base.executor).catch(() => ({})) : {};
  for (const name of ctx.forge.workerNames()) facts[name] ??= { permissions: ctx.forge.permissionsOf(name) };
  try {
    const saved = writeDelegation(home, applyChange(base, change, facts), layoutOnly(change));
    return { settings: saved, hook: hookHealth(home, saved) };
  } catch (err) {
    if (err instanceof DelegationError) throw new ApiError(400, err.message);
    throw err;
  }
});

route("GET", "/api/tasks", (ctx, _body, url) => {
  const limit = Number(url.searchParams.get("limit") ?? 30);
  return ctx.forge
    .list()
    .slice(0, limit)
    .map((t) => ({
      id: t.id,
      orderId: t.orderId,
      title: t.title,
      status: t.status,
      orderStatus: orderStatus(t),
      worker: t.worker,
      model: t.model,
      conversationId: t.agentId,
      cwd: t.cwd,
      turns: t.turns.length,
      updatedAt: t.updatedAt,
      estimateMs: t.estimate?.ms,
      estimateSource: t.estimate?.source,
      estimateBasis: t.estimate?.basis,
      elapsedMs: elapsedMs(t),
    }));
});

/** Board task controls; a refused action (wrong state, unknown id) answers 4xx with Forge's message. */
async function taskCall<T>(id: string, fn: () => Promise<T>): Promise<T> {
  if (!/^[\w-]+$/.test(id)) throw new ApiError(400, `Invalid task id: ${id}`);
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ForgeError) throw new ApiError(err.message.startsWith("No task") ? 404 : 409, err.message);
    throw err;
  }
}

const taskState = (t: Task) => ({ id: t.id, status: t.status, orderStatus: orderStatus(t) });

route("POST", "/api/tasks/clear", async (ctx) => ({ deleted: await ctx.forge.clearFinished() }));
route("POST", "/api/tasks/:id/pause", (ctx, _b, _u, { id }) => taskCall(id!, async () => taskState(await ctx.forge.pause(id!, "board"))));
route("POST", "/api/tasks/:id/resume", (ctx, _b, _u, { id }) =>
  taskCall(id!, async () => {
    await ctx.forge.resume(id!);
    return taskState(ctx.forge.get(id!));
  }),
);
route("POST", "/api/tasks/:id/cancel", (ctx, _b, _u, { id }) => taskCall(id!, async () => taskState(await ctx.forge.cancel(id!, "board"))));
route("DELETE", "/api/tasks/:id", (ctx, _b, _u, { id }) =>
  taskCall(id!, async () => {
    await ctx.forge.delete(id!);
    return { deleted: id };
  }),
);

/** Board-only SDD access; every request names the workspace it was made against. */
function sddCall<T>(ctx: ApiContext, fn: (store: SddStore) => T): T {
  try {
    return fn(new SddStore(ctx.config.home, ctx.config.worker));
  } catch (err) {
    if (err instanceof SddError) {
      const status = { disabled: 403, not_found: 404, conflict: 409, workspace_changed: 409, invalid: 400 }[err.code];
      throw new ApiError(status, err.message);
    }
    throw err;
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const param = (url: URL, name: string): string => {
  const v = url.searchParams.get(name);
  if (!v) throw new ApiError(400, `${name} is required`);
  return v;
};

route("GET", "/api/sdd/workspace", (ctx) => sddCall(ctx, (s) => s.workspace()));
route("GET", "/api/sdd/projects", (ctx, _b, url) => sddCall(ctx, (s) => s.listProjects(param(url, "workspace"))));
route("GET", "/api/sdd/tasks", (ctx, _b, url) => sddCall(ctx, (s) => s.listTasks(param(url, "project"), param(url, "workspace"))));
route("GET", "/api/sdd/task", (ctx, _b, url) => sddCall(ctx, (s) => s.readTask(param(url, "project"), param(url, "task"), param(url, "workspace"))));
route("POST", "/api/sdd/project", (ctx, body) => {
  const b = (body ?? {}) as Record<string, unknown>;
  return sddCall(ctx, (s) => s.createProject(str(b.name) ?? "", str(b.workspace) ?? ""));
});
route("POST", "/api/sdd/task", (ctx, body) => {
  const b = (body ?? {}) as Record<string, unknown>;
  return sddCall(ctx, (s) => s.createTask(str(b.project) ?? "", { title: str(b.title) ?? "", content: str(b.content), createdBy: "board" }, str(b.workspace) ?? ""));
});
route("POST", "/api/sdd/save", (ctx, body) => {
  const b = (body ?? {}) as Record<string, unknown>;
  return sddCall(ctx, (s) => s.saveTask(str(b.project) ?? "", str(b.task) ?? "", str(b.content) ?? "", str(b.baseRevision) ?? "", str(b.workspace) ?? ""));
});

route("GET", "/api/update", async (ctx) => ({
  ...ctx.updater.status(),
  running: runningTasks(ctx),
  backendVersion: ctx.version,
  installedVersion: packageVersion(),
  backendCommit: ctx.commit,
  installedCommit: await ctx.updater.head(),
}));
route("POST", "/api/update/check", async (ctx) => ctx.updater.check());
route("POST", "/api/update/check-daily", (ctx) => ctx.updater.checkDaily());
route("POST", "/api/update/apply", (ctx) => ctx.updater.apply());
route("POST", "/api/backend/restart", (ctx) => {
  const running = runningTasks(ctx);
  if (running.length) throw new ApiError(409, `Tasks are running (${running.join(", ")}); restarting would cancel them.`);
  ctx.restart();
  return { restarting: true };
});
route("POST", "/api/backend/stop", (ctx) => {
  ctx.stop();
  return { stopping: true };
});

route("GET", "/api/status", (ctx) => ({
  pid: process.pid,
  version: ctx.version,
  startedAt: ctx.startedAt,
  home: ctx.config.home,
  mcpSessions: ctx.sessions(),
  running: runningTasks(ctx),
}));
