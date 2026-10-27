import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findEditor, renderProgress } from "./progress.js";
import type { Task } from "./types.js";

const task = (over: Partial<Task> = {}): Task =>
  ({
    id: "cf-1",
    title: "Fix the login bug",
    cwd: "/repo",
    worker: "cursor",
    model: "m",
    status: "running",
    createdAt: "2026-10-27T01:00:00.000Z",
    updatedAt: "2026-10-27T01:00:30.000Z",
    turns: [{ index: 1, prompt: "p", status: "running", startedAt: "2026-10-27T01:00:00.000Z", runId: "r" }],
    steps: [
      { seq: 1, at: "2026-10-27T01:00:10.000Z", kind: "tool", text: "read src/a.ts", turn: 1 },
      { seq: 2, at: "2026-10-27T01:00:20.000Z", kind: "tool", text: "edit src/a.ts", turn: 1 },
    ],
    verifications: [],
    touched: ["src/a.ts"],
    ...over,
  }) as Task;

describe("renderProgress", () => {
  it("shows status, elapsed time, edited files and the newest step first", () => {
    const md = renderProgress(task(), Date.parse("2026-10-27T01:02:05.000Z"));
    expect(md).toContain("# Fix the login bug");
    expect(md).toContain("| Status | **executing** (running) |");
    expect(md).toContain("| Elapsed | 2m 5s |");
    expect(md).toContain("- `src/a.ts`");
    expect(md.indexOf("edit src/a.ts")).toBeLessThan(md.indexOf("read src/a.ts"));
    expect(md).not.toContain("## Worker report");
  });

  it("adds the error and the worker report once the turn ended", () => {
    const md = renderProgress(task({ status: "error", turns: [{ index: 1, prompt: "p", status: "error", startedAt: "2026-10-27T01:00:00.000Z", error: "boom", result: "Changed a.ts" }] }));
    expect(md).toContain("> **Error:** boom");
    expect(md).toContain("## Worker report\n\nChanged a.ts");
  });
});

describe("findEditor", () => {
  it("finds a command on PATH and returns nothing when it is missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-editor-"));
    const bin = path.join(dir, "myeditor");
    fs.writeFileSync(bin, "");
    expect(findEditor("myeditor", { PATH: dir })).toBe(bin);
    expect(findEditor("missing-editor", { PATH: dir })).toBeUndefined();
    expect(findEditor(bin, {})).toBe(bin);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
