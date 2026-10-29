import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { elapsedMs } from "./estimate.js";
import { orderStatus } from "./forge.js";
import type { Task } from "./types.js";

const STEPS_SHOWN = 40;

export function progressFile(home: string, id: string): string {
  return path.join(home, "progress", `${id}.md`);
}

const oneLine = (text: string | undefined, max: number) => {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour12: false });

function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** A Markdown page an editor can keep open; it is rewritten whenever the task is saved. */
export function renderProgress(task: Task, now = Date.now()): string {
  const status = orderStatus(task);
  const running = task.status === "running" || task.status === "queued";
  const end = running ? now : Date.parse(task.updatedAt);
  const turn = task.turns.at(-1);
  const lines = [
    `# ${oneLine(task.title, 120)}`,
    "",
    `| | |`,
    `|---|---|`,
    `| Task | \`${task.id}\` |`,
    `| Status | **${status}** (${task.status}) |`,
    `| Directory | \`${task.worktree?.origin ?? task.cwd}\`${task.worktree ? ` (worktree \`${task.cwd}\`)` : ""} |`,
    `| Executor | ${task.worker} · ${task.model} |`,
    `| Turns | ${task.turns.length} |`,
    `| Elapsed | ${duration(end - Date.parse(task.createdAt))} |`,
    ...(task.estimate
      ? [`| Estimate | ${duration(task.estimate.ms)} (${task.estimate.source === "worker" ? "worker's ETA" : (task.estimate.basis ?? "history")}); worker time so far ${duration(elapsedMs(task, now))} |`]
      : []),
    `| Updated | ${clock(task.updatedAt)} |`,
  ];
  if (turn?.error) lines.push("", `> **Error:** ${oneLine(turn.error, 400)}`);
  const verification = task.verifications.at(-1);
  if (verification) lines.push("", `Verification \`${oneLine(verification.command, 120)}\`: ${verification.passed ? "passed" : `failed (exit ${verification.exitCode ?? "timeout"})`}`);
  if (task.touched?.length) lines.push("", "## Files edited", ...task.touched.map((f) => `- \`${f}\``));
  const steps = task.steps.slice(-STEPS_SHOWN).reverse();
  if (steps.length) {
    lines.push("", `## Latest steps${task.steps.length > STEPS_SHOWN ? ` (last ${STEPS_SHOWN} of ${task.steps.length})` : ""}`, "");
    for (const s of steps) lines.push(`- \`${clock(s.at)}\` ${s.kind === "tool" ? "🔧" : s.kind === "error" ? "❌" : "·"} ${oneLine(s.text, 200).replaceAll("`", "'")}`);
  }
  if (turn?.result && !running) lines.push("", "## Worker report", "", turn.result.trim());
  return `${lines.join("\n")}\n`;
}

export function writeProgress(home: string, task: Task): string {
  const file = progressFile(home, task.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, renderProgress(task));
  fs.renameSync(tmp, file);
  return file;
}

/** The editor command: an explicit path or name, else `cursor` from PATH or its usual install places. */
export function findEditor(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (path.isAbsolute(command)) return fs.existsSync(command) ? command : undefined;
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  if (command === "cursor") {
    dirs.push(path.join(os.homedir(), "bin"), "/usr/local/bin", "/opt/homebrew/bin", "/Applications/Cursor.app/Contents/Resources/app/bin");
  }
  const names = process.platform === "win32" ? [`${command}.cmd`, `${command}.exe`, command] : [command];
  for (const dir of dirs) for (const name of names) if (fs.existsSync(path.join(dir, name))) return path.join(dir, name);
  return undefined;
}

/** Opens the file in the last active editor window; never throws, returns false when no editor is found. */
export function openInEditor(command: string, file: string): boolean {
  const bin = findEditor(command);
  if (!bin) return false;
  try {
    const child = spawn(bin, ["--reuse-window", file], { detached: true, stdio: "ignore", windowsHide: true, shell: process.platform === "win32" });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
