import { Agent, type AgentOptions, Cursor, type Run, type SDKAgent } from "@cursor/sdk";
import type { ForgeConfig } from "../config.js";
import type { ModelEntry, Permission } from "../delegation.js";
import type { ConversationInfo, SessionOptions, Worker, WorkerRun, WorkerRunResult, WorkerSession, WorkerUsage } from "./worker.js";

class CursorRun implements WorkerRun {
  constructor(private readonly run: Run) {}

  get id(): string {
    return this.run.id;
  }

  messages() {
    return this.run.stream();
  }

  async wait(): Promise<WorkerRunResult> {
    const result = await this.run.wait();
    return {
      status: result.status,
      result: result.result,
      error: result.error?.message,
      durationMs: result.durationMs,
      usage: result.usage,
    };
  }

  async cancel(): Promise<void> {
    if (this.run.supports("cancel")) await this.run.cancel();
  }

  async steer(text: string): Promise<boolean> {
    if (!this.run.steer) return false;
    return (await this.run.steer(text)) === "complete_delivered";
  }
}

class CursorSession implements WorkerSession {
  constructor(private readonly agent: SDKAgent) {}

  get agentId(): string {
    return this.agent.agentId;
  }

  async send(prompt: string): Promise<WorkerRun> {
    return new CursorRun(await this.agent.send(prompt));
  }

  async close(): Promise<void> {
    await this.agent[Symbol.asyncDispose]();
  }
}

const EFFORT_PARAMS = ["effort", "reasoning_effort", "reasoning"];
const CATALOG_TTL_MS = 5 * 60_000;

export class CursorWorker implements Worker {
  readonly name = "cursor";
  readonly description = "Local Cursor agent via @cursor/sdk; edits files and runs commands in cwd.";
  readonly permissions: readonly Permission[] = ["sandbox", "auto-review", "sandbox+auto-review"];
  private catalog?: { at: number; models: ModelEntry[] };
  private loading?: Promise<ModelEntry[]>;

  constructor(private readonly config: ForgeConfig) {}

  get defaultModel(): string {
    return this.config.model;
  }

  private options(opts: SessionOptions): AgentOptions {
    const params = opts.modelParams ?? this.config.modelParams;
    const sandbox = opts.permission === "sandbox" || opts.permission === "sandbox+auto-review";
    const autoReview = opts.permission === "auto-review" || opts.permission === "sandbox+auto-review" || this.config.autoReview;
    return {
      apiKey: this.config.apiKey,
      model: params.length ? { id: opts.model, params } : { id: opts.model },
      mcpServers: opts.mcpServers,
      local: {
        cwd: opts.cwd,
        settingSources: this.config.settingSources,
        autoReview,
        ...(sandbox ? { sandboxOptions: { enabled: true } } : {}),
      },
    };
  }

  /** The Cursor catalog call takes several seconds, so it is cached and refreshed in the background. */
  async models(): Promise<ModelEntry[]> {
    const fresh = this.catalog && Date.now() - this.catalog.at < CATALOG_TTL_MS;
    this.loading ??= Cursor.models
      .list({ apiKey: this.config.apiKey })
      .then((list) => {
        const models = list.map((m): ModelEntry => {
          const effort = m.parameters?.find((p) => EFFORT_PARAMS.includes(p.id));
          return { id: m.id, displayName: m.displayName, effortParam: effort?.id, efforts: effort?.values.map((v) => v.value) ?? [] };
        });
        this.catalog = { at: Date.now(), models };
        return models;
      })
      .finally(() => (this.loading = undefined));
    if (fresh) return this.catalog!.models;
    if (this.catalog) {
      this.loading.catch(() => undefined);
      return this.catalog.models;
    }
    return this.loading;
  }

  async conversations(options: { cwd?: string; limit?: number }): Promise<ConversationInfo[]> {
    const res = await Agent.list({ runtime: "local", cwd: options.cwd, limit: options.limit ?? 50 });
    return res.items.map((a) => ({
      id: a.agentId,
      name: a.name,
      summary: a.summary || undefined,
      status: a.status,
      archived: a.archived === true,
      cwd: a.runtime === "local" ? a.cwd : undefined,
      updatedAt: a.lastModified ? new Date(a.lastModified).toISOString() : undefined,
    }));
  }

  async archive(id: string, options: { cwd?: string }): Promise<void> {
    await Agent.archive(id, { cwd: options.cwd, apiKey: this.config.apiKey });
  }

  async unarchive(id: string, options: { cwd?: string }): Promise<void> {
    await Agent.unarchive(id, { cwd: options.cwd, apiKey: this.config.apiKey });
  }

  async create(opts: SessionOptions): Promise<WorkerSession> {
    return new CursorSession(await Agent.create(this.options(opts)));
  }

  async resume(agentId: string, opts: SessionOptions): Promise<WorkerSession> {
    return new CursorSession(await Agent.resume(agentId, this.options(opts)));
  }

  private billingUnavailable = false;

  async usage(agentId: string): Promise<WorkerUsage | undefined> {
    // Accounts without the usage API take ~10s to say so; ask once per process.
    if (this.billingUnavailable) return undefined;
    try {
      const res = await Agent.getUsage(agentId, { apiKey: this.config.apiKey });
      return { usage: res.usage, chargedCents: res.cost?.chargedCents };
    } catch (err) {
      if (/feature_unavailable|not available for your account/i.test((err as Error).message)) {
        this.billingUnavailable = true;
        return undefined;
      }
      throw err;
    }
  }
}
