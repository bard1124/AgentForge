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
}

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
      `- Work only inside \`${input.cwd}\`.`,
      "- Do not commit, push, or switch branches unless the task explicitly says so.",
      "- In large files, locate code with grep/rg first and read only the line ranges you need; do not re-read a file you already read unless it changed.",
      "- Prefer several small edits over one large rewrite, and check an edit's result before building on it.",
      "- If something blocks you or the task is ambiguous, stop and explain what you need instead of guessing.",
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
