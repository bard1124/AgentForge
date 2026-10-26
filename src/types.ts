import type { ModelParameterValue, TokenUsage } from "@cursor/sdk";
import type { Permission } from "./delegation.js";

/** Lifecycle as reported to Claude and the board, derived from the internal status. */
export type OrderStatus = "queued" | "dispatching" | "executing" | "paused" | "completed" | "failed" | "blocked" | "cancelled" | "uncertain";

export type TaskStatus =
  | "queued"
  | "running"
  /** Stopped from the board with its agent kept; resume re-sends the stopped turn. Not running. */
  | "paused"
  | "finished"
  | "error"
  | "cancelled"
  | "interrupted"
  | "accepted"
  | "rejected";

export type StepKind = "say" | "think" | "tool" | "status" | "task" | "user" | "verify" | "error";

export interface Step {
  /** Monotonic per task; poll with `since` to get only new steps. */
  seq: number;
  at: string;
  kind: StepKind;
  /** One-line human readable summary. */
  text: string;
  tool?: string;
  callId?: string;
  toolStatus?: "running" | "completed" | "error";
  turn: number;
}

export interface Turn {
  index: number;
  prompt: string;
  runId?: string;
  status: "running" | "paused" | "finished" | "error" | "cancelled" | "interrupted";
  startedAt: string;
  endedAt?: string;
  result?: string;
  error?: string;
  durationMs?: number;
  usage?: TokenUsage;
}

export interface GitBaseline {
  isRepo: boolean;
  head?: string;
  branch?: string;
  /** Paths that were already dirty before the task started. */
  dirty: string[];
}

export interface Verification {
  at: string;
  command: string;
  exitCode: number | null;
  passed: boolean;
  durationMs: number;
  outputTail: string;
}

export interface Task {
  id: string;
  /** Caller-chosen UUID that makes dispatch idempotent. */
  orderId?: string;
  /** Hash of the dispatch arguments, so a retry with the same order_id must match. */
  orderHash?: string;
  title: string;
  cwd: string;
  worker: string;
  model: string;
  modelParams?: ModelParameterValue[];
  /** New-session permission chosen at dispatch; kept for every resume of this task's agent. */
  permission?: Permission;
  /** Names from the MCP config file; resolved again on every session start. */
  mcpServers?: string[];
  acceptance?: string;
  verifyCommand?: string;
  agentId?: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  /** PID of the AgentForge server driving this task; other servers treat it as read-only while alive. */
  ownerPid?: number;
  turns: Turn[];
  steps: Step[];
  stepSeq: number;
  /** Last time the worker emitted any event, including ones not kept as steps. */
  lastEventAt?: string;
  /** Messages queued while a turn was running and steering was unavailable. */
  pending: string[];
  baseline: GitBaseline;
  verifications: Verification[];
  reworkCount: number;
  maxRework: number;
  maxTurns: number;
  maxTaskMs: number;
  /** Worker running time summed over finished turns. */
  activeMs: number;
}

export interface ChangeSummary {
  isRepo: boolean;
  baseHead?: string;
  currentHead?: string;
  commits: string[];
  diffStat: string;
  files: { status: string; path: string; preExisting: boolean }[];
}
