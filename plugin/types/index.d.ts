export type Permission = "sandbox" | "auto-review" | "sandbox+auto-review";

export type Settings = {
  enabled: boolean;
  executor: string;
  route?: { model: string };
  effort?: string;
  permission?: Permission;
  sdd: { enabled: boolean; workspace: string };
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

export type TaskRow = { id: string; title: string; orderStatus: string; worker: string; model: string; updatedAt: string };

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
