import { describe, expect, it } from "vitest";
import { assessProbe, probeWorker } from "./doctor.js";
import type { Worker, WorkerRunResult } from "./workers/worker.js";

function worker(opts: { createDelayMs?: number; firstEventDelayMs?: number; result?: WorkerRunResult; hang?: boolean }): Worker {
  const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms));
  return {
    name: "cursor",
    async create() {
      await wait(opts.createDelayMs);
      return {
        agentId: "a",
        async send() {
          let cancelled = false;
          return {
            id: "r",
            async *messages() {
              yield { type: "status", agent_id: "a", run_id: "r", status: "RUNNING" } as never;
              await wait(opts.firstEventDelayMs);
              while (opts.hang && !cancelled) await wait(10);
              if (!cancelled) yield { type: "assistant", agent_id: "a", run_id: "r", message: { role: "assistant", content: [{ type: "text", text: "OK" }] } } as never;
            },
            wait: async () => (cancelled ? { status: "cancelled" } : (opts.result ?? { status: "finished", result: "OK" })),
            cancel: async () => {
              cancelled = true;
            },
          };
        },
        close: async () => undefined,
      };
    },
    resume: async () => {
      throw new Error("unused");
    },
  } as unknown as Worker;
}

describe("doctor probe", () => {
  it("times agent creation and the first non-status event", async () => {
    const r = await probeWorker(worker({ createDelayMs: 30, firstEventDelayMs: 60 }), { model: "m", timeoutMs: 5000 });
    expect(r.status).toBe("finished");
    expect(r.createMs).toBeGreaterThanOrEqual(25);
    expect(r.firstEventMs).toBeGreaterThanOrEqual(50);
    expect(assessProbe(r)).toMatchObject({ ok: true, slow: false });
    expect(assessProbe(r).lines.at(-1)).toMatch(/healthy/);
  });

  it("reports a turn that never answers as a timeout", async () => {
    const r = await probeWorker(worker({ hang: true }), { model: "m", timeoutMs: 100 });
    expect(r.status).toBe("timeout");
    expect(assessProbe(r)).toMatchObject({ ok: false, slow: true });
  });

  it("reports an agent that cannot be created in time as a timeout", async () => {
    const r = await probeWorker(worker({ createDelayMs: 500 }), { model: "m", timeoutMs: 50 });
    expect(r.status).toBe("timeout");
  });

  it("flags slow first events and explains failures", () => {
    expect(assessProbe({ model: "m", createMs: 1000, firstEventMs: 90_000, totalMs: 95_000, status: "finished" })).toMatchObject({ ok: true, slow: true });
    expect(assessProbe({ model: "m", createMs: 1000, firstEventMs: 30_000, totalMs: 35_000, status: "finished" }).lines.at(-1)).toMatch(/Somewhat slow/);
    const failed = assessProbe({ model: "m", totalMs: 10, status: "error", error: "bad key" });
    expect(failed.ok).toBe(false);
    expect(failed.lines.join("\n")).toMatch(/bad key[\s\S]*agentforge login/);
  });
});
