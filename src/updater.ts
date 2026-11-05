import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { commandLine, isWindows } from "./platform.js";
import {
  type Channel,
  fetchRelease,
  isDevCheckout,
  isPrerelease,
  isReleaseInstall,
  listReleases,
  notesBetween,
  pickRelease,
  platformId,
  pruneVersions,
  type ReleaseInfo,
  readReleaseState,
  writeReleaseState,
} from "./release.js";

const run = promisify(execFile);
const DAY_MS = 24 * 60 * 60_000;

export type UpdateState = "unknown" | "up_to_date" | "available" | "dirty" | "diverged" | "ahead" | "offline" | "no_upstream" | "unverified_remote" | "error";
type Stage = "merged" | "dependencies" | "built" | "downloaded" | "installed";

export interface UpdateSettings {
  channel: Channel;
  /** Installs stable releases by itself once no task is running. */
  auto: boolean;
}

const settingsFile = (home: string) => path.join(home, "update-settings.json");

export function readUpdateSettings(home: string): UpdateSettings {
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile(home), "utf8")) as Partial<UpdateSettings>;
    return { channel: s.channel === "beta" ? "beta" : "stable", auto: s.auto !== false };
  } catch {
    return { channel: "stable", auto: true };
  }
}

export function writeUpdateSettings(home: string, change: Partial<UpdateSettings>): UpdateSettings {
  const next = { ...readUpdateSettings(home), ...change };
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(settingsFile(home), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** Called by the successor backend when the new version did not start and the previous one was put back. */
export function recordRollback(home: string, error: string): void {
  const file = path.join(home, "update-state.json");
  let status: UpdateStatus;
  try {
    status = JSON.parse(fs.readFileSync(file, "utf8")) as UpdateStatus;
  } catch {
    status = { state: "unknown", message: "" };
  }
  const apply = { ...(status.apply ?? { at: new Date().toISOString() }), ok: false, rolledBack: true, error };
  fs.writeFileSync(file, `${JSON.stringify({ ...status, state: "error", apply, message: `The new version did not start, so the previous one was put back: ${error}` }, null, 2)}\n`);
}

export interface UpdateStatus {
  state: UpdateState;
  message: string;
  /** git: a developer checkout updated by fast-forward; release: packages from GitHub releases. */
  source?: "git" | "release";
  channel?: Channel;
  auto?: boolean;
  /** Tracked files with local changes that block a git update. */
  dirtyFiles?: string[];
  /** What the update brings: release notes, or commit subjects for a checkout. */
  notes?: string;
  root?: string;
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
  apply?: { at: string; ok: boolean; stage?: Stage; error?: string; from?: string; to?: string; rolledBack?: boolean };
}

export interface RestartTarget {
  /** The cli the new backend runs. */
  cli: string;
  /** Started instead when `cli` does not come up. */
  rollback?: string;
}

export interface UpdaterDeps {
  root: string;
  home: string;
  /** Ids of tasks still running; an update waits until there are none. */
  running: () => string[];
  /** Re-installs the plugin from the updated checkout. */
  reinstall: () => Promise<void>;
  /** Restarts the backend so it runs the installed code; called once no task is running. */
  restart?: (target?: RestartTarget) => void;
  /** Dependency and build commands; npm ci and npm run build by default. */
  steps?: { dependencies: [string, string[]]; build: [string, string[]] };
  /** Defaults to git for a checkout marked `.agentforge-dev`, release otherwise. */
  source?: "git" | "release";
  fetch?: typeof fetch;
  platform?: string;
  /** Registers the plugin from another version's cli (`<cli> install`). */
  installFrom?: (cli: string) => Promise<void>;
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
  readonly source: "git" | "release";
  private target?: ReleaseInfo;

  constructor(private readonly deps: UpdaterDeps) {
    this.source = deps.source ?? (isDevCheckout(deps.root) ? "git" : "release");
  }

  private get cli(): string {
    return path.join(this.deps.root, "dist", "cli.js");
  }

  private version(): string {
    return (JSON.parse(fs.readFileSync(path.join(this.deps.root, "package.json"), "utf8")) as { version: string }).version;
  }

  /** The version a restarted backend runs: the last release installed, else this checkout's. */
  installedVersion(): string {
    return (this.source === "release" && readReleaseState(this.deps.home).current?.version) || this.version();
  }

  /** What a restart should start: the release installed after this backend started, if any. */
  restartTarget(): RestartTarget | undefined {
    const current = this.source === "release" ? readReleaseState(this.deps.home).current : undefined;
    return current && path.resolve(current.cli) !== path.resolve(this.cli) ? { cli: current.cli, rollback: this.cli } : undefined;
  }

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

  /** The checkout's current commit, or undefined when git cannot tell. */
  async head(): Promise<string | undefined> {
    return this.git(["rev-parse", "--short", "HEAD"], 5000).catch(() => undefined);
  }

  /** The cached state only; never touches the network. */
  status(): UpdateStatus {
    const { channel, auto } = readUpdateSettings(this.deps.home);
    return { ...this.load(), busy: this.busy, source: this.source, channel, auto: this.source === "release" && auto, root: this.deps.root };
  }

  settings(change: Partial<UpdateSettings>): UpdateStatus {
    writeUpdateSettings(this.deps.home, change);
    return this.status();
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
      this.save(this.source === "git" ? await this.inspect(true) : await this.inspectRelease());
      return this.status();
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
      const dirty = (await this.git(["status", "--porcelain", "--untracked-files=no"])).split("\n").map((l) => /^\S+\s+(?:.* -> )?(.+)$/.exec(l.trim())?.[1]).filter((f): f is string => !!f);
      const blocking = dirty.filter((f) => f !== LOCKFILE);
      const facts = { ...base, branch, upstream, local, remote, ahead, behind };
      if (blocking.length) {
        const list = `${blocking.slice(0, 5).join(", ")}${blocking.length > 5 ? ` and ${blocking.length - 5} more` : ""}`;
        return {
          ...facts,
          state: "dirty",
          dirtyFiles: blocking,
          message: `Local changes in ${this.deps.root}: ${list}. Commit or discard them, or use Stash & update (keeps them in git stash).`,
        };
      }
      if (ahead && behind) return { ...facts, state: "diverged", message: `Local and ${upstream} have diverged (${ahead} ahead, ${behind} behind); a fast-forward is impossible.` };
      if (ahead) return { ...facts, state: "ahead", message: `Local is ${ahead} commit(s) ahead of ${upstream}; nothing to install.` };
      if (behind) {
        const notes = await this.git(["log", "--pretty=- %s", "--max-count=20", "HEAD..@{u}"]).catch(() => "");
        const lock = dirty.includes(LOCKFILE) ? ` ${LOCKFILE} was rewritten locally; the update restores it.` : "";
        return { ...facts, state: "available", notes, message: `${behind} new commit(s) on ${upstream}.${lock}` };
      }
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
  apply(opts: { stash?: boolean } = {}): UpdateStatus {
    if (this.busy) return this.status();
    const running = this.deps.running();
    if (running.length) return { ...this.status(), message: `Tasks are running (${running.join(", ")}); update once they finish.` };
    this.busy = "apply";
    this.applying = (this.source === "git" ? this.doApply(opts) : this.doApplyRelease()).finally(() => (this.busy = undefined));
    return this.status();
  }

  private async inspectRelease(): Promise<UpdateStatus> {
    const previous = this.load();
    const { channel } = readUpdateSettings(this.deps.home);
    const current = this.installedVersion();
    const base: UpdateStatus = { state: "unknown", message: "", checkedAt: new Date().toISOString(), apply: previous.apply, local: current };
    let releases: ReleaseInfo[];
    try {
      releases = await listReleases(this.deps.fetch);
    } catch (err) {
      return { ...base, state: "offline", message: `Could not reach GitHub releases: ${firstLine(err)}. Try again later.` };
    }
    // A git checkout moves to a release install even at the same version.
    const migrating = !isReleaseInstall(this.deps.root, this.deps.home) && !readReleaseState(this.deps.home).current;
    const platform = this.deps.platform ?? platformId();
    const target = pickRelease(releases, current, channel, platform, migrating);
    this.target = target;
    if (!target) return { ...base, state: "up_to_date", remote: current, message: `Up to date (${channel} channel).` };
    const move = migrating ? ` This also moves AgentForge from ${this.deps.root} to a release install in ${path.join(this.deps.home, "versions")}.` : "";
    return {
      ...base,
      state: "available",
      remote: target.version,
      notes: notesBetween(releases, migrating ? "0.0.0" : current, target, channel).slice(0, 4000),
      message: `Version ${target.version} is available (${channel} channel).${move}`,
    };
  }

  private async doApplyRelease(): Promise<void> {
    const from = this.installedVersion();
    let record: NonNullable<UpdateStatus["apply"]> = { at: new Date().toISOString(), ok: false, from };
    const step = (stage: Stage) => {
      record = { ...record, stage };
      this.save({ ...this.load(), apply: record });
    };
    try {
      const gate = await this.inspectRelease();
      const target = this.target;
      if (gate.state !== "available" || !target) {
        this.save({ ...gate, apply: this.load().apply?.ok ? this.load().apply : undefined });
        return;
      }
      record = { ...record, to: target.version };
      const cli = await fetchRelease(this.deps.home, target, this.deps.fetch, this.deps.platform ?? platformId());
      step("downloaded");
      await (this.deps.installFrom ?? installFrom(this.deps.home))(cli);
      step("installed");
      const prior = readReleaseState(this.deps.home).current ?? { version: this.version(), cli: this.cli };
      writeReleaseState(this.deps.home, { current: { version: target.version, cli }, previous: prior });
      pruneVersions(this.deps.home, [target.version, prior.version]);
      record = { ...record, ok: true, error: undefined };
      const restart = this.deps.restart;
      this.save({
        ...gate,
        state: "up_to_date",
        local: target.version,
        apply: record,
        message: restart
          ? `Installed ${target.version}. The backend restarts by itself once no task is running and goes back to ${prior.version} if the new one does not start; then run /reload-plugins.`
          : `Installed ${target.version}. Restart the backend and run /reload-plugins to use it.`,
      });
      if (restart) this.restartWhenIdle(() => restart({ cli, rollback: prior.cli }));
    } catch (err) {
      record = { ...record, ok: false, error: firstLine(err) };
      this.save({ ...this.load(), apply: record, message: `Update to ${record.to ?? "the new version"} stopped${record.stage ? ` after ${record.stage}` : ""}: ${record.error}. Nothing was switched; try again.` });
    }
  }

  /**
   * Checks now and every `everyMs`; on the release source with auto on, installs a newer stable
   * release once no task runs. Betas are never installed automatically.
   */
  startAuto(everyMs = 6 * 60 * 60_000, firstMs = 60_000, busyRetryMs = 10 * 60_000): () => void {
    let timer: NodeJS.Timeout | undefined;
    const schedule = (ms: number) => {
      timer = setTimeout(() => void tick(), ms);
      timer.unref?.();
    };
    const tick = async () => {
      const s = await this.check().catch(() => undefined);
      const { auto } = readUpdateSettings(this.deps.home);
      if (this.source !== "release" || !auto || s?.state !== "available" || !s.remote || isPrerelease(s.remote)) return schedule(everyMs);
      if (this.deps.running().length || this.busy) return schedule(busyRetryMs);
      this.apply();
      await this.settled();
      schedule(everyMs);
    };
    schedule(firstMs);
    return () => clearTimeout(timer);
  }

  /** Resolves when the apply started last has finished. */
  settled(): Promise<void> {
    return this.applying ?? Promise.resolve();
  }

  private applying?: Promise<void>;

  private restartWhenIdle(restart: () => void): void {
    if (!this.deps.running().length) return restart();
    setTimeout(() => this.restartWhenIdle(restart), 5_000).unref();
  }

  private async doApply(opts: { stash?: boolean } = {}): Promise<void> {
    const prev = this.load().apply;
    const resume = prev && !prev.ok && prev.stage ? prev.stage : undefined;
    let record: NonNullable<UpdateStatus["apply"]> = { at: new Date().toISOString(), ok: false, stage: resume, from: prev?.from, to: prev?.to };
    const step = (stage: Stage) => {
      record = { ...record, stage };
      this.save({ ...this.load(), apply: record });
    };
    try {
      if (!resume) {
        if (opts.stash && (await this.git(["status", "--porcelain", "--untracked-files=no"])).trim()) {
          await this.git(["stash", "push", "-m", `agentforge-update ${new Date().toISOString()}`]);
        }
        const gate = await this.inspect(true);
        if (gate.state !== "available") {
          // Nothing to install is an answer, not a failed install.
          this.save({ ...gate, apply: prev?.ok ? prev : undefined });
          return;
        }
        if ((await this.git(["status", "--porcelain", "--untracked-files=no", "--", LOCKFILE])).trim()) await this.git(["checkout", "--", LOCKFILE]);
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
      const restart = this.deps.restart;
      this.save({
        ...after,
        apply: record,
        message: restart
          ? "Installed. The backend restarts by itself once no task is running; then run /reload-plugins (or restart Claude Code)."
          : "Installed. Run /reload-plugins (or restart Claude Code) and restart the backend to use the new version.",
      });
      if (restart) this.restartWhenIdle(restart);
    } catch (err) {
      record = { ...record, ok: false, error: firstLine(err) };
      this.save({ ...this.load(), apply: record, message: `Update stopped${record.stage ? ` after ${record.stage}` : ""}: ${record.error}. Retrying continues from there.` });
    }
  }
}

const LOCKFILE = "package-lock.json";

/** Registers the plugin from a release's cli, which points Claude Code and the board at that version. */
function installFrom(home: string): (cli: string) => Promise<void> {
  return (cli) =>
    run(process.execPath, [cli, "install"], { cwd: home, timeout: 5 * 60_000, windowsHide: true, env: { ...process.env, AGENTFORGE_HOME: home, NODE_NO_WARNINGS: "1" } }).then(() => undefined);
}

function firstLine(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e.stderr?.trim() || e.message || String(err)).split("\n")[0]!.slice(0, 300);
}
