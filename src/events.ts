import type { SDKMessage } from "@cursor/sdk";
import type { Step, Task } from "./types.js";

const ARG_KEYS = ["command", "path", "file_path", "target_file", "targetFile", "pattern", "globPattern", "glob", "query", "url", "description", "text"];

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Picks the most informative argument of a tool call for a one-line summary. */
export function summarizeArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args !== "object") return truncate(String(args), 400);
  const record = args as Record<string, unknown>;
  for (const key of ARG_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value) return truncate(value, 400);
  }
  return truncate(JSON.stringify(args), 400);
}

/**
 * Folds the SDK message stream into a compact step log: consecutive assistant
 * text is merged, and each tool call is one step updated in place on completion.
 */
export class StepRecorder {
  private readonly byCallId = new Map<string, Step>();
  private streamStep: Step | undefined;
  private streamBuffer = "";

  constructor(
    private readonly task: Task,
    private readonly turn: number,
    private readonly maxSteps: number,
  ) {}

  private get steps(): Step[] {
    return this.task.steps;
  }

  push(step: Omit<Step, "seq" | "at" | "turn">): void {
    this.task.stepSeq += 1;
    this.steps.push({ seq: this.task.stepSeq, at: new Date().toISOString(), turn: this.turn, ...step });
    if (this.steps.length > this.maxSteps) this.steps.splice(0, this.steps.length - this.maxSteps);
  }

  /** Streamed text arrives in chunks; extend the last step while the same stream continues. */
  private appendStreamed(kind: "say" | "think", text: string, max: number): void {
    const last = this.steps.at(-1);
    if (last && last === this.streamStep && last.kind === kind) {
      this.streamBuffer += text;
      last.text = truncate(this.streamBuffer, max);
      return;
    }
    this.streamBuffer = text;
    this.push({ kind, text: truncate(text, max) });
    this.streamStep = this.steps.at(-1);
  }

  record(message: SDKMessage): boolean {
    switch (message.type) {
      case "assistant": {
        const text = message.message.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("");
        if (!text) return false;
        this.appendStreamed("say", text, 400);
        return true;
      }
      case "thinking":
        if (!message.text) return false;
        this.appendStreamed("think", message.text, 240);
        return true;
      case "tool_call": {
        const existing = this.byCallId.get(message.call_id);
        if (existing) {
          existing.toolStatus = message.status;
          if (message.status === "error") existing.text = `${existing.text} [failed]`;
          return true;
        }
        this.push({
          kind: "tool",
          tool: message.name,
          callId: message.call_id,
          toolStatus: message.status,
          text: `${message.name} ${summarizeArgs(message.args)}`.trim(),
        });
        const step = this.steps.at(-1);
        if (step) this.byCallId.set(message.call_id, step);
        return true;
      }
      case "status":
        this.push({ kind: "status", text: `${message.status}${message.message ? `: ${message.message}` : ""}` });
        return true;
      case "task":
        if (!message.text && !message.status) return false;
        this.push({ kind: "task", text: truncate([message.status, message.text].filter(Boolean).join(": "), 240) });
        return true;
      default:
        return false;
    }
  }
}
