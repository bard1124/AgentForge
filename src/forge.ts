import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ForgeConfig } from "./config.js";
import type { ModelParameterValue, SDKMessage, TokenUsage } from "@cursor/sdk";
import { type Delegation, type ModelEntry, type Permission, readDelegation } from "./delegation.js";
import { isRetryableError, isTransientMessage } from "./errors.js";
import { StepRecorder, truncate } from "./events.js";
import { captureBaseline, diffFor, summarizeChanges } from "./git.js";
import { loadMcpServers, McpConfigError, pickMcpServers } from "./mcp-config.js";
import { buildBrief, buildReworkPrompt } from "./prompts.js";
import { TaskStore } from "./store.js";
import { type ChangeSummary, type OrderStatus, type Step, type Task, type Turn, type Verification } from "./types.js";
import { runVerification } from "./verify.js";
import type { ConversationInfo, Worker, WorkerRun, WorkerSession } from "./workers/worker.js";

export class ForgeError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The lifecycle Claude and the board see; `uncertain` means the outcome must be checked before re-dispatching. */
export function orderStatus(task: Task): OrderStatus {
  const turn = task.turns.at(-1);
  switch (task.status) {
    case "queued":
      return "queued";
    case "running":
      return turn?.runId ? "executing" : "dispatching";
    case "paused":
      return "paused";
    case "finished":
    case "accepted":
      return "completed";
    case "error":
      return turn?.error?.startsWith("Stopped: task time budget") ? "blocked" : "failed";
    case "rejected":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "interrupted":
      return "uncertain";
  }
}

/** Rejects after `ms`; a value that arrives later is handed to `onLate` so it can be cleaned up. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string, onLate?: (value: T) => void): Promise<T> {
  if (!(ms > 0)) return promise;
  return new Promise<T>((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(message));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        if (timedOut) onLate?.(value);
        else resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        if (!timedOut) reject(err);
      },
    );
  });
}

interface LiveTask {
  task: Task;
  session?: WorkerSession;
  opening?: Promise<WorkerSession>;
  run?: WorkerRun;
  done?: Promise<void>;
  /** Set by pause(): the cancelled turn ends as paused and queued follow-ups wait for resume. */
  pausing?: boolean;
  /** Set by cancel() and shutdown(): the ending turn is not continued automatically. */
  cancelling?: boolean;
  waiters: Set<() => void>;
}

/** Worker tools that write the file named by `args.path`. */
const EDIT_TOOLS = new Set(["edit", "write", "delete"]);

/** `file` relative to `cwd` with forward slashes, as git prints it; absolute when outside `cwd`. */
function relativeTo(cwd: string, file: string): string {
  const rel = path.relative(cwd, path.resolve(cwd, file));
  return rel.startsWith("..") || path.isAbsolute(rel) ? path.resolve(cwd, file) : rel.split(path.sep).join("/");
}

const AUTO_RETRY_PROMPT =
  "Your previous turn was cut off by a connection error. Continue from where you stopped: check what is already done (files, git diff) and do not redo finished work. The original task is unchanged.";

export interface DispatchInput {
  orderId?: string;
  task: string;
  cwd: string;
  title?: string;
  acceptance?: string;
  verifyCommand?: string;
  context?: string;
  worker?: string;
  model?: string;
  modelParams?: ModelParameterValue[];
  mcpServers?: string[];
  maxRework?: number;
  maxTurns?: number;
  maxMinutes?: number;
}

export interface BudgetView {
  turns: string;
  activeMinutes: string;
  exhausted?: string;
}

export interface UsageView {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  /** Billed amount from the worker backend, when it reports one. */
  chargedUsd?: number;
}

export interface StatusView {
  id: string;
  orderId?: string;
  orderStatus: OrderStatus;
  title: string;
  status: Task["status"];
  worker: string;
  cwd: string;
  model: string;
  permission?: Permission;
  /** The worker's native conversation id (Cursor agent id). */
  agentId?: string;
  turns: number;
  currentTurn?: { index: number; status: Turn["status"]; prompt: string; elapsedSec: number };
  pendingFollowups: number;
  /** Seconds since the worker last emitted anything; only set while running. */
  idleSec?: number;
  lastError?: { message: string; retryable: boolean };
  budget: BudgetView;
  usage?: UsageView;
  steps: Step[];
  lastSeq: number;
  lastMessage?: string;
  hint: string;
}

export interface ResultView {
  id: string;
  orderId?: string;
  orderStatus: OrderStatus;
  agentId?: string;
  title: string;
  status: Task["status"];
  finalReport?: string;
  lastError?: string;
  changes: ChangeSummary;
  diff?: string;
  /** Tool calls replayed after a reconnect; check edited files for duplicated code. */
  replayed?: Task["replayed"];
  verifications: Verification[];
  reworkCount: number;
  budget: BudgetView;
  usage?: UsageView;
  eventLog: string;
}

export interface ExecutorRuntime {
  description?: string;
  /** null when the executor publishes no catalog to judge by. */
  online: boolean | null;
  defaultModel: string;
  permissions: readonly Permission[];
  models?: ModelEntry[];
  error?: string;
  note?: string;
}

export interface AcceptInput {
  verifyCommand?: string;
  feedback?: string;
  reworkOnFail?: boolean;
}

function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function now(): string {
  return new Date().toISOString();
}

export function sumUsage(turns: Turn[]): UsageView | undefined {
  const reported = turns.map((t) => t.usage).filter((u): u is TokenUsage => !!u);
  if (!reported.length) return undefined;
  return reported.reduce<UsageView>(
    (acc, u) => ({
      inputTokens: acc.inputTokens + u.inputTokens,
      outputTokens: acc.outputTokens + u.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + u.cacheReadTokens,
      totalTokens: acc.totalTokens + u.totalTokens,
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0 },
  );
}

/**
 * Supervisor-side orchestration. Claude Code does the reasoning; each tool call
 * here is an action whose observation (status, result, verification) flows back.
 */
export class Forge {
  private readonly live = new Map<string, LiveTask>();

  constructor(
    private readonly config: ForgeConfig,
    private readonly store: TaskStore,
    private readonly workers: Record<string, Worker>,
  ) {
    this.recoverOrphans();
  }

  /** Tasks left running by a server that no longer exists cannot be observed anymore. */
  private recoverOrphans(): void {
    for (const task of this.store.list()) {
      if ((task.status === "running" || task.status === "queued") && !isAlive(task.ownerPid)) {
        task.status = "interrupted";
        for (const turn of task.turns) {
          if (turn.status === "running") {
            turn.status = "interrupted";
            turn.endedAt = now();
          }
        }
        task.updatedAt = now();
        this.store.save(task);
      }
    }
  }

  workerNames(): string[] {
    return Object.keys(this.workers);
  }

  permissionsOf(name: string): readonly Permission[] {
    return this.workers[name]?.permissions ?? [];
  }

  delegation(): Delegation {
    return readDelegation(this.config.home, this.config.worker).settings;
  }

  /**
   * Explicit arguments win; otherwise the board's executor, model and effort apply. The board's
   * permission applies to its executor only, and a permission the worker cannot apply blocks the dispatch.
   */
  private async route(input: DispatchInput): Promise<{ workerName: string; model: string; modelParams?: ModelParameterValue[]; permission?: Permission; warnings: string[] }> {
    const board = this.delegation();
    const warnings: string[] = [];
    const workerName = input.worker ?? (this.workers[board.executor] ? board.executor : this.config.worker);
    const worker = this.workers[workerName];
    if (!worker) throw new ForgeError(`Unknown worker "${workerName}". Available: ${this.workerNames().join(", ")}`);
    const onBoard = workerName === board.executor;
    const model = input.model ?? (onBoard ? board.route?.model : undefined) ?? worker.defaultModel ?? this.config.model;
    let modelParams = input.modelParams;
    if (!modelParams && onBoard && board.route?.model === model && board.effort) {
      const entry = (await worker.models?.().catch(() => undefined))?.find((m) => m.id === model);
      if (entry?.effortParam && entry.efforts.includes(board.effort)) modelParams = [{ id: entry.effortParam, value: board.effort }];
      else warnings.push(`The board's effort "${board.effort}" could not be applied to ${model} (catalog unavailable or option removed); the model default is used.`);
    }
    const permission = onBoard ? board.permission : undefined;
    if (permission && !worker.permissions?.includes(permission)) {
      throw new ForgeError(`Blocked: ${workerName} cannot apply the "${permission}" new-session permission set on the board, so nothing was started. Change it on the board or tell the user.`);
    }
    return { workerName, model, modelParams, permission, warnings };
  }

  private readonly orders = new Map<string, Promise<{ task: Task; warnings: string[]; reused?: boolean }>>();

  findOrder(orderId: string): Task | undefined {
    const live = [...this.live.values()].find((l) => l.task.orderId === orderId)?.task;
    return live ?? this.list().find((t) => t.orderId === orderId);
  }

  /** With an order_id the call is idempotent: the same id and arguments return the original task. */
  async dispatch(input: DispatchInput): Promise<{ task: Task; warnings: string[]; reused?: boolean }> {
    const orderId = input.orderId;
    if (orderId === undefined) return this.submit(input);
    if (!UUID.test(orderId)) throw new ForgeError("order_id must be a real UUID (crypto.randomUUID()) generated before the first attempt; omit it to let AgentForge assign none.");
    const hash = crypto.createHash("sha256").update(JSON.stringify({ ...input, cwd: path.resolve(input.cwd) })).digest("hex");
    const same = (task: Task) => {
      if (task.orderHash !== hash) throw new ForgeError(`order_id ${orderId} was already used for task ${task.id} with different arguments. Retries must repeat the original arguments exactly; new work needs a new order_id.`);
      return { task, warnings: [], reused: true };
    };
    const inflight = this.orders.get(orderId);
    if (inflight) {
      const task = (await inflight.catch(() => undefined))?.task ?? this.findOrder(orderId);
      // The first attempt was refused before creating a task; this one tries afresh.
      return task ? same(task) : this.dispatch(input);
    }
    const existing = this.findOrder(orderId);
    if (existing) return same(existing);
    const pending = this.submit({ ...input }, hash);
    this.orders.set(orderId, pending);
    try {
      return await pending;
    } finally {
      this.orders.delete(orderId);
    }
  }

  private async submit(input: DispatchInput, orderHash?: string): Promise<{ task: Task; warnings: string[] }> {
    const { workerName, model, modelParams, permission, warnings } = await this.route(input);
    const cwd = path.resolve(input.cwd);
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new ForgeError(`cwd does not exist or is not a directory: ${cwd}`);
    this.resolveMcp(input.mcpServers ?? []);

    const busy = this.list().filter((t) => t.cwd === cwd && t.status === "running");
    if (busy.length) {
      warnings.push(`Other running task(s) in the same directory: ${busy.map((t) => t.id).join(", ")}. Edits may conflict.`);
    }
    const baseline = await captureBaseline(cwd);
    if (!baseline.isRepo) warnings.push("cwd is not a git repository; change tracking is unavailable.");
    else if (baseline.dirty.length) warnings.push(`Working tree already had ${baseline.dirty.length} modified file(s); they are flagged as preExisting in results.`);

    const task: Task = {
      id: this.store.newId(),
      orderId: input.orderId,
      orderHash,
      title: input.title?.trim() || truncate(input.task, 80),
      cwd,
      worker: workerName,
      model,
      modelParams: modelParams?.length ? modelParams : undefined,
      permission,
      mcpServers: input.mcpServers?.length ? input.mcpServers : undefined,
      acceptance: input.acceptance,
      verifyCommand: input.verifyCommand,
      status: "queued",
      createdAt: now(),
      updatedAt: now(),
      ownerPid: process.pid,
      turns: [],
      steps: [],
      stepSeq: 0,
      pending: [],
      baseline,
      verifications: [],
      reworkCount: 0,
      maxRework: input.maxRework ?? this.config.maxRework,
      maxTurns: input.maxTurns ?? this.config.maxTurns,
      maxTaskMs: input.maxMinutes !== undefined ? input.maxMinutes * 60_000 : this.config.maxTaskMs,
      activeMs: 0,
    };
    this.store.save(task);
    const live: LiveTask = { task, waiters: new Set() };
    this.live.set(task.id, live);

    const brief = buildBrief({ task: input.task, cwd, acceptance: input.acceptance, verifyCommand: input.verifyCommand, context: input.context });
    try {
      await this.startTurn(live, brief);
    } catch (err) {
      task.status = "error";
      this.addStep(task, { kind: "error", text: `Failed to start worker: ${(err as Error).message}` });
      this.persist(task);
      const again = isRetryableError(err) ? ` forge_retry with task_id ${task.id} tries again on the same task.` : "";
      throw new ForgeError(`Task ${task.id} could not start: ${(err as Error).message}${again}`, { cause: err });
    }
    return { task, warnings };
  }

  get(id: string): Task {
    const task = this.live.get(id)?.task ?? this.store.get(id);
    if (!task) throw new ForgeError(`No task with id ${id}`);
    return this.withDefaults(task);
  }

  list(): Task[] {
    return this.store.list().map((t) => this.withDefaults(this.live.get(t.id)?.task ?? t));
  }

  /** Records written before budgets existed lack these fields. */
  private withDefaults(task: Task): Task {
    task.maxTurns ??= this.config.maxTurns;
    task.maxTaskMs ??= this.config.maxTaskMs;
    task.activeMs ??= 0;
    return task;
  }

  private resolveMcp(names: string[]) {
    try {
      return pickMcpServers(this.config.mcpConfigPath, names);
    } catch (err) {
      if (err instanceof McpConfigError) throw new ForgeError(err.message);
      throw err;
    }
  }

  private budgetOf(task: Task): BudgetView {
    const running = task.turns.at(-1);
    const liveMs = running?.status === "running" ? Date.now() - Date.parse(running.startedAt) : 0;
    const minutes = (ms: number) => (ms / 60_000).toFixed(1);
    const view: BudgetView = {
      turns: `${task.turns.length}/${task.maxTurns}`,
      activeMinutes: `${minutes(task.activeMs + liveMs)}/${minutes(task.maxTaskMs)}`,
    };
    if (task.turns.length >= task.maxTurns) view.exhausted = "turns";
    else if (task.activeMs >= task.maxTaskMs) view.exhausted = "time";
    return view;
  }

  status(id: string, since = 0, limit = 30): StatusView {
    const task = this.get(id);
    const turn = task.turns.at(-1);
    const steps = task.steps.filter((s) => s.seq > since).slice(-limit);
    const lastSay = [...task.steps].reverse().find((s) => s.kind === "say");
    const idleSec = this.idleSec(task);
    const failed = task.status === "error" ? turn?.error : undefined;
    const previous = task.turns.at(-2);
    const alreadyRetried = !!turn && (!!turn.autoRetry || (previous?.status === "error" && (!!previous.autoRetry || previous.prompt === turn.prompt)));
    const retryable = failed !== undefined && (turn?.retryable ?? isTransientMessage(failed)) && !alreadyRetried;
    const lastError = failed !== undefined ? { message: failed, retryable } : undefined;
    return {
      id: task.id,
      orderId: task.orderId,
      orderStatus: orderStatus(task),
      title: task.title,
      status: task.status,
      worker: task.worker,
      cwd: task.cwd,
      model: task.model,
      permission: task.permission,
      agentId: task.agentId,
      turns: task.turns.length,
      currentTurn: turn && {
        index: turn.index,
        status: turn.status,
        prompt: truncate(turn.prompt, 200),
        elapsedSec: Math.round(((turn.endedAt ? Date.parse(turn.endedAt) : Date.now()) - Date.parse(turn.startedAt)) / 1000),
      },
      pendingFollowups: task.pending.length,
      idleSec,
      lastError,
      budget: this.budgetOf(task),
      usage: sumUsage(task.turns),
      steps,
      lastSeq: task.stepSeq,
      lastMessage: lastSay?.text,
      hint: this.statusHint(task, idleSec, lastError?.retryable, alreadyRetried),
    };
  }

  private idleSec(task: Task): number | undefined {
    if (task.status !== "running" || !task.lastEventAt) return undefined;
    return Math.round((Date.now() - Date.parse(task.lastEventAt)) / 1000);
  }

  /** Blocks until the task leaves the running state or the timeout elapses. */
  async wait(id: string, timeoutSec: number): Promise<boolean> {
    const live = this.live.get(id);
    const task = this.get(id);
    if (task.status !== "running" && task.status !== "queued") return true;
    if (!live) throw new ForgeError(`Task ${id} is owned by another AgentForge process (pid ${task.ownerPid}); poll forge_status instead.`);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        live.waiters.delete(done);
        resolve(true);
      };
      const timer = setTimeout(() => {
        live.waiters.delete(done);
        resolve(false);
      }, timeoutSec * 1000);
      live.waiters.add(done);
    });
  }

  async followup(id: string, message: string): Promise<"started" | "steered" | "queued"> {
    const live = await this.claim(id);
    const { task } = live;
    if (task.status === "running" && live.run) {
      if (live.run.steer && (await live.run.steer(message).catch(() => false))) {
        this.addStep(task, { kind: "user", text: `[steer] ${truncate(message, 300)}` });
        this.persist(task);
        return "steered";
      }
      task.pending.push(message);
      this.addStep(task, { kind: "user", text: `[queued] ${truncate(message, 300)}` });
      this.persist(task);
      return "queued";
    }
    await this.startTurn(live, message);
    return "started";
  }

  /**
   * Re-sends the prompt of the last failed or interrupted turn on the same agent; after an automatic
   * retry, the instruction it continued. A paused task is resumed.
   */
  async retry(id: string): Promise<Turn> {
    if (this.get(id).status === "paused") return this.resume(id);
    const live = await this.claim(id);
    const { task } = live;
    const last = task.turns.at(-1);
    if (!last || (task.status !== "error" && task.status !== "interrupted")) {
      throw new ForgeError(`Task ${id} has no failed turn to retry (status: ${task.status}).`);
    }
    // A session that just failed may hold broken connection state; start from a fresh resume.
    await live.session?.close().catch(() => undefined);
    live.session = undefined;
    const prompt = last.autoRetry ? ([...task.turns].reverse().find((t) => !t.autoRetry)?.prompt ?? last.prompt) : last.prompt;
    await this.startTurn(live, prompt);
    return task.turns.at(-1)!;
  }

  /** Cancels the running turn but keeps the agent and queued follow-ups; resume() picks it up again. */
  async pause(id: string): Promise<Task> {
    const live = this.live.get(id);
    const task = this.get(id);
    if (task.status !== "running") throw new ForgeError(`Task ${id} is not running (status: ${task.status}).`);
    if (!live?.run) throw new ForgeError(`Task ${id} is still starting or owned by another AgentForge process (pid ${task.ownerPid}); try again shortly.`);
    live.pausing = true;
    await live.run.cancel();
    await live.done;
    return task;
  }

  /** Re-sends the paused turn's prompt on the same agent. */
  async resume(id: string): Promise<Turn> {
    const live = await this.claim(id);
    const { task } = live;
    const last = task.turns.at(-1);
    if (!last || task.status !== "paused") throw new ForgeError(`Task ${id} is not paused (status: ${task.status}).`);
    await this.startTurn(live, last.prompt);
    return task.turns.at(-1)!;
  }

  async cancel(id: string): Promise<Task> {
    if (this.get(id).status === "paused") {
      const { task } = await this.claim(id);
      const last = task.turns.at(-1);
      if (last?.status === "paused") last.status = "cancelled";
      task.status = "cancelled";
      task.pending = [];
      this.persist(task);
      return task;
    }
    const live = this.live.get(id);
    const task = this.get(id);
    if (task.status !== "running") throw new ForgeError(`Task ${id} is not running (status: ${task.status}).`);
    if (!live?.run) throw new ForgeError(`Task ${id} is owned by another AgentForge process (pid ${task.ownerPid}).`);
    task.pending = [];
    live.cancelling = true;
    await live.run.cancel();
    await live.done;
    return task;
  }

  /** Removes a task that is not running, with its event log; its order_id can then be dispatched afresh. */
  async delete(id: string): Promise<void> {
    const task = this.get(id);
    if (task.status === "running" || task.status === "queued") throw new ForgeError(`Task ${id} is running; pause or cancel it first.`);
    const live = this.live.get(id);
    if (live) {
      await this.release(live);
      this.live.delete(id);
    }
    if (task.orderId) this.orders.delete(task.orderId);
    this.store.delete(id);
  }

  /** Deletes every task that is neither running nor paused; returns how many. */
  async clearFinished(): Promise<number> {
    const done = this.list().filter((t) => t.status !== "running" && t.status !== "queued" && t.status !== "paused");
    for (const task of done) await this.delete(task.id);
    return done.length;
  }

  async result(id: string, opts: { includeDiff?: boolean; paths?: string[]; maxDiffChars?: number } = {}): Promise<ResultView> {
    const task = this.get(id);
    const lastFinished = [...task.turns].reverse().find((t) => t.result);
    const lastError = [...task.turns].reverse().find((t) => t.error)?.error;
    const changes = await summarizeChanges(task.cwd, task.baseline).catch(
      (err): ChangeSummary => ({ isRepo: false, commits: [], diffStat: `git error: ${(err as Error).message}`, files: [] }),
    );
    const others = this.otherEditors(task);
    for (const f of changes.files) {
      const other = task.touched?.includes(f.path) ? undefined : others.get(f.path);
      if (other) f.byOtherTask = other;
    }
    let diff: string | undefined;
    if (opts.includeDiff && changes.isRepo) {
      const paths = opts.paths?.length ? opts.paths : changes.files.filter((f) => !f.preExisting && !f.byOtherTask).map((f) => f.path);
      diff = paths.length ? await diffFor(task.cwd, task.baseline, paths, opts.maxDiffChars ?? 40_000) : "";
    }
    return {
      id: task.id,
      orderId: task.orderId,
      orderStatus: orderStatus(task),
      agentId: task.agentId,
      title: task.title,
      status: task.status,
      finalReport: lastFinished?.result,
      lastError,
      changes,
      diff,
      ...(task.replayed?.length ? { replayed: task.replayed } : {}),
      verifications: task.verifications,
      reworkCount: task.reworkCount,
      budget: this.budgetOf(task),
      usage: await this.usageOf(task),
      eventLog: this.store.eventFile(task.id),
    };
  }

  /** Files that other tasks in the same directory wrote since this one started, mapped to the task id. */
  private otherEditors(task: Task): Map<string, string> {
    const out = new Map<string, string>();
    for (const t of this.list()) {
      if (t.id === task.id || t.cwd !== task.cwd || t.updatedAt < task.createdAt) continue;
      for (const f of t.touched ?? []) if (!out.has(f)) out.set(f, t.id);
    }
    return out;
  }

  /** Prefers the worker backend's billed totals; falls back to per-turn token counts. */
  private async usageOf(task: Task): Promise<UsageView | undefined> {
    const fromTurns = sumUsage(task.turns);
    const worker = this.workers[task.worker];
    if (!task.agentId || !worker?.usage) return fromTurns;
    try {
      const billed = await worker.usage(task.agentId, { cwd: task.cwd, model: task.model });
      if (!billed) return fromTurns;
      return {
        inputTokens: billed.usage.inputTokens,
        outputTokens: billed.usage.outputTokens,
        cacheReadTokens: billed.usage.cacheReadTokens,
        totalTokens: billed.usage.totalTokens,
        chargedUsd: billed.chargedCents !== undefined ? Math.round(billed.chargedCents) / 100 : undefined,
      };
    } catch {
      return fromTurns;
    }
  }

  async accept(id: string, input: AcceptInput): Promise<{ task: Task; verification?: Verification; action: "accepted" | "rework" | "rejected" }> {
    const live = await this.claim(id);
    const { task } = live;
    if (task.status === "running" || task.status === "queued") throw new ForgeError(`Task ${id} is still running; wait for it first.`);
    const command = input.verifyCommand ?? task.verifyCommand;

    let verification: Verification | undefined;
    if (command) {
      verification = await runVerification(command, task.cwd, this.config.verifyTimeoutMs);
      task.verifications.push(verification);
      this.addStep(task, { kind: "verify", text: `${verification.passed ? "PASS" : "FAIL"} (${verification.exitCode ?? "timeout"}) ${command}` });
    }

    if (!verification || verification.passed) {
      task.status = "accepted";
      this.persist(task);
      await this.release(live);
      return { task, verification, action: "accepted" };
    }

    if ((input.reworkOnFail ?? true) && task.reworkCount < task.maxRework) {
      task.reworkCount += 1;
      await this.startTurn(live, buildReworkPrompt(verification, input.feedback));
      return { task, verification, action: "rework" };
    }
    task.status = "rejected";
    this.persist(task);
    return { task, verification, action: "rejected" };
  }

  async shutdown(): Promise<void> {
    for (const live of this.live.values()) {
      live.cancelling = true;
      if (live.run) await live.run.cancel().catch(() => undefined);
      await this.release(live);
    }
  }

  /** Makes this process the driver of a task, resuming its worker session if needed. */
  private async claim(id: string): Promise<LiveTask> {
    let live = this.live.get(id);
    if (!live) {
      const task = this.store.get(id);
      if (!task) throw new ForgeError(`No task with id ${id}`);
      if (task.ownerPid !== process.pid && isAlive(task.ownerPid) && task.status === "running") {
        throw new ForgeError(`Task ${id} is running in another AgentForge process (pid ${task.ownerPid}).`);
      }
      task.ownerPid = process.pid;
      live = { task: this.withDefaults(task), waiters: new Set() };
      this.live.set(id, live);
    }
    return live;
  }

  /** Callers that time out leave the open in flight; a retry waits on it instead of opening a second agent. */
  private ensureSession(live: LiveTask): Promise<WorkerSession> {
    if (live.session) return Promise.resolve(live.session);
    live.opening ??= this.openSession(live).finally(() => {
      live.opening = undefined;
    });
    return live.opening;
  }

  private async openSession(live: LiveTask): Promise<WorkerSession> {
    const { task } = live;
    const worker = this.workers[task.worker];
    if (!worker) throw new ForgeError(`Worker "${task.worker}" is not available.`);
    const opts = { cwd: task.cwd, model: task.model, modelParams: task.modelParams, mcpServers: this.resolveMcp(task.mcpServers ?? []), permission: task.permission };
    live.session = task.agentId ? await worker.resume(task.agentId, opts) : await worker.create(opts);
    task.agentId = live.session.agentId;
    return live.session;
  }

  private async startTurn(live: LiveTask, prompt: string, autoRetry = false): Promise<void> {
    const { task } = live;
    const budget = this.budgetOf(task);
    if (budget.exhausted) {
      throw new ForgeError(
        `Task ${task.id} has used its ${budget.exhausted === "turns" ? `turn budget (${budget.turns})` : `time budget (${budget.activeMinutes} min)`}. ` +
          "Ask the user before continuing; dispatch a new task with a narrower scope or higher max_turns / max_minutes.",
      );
    }
    const turn: Turn = { index: task.turns.length + 1, prompt, status: "running", startedAt: now(), ...(autoRetry ? { autoRetry } : {}) };
    task.turns.push(turn);
    task.status = "running";
    task.lastEventAt = now();
    if (turn.index > 1) this.addStep(task, { kind: "user", text: truncate(prompt, 300) });
    this.persist(task);

    const limitMs = this.config.startTimeoutMs;
    const limit = `${Math.round(limitMs / 1000)}s`;
    let run: WorkerRun;
    try {
      const session = await withTimeout(this.ensureSession(live), limitMs, `Worker did not start within ${limit} (timed out creating the agent).`);
      run = await withTimeout(session.send(prompt), limitMs, `Worker did not start within ${limit} (timed out sending the prompt).`, (late) => {
        void late.cancel().catch(() => undefined);
      });
    } catch (err) {
      turn.status = "error";
      turn.error = (err as Error).message;
      turn.endedAt = now();
      task.status = "error";
      this.persist(task);
      throw err;
    }
    turn.runId = run.id;
    task.lastEventAt = now();
    live.run = run;
    this.persist(task);
    this.store.appendEvent(task.id, { type: "forge_turn_started", turn: turn.index, runId: run.id, agentId: task.agentId });
    live.done = this.drive(live, run, turn);
  }

  private async drive(live: LiveTask, run: WorkerRun, turn: Turn): Promise<void> {
    const { task } = live;
    const recorder = new StepRecorder(task, turn.index, this.config.maxStepsKept);
    let lastSave = 0;
    let overBudget = false;
    const budgetTimer = setTimeout(() => {
      overBudget = true;
      void run.cancel().catch(() => undefined);
    }, Math.max(0, task.maxTaskMs - task.activeMs));
    const completed = new Set<string>();
    try {
      for await (const message of run.messages()) {
        this.store.appendEvent(task.id, message);
        task.lastEventAt = now();
        recorder.record(message);
        this.noteToolCall(task, message, completed);
        if (Date.now() - lastSave > 1000) {
          lastSave = Date.now();
          this.persist(task);
        }
      }
      const res = await run.wait();
      turn.status = res.status;
      turn.result = res.result;
      turn.error = res.error;
      if (res.status === "error") turn.retryable = res.retryable ?? isTransientMessage(res.error);
      turn.durationMs = res.durationMs;
      turn.usage = res.usage;
    } catch (err) {
      turn.status = "error";
      turn.error = (err as Error).message;
      turn.retryable = isRetryableError(err);
    }
    clearTimeout(budgetTimer);
    turn.endedAt = now();
    task.activeMs += Date.parse(turn.endedAt) - Date.parse(turn.startedAt);
    const stopping = !!live.pausing || !!live.cancelling;
    if (live.pausing && turn.status === "cancelled") turn.status = "paused";
    live.pausing = false;
    live.cancelling = false;
    if (overBudget) {
      turn.status = "error";
      turn.error = `Stopped: task time budget of ${Math.round(task.maxTaskMs / 60_000)} min used up. Ask the user before continuing.`;
      delete turn.retryable;
      task.pending = [];
    }
    live.run = undefined;
    const autoRetry = turn.status === "error" && !!turn.retryable && !turn.autoRetry && !stopping && this.config.autoRetry > 0 && !this.budgetOf(task).exhausted;
    // Stays running across an automatic retry, so a poll in between never reports the failure.
    task.status = autoRetry ? "running" : turn.status;
    if (turn.error) this.addStep(task, { kind: "error", text: truncate(turn.error, 300) });
    this.persist(task);

    if (autoRetry) {
      this.addStep(task, { kind: "status", text: "Transient connection error; continuing automatically on the same agent (once)." });
      await live.session?.close().catch(() => undefined);
      live.session = undefined;
      try {
        await this.startTurn(live, AUTO_RETRY_PROMPT, true);
        return;
      } catch (err) {
        this.addStep(task, { kind: "error", text: `Automatic retry failed to start: ${(err as Error).message}` });
        this.persist(task);
      }
    }

    const next = turn.status === "paused" ? undefined : task.pending.shift();
    if (next !== undefined && turn.status !== "cancelled") {
      try {
        await this.startTurn(live, next);
        return;
      } catch (err) {
        this.addStep(task, { kind: "error", text: `Queued follow-up failed to start: ${(err as Error).message}` });
        this.persist(task);
      }
    }
    for (const notify of [...live.waiters]) notify();
  }

  /** Records files the edit tools wrote, and calls that completed twice in one run (replayed after a reconnect). */
  private noteToolCall(task: Task, message: SDKMessage, completed: Set<string>): void {
    if (message.type !== "tool_call" || message.status !== "completed") return;
    const args = (message.args ?? {}) as { path?: unknown; command?: unknown };
    const file = typeof args.path === "string" ? relativeTo(task.cwd, args.path) : undefined;
    if (file && EDIT_TOOLS.has(message.name)) {
      task.touched ??= [];
      if (!task.touched.includes(file)) task.touched.push(file);
    }
    if (!completed.has(message.call_id)) {
      completed.add(message.call_id);
      return;
    }
    const target = file ?? (typeof args.command === "string" ? truncate(args.command, 200) : "");
    task.replayed ??= [];
    task.replayed.push({ at: now(), tool: message.name, target });
    const check = EDIT_TOOLS.has(message.name) ? " It may have applied twice: check that file for duplicated code." : "";
    this.addStep(task, { kind: "error", text: `Replayed after a reconnect: ${message.name} ${target}.${check}` });
  }

  private async release(live: LiveTask): Promise<void> {
    await live.session?.close().catch(() => undefined);
    live.session = undefined;
    for (const notify of [...live.waiters]) notify();
  }

  private addStep(task: Task, step: Omit<Step, "seq" | "at" | "turn">): void {
    new StepRecorder(task, task.turns.length, this.config.maxStepsKept).push(step);
  }

  private persist(task: Task): void {
    task.updatedAt = now();
    this.store.save(task);
  }

  private statusHint(task: Task, idleSec: number | undefined, retryable: boolean | undefined, alreadyRetried: boolean): string {
    if (alreadyRetried && task.status === "error") {
      const turn = task.turns.at(-1);
      if (turn?.retryable ?? isTransientMessage(turn?.error)) {
        return "The connection keeps dropping: this turn failed again after a retry, often because a proxy/VPN cuts long connections or one turn runs very long. Stop retrying and tell the user; suggest splitting the task into smaller dispatches rather than re-dispatching the same brief.";
      }
      return "This turn already failed and was retried once. Stop retrying and report lastError to the user.";
    }
    const exhausted = this.budgetOf(task).exhausted;
    if (exhausted && task.status !== "running" && task.status !== "accepted") {
      return `The task's ${exhausted} budget is used up, so no further turns can start. Review forge_result, then accept or report to the user; continuing needs a new task.`;
    }
    return this.hintFor(task, idleSec, retryable);
  }

  capabilities(): { workers: { name: string; description?: string }[]; mcpServers: string[]; mcpConfig: string; defaults: Record<string, unknown>; warning?: string } {
    let mcpServers: string[] = [];
    try {
      mcpServers = Object.keys(loadMcpServers(this.config.mcpConfigPath));
    } catch {
      // Surfaced on dispatch, where it matters.
    }
    return {
      workers: Object.values(this.workers).map((w) => ({ name: w.name, description: w.description })),
      mcpServers,
      mcpConfig: this.config.mcpConfigPath,
      defaults: {
        board: this.delegation(),
        model: this.config.model,
        modelParams: this.config.modelParams,
        maxTurns: this.config.maxTurns,
        maxMinutes: this.config.maxTaskMs / 60_000,
        maxRework: this.config.maxRework,
      },
      warning: this.workers[this.delegation().executor]
        ? undefined
        : `The board's executor "${this.delegation().executor}" is not loaded (check AGENTFORGE_WORKERS); dispatches fall back to "${this.config.worker}".`,
    };
  }

  /** Each executor's reachability and model catalog; `online` is false when the catalog cannot be read. */
  async runtimeInfo(only?: string): Promise<{ executors: Record<string, ExecutorRuntime>; board: Delegation }> {
    const names = only ? [only] : this.workerNames();
    if (only && !this.workers[only]) throw new ForgeError(`Unknown executor "${only}". Available: ${this.workerNames().join(", ")}`);
    const entries = await Promise.all(
      names.map(async (name): Promise<[string, ExecutorRuntime]> => {
        const worker = this.workers[name]!;
        const base = { description: worker.description, defaultModel: worker.defaultModel ?? this.config.model, permissions: worker.permissions ?? [] };
        if (!worker.models) return [name, { ...base, online: null, note: "This executor publishes no model catalog." }];
        try {
          return [name, { ...base, online: true, models: await worker.models() }];
        } catch (err) {
          return [name, { ...base, online: false, error: (err as Error).message }];
        }
      }),
    );
    return { executors: Object.fromEntries(entries), board: this.delegation() };
  }

  async conversation(input: { action: "list" | "archive" | "restore" | "rename"; executor?: string; id?: string; cwd?: string; limit?: number }): Promise<unknown> {
    const name = input.executor ?? this.delegation().executor;
    const worker = this.workers[name];
    if (!worker) throw new ForgeError(`Unknown executor "${name}".`);
    if (input.action === "rename") throw new ForgeError(`${name} does not support renaming conversations.`);
    if (input.action === "list") {
      if (!worker.conversations) throw new ForgeError(`${name} does not expose its conversations.`);
      const items: (ConversationInfo & { taskId?: string })[] = await worker.conversations({ cwd: input.cwd, limit: input.limit });
      const byAgent = new Map(this.list().filter((t) => t.agentId).map((t) => [t.agentId!, t.id]));
      return { executor: name, conversations: items.map((c) => ({ ...c, taskId: byAgent.get(c.id) })) };
    }
    if (!input.id) throw new ForgeError("id (the conversation id) is required.");
    const op = input.action === "archive" ? worker.archive : worker.unarchive;
    if (!op) throw new ForgeError(`${name} does not support ${input.action}.`);
    const cwd = input.cwd ?? this.list().find((t) => t.agentId === input.id)?.cwd;
    await op.call(worker, input.id, { cwd });
    return { executor: name, id: input.id, action: input.action, done: true };
  }

  private hintFor(task: Task, idleSec: number | undefined, retryable: boolean | undefined): string {
    switch (task.status) {
      case "running":
      case "queued":
        if (idleSec !== undefined && idleSec >= this.config.stallWarnSec) {
          return `Worker has emitted nothing for ${idleSec}s. It may be waiting on the model backend or stalled. Tell the user; if it stays silent, forge_cancel then forge_followup to retry on the same agent.`;
        }
        return "Worker is busy. Use forge_wait to block until it finishes, or forge_followup to steer it.";
      case "paused":
        return "The user paused this task on the board. Do not re-dispatch or retry it; it resumes from the board, or with forge_retry only if the user asks.";
      case "finished":
        return "Turn finished. Review with forge_result, then forge_accept (optionally with verify_command) or forge_followup to request changes.";
      case "error":
        return retryable
          ? "Last turn failed with a transient connection error. forge_retry continues on the same agent with the progress so far kept; do not re-dispatch. Retry once, then report to the user if it fails again."
          : "Last turn failed. Read lastError; fix the cause or give guidance via forge_followup. Do not blindly retry.";
      case "cancelled":
        return "Cancelled. forge_followup resumes the same agent with a new instruction.";
      case "interrupted":
        return "The AgentForge process driving this task exited mid-turn. forge_followup resumes the agent; check forge_result for partial changes first.";
      case "accepted":
        return "Accepted. forge_followup reopens it on the same agent if more is needed.";
      case "rejected":
        return "Verification failed and rework budget is exhausted. Decide manually: forge_followup with guidance, or take over.";
    }
  }
}