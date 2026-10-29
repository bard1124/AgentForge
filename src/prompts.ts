import fs from "node:fs";
import path from "node:path";
import type { Verification } from "./types.js";

export interface BriefInput {
  task: string;
  cwd: string;
  acceptance?: string;
  verifyCommand?: string;
  context?: string;
  /** Standing instructions for every task in this project (build toolchain, shell, offline rules). */
  projectNotes?: string;
  /** Ask the worker to end each turn after one slice; AgentForge continues it with the next. */
  slices?: boolean;
}

/** The marker a worker ends a slice with; its absence means the task is done. */
export const NEXT_MARKER = "NEXT:";

const NOTES = path.join(".agentforge", "worker.md");

/**
 * Standing worker notes: the nearest `.agentforge/worker.md` from `cwd` up to its repository root,
 * then `<home>/worker.md` for every project. Both apply when both exist.
 */
export function readProjectNotes(cwd: string, home: string): { text: string; files: string[] } | undefined {
  const found: string[] = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const file = path.join(dir, NOTES);
    if (fs.existsSync(file)) {
      found.push(file);
      break;
    }
    if (fs.existsSync(path.join(dir, ".git")) || path.dirname(dir) === dir) break;
  }
  const global = path.join(home, "worker.md");
  if (fs.existsSync(global)) found.push(global);
  const parts = found.map((f) => fs.readFileSync(f, "utf8").trim()).filter(Boolean);
  return parts.length ? { text: parts.join("\n\n"), files: found } : undefined;
}

/** The first message a worker receives: the task plus the contract it will be accepted against. */
export function buildBrief(input: BriefInput): string {
  const sections = [
    "You are a worker agent dispatched by AgentForge. A supervising Claude Code session assigned you this task and will review your output.",
    `## Task\n${input.task.trim()}`,
  ];
  if (input.projectNotes?.trim()) sections.push(`## Project notes (apply to every task here)\n${input.projectNotes.trim()}`);
  if (input.context?.trim()) sections.push(`## Context from the supervisor\n${input.context.trim()}`);
  if (input.acceptance?.trim()) sections.push(`## Acceptance criteria\n${input.acceptance.trim()}`);
  if (input.verifyCommand?.trim()) {
    sections.push(`## Verification\nThe supervisor will run this command in \`${input.cwd}\` to accept the work:\n\`\`\`\n${input.verifyCommand.trim()}\n\`\`\`\nMake it pass before you finish.`);
  }
  sections.push(
    [
      "## Rules",
      "- After a quick look at the code, start your first message with `ETA: <minutes>m`, your estimate of the time the task will take.",
      `- Work only inside \`${input.cwd}\`.`,
      "- Do not commit, push, or switch branches unless the task explicitly says so.",
      "- In large files, locate code with grep/rg first and read only the line ranges you need; do not re-read a file you already read unless it changed.",
      "- Prefer several small edits over one large rewrite, and check an edit's result before building on it.",
      "- Read only what the change needs (the files named in the task or context first), then make the first edit; look things up as you go instead of studying everything up front.",
      "- If something blocks you or the task is ambiguous, stop and explain what you need instead of guessing.",
      ...(input.slices
        ? [
            "",
            "## Work in slices",
            "Your connection can drop during long turns, so keep each turn short. Split the work into slices of one coherent change each (a few files plus the checks for them).",
            `After each slice, end your turn with two or three lines on what you did and a last line \`${NEXT_MARKER} <the next slice>\`. AgentForge then sends you "continue" and you do that slice. Do not end a turn with ${NEXT_MARKER} unless work remains.`,
            "After the last slice, end without that line and give the report below.",
          ]
        : []),
      "",
      "## When you finish",
      "End your final message with a short report:",
      "1. What you changed (files and why).",
      "2. How you verified it.",
      "3. Open issues or follow-ups, if any.",
    ].join("\n"),
  );
  return sections.join("\n\n");
}

/** The slice the worker said comes next, from the last `NEXT:` line of its turn; undefined when it finished. */
export function nextSlice(result: string | undefined): string | undefined {
  const lines = (result ?? "").trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines.at(-1);
  if (!last?.toUpperCase().startsWith(NEXT_MARKER)) return undefined;
  return last.slice(NEXT_MARKER.length).trim() || "the next slice";
}

export function buildContinuePrompt(next: string): string {
  return `Continue with the next slice: ${next}\nEnd this turn the same way: a short note and \`${NEXT_MARKER} ...\` if work remains, else the final report.`;
}

export interface ResumeState {
  /** Files edited so far, relative to the working directory. */
  touched: string[];
  diffStat: string;
  /** Latest completed steps of the cut-off turn, oldest first. */
  recent: string[];
  /** What the cut-off turn was doing: its prompt. */
  prompt: string;
}

/** Continues a turn a connection error cut off, with what AgentForge saw done so the worker need not re-read it. */
export function buildResumePrompt(state: ResumeState): string {
  const parts = [
    "Your previous turn was cut off by a connection error. Continue from where you stopped; do not redo finished work and do not re-read files you already read unless you need a detail you do not have.",
    `That turn was working on:\n${state.prompt.length > 600 ? `${state.prompt.slice(0, 600)}…` : state.prompt}`,
  ];
  if (state.touched.length) parts.push(`Files you edited so far:\n${state.touched.map((f) => `- ${f}`).join("\n")}`);
  if (state.diffStat.trim()) parts.push(`git diff --stat against the start of the task:\n\`\`\`\n${state.diffStat.trim()}\n\`\`\``);
  if (state.recent.length) parts.push(`Your last completed steps:\n${state.recent.map((s) => `- ${s}`).join("\n")}`);
  parts.push("Check the files above where an edit may have been cut off, then carry on.");
  return parts.join("\n\n");
}

export const EXPLORE_NUDGE =
  `You have read and searched for a while without editing anything. Start implementing now with what you know: make the first edit, look up details as you need them, and keep each turn to one slice (end it with \`${NEXT_MARKER} ...\` while work remains).`;

/** Feedback sent back to the worker when verification fails. */
export function buildReworkPrompt(verification: Verification, feedback?: string): string {
  const parts = [
    `The supervisor ran \`${verification.command}\` and it failed (exit code ${verification.exitCode ?? "timeout"}).`,
    `Output (tail):\n\`\`\`\n${verification.outputTail}\n\`\`\``,
  ];
  if (feedback?.trim()) parts.push(`Supervisor feedback:\n${feedback.trim()}`);
  parts.push("Fix the problem, re-run the check yourself, and report again in the same format.");
  return parts.join("\n\n");
}
