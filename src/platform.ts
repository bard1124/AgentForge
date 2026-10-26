import { spawn } from "node:child_process";

export const isWindows = process.platform === "win32";

function cmdQuote(arg: string): string {
  return /^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replaceAll('"', '""')}"`;
}

/**
 * How to run a CLI found on PATH. On Windows, npm and npm-installed CLIs (npm, claude) are
 * `.cmd` shims, which Node only runs through a shell, so the line is quoted for cmd.exe.
 */
export function commandLine(command: string, args: string[]): { file: string; args: string[]; shell: boolean } {
  if (!isWindows || /\.exe$/i.test(command)) return { file: command, args, shell: false };
  return { file: [command, ...args].map(cmdQuote).join(" "), args: [], shell: true };
}

/** Kills a process and everything it started; Windows has no process groups, so taskkill walks the tree. */
export function killTree(pid: number): void {
  if (isWindows) {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => undefined);
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}
