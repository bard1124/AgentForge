import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { commandLine, isWindows } from "./platform.js";

const run = promisify(execFile);
const DAY_MS = 24 * 60 * 60_000;

export type UpdateState = "unknown" | "up_to_date" | "available" | "dirty" | "diverged" | "ahead" | "offline" | "no_upstream" | "unverified_remote" | "error";
type Stage = "merged" | "dependencies" | "built" | "installed";

export interface UpdateStatus {
  state: UpdateState;
  message: string;
  branch?: string;
  upstream?: string;
  local?: string;
  remote?: string;
  behind?: number;
  ahead?: number;
  checkedAt?: string;
  /** A background check or apply is running. */
  busy?: "check" | "apply";
  /** Set after an apply; `stage` is the last step that completed. */
  apply?: { at: string; ok: boolean; stage?: Stage; error?: string; from?: string; to?: string };
}

export interface UpdaterDeps {
  root: string;
  home: string;
  /** Ids of tasks still running; an update waits until there are none. */
  running: () => string[];
  /** Re-installs the plugin from the updated checkout. */
  reinstall: () => Promise<void>;
  /** Dependency and build commands; npm ci and npm run build by default. */
  steps?: { dependencies: [string, string[]]; build: [string, string[]] };
}

const NPM_STEPS: NonNullable<UpdaterDeps["steps"]> = {
  // Windows locks native modules this backend has loaded, so npm ci (which deletes node_modules) cannot run there.
  dependencies: ["npm", [isWindows ? "install" : "ci", "--no-audit", "--no-fund"]],
  build: ["npm", ["run", "build"]],
};

function runStep([command, args]: [string, string[]], cwd: string, timeout: number) {
  const line = commandLine(command, args);
  return run(line.file, line.args, { cwd, timeout, shell: line.shell, windowsHide: true });
}

/** Repositories renamed on GitHub; clones made before the rename keep the old origin URL, which GitHub redirects. */
const RENAMED_REPOS: Record<string, string> = { "bard1124/claudeforge": "bard1124/agentforge" };

/** owner/repo from a GitHub URL in https, ssh or scp form, with renamed repositories mapped to their current name. */
export function githubRepo(url: string | undefined): string | undefined {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url ?? "");
  if (!m) return undefined;
  const repo = `${m[1]}/${m[2]}`.toLowerCase();
  return RENAMED_REPOS[repo] ?? repo;
}

export class Updater {
  private busy?: "check" | "apply";

  constructor(private readonly deps: UpdaterDeps) {}

  private get file(): string {
    return path.join(this.deps.home, "update-state.json");
  }

  private load(): UpdateStatus {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8")) as UpdateStatus;
    } catch {
      return { state: "unknown", message: "Not checked yet." };
    }
  }

  private save(status: UpdateStatus): UpdateStatus {
    fs.mkdirSync(this.deps.home, { recursive: true });
    fs.writeFileSync(this.file, `${JSON.stringify(status, null, 2)}\n`);
    return status;
  }

  private async git(args: string[], timeout = 30_000): Promise<string> {
    const { stdout } = await run("git", args, { cwd: this.deps.root, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    return stdout.trim();
  }

  /** The cached state only; never touches the network. */
  status(): UpdateStatus {
    return { ...this.load(), busy: this.busy };
  }

  /** Starts a check in the background when the last one is over a day old. */
  checkDaily(): UpdateStatus {
    const last = this.load().checkedAt;
    if (!this.busy && (!last || Date.now() - Date.parse(last) > DAY_MS)) void this.check().catch(() => undefined);
    return this.status();
  }

  private async verifiedRemote(): Promise<string | undefined> {
    const pkg = JSON.parse(fs.readFileSync(path.join(this.deps.root, "package.json"), "utf8")) as { repository?: string | { url?: string } };
    const expected = githubRepo(typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url);
    const actual = githubRepo(await this.git(["config", "--get", "remote.origin.url"]).catch(() => undefined));
    return expected && actual === expected ? actual : undefined;
  }

  /** Fetches origin and compares; also the safety gate apply goes through. */
  async check(): Promise<UpdateStatus> {
    if (this.busy) return this.status();
    this.busy = "check";
    try {
      return this.save(await this.inspect(true));
    } finally {
      this.busy = undefined;
    }
  }

  private async inspect(fetch: boolean): Promise<UpdateStatus> {
    const previous = this.load();
    const base: UpdateStatus = { state: "unknown", message: "", checkedAt: new Date().toISOString(), apply: previous.apply };
    try {
      if (!(await this.verifiedRemote())) {
        return { ...base, state: "unverified_remote", message: "origin is not the repository named in package.json; updates are disabled for this checkout." };
      }
      const branch = await this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
      const upstream = await this.git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).catch(() => undefined);
      if (!upstream) return { ...base, branch, state: "no_upstream", message: `Branch ${branch} tracks no remote branch.` };
      if (fetch) {
        try {
          await this.git(["fetch", "--quiet", "origin"], 60_000);
        } catch (err) {
          return { ...base, branch, upstream, state: "offline", message: `Could not reach origin: ${firstLine(err)}. Try again later.` };
        }
      }
      const [local, remote] = await Promise.all([this.git(["rev-parse", "--short", "HEAD"]), this.git(["rev-parse", "--short", "@{u}"])]);
      const [ahead = 0, behind = 0] = (await this.git(["rev-list", "--left-right", "--count", "HEAD...@{u}"])).split(/\s+/).map(Number);
      const dirty = await this.git(["status", "--porcelain", "--untracked-files=no"]);
      const facts = { ...base, branch, upstream, local, remote, ahead, behind };
      if (dirty) return { ...facts, state: "dirty", message: "The checkout has local changes; commit or discard them yourself, then check again." };
      if (ahead && behind) return { ...facts, state: "diverged", message: `Local and ${upstream} have diverged (${ahead} ahead, ${behind} behind); a fast-forward is impossible.` };
      if (ahead) return { ...facts, state: "ahead", message: `Local is ${ahead} commit(s) ahead of ${upstream}; nothing to install.` };
      if (behind) return { ...facts, state: "available", message: `${behind} new commit(s) on ${upstream}.` };
      return { ...facts, state: "up_to_date", message: "Up to date." };
    } catch (err) {
      return { ...base, state: "error", message: firstLine(err) };
    }
  }

  /**
   * Fast-forwards to origin, installs dependencies, builds, and re-installs the plugin.
   * Runs in the background; a failure after the merge is retried from where it stopped
   * without fetching again. Never stashes, resets, or deletes files.
   */
  apply(): UpdateStatus {
    if (this.busy) return this.status();
    const running = this.deps.running();
    if (running.length) return { ...this.status(), message: `Tasks are running (${running.join(", ")}); update once they finish.` };
    this.busy = "apply";
    this.applying = this.doApply().finally(() => (this.busy = undefined));
    return this.status();
  }

  /** Resolves when the apply started last has finished. */
  settled(): Promise<void> {
    return this.applying ?? Promise.resolve();
  }

  private applying?: Promise<void>;

  private async doApply(): Promise<void> {
    const prev = this.load().apply;
    const resume = prev && !prev.ok && prev.stage ? prev.stage : undefined;
    let record: NonNullable<UpdateStatus["apply"]> = { at: new Date().toISOString(), ok: false, stage: resume, from: prev?.from, to: prev?.to };
    const step = (stage: Stage) => {
      record = { ...record, stage };
      this.save({ ...this.load(), apply: record });
    };
    try {
      if (!resume) {
        const gate = await this.inspect(true);
        if (gate.state !== "available") {
          this.save({ ...gate, apply: { at: record.at, ok: false, error: `Not installed: ${gate.message}` } });
          return;
        }
        await this.git(["merge", "--ff-only", "--quiet", "@{u}"]);
        record = { ...record, from: gate.local, to: gate.remote };
        step("merged");
      }
      const steps = this.deps.steps ?? NPM_STEPS;
      if (!resume || resume === "merged") {
        await runStep(steps.dependencies, this.deps.root, 10 * 60_000);
        step("dependencies");
      }
      if (record.stage === "dependencies") {
        await runStep(steps.build, this.deps.root, 5 * 60_000);
        step("built");
      }
      if (record.stage === "built") {
        await this.deps.reinstall();
        step("installed");
      }
      record = { ...record, ok: true, error: undefined };
      const after = await this.inspect(false);
      this.save({ ...after, apply: record, message: "Installed. Run /reload-plugins (or restart Claude Code) and restart the backend to use the new version." });
    } catch (err) {
      record = { ...record, ok: false, error: firstLine(err) };
      this.save({ ...this.load(), apply: record, message: `Update stopped${record.stage ? ` after ${record.stage}` : ""}: ${record.error}. Retrying continues from there.` });
    }
  }
}

function firstLine(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e.stderr?.trim() || e.message || String(err)).split("\n")[0]!.slice(0, 300);
}
