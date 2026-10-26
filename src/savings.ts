import fs from "node:fs";
import path from "node:path";
import { sumUsage } from "./forge.js";
import type { Task } from "./types.js";

/** One line per MCP tool call: what Claude sent and read back, in estimated tokens. */
export interface TrafficEntry {
  at: string;
  tool: string;
  tokens: number;
}

export interface SavingsPeriod {
  /** Tokens the executor spent on tasks created in the period. */
  delegatedTokens: number;
  /** Estimated tokens of Claude's MCP tool traffic in the period. */
  claudeTokens: number;
  /** (delegated - claude) / delegated as a rounded percentage; null when nothing was delegated. */
  savedPct: number | null;
}

export interface SavingsSummary {
  today: SavingsPeriod;
  week: SavingsPeriod;
  all: SavingsPeriod;
}

export function trafficFile(home: string): string {
  return path.join(home, "claude-traffic.jsonl");
}

/** Appends one ledger line; a failed write is dropped so it never fails the tool call. */
export function recordTraffic(home: string, tool: string, tokens: number): void {
  try {
    const entry: TrafficEntry = { at: new Date().toISOString(), tool, tokens };
    fs.appendFileSync(trafficFile(home), `${JSON.stringify(entry)}\n`);
  } catch {
    // the ledger is an estimate; losing a line is fine
  }
}

/** Ledger lines that parse; a missing file or corrupt lines read as nothing. */
export function readTraffic(home: string): TrafficEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(trafficFile(home), "utf8");
  } catch {
    return [];
  }
  const entries: TrafficEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Partial<TrafficEntry>;
      if (typeof e.at === "string" && typeof e.tokens === "number" && Number.isFinite(e.tokens) && !Number.isNaN(Date.parse(e.at))) {
        entries.push({ at: e.at, tool: String(e.tool ?? ""), tokens: e.tokens });
      }
    } catch {
      // skip a torn or hand-edited line
    }
  }
  return entries;
}

function period(delegatedTokens: number, claudeTokens: number): SavingsPeriod {
  return { delegatedTokens, claudeTokens, savedPct: delegatedTokens > 0 ? Math.round(((delegatedTokens - claudeTokens) / delegatedTokens) * 100) : null };
}

/** Delegated vs Claude-side tokens by local day: today, the last 7 days (today included), and all time. */
export function savingsSummary(home: string, tasks: Pick<Task, "createdAt" | "turns">[], now: Date): SavingsSummary {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime();
  const sums = { today: { delegated: 0, claude: 0 }, week: { delegated: 0, claude: 0 }, all: { delegated: 0, claude: 0 } };
  const add = (at: string, side: "delegated" | "claude", n: number) => {
    const t = Date.parse(at);
    sums.all[side] += n;
    if (t >= weekStart) sums.week[side] += n;
    if (t >= midnight) sums.today[side] += n;
  };
  for (const task of tasks) add(task.createdAt, "delegated", sumUsage(task.turns)?.totalTokens ?? 0);
  for (const e of readTraffic(home)) add(e.at, "claude", e.tokens);
  return {
    today: period(sums.today.delegated, sums.today.claude),
    week: period(sums.week.delegated, sums.week.claude),
    all: period(sums.all.delegated, sums.all.claude),
  };
}
