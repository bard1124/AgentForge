import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SDKMessage } from "@cursor/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { defaultDelegation, writeDelegation } from "./delegation.js";
import { Forge } from "./forge.js";
import { TaskStore } from "./store.js";
import type { SessionOptions, Worker, WorkerRun, WorkerRunResult, WorkerSession, WorkerUsage } from "./workers/worker.js";

type Script = (cwd: string, prompt: string) => { messages: SDKMessage[]; result: WorkerRunResult; holdUntil?: Promise<void> };

class FakeWorker implements Worker {
  readonly name = "cursor";
  prompts: string[] = [];
  resumed: string[] = [];
  sessionOpts: SessionOptions[] = [];
  billed?: WorkerUsage;
  constructor(private readonly script: Script) {}

  private session(agentId: string, opts: SessionOptions): WorkerSession {
    this.sessionOpts.push(opts);
    return {
      agentId,
      send: async (prompt) => {
        this.prompts.push(prompt);
        const { messages, result, holdUntil } = this.script(opts.cwd, prompt);
        let cancelled = false;
        let release!: () => void;
        const cancelledSignal = new Promise<void>((r) => (release = r));
        const run: WorkerRun = {
          id: `run-${this.prompts.length}`,
          async *messages() {
            for (const m of messages) yield m;
            if (holdUntil) await Promise.race([holdUntil, cancelledSignal]);
          },
          wait: async () => (cancelled ? { status: "cancelled" } : result),
          cancel: async () => {
            cancelled = true;
            release();
          },
        };
        return run;
      },
      close: async () => undefined,
    };
  }

  async create(opts: SessionOptions) {
    return this.session("agent-1", opts);
  }

  async resume(agentId: string, opts: SessionOptions) {
    this.resumed.push(agentId);
    return this.session(agentId, opts);
  }

  async usage(): Promise<WorkerUsage | undefined> {
    return this.billed;
  }
}

const base = { agent_id: "agent-1", run_id: "run" };
const say = (text: string): SDKMessage => ({ type: "assistant", ...base, message: { role: "assistant", content: [{ type: "text", text }] } });
const tool = (call_id: string, status: "running" | "completed", args: unknown): SDKMessage => ({ type: "tool_call", ...base, call_id, name: "edit", status, args });

let home: string;
let repo: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cf-home-"));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "cf-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  fs.writeFileSync(path.join(repo, "dirty.txt"), "x\n");
  git("add", ".");
  git("commit", "-qm", "init");
  fs.writeFileSync(path.join(repo, "dirty.txt"), "already dirty\n");
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

function makeForge(worker: Worker, overrides: Partial<ReturnType<typeof loadConfig>> = {}) {
  const config = { ...loadConfig({}), home, mcpConfigPath: path.join(home, "mcp.json"), ...overrides };
  return new Forge(config, new TaskStore(home), { cursor: worker });
}

const usage = (total: number) => ({ inputTokens: total - 10, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0, totalTokens: total });

describe("Forge", () => {
  it("dispatches, records steps, reports changes, and accepts after one rework round", async () => {
    let round = 0;
    const worker = new FakeWorker((cwd) => {
      round += 1;
      fs.writeFileSync(path.join(cwd, "a.txt"), round === 1 ? "broken\n" : "fixed\n");
      fs.mkdirSync(path.join(cwd, "lib"), { recursive: true });
      fs.writeFileSync(path.join(cwd, "lib", "new.txt"), "brand new\n");
      return {
        messages: [say("Editing "), say("a.txt"), tool("c1", "running", { path: "a.txt" }), tool("c1", "completed", { path: "a.txt" })],
        result: { status: "finished", result: `report ${round}` },
      };
    });
    const forge = makeForge(worker);

    const { task, warnings } = await forge.dispatch({ task: "fix a.txt", cwd: repo, verifyCommand: `node -e "process.exit(require('fs').readFileSync('a.txt', 'utf8').includes('fixed') ? 0 : 1)"` });
    expect(warnings.join()).toMatch(/1 modified file/);
    expect(worker.prompts[0]).toContain("fix a.txt");
    expect(worker.prompts[0]).toContain("readFileSync('a.txt'");

    expect(await forge.wait(task.id, 5)).toBe(true);
    const status = forge.status(task.id);
    expect(status.status).toBe("finished");
    expect(status.steps.map((s) => s.text)).toEqual(["Editing a.txt", "edit a.txt"]);
    expect(status.steps[1]?.toolStatus).toBe("completed");

    const result = await forge.result(task.id, { includeDiff: true });
    expect(result.finalReport).toBe("report 1");
    expect(result.changes.files).toEqual(
      expect.arrayContaining([
        { status: "M", path: "a.txt", preExisting: false },
        { status: "M", path: "dirty.txt", preExisting: true },
        { status: "??", path: "lib/new.txt", preExisting: false },
      ]),
    );
    expect(result.diff).toContain("+broken");
    expect(result.diff).toContain("+brand new");
    expect(result.diff).not.toContain("dirty");

    const first = await forge.accept(task.id, { feedback: "keep it simple" });
    expect(first.action).toBe("rework");
    expect(worker.prompts[1]).toContain("readFileSync('a.txt'");
    expect(worker.prompts[1]).toContain("keep it simple");

    await forge.wait(task.id, 5);
    const second = await forge.accept(task.id, {});
    expect(second.action).toBe("accepted");
    expect(forge.get(task.id).status).toBe("accepted");
    expect(forge.get(task.id).verifications.map((v) => v.passed)).toEqual([false, true]);
  });

  it("tracks changes in a repository that has no commits yet", async () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "cf-fresh-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: fresh });
      const worker = new FakeWorker((cwd) => {
        fs.writeFileSync(path.join(cwd, "new.txt"), "hello\n");
        return { messages: [], result: { status: "finished", result: "ok" } };
      });
      const forge = makeForge(worker);
      const { task, warnings } = await forge.dispatch({ task: "t", cwd: fresh });
      expect(warnings).toEqual([]);
      await forge.wait(task.id, 5);
      const result = await forge.result(task.id, { includeDiff: true });
      expect(result.changes.files).toEqual([{ status: "??", path: "new.txt", preExisting: false }]);
      expect(result.diff).toContain("+hello");
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("rejects once the rework budget is spent", async () => {
    const worker = new FakeWorker(() => ({ messages: [], result: { status: "finished", result: "done" } }));
    const forge = makeForge(worker);
    const { task } = await forge.dispatch({ task: "t", cwd: repo, verifyCommand: "exit 1", maxRework: 1 });
    await forge.wait(task.id, 5);
    expect((await forge.accept(task.id, {})).action).toBe("rework");
    await forge.wait(task.id, 5);
    expect((await forge.accept(task.id, {})).action).toBe("rejected");
  });

  it("queues follow-ups sent mid-turn and runs them on the same agent", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const worker = new FakeWorker((_cwd, prompt) => ({
      messages: [say(prompt.slice(0, 10))],
      result: { status: "finished", result: prompt },
      holdUntil: worker.prompts.length === 1 ? gate : undefined,
    }));
    const forge = makeForge(worker);
    const { task } = await forge.dispatch({ task: "long job", cwd: repo });

    const running = forge.status(task.id);
    expect(running.idleSec).toBeGreaterThanOrEqual(0);
    expect(running.hint).toMatch(/busy/);
    forge.get(task.id).lastEventAt = new Date(Date.now() - 300_000).toISOString();
    const stalled = forge.status(task.id);
    expect(stalled.idleSec).toBeGreaterThanOrEqual(300);
    expect(stalled.hint).toMatch(/emitted nothing for 30\ds/);

    expect(await forge.followup(task.id, "also do X")).toBe("queued");
    expect(forge.status(task.id).pendingFollowups).toBe(1);
    release();
    await forge.wait(task.id, 5);

    expect(forge.status(task.id).idleSec).toBeUndefined();
    expect(worker.prompts.at(-1)).toBe("also do X");
    expect(forge.get(task.id).turns).toHaveLength(2);
    expect(forge.get(task.id).status).toBe("finished");
  });

  it("flags transient turn failures as retryable and retries the same prompt on the same agent", async () => {
    let attempts = 0;
    const worker = new FakeWorker(() => {
      attempts += 1;
      return attempts === 1
        ? { messages: [], result: { status: "error", error: "[unknown] Failed to connect to API key exchange endpoint: fetch failed" } }
        : { messages: [], result: { status: "finished", result: "ok" } };
    });
    const forge = makeForge(worker);
    const { task } = await forge.dispatch({ task: "do it", cwd: repo });
    await forge.wait(task.id, 5);

    const failed = forge.status(task.id);
    expect(failed.status).toBe("error");
    expect(failed.lastError?.retryable).toBe(true);
    expect(failed.hint).toMatch(/forge_retry/);

    await forge.retry(task.id);
    await forge.wait(task.id, 5);
    expect(worker.prompts).toHaveLength(2);
    expect(worker.prompts[1]).toBe(worker.prompts[0]);
    expect(worker.resumed).toEqual(["agent-1"]);
    expect(forge.status(task.id).status).toBe("finished");
    expect(forge.status(task.id).lastError).toBeUndefined();
    await expect(forge.retry(task.id)).rejects.toThrow(/no failed turn/);
  });

  it("stops recommending retries after one failed retry", async () => {
    const worker = new FakeWorker(() => ({ messages: [], result: { status: "error", error: "fetch failed" } }));
    const forge = makeForge(worker);
    const { task } = await forge.dispatch({ task: "do it", cwd: repo });
    await forge.wait(task.id, 5);
    expect(forge.status(task.id).lastError?.retryable).toBe(true);
    await forge.retry(task.id);
    await forge.wait(task.id, 5);
    const status = forge.status(task.id);
    expect(status.lastError?.retryable).toBe(false);
    expect(status.hint).toMatch(/Stop retrying/);
  });

  it("times out a worker that never starts and lets retry reuse the in-flight agent", async () => {
    class SlowWorker extends FakeWorker {
      creates = 0;
      release!: () => void;
      private readonly gate = new Promise<void>((r) => (this.release = r));
      override async create(opts: SessionOptions) {
        this.creates += 1;
        await this.gate;
        return super.create(opts);
      }
    }
    const worker = new SlowWorker(() => ({ messages: [], result: { status: "finished", result: "ok" } }));
    const forge = makeForge(worker, { startTimeoutMs: 50 });

    const error = await forge.dispatch({ task: "do it", cwd: repo }).catch((e: Error) => e);
    expect(error.message).toMatch(/did not start within 0s \(timed out creating the agent\).*forge_retry/);
    const id = error.message.match(/cf-\d{8}-[a-z0-9]+/)![0];
    expect(forge.status(id).lastError?.retryable).toBe(true);

    worker.release();
    await forge.retry(id);
    await forge.wait(id, 5);
    expect(forge.status(id).status).toBe("finished");
    expect(worker.creates).toBe(1);
    expect(worker.prompts).toEqual([expect.stringContaining("do it")]);
  });

  it("does not mark logic failures as retryable", async () => {
    const worker = new FakeWorker(() => ({ messages: [], result: { status: "error", error: "Model refused: unsupported tool" } }));
    const forge = makeForge(worker);
    const { task } = await forge.dispatch({ task: "do it", cwd: repo });
    await forge.wait(task.id, 5);
    expect(forge.status(task.id).lastError).toEqual({ message: "Model refused: unsupported tool", retryable: false });
    expect(forge.status(task.id).hint).toMatch(/Do not blindly retry/);
  });

  it("refuses new turns once the turn budget is used", async () => {
    const worker = new FakeWorker(() => ({ messages: [], result: { status: "finished", result: "ok" } }));
    const forge = makeForge(worker);
    const { task } = await forge.dispatch({ task: "t", cwd: repo, maxTurns: 2 });
    await forge.wait(task.id, 5);
    await forge.followup(task.id, "second");
    await forge.wait(task.id, 5);

    const status = forge.status(task.id);
    expect(status.budget).toMatchObject({ turns: "2/2", exhausted: "turns" });
    expect(status.hint).toMatch(/turns budget is used up/);
    await expect(forge.followup(task.id, "third")).rejects.toThrow(/turn budget \(2\/2\)/);
    expect(worker.prompts).toHaveLength(2);
  });

  it("cancels a turn that runs past the time budget", async () => {
    const worker = new FakeWorker(() => ({ messages: [], result: { status: "finished" }, holdUntil: new Promise(() => undefined) }));
    const forge = makeForge(worker);
    const { task } = await forge.dispatch({ task: "t", cwd: repo, maxMinutes: 0.002 });
    expect(await forge.wait(task.id, 5)).toBe(true);

    const status = forge.status(task.id);
    expect(status.status).toBe("error");
    expect(status.lastError).toMatchObject({ retryable: false });
    expect(status.lastError?.message).toMatch(/time budget/);
    expect(status.budget.exhausted).toBe("time");
    await expect(forge.followup(task.id, "more")).rejects.toThrow(/time budget/);
  });

  it("sums per-turn token usage and prefers billed totals in results", async () => {
    const worker = new FakeWorker(() => ({ messages: [], result: { status: "finished", result: "ok", usage: usage(100) } }));
    const forge = makeForge(worker);
    const { task } = await forge.dispatch({ task: "t", cwd: repo });
    await forge.wait(task.id, 5);
    await forge.followup(task.id, "again");
    await forge.wait(task.id, 5);

    expect(forge.status(task.id).usage).toEqual({ inputTokens: 180, outputTokens: 20, cacheReadTokens: 10, totalTokens: 200 });
    expect((await forge.result(task.id)).usage?.totalTokens).toBe(200);

    worker.billed = { usage: usage(250), chargedCents: 12.3456 };
    expect((await forge.result(task.id)).usage).toMatchObject({ totalTokens: 250, chargedUsd: 0.12 });
  });

  it("passes model params and named MCP servers (with ${VAR} expansion) to every session", async () => {
    fs.writeFileSync(
      path.join(home, "mcp.json"),
      JSON.stringify({ mcpServers: { jira: { url: "https://jira/mcp", headers: { Authorization: "Bearer ${CF_TEST_TOKEN}" } }, other: { command: "x" } } }),
    );
    process.env.CF_TEST_TOKEN = "s3cret";
    try {
      const worker = new FakeWorker(() => ({ messages: [], result: { status: "finished", result: "ok" } }));
      const forge = makeForge(worker);
      const { task } = await forge.dispatch({ task: "t", cwd: repo, mcpServers: ["jira"], modelParams: [{ id: "reasoning", value: "high" }] });
      await forge.wait(task.id, 5);

      const expected = { jira: { url: "https://jira/mcp", headers: { Authorization: "Bearer s3cret" } } };
      expect(worker.sessionOpts[0]).toMatchObject({ modelParams: [{ id: "reasoning", value: "high" }], mcpServers: expected });
      expect(fs.readFileSync(path.join(home, "tasks", `${task.id}.json`), "utf8")).not.toContain("s3cret");

      const resumed = makeForge(worker);
      await resumed.followup(task.id, "after restart");
      await resumed.wait(task.id, 5);
      expect(worker.sessionOpts.at(-1)?.mcpServers).toEqual(expected);

      await expect(forge.dispatch({ task: "t", cwd: repo, mcpServers: ["nope"] })).rejects.toThrow(/Unknown MCP server\(s\): nope.*jira, other/);
      expect(forge.capabilities().mcpServers).toEqual(["jira", "other"]);
    } finally {
      delete process.env.CF_TEST_TOKEN;
    }
  });

  it("rejects unknown workers and lists the available ones", async () => {
    const forge = makeForge(new FakeWorker(() => ({ messages: [], result: { status: "finished" } })));
    await expect(forge.dispatch({ task: "t", cwd: repo, worker: "codex" })).rejects.toThrow(/Unknown worker "codex". Available: cursor/);
  });

  it("marks tasks from a dead server as interrupted and resumes the agent on follow-up", async () => {
    const store = new TaskStore(home);
    const worker = new FakeWorker(() => ({ messages: [], result: { status: "finished", result: "resumed" } }));
    const first = makeForge(worker);
    const { task } = await first.dispatch({ task: "t", cwd: repo });
    await first.wait(task.id, 5);

    const orphan = store.get(task.id)!;
    orphan.status = "running";
    orphan.ownerPid = 999_999;
    orphan.turns.at(-1)!.status = "running";
    store.save(orphan);

    const second = makeForge(worker);
    expect(second.get(task.id).status).toBe("interrupted");
    expect(await second.followup(task.id, "continue")).toBe("started");
    await second.wait(task.id, 5);
    expect(worker.resumed).toEqual(["agent-1"]);
    expect(second.get(task.id).status).toBe("finished");
  });
});

describe("orders and the board", () => {
  const finished = () => ({ messages: [], result: { status: "finished" as const, result: "ok" } });
  const ORDER = "7d2615b6-a00f-42cb-8261-39900ec7c177";

  it("makes dispatch idempotent per order_id and refuses reuse with other arguments", async () => {
    const worker = new FakeWorker(finished);
    const forge = makeForge(worker);
    const [a, b] = await Promise.all([
      forge.dispatch({ orderId: ORDER, task: "do it", cwd: repo }),
      forge.dispatch({ orderId: ORDER, task: "do it", cwd: repo }),
    ]);
    expect(b.task.id).toBe(a.task.id);
    expect(worker.prompts).toHaveLength(1);
    const again = await forge.dispatch({ orderId: ORDER, task: "do it", cwd: repo });
    expect(again).toMatchObject({ reused: true });
    expect(again.task.id).toBe(a.task.id);
    await expect(forge.dispatch({ orderId: ORDER, task: "something else", cwd: repo })).rejects.toThrow(/different arguments/);
    await expect(forge.dispatch({ orderId: "my-task", task: "x", cwd: repo })).rejects.toThrow(/real UUID/);
    expect(forge.findOrder(ORDER)?.id).toBe(a.task.id);
  });

  it("maps internal statuses to order statuses", async () => {
    const forge = makeForge(new FakeWorker(finished));
    const { task } = await forge.dispatch({ task: "x", cwd: repo });
    await forge.wait(task.id, 5);
    expect(forge.status(task.id).orderStatus).toBe("completed");
    const store = new TaskStore(home);
    const record = store.get(task.id)!;
    record.status = "running";
    record.ownerPid = 999_999_999;
    store.save(record);
    expect(makeForge(new FakeWorker(finished)).status(task.id).orderStatus).toBe("uncertain");
  });

  it("applies the board's model, effort, and permission to new tasks only", async () => {
    const worker = Object.assign(new FakeWorker(finished), {
      permissions: ["sandbox"] as const,
      defaultModel: "composer-2.5",
      models: async () => [{ id: "claude-opus-5-5", effortParam: "effort", efforts: ["low", "high"] }],
    });
    const forge = makeForge(worker);
    writeDelegation(home, { ...defaultDelegation(home), enabled: true, route: { model: "claude-opus-5-5" }, effort: "high", permission: "sandbox" });
    const { task } = await forge.dispatch({ task: "x", cwd: repo });
    expect(task).toMatchObject({ model: "claude-opus-5-5", modelParams: [{ id: "effort", value: "high" }], permission: "sandbox" });
    expect(worker.sessionOpts[0]).toMatchObject({ permission: "sandbox" });

    const explicit = await forge.dispatch({ task: "y", cwd: repo, model: "composer-2.5" });
    expect(explicit.task.model).toBe("composer-2.5");
    expect(explicit.task.modelParams).toBeUndefined();

    writeDelegation(home, { ...defaultDelegation(home), permission: "auto-review" });
    await expect(forge.dispatch({ task: "z", cwd: repo })).rejects.toThrow(/Blocked: cursor cannot apply the "auto-review"/);
  });
});
