import { spawn } from "node:child_process";
import { isWindows, killTree } from "./platform.js";
import type { Verification } from "./types.js";

const TAIL_CHARS = 6000;

export function runVerification(command: string, cwd: string, timeoutMs: number): Promise<Verification> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: process.env, detached: !isWindows, windowsHide: true });
    let output = "";
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > TAIL_CHARS * 2) output = output.slice(-TAIL_CHARS);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // Kill the whole tree so build tools spawned by the shell die too.
      if (child.pid) killTree(child.pid);
      else child.kill("SIGKILL");
    }, timeoutMs);

    let settled = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const tail = output.slice(-TAIL_CHARS);
      resolve({
        at: new Date(startedAt).toISOString(),
        command,
        exitCode: timedOut ? null : exitCode,
        passed: !timedOut && exitCode === 0,
        durationMs: Date.now() - startedAt,
        outputTail: timedOut ? `${tail}\n[killed after ${Math.round(timeoutMs / 1000)}s timeout]` : tail,
      });
    };
    child.on("error", (err) => {
      output += `\n${err.message}`;
      finish(-1);
    });
    child.on("close", (code) => finish(code));
  });
}
