#!/usr/bin/env node
import fs from "node:fs";
import { heartbeatFile, promptContext, readDelegation } from "./delegation.js";

/**
 * Claude Code `UserPromptSubmit` hook: reads the board settings on every message and
 * adds the dispatch preference as context. It never blocks the prompt and never
 * records it; the heartbeat only proves the hook ran.
 */
function main(): void {
  const i = process.argv.indexOf("--home");
  const home = i >= 0 ? process.argv[i + 1] : process.env.CLAUDEFORGE_HOME;
  let input: { session_id?: string; cwd?: string } = {};
  try {
    input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    // No or malformed input still gets the preference.
  }
  let context: string;
  try {
    if (!home) throw new Error("AgentForge home not configured");
    const read = readDelegation(home);
    context = promptContext(read);
    fs.writeFileSync(
      heartbeatFile(home),
      `${JSON.stringify({ at: new Date().toISOString(), sessionId: input.session_id, cwd: input.cwd, enabled: read.settings.enabled && !read.corrupt })}\n`,
    );
  } catch (err) {
    context = `AgentForge auto-dispatch: OFF (settings unreadable: ${(err as Error).message}). Work as usual.`;
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } }));
}

try {
  main();
} catch {
  // A hook failure must never block the user's prompt.
}
process.exit(0);
