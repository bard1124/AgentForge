import type { Verification } from "./types.js";

export interface BriefInput {
  task: string;
  cwd: string;
  acceptance?: string;
  verifyCommand?: string;
  context?: string;
}

/** The first message a worker receives: the task plus the contract it will be accepted against. */
export function buildBrief(input: BriefInput): string {
  const sections = [
    "You are a worker agent dispatched by AgentForge. A supervising Claude Code session assigned you this task and will review your output.",
    `## Task\n${input.task.trim()}`,
  ];
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
