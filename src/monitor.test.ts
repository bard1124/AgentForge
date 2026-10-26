import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fit, monitorSnapshot, monitorWeb, renderTerminal } from "./monitor.js";
import type { Task } from "./types.js";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cf-mon-"));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function task(id: string, over: Partial<Task>): Task {
  const at = "2026-10-23T10:00:00.000Z";
  return {
    id, title: id, cwd: "/w", worker: "cursor", model: "composer-2.5", status: "finished", createdAt: at, updatedAt: at,
    turns: [{ index: 0, prompt: "do it", status: "finished", startedAt: at, result: "done it" }],
    steps: [], stepSeq: 0, pending: [], baseline: { isRepo: false, dirty: [] }, verifications: [], reworkCount: 0, maxRework: 2,
    maxTurns: 5, maxTaskMs: 60_000, activeMs: 0, ...over,
  } as Task;
}

function write(...tasks: Task[]) {
  fs.mkdirSync(path.join(home, "tasks"), { recursive: true });
  for (const t of tasks) fs.writeFileSync(path.join(home, "tasks", `${t.id}.json`), JSON.stringify(t));
}

describe("monitor", () => {
  it("reads an empty home without creating anything", async () => {
    const bare = path.join(home, "missing");
    const s = await monitorSnapshot(bare);
    expect(s.summary.total).toBe(0);
    expect(s.backend.online).toBe(false);
    expect(fs.existsSync(bare)).toBe(false);
  });

  it("summarizes tasks by order status and groups agent conversations", async () => {
    write(
      task("cf-a", { agentId: "agent-1", createdAt: "2026-10-23T10:00:01.000Z" }),
      task("cf-b", { agentId: "agent-1", status: "running", createdAt: "2026-10-23T10:00:02.000Z", turns: [{ index: 0, prompt: "p", status: "running", startedAt: "2026-10-23T10:00:02.000Z", runId: "r" }] }),
      task("cf-c", { status: "error", createdAt: "2026-10-23T10:00:03.000Z", turns: [{ index: 0, prompt: "p", status: "error", startedAt: "2026-10-23T10:00:03.000Z", error: "boom" }] }),
    );
    fs.writeFileSync(path.join(home, "tasks", "cf-bad.json"), "{");
    const s = await monitorSnapshot(home, { now: Date.parse("2026-10-23T10:01:02.000Z") });
    expect(s.summary).toEqual({ total: 3, active: 1, completed: 1, problems: 1, cancelled: 0 });
    expect(s.tasks.map((t) => t.id)).toEqual(["cf-c", "cf-b", "cf-a"]);
    const running = s.tasks.find((t) => t.id === "cf-b")!;
    expect(running.orderStatus).toBe("executing");
    expect(running.elapsedMs).toBe(60_000);
    expect(running.stale).toBe(true);
    expect(s.tasks.find((t) => t.id === "cf-c")!.latest).toBe("boom");
    expect(s.agents).toEqual([expect.objectContaining({ id: "agent-1", tasks: 2, latestTask: "cf-b" })]);
    expect(s.warnings[0]).toMatch(/cf-bad unreadable/);

    const text = renderTerminal(s, { width: 100, height: 60 });
    expect(text).toMatch(/backend offline/);
    expect(text).toMatch(/Auto-dispatch OFF · cursor/);
    expect(text).toMatch(/need attention 1/);
    expect(text).toMatch(/cf-b\s+executing/);
  });

  it("fits wide characters to the display width", () => {
    expect(fit("看板任务", 5)).toBe("看板…");
    expect(fit("ab", 4)).toBe("ab  ");
  });

  it("serves a read-only page to local requests only", async () => {
    write(task("cf-a", {}));
    const web = await monitorWeb(home, { port: 0 });
    try {
      const page = await fetch(`${web.url}/`);
      expect(page.headers.get("content-security-policy")).toMatch(/script-src 'self'/);
      expect(await page.text()).toMatch(/read-only monitor/);
      const snap = (await (await fetch(`${web.url}/api/snapshot`)).json()) as { summary: { total: number } };
      expect(snap.summary.total).toBe(1);
      expect((await fetch(`${web.url}/api/snapshot`, { method: "POST" })).status).toBe(405);
      expect((await fetch(`${web.url}/api/snapshot`, { headers: { origin: "http://evil.example" } })).status).toBe(403);
    } finally {
      await web.close();
    }
  });
});
