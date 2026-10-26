import type { ResultView, StatusView } from "./forge.js";
import type { Step } from "./types.js";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint("2");
const red = paint("31");
const green = paint("32");
const yellow = paint("33");
const magenta = paint("35");
const cyan = paint("36");
const bold = paint("1");

const LABELS: Record<Step["kind"], (s: string) => string> = {
  say: cyan,
  think: dim,
  tool: yellow,
  status: magenta,
  task: magenta,
  user: green,
  verify: bold,
  error: red,
};

export function formatStep(step: Step): string {
  const time = dim(step.at.slice(11, 19));
  const label = LABELS[step.kind](step.kind.padEnd(6));
  let text = step.text;
  if (step.kind === "tool") {
    const mark = step.toolStatus === "error" ? red("x") : step.toolStatus === "completed" ? green("+") : yellow("~");
    text = `${mark} ${text}`;
  } else if (step.kind === "verify") {
    text = text.startsWith("PASS") ? green(text) : red(text);
  } else if (step.kind === "think") {
    text = dim(text);
  }
  return `${time} ${dim(`t${step.turn}`)} ${label} ${text}`;
}

const HOLD_MS = 5000;

/**
 * Releases steps for live printing in order, holding back ones that are still
 * changing (a running tool call, or the newest message/thought while it streams)
 * for up to HOLD_MS so lines are printed once, complete.
 */
export class StepTail {
  private lastSeq: number;
  private readonly heldSince = new Map<number, number>();

  constructor(since = 0) {
    this.lastSeq = since;
  }

  take(steps: Step[], active: boolean): Step[] {
    const pending = steps.filter((s) => s.seq > this.lastSeq);
    const out: Step[] = [];
    for (const [i, step] of pending.entries()) {
      const streaming = (step.kind === "say" || step.kind === "think") && i === pending.length - 1;
      const unsettled = active && (streaming || (step.kind === "tool" && step.toolStatus === "running"));
      if (unsettled) {
        const since = this.heldSince.get(step.seq) ?? Date.now();
        this.heldSince.set(step.seq, since);
        if (Date.now() - since < HOLD_MS) break;
      }
      out.push(step);
      this.lastSeq = step.seq;
      this.heldSince.delete(step.seq);
    }
    return out;
  }
}

export function formatStatusLine(s: StatusView): string {
  const parts = [`status=${s.status}`, `turns=${s.budget.turns}`, `active=${s.budget.activeMinutes}min`];
  if (s.idleSec !== undefined) parts.push(`idle=${s.idleSec}s`);
  if (s.usage) parts.push(`tokens=${s.usage.totalTokens}`);
  return dim(`-- ${parts.join("  ")}`);
}

export function formatResult(r: ResultView): string {
  const lines: string[] = [];
  const statusColor = r.status === "accepted" || r.status === "finished" ? green : r.status === "paused" ? yellow : red;
  lines.push("", bold(`== ${r.id}  ${r.title}`), `status: ${statusColor(r.status)}`);
  if (r.finalReport) lines.push("", bold("Report"), r.finalReport.trim());
  if (r.lastError && r.status !== "accepted" && r.status !== "finished") lines.push("", red(`Last error: ${r.lastError}`));
  if (r.changes.isRepo) {
    lines.push("", bold("Changes"));
    if (r.changes.commits.length) lines.push(...r.changes.commits.map((c) => `  commit ${c}`));
    if (!r.changes.files.length) lines.push("  (no file changes)");
    for (const f of r.changes.files) lines.push(`  ${f.status.padEnd(2)} ${f.path}${f.preExisting ? dim("  (dirty before dispatch)") : ""}`);
  }
  const last = r.verifications.at(-1);
  if (last) lines.push("", `${bold("Verify")} ${last.passed ? green("PASS") : red("FAIL")} ${last.command} (${r.verifications.length} run(s), rework ${r.reworkCount})`);
  const usage = r.usage
    ? `tokens in=${r.usage.inputTokens} out=${r.usage.outputTokens} cache=${r.usage.cacheReadTokens} total=${r.usage.totalTokens}` +
      (r.usage.chargedUsd !== undefined ? `  charged=$${r.usage.chargedUsd.toFixed(2)}` : "")
    : "tokens n/a";
  lines.push(dim(`budget turns=${r.budget.turns} active=${r.budget.activeMinutes}min  ${usage}`));
  lines.push(dim(`events: ${r.eventLog}`));
  return lines.join("\n");
}
