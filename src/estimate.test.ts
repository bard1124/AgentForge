import { describe, expect, it } from "vitest";
import { DEFAULT_ESTIMATE_MS, elapsedMs, historyEstimate, parseWorkerEstimate } from "./estimate.js";
import type { Task } from "./types.js";

const MIN = 60_000;

function done(minutes: number, opts: { cwd?: string; model?: string; brief?: string; status?: Task["status"]; origin?: string } = {}): Task {
  return {
    cwd: opts.cwd ?? "/repo",
    model: opts.model ?? "m1",
    status: opts.status ?? "finished",
    activeMs: minutes * MIN,
    turns: [{ index: 1, prompt: opts.brief ?? "x".repeat(100), status: "finished", startedAt: "" }],
    ...(opts.origin ? { worktree: { origin: opts.origin } } : {}),
  } as Task;
}

const input = { cwd: "/repo", model: "m1", brief: "x".repeat(100) };

describe("historyEstimate", () => {
  it("falls back to a 10 minute default under 3 samples", () => {
    const e = historyEstimate([done(4), done(6)], input);
    expect(e).toMatchObject({ ms: DEFAULT_ESTIMATE_MS, source: "history", basis: "default" });
  });

  it("prefers same repo and model, then same repo, then all tasks", () => {
    const sameModel = [done(2), done(3), done(4)];
    const otherModel = [done(20, { model: "m2" }), done(30, { model: "m2" }), done(40, { model: "m2" })];
    const elsewhere = [done(50, { cwd: "/other" }), done(60, { cwd: "/other" }), done(70, { cwd: "/other" })];

    expect(historyEstimate([...sameModel, ...otherModel, ...elsewhere], input)).toMatchObject({ ms: 3 * MIN, basis: "median of 3 tasks in this repo with this model" });
    expect(historyEstimate([done(2), ...otherModel, ...elsewhere], input)).toMatchObject({ ms: 25 * MIN, basis: "median of 4 tasks in this repo" });
    expect(historyEstimate(elsewhere, input)).toMatchObject({ ms: 60 * MIN, basis: "median of 3 tasks overall" });
  });

  it("counts worktree tasks by their origin and only finished or accepted ones with active time", () => {
    const tasks = [done(5, { cwd: "/wt/a", origin: "/repo" }), done(5, { status: "accepted" }), done(5), done(90, { status: "error" }), done(0)];
    expect(historyEstimate(tasks, input)).toMatchObject({ ms: 5 * MIN, basis: "median of 3 tasks in this repo with this model" });
  });

  it("scales by brief length, clamped to 0.5..2, at least one minute", () => {
    const tasks = [done(10), done(10), done(10)];
    expect(historyEstimate(tasks, { ...input, brief: "x".repeat(150) }).ms).toBe(15 * MIN);
    expect(historyEstimate(tasks, { ...input, brief: "x".repeat(1000) }).ms).toBe(20 * MIN);
    expect(historyEstimate(tasks, { ...input, brief: "x" }).ms).toBe(5 * MIN);
    expect(historyEstimate([done(0.5), done(0.5), done(0.5)], { ...input, brief: "x" }).ms).toBe(MIN);
  });
});

describe("parseWorkerEstimate", () => {
  it("reads minutes, hours and hours with minutes, case-insensitively", () => {
    expect(parseWorkerEstimate("ETA: 7m\nLooking at the code")).toBe(7 * MIN);
    expect(parseWorkerEstimate("eta: 2h")).toBe(120 * MIN);
    expect(parseWorkerEstimate("Eta:1h30m")).toBe(90 * MIN);
    expect(parseWorkerEstimate("ETA: 1h 15m")).toBe(75 * MIN);
  });

  it("takes the first match and ignores missing or out-of-range values", () => {
    expect(parseWorkerEstimate("ETA: 5m, maybe ETA: 9m")).toBe(5 * MIN);
    expect(parseWorkerEstimate("No estimate here")).toBeUndefined();
    expect(parseWorkerEstimate("ETA: 0m")).toBeUndefined();
    expect(parseWorkerEstimate("ETA: 11h")).toBeUndefined();
    expect(parseWorkerEstimate("ETA: 601m")).toBeUndefined();
    expect(parseWorkerEstimate("ETA: 10h")).toBe(600 * MIN);
  });
});

describe("elapsedMs", () => {
  it("adds the running turn's time to finished turns", () => {
    const task = { activeMs: 4 * MIN, turns: [{ status: "running", startedAt: new Date(0).toISOString() }] } as Task;
    expect(elapsedMs(task, 2 * MIN)).toBe(6 * MIN);
    expect(elapsedMs({ ...task, turns: [] }, 2 * MIN)).toBe(4 * MIN);
  });
});
