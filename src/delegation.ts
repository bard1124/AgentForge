import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Imported by the prompt hook, so this module must stay free of heavy dependencies. */

export const PERMISSIONS = ["sandbox", "auto-review", "sandbox+auto-review"] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Board sections that can be collapsed; Dispatch always stays open. */
export const BOARD_SECTIONS = ["savings", "executor", "sdd", "tasks", "update"] as const;
export type BoardSection = (typeof BOARD_SECTIONS)[number];

export interface Delegation {
  /** Auto-dispatch: Claude hands implementation work to the executor on its own. */
  enabled: boolean;
  executor: string;
  /** A fixed model; absent follows the executor's default. */
  route?: { model: string };
  /** Thinking effort; only kept together with `route`, absent follows the model's default. */
  effort?: string;
  /** New-session permission, applied once when a task's agent is created; absent follows the executor. */
  permission?: Permission;
  sdd: { enabled: boolean; workspace: string };
  /** Board layout; absent means every section is expanded. */
  board?: { collapsed: BoardSection[] };
  updatedAt?: string;
}

export interface DelegationRead {
  settings: Delegation;
  /** Set when the file exists but cannot be used; everything then reads as off and writes are refused. */
  corrupt?: string;
}

export function delegationFile(home: string): string {
  return path.join(home, "delegation.json");
}

export function heartbeatFile(home: string): string {
  return path.join(home, "hook-heartbeat.json");
}

export function defaultDelegation(home: string, executor = "cursor"): Delegation {
  return { enabled: false, executor, sdd: { enabled: true, workspace: path.join(home, "sdd") } };
}

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? path.join(os.homedir(), p.slice(1)) : p;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Known section ids in board order; unknown ids and duplicates drop out. */
function sectionIds(list: unknown[]): BoardSection[] {
  return BOARD_SECTIONS.filter((id) => list.includes(id));
}

/** Validates the stored shape; unknown or missing optional fields fall back to defaults. */
export function parseDelegation(raw: unknown, home: string, fallbackExecutor = "cursor"): Delegation {
  if (!isObject(raw)) throw new Error("delegation.json is not an object");
  const base = defaultDelegation(home, fallbackExecutor);
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") throw new Error("enabled must be a boolean");
  const out: Delegation = {
    enabled: raw.enabled === true,
    executor: typeof raw.executor === "string" && raw.executor ? raw.executor : base.executor,
    sdd: { ...base.sdd },
  };
  if (isObject(raw.route) && typeof raw.route.model === "string" && raw.route.model) out.route = { model: raw.route.model };
  if (out.route && typeof raw.effort === "string" && raw.effort) out.effort = raw.effort;
  if (typeof raw.permission === "string" && (PERMISSIONS as readonly string[]).includes(raw.permission)) out.permission = raw.permission as Permission;
  if (isObject(raw.sdd)) {
    // Older files without the field read as on.
    if (raw.sdd.enabled !== undefined && typeof raw.sdd.enabled !== "boolean") throw new Error("sdd.enabled must be a boolean");
    out.sdd.enabled = raw.sdd.enabled !== false;
    if (typeof raw.sdd.workspace === "string" && raw.sdd.workspace.trim()) out.sdd.workspace = path.resolve(expandHome(raw.sdd.workspace.trim()));
  }
  if (isObject(raw.board) && Array.isArray(raw.board.collapsed)) {
    const collapsed = sectionIds(raw.board.collapsed);
    if (collapsed.length) out.board = { collapsed };
  }
  if (typeof raw.updatedAt === "string") out.updatedAt = raw.updatedAt;
  return out;
}

export function readDelegation(home: string, fallbackExecutor = "cursor"): DelegationRead {
  const file = delegationFile(home);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { settings: defaultDelegation(home, fallbackExecutor) };
    return { settings: { ...defaultDelegation(home, fallbackExecutor), sdd: { enabled: false, workspace: path.join(home, "sdd") } }, corrupt: (err as Error).message };
  }
  try {
    return { settings: parseDelegation(JSON.parse(text), home, fallbackExecutor) };
  } catch (err) {
    const settings = defaultDelegation(home, fallbackExecutor);
    settings.sdd.enabled = false;
    return { settings, corrupt: `${file}: ${(err as Error).message}` };
  }
}

/** `keepStamp` leaves `updatedAt` alone for layout-only writes, which the prompt hook does not read. */
export function writeDelegation(home: string, settings: Delegation, keepStamp = false): Delegation {
  const saved = keepStamp ? { ...settings } : { ...settings, updatedAt: new Date().toISOString() };
  fs.mkdirSync(home, { recursive: true });
  const file = delegationFile(home);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(saved, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return saved;
}

export interface ModelEntry {
  id: string;
  displayName?: string;
  /** The model parameter that carries thinking effort, e.g. `effort` or `reasoning_effort`. */
  effortParam?: string;
  /** Effort values the catalog offers; empty when the model takes none. */
  efforts: string[];
}

export interface ExecutorFacts {
  /** Model catalog; undefined when it could not be read (executor offline). */
  models?: ModelEntry[];
  /** Permissions the executor can apply to new sessions. */
  permissions: readonly Permission[];
}

export interface DelegationChange {
  enabled?: boolean;
  executor?: string;
  /** null clears the fixed model (follow the executor's default). */
  model?: string | null;
  /** null clears the effort (follow the model's default). */
  effort?: string | null;
  /** null or "default" clears the permission. */
  permission?: Permission | "default" | null;
  sddEnabled?: boolean;
  sddWorkspace?: string;
  /** Replaces the collapsed board sections; unknown ids are ignored. */
  collapsed?: string[];
}

/** A change that only touches the board layout. */
export const layoutOnly = (change: DelegationChange): boolean => Object.keys(change).length > 0 && Object.keys(change).every((k) => k === "collapsed");

export class DelegationError extends Error {}

/**
 * Applies a board change. Switching executor resets model, effort and permission;
 * switching model drops an effort the new model does not offer. New selections are
 * checked against the executor's catalog, so an offline executor refuses them while
 * the switch itself can still be turned off.
 */
export function applyChange(current: Delegation, change: DelegationChange, executors: Record<string, ExecutorFacts>): Delegation {
  const next: Delegation = { ...current, sdd: { ...current.sdd } };
  if (change.enabled !== undefined) next.enabled = change.enabled;
  if (change.sddEnabled !== undefined) next.sdd.enabled = change.sddEnabled;
  if (change.sddWorkspace !== undefined) {
    const dir = expandHome(change.sddWorkspace.trim());
    if (!dir || !path.isAbsolute(dir)) throw new DelegationError("The SDD workspace must be an absolute directory.");
    next.sdd.workspace = path.resolve(dir);
  }
  if (change.collapsed !== undefined) {
    if (!Array.isArray(change.collapsed)) throw new DelegationError("collapsed must be a list of section ids.");
    const collapsed = sectionIds(change.collapsed);
    if (collapsed.length) next.board = { collapsed };
    else delete next.board;
  }
  if (change.executor !== undefined && change.executor !== current.executor) {
    if (!executors[change.executor]) throw new DelegationError(`Unknown executor "${change.executor}". Available: ${Object.keys(executors).join(", ")}`);
    next.executor = change.executor;
    delete next.route;
    delete next.effort;
    delete next.permission;
  }
  const facts = executors[next.executor];
  const catalog = facts?.models;
  const entry = (id: string) => catalog?.find((m) => m.id === id);

  if (change.model !== undefined) {
    if (change.model === null || change.model === "") {
      delete next.route;
      delete next.effort;
    } else if (change.model !== next.route?.model) {
      if (!catalog) throw new DelegationError(`The ${next.executor} model catalog is unavailable (executor offline?); cannot select a model now.`);
      const model = entry(change.model);
      if (!model) throw new DelegationError(`Model "${change.model}" is not in the ${next.executor} catalog.`);
      next.route = { model: model.id };
      if (next.effort && !model.efforts.includes(next.effort)) delete next.effort;
    }
  }
  if (change.effort !== undefined) {
    if (change.effort === null || change.effort === "") delete next.effort;
    else {
      if (!next.route) throw new DelegationError("Pick a fixed model before setting a thinking effort; the executor default has none to fix.");
      const model = entry(next.route.model);
      if (!model) throw new DelegationError(`Model "${next.route.model}" is not in the current catalog; cannot check its efforts.`);
      if (!model.efforts.includes(change.effort)) {
        throw new DelegationError(model.efforts.length ? `Effort "${change.effort}" is not offered for ${model.id}. Options: ${model.efforts.join(", ")}` : `${model.id} offers no effort options; it follows the model default.`);
      }
      next.effort = change.effort;
    }
  }
  if (change.permission !== undefined) {
    if (change.permission === null || change.permission === "default") delete next.permission;
    else {
      if (!facts?.permissions.includes(change.permission)) throw new DelegationError(`${next.executor} does not support the "${change.permission}" new-session permission.`);
      next.permission = change.permission;
    }
  }
  return next;
}

function describeRoute(s: Delegation): string {
  const model = s.route ? `model ${s.route.model}${s.effort ? `, effort ${s.effort}` : ", model-default effort"}` : "the executor's default model";
  return `executor ${s.executor}, ${model}, new-session permission ${s.permission ?? "executor default"}`;
}

/** The per-message context the prompt hook adds. */
export function promptContext(read: DelegationRead): string {
  const s = read.settings;
  if (read.corrupt) {
    return `AgentForge auto-dispatch: OFF (settings unreadable: ${read.corrupt}). Work as usual; use forge_* only if the user explicitly asks.`;
  }
  if (!s.enabled) {
    return [
      "AgentForge auto-dispatch: OFF.",
      "Do not hand new work to an agent on your own; work as usual.",
      "If the user explicitly asks for an agent (Cursor, /forge), forge_dispatch is still available. Keep following up tasks already dispatched; switching off cancels nothing.",
    ].join(" ");
  }
  const lines = [
    `AgentForge auto-dispatch: ON (${describeRoute(s)}).`,
    "You plan and accept; the agent implements. For requests that need code written, bugs fixed, or tests run: settle the plan, then hand the implementation to forge_dispatch with a complete brief, acceptance criteria, a narrow verify_command, and cwd. Pass order_id as a fresh UUID (crypto.randomUUID()); if a dispatch's outcome is unclear, retry with the same order_id and identical arguments instead of dispatching again.",
    "Questions, explanations, discussion, and planning stay with you. Do it yourself instead of dispatching (starting an agent costs about a minute) when: the change is small (one file, a few dozen lines, or a config/text edit); it depends on this machine's live state (running services, local databases, credentials, browser or interactive debugging); or each step needs your judgement on fresh output. Dispatch multi-file implementation and test-writing work. When the user says to do it directly or to dispatch, follow that.",
    "Size each dispatch for one area (a module and its tests); split work you expect to take over 20-30 minutes into tasks run in order, or in parallel with isolation \"worktree\". Put what you already found in context: file paths with line ranges, signatures to change, the test helpers and an existing test to copy, so the agent edits instead of re-reading. Keep task + context under about 4,000 characters; put longer specs in a document and point to it.",
    "Track by running the wait_command forge_dispatch returns as a background shell command (or forge_wait), review with forge_result, verify, then report. Do not edit project files the agent is working on.",
  ];
  if (s.sdd.enabled) {
    lines.push(
      `SDD task documents are ON (workspace ${s.sdd.workspace}). Once a development task's plan is settled, save it with sdd_task before dispatching (goal, scope, plan, acceptance), and put the returned task.md path in the forge_dispatch brief. If the user asked only for a plan, save it and deliver without dispatching. When changing an existing task, read its task.md first and update the same document. Plain Q&A and discussion create no documents; skip the document when the user says so. Report a failed save; never claim a save that did not happen.`,
    );
  }
  return lines.join("\n");
}
