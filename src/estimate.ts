import type { Task } from "./types.js";

export type Estimate = NonNullable<Task["estimate"]>;

export const DEFAULT_ESTIMATE_MS = 10 * 60_000;
const MIN_SAMPLES = 3;
const MINUTE = 60_000;

export interface EstimateInput {
  cwd: string;
  model: string;
  brief: string;
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

const originOf = (t: Task) => t.worktree?.origin ?? t.cwd;

/** Median active time of comparable finished tasks, scaled by how long this brief is next to theirs. */
export function historyEstimate(tasks: Task[], input: EstimateInput, at = new Date().toISOString()): Estimate {
  const done = tasks.filter((t) => (t.status === "finished" || t.status === "accepted") && t.activeMs > 0);
  const sameCwd = done.filter((t) => originOf(t) === input.cwd);
  const tiers: [Task[], string][] = [
    [sameCwd.filter((t) => t.model === input.model), "in this repo with this model"],
    [sameCwd, "in this repo"],
    [done, "overall"],
  ];
  const tier = tiers.find(([samples]) => samples.length >= MIN_SAMPLES);
  if (!tier) return { ms: DEFAULT_ESTIMATE_MS, source: "history", at, basis: "default" };
  const [samples, where] = tier;
  const lengths = samples.map((t) => t.turns[0]?.prompt.length ?? 0).filter((n) => n > 0);
  const typical = lengths.length ? median(lengths) : 0;
  const factor = typical && input.brief.length ? Math.min(2, Math.max(0.5, input.brief.length / typical)) : 1;
  const ms = Math.max(1, Math.round((median(samples.map((t) => t.activeMs)) * factor) / MINUTE)) * MINUTE;
  return { ms, source: "history", at, basis: `median of ${samples.length} tasks ${where}` };
}

const ETA = /\bETA:\s*(?:(\d+)\s*h(?:\s*(\d+)\s*m)?|(\d+)\s*m)\b/i;

/** The worker's own `ETA: 15m` / `ETA: 2h` / `ETA: 1h30m`, in ms; undefined when absent or outside 1m..10h. */
export function parseWorkerEstimate(text: string): number | undefined {
  const m = ETA.exec(text);
  if (!m) return undefined;
  const minutes = m[3] !== undefined ? Number(m[3]) : Number(m[1]) * 60 + Number(m[2] ?? 0);
  return minutes >= 1 && minutes <= 600 ? minutes * MINUTE : undefined;
}

/** Worker running time so far: finished turns plus the running one. */
export function elapsedMs(task: Task, now = Date.now()): number {
  const turn = task.turns.at(-1);
  const live = turn?.status === "running" ? Math.max(0, now - Date.parse(turn.startedAt)) : 0;
  return (task.activeMs ?? 0) + live;
}
