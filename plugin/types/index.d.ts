export type Permission = "sandbox" | "auto-review" | "sandbox+auto-review";

/** Board sections that can be collapsed; Dispatch has no toggle. */
export type SectionId = "savings" | "executor" | "sdd" | "tasks" | "update";

export type Settings = {
  enabled: boolean;
  executor: string;
  route?: { model: string };
  effort?: string;
  permission?: Permission;
  sdd: { enabled: boolean; workspace: string };
  board?: { collapsed: SectionId[] };
  updatedAt?: string;
};

export type ModelEntry = { id: string; displayName?: string; effortParam?: string; efforts: string[] };

export type ExecutorRuntime = {
  online: boolean | null;
  defaultModel: string;
  permissions: Permission[];
  models?: ModelEntry[];
  error?: string;
};

export type TaskRow = {
  id: string;
  title: string;
  status: string;
  orderStatus: string;
  worker: string;
  model: string;
  updatedAt: string;
  estimateMs?: number;
  estimateSource?: "history" | "worker";
  estimateBasis?: string;
  /** Worker running time, the running turn included. */
  elapsedMs?: number;
};

export type UpdateView = {
  state: string;
  message: string;
  busy?: "check" | "apply";
  local?: string;
  remote?: string;
  behind?: number;
  checkedAt?: string;
  apply?: { ok: boolean; stage?: string; error?: string };
  running?: string[];
  backendVersion?: string;
  installedVersion?: string;
  backendCommit?: string;
  installedCommit?: string;
};

export type SddProject = { id: string; name: string; tasks: number };
export type SddTask = { id: string; title: string; updatedAt: string; path: string; revision: string };

export type SddView = {
  dir: string;
  enabled: boolean;
  corrupt?: string;
  projects: SddProject[];
  projectId?: string;
  tasks: SddTask[];
  taskId?: string;
  doc?: { title: string; path: string; revision: string; content: string };
  draft?: string;
  conflict?: string;
};

export type SavingsPeriod = { delegatedTokens: number; claudeTokens: number; savedPct: number | null };
export type SavingsView = { today: SavingsPeriod; week: SavingsPeriod; all: SavingsPeriod };

export type BoardModel = {
  loaded: boolean;
  error?: string;
  notice?: string;
  settings?: Settings;
  corrupt?: string;
  executors: string[];
  hook?: { state: "active" | "pending"; detail: string; lastRunAt?: string };
  hooksDisabled?: boolean;
  backend?: { pid: number; version: string };
  running: number;
  runtime: Record<string, ExecutorRuntime | { loading: true }>;
  tasks: TaskRow[];
  /** First task row shown in the card's window. */
  taskOffset: number;
  /** A task id, or "clear", whose delete waits for Confirm. */
  confirm?: string;
  /** A task id, or "clear", whose action is in flight. */
  taskBusy?: string;
  savings?: SavingsView;
  sddOpen: boolean;
  sdd?: SddView;
  updateOpen: boolean;
  update?: UpdateView;
};

declare module "claude-code" {
  interface PluginState {
    agentforge: { board: Shaped<BoardModel> };
  }
}
