import type { McpServerConfig, ModelParameterValue, SDKMessage, TokenUsage } from "@cursor/sdk";
import type { ForgeConfig } from "../config.js";
import type { ModelEntry, Permission } from "../delegation.js";

export interface WorkerRunResult {
  status: "finished" | "error" | "cancelled";
  result?: string;
  error?: string;
  durationMs?: number;
  usage?: TokenUsage;
}

export interface WorkerRun {
  readonly id: string;
  messages(): AsyncIterable<SDKMessage>;
  wait(): Promise<WorkerRunResult>;
  cancel(): Promise<void>;
  /** Injects a message into the running turn. Resolves false when the caller must send it as a follow-up instead. */
  steer?(text: string): Promise<boolean>;
}

export interface WorkerSession {
  readonly agentId: string;
  send(prompt: string): Promise<WorkerRun>;
  close(): Promise<void>;
}

export interface SessionOptions {
  cwd: string;
  model: string;
  modelParams?: ModelParameterValue[];
  mcpServers?: Record<string, McpServerConfig>;
  /** The task's permission, fixed when its agent was created; resumes pass the same value. */
  permission?: Permission;
}

export interface ConversationInfo {
  /** The worker's native conversation id (Cursor agent id). */
  id: string;
  name: string;
  summary?: string;
  status?: string;
  archived: boolean;
  cwd?: string;
  updatedAt?: string;
}

export interface WorkerUsage {
  usage: TokenUsage;
  /** Amount actually charged, in cents; absent until billing reports it. */
  chargedCents?: number;
}

/**
 * A coding agent that AgentForge can hand work to. Plugins are ES modules that
 * export `createWorker(config)` (default or named) returning this interface.
 */
export interface Worker {
  readonly name: string;
  readonly description?: string;
  /** Model used when neither the task nor the board fixes one. */
  readonly defaultModel?: string;
  /** New-session permissions `create` can apply; a task asking for another fails instead of starting. */
  readonly permissions?: readonly Permission[];
  create(options: SessionOptions): Promise<WorkerSession>;
  resume(agentId: string, options: SessionOptions): Promise<WorkerSession>;
  usage?(agentId: string, options: SessionOptions): Promise<WorkerUsage | undefined>;
  /** Model catalog; rejects when the worker backend cannot be reached. */
  models?(): Promise<ModelEntry[]>;
  /** Native conversations, for listing, archiving and restoring from Claude Code. */
  conversations?(options: { cwd?: string; limit?: number }): Promise<ConversationInfo[]>;
  archive?(id: string, options: { cwd?: string }): Promise<void>;
  unarchive?(id: string, options: { cwd?: string }): Promise<void>;
}

export type WorkerFactory = (config: ForgeConfig) => Worker | Promise<Worker>;
