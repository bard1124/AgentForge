import type { SDKMessage } from "@cursor/sdk";
import { describe, expect, it } from "vitest";
import { StepRecorder, summarizeArgs, truncate } from "./events.js";
import { parsePorcelain } from "./git.js";
import { StepTail } from "./printer.js";
import type { Step, Task } from "./types.js";

describe("StepRecorder", () => {
  it("merges streamed thinking and text into separate steps", () => {
    const task = { steps: [], stepSeq: 0 } as unknown as Task;
    const rec = new StepRecorder(task, 1, 100);
    const ids = { agent_id: "a", run_id: "r" };
    const think = (text: string): SDKMessage => ({ type: "thinking", ...ids, text });
    const say = (text: string): SDKMessage => ({ type: "assistant", ...ids, message: { role: "assistant", content: [{ type: "text", text }] } });

    for (const m of [think("Tracing "), think("the math"), think(""), say("Done "), say("now"), think("Next")]) rec.record(m);
    expect(task.steps.map((s) => [s.kind, s.text])).toEqual([
      ["think", "Tracing the math"],
      ["say", "Done now"],
      ["think", "Next"],
    ]);
  });
});

describe("StepTail", () => {
  const step = (seq: number, kind: Step["kind"], toolStatus?: Step["toolStatus"]): Step => ({ seq, at: "", turn: 1, kind, text: `${seq}`, toolStatus });

  it("holds the streaming tail and running tools until they settle", () => {
    const tail = new StepTail();
    const steps = [step(1, "status"), step(2, "think"), step(3, "tool", "running"), step(4, "say")];
    expect(tail.take(steps, true).map((s) => s.seq)).toEqual([1, 2]);
    steps[2]!.toolStatus = "completed";
    expect(tail.take(steps, true).map((s) => s.seq)).toEqual([3]);
    expect(tail.take(steps, false).map((s) => s.seq)).toEqual([4]);
    expect(tail.take(steps, false)).toEqual([]);
  });
});

describe("summarizeArgs", () => {
  it("prefers well-known fields", () => {
    expect(summarizeArgs({ command: "npm test", timeout: 5 })).toBe("npm test");
    expect(summarizeArgs({ path: "src/a.ts", contents: "..." })).toBe("src/a.ts");
  });

  it("falls back to truncated JSON", () => {
    expect(summarizeArgs({ x: 1 })).toBe('{"x":1}');
    expect(summarizeArgs({ x: "y".repeat(500) }).length).toBe(160);
  });
});

describe("truncate", () => {
  it("collapses whitespace", () => {
    expect(truncate("a\n\n b", 10)).toBe("a b");
  });
});

describe("parsePorcelain", () => {
  it("handles renames and untracked files", () => {
    expect(parsePorcelain("R  new.ts\0old.ts\0?? x.md\0 M y.ts\0")).toEqual([
      { status: "R", path: "new.ts" },
      { status: "??", path: "x.md" },
      { status: "M", path: "y.ts" },
    ]);
  });
});
