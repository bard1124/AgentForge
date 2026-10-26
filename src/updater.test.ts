import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { githubRepo, Updater } from "./updater.js";

const URL = "https://github.com/acme/agentforge.git";
let tmp: string;
let origin: string;
let clone: string;
let other: string;
let running: string[];
let reinstalls: number;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

function commit(cwd: string, file: string, text: string) {
  fs.writeFileSync(path.join(cwd, file), text);
  git(cwd, "add", ".");
  git(cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", file);
}

const noop: [string, string[]] = [process.execPath, ["-e", ""]];
function updater(steps = { dependencies: noop, build: noop }) {
  return new Updater({ root: clone, home: path.join(tmp, "home"), running: () => running, reinstall: async () => void reinstalls++, steps });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cf-upd-"));
  origin = path.join(tmp, "origin.git");
  clone = path.join(tmp, "clone");
  other = path.join(tmp, "other");
  running = [];
  reinstalls = 0;
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  fs.mkdirSync(other);
  git(other, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(other, "package.json"), JSON.stringify({ version: "1.0.0", repository: { url: `git+${URL}` } }));
  commit(other, "a.txt", "one\n");
  git(other, "remote", "add", "origin", origin);
  git(other, "push", "-q", "-u", "origin", "main");
  execFileSync("git", ["clone", "-q", origin, clone]);
  // origin looks like the GitHub repository named in package.json but resolves to the local bare repo.
  git(clone, "remote", "set-url", "origin", URL);
  git(clone, "config", `url.${origin}.insteadOf`, URL);
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("githubRepo", () => {
  it("normalizes https, ssh, and scp forms", () => {
    expect(githubRepo("git+https://github.com/Bard1124/AgentForge.git")).toBe("bard1124/agentforge");
    expect(githubRepo("git@github.com:bard1124/AgentForge.git")).toBe("bard1124/agentforge");
    expect(githubRepo("ssh://git@github.com/bard1124/AgentForge")).toBe("bard1124/agentforge");
    expect(githubRepo("https://gitlab.com/x/y")).toBeUndefined();
  });

  it("maps a clone of the pre-rename repository to the current name", () => {
    expect(githubRepo("git@github.com:bard1124/ClaudeForge.git")).toBe("bard1124/agentforge");
  });
});

describe("Updater", () => {
  it("reports up to date, then an available fast-forward, and installs it", async () => {
    const u = updater();
    expect((await u.check()).state).toBe("up_to_date");
    commit(other, "b.txt", "two\n");
    git(other, "push", "-q");
    const checked = await u.check();
    expect(checked).toMatchObject({ state: "available", behind: 1 });
    expect(u.status().state).toBe("available");
    u.apply();
    await u.settled();
    expect(u.status()).toMatchObject({ state: "up_to_date", apply: { ok: true, stage: "installed" } });
    expect(fs.existsSync(path.join(clone, "b.txt"))).toBe(true);
    expect(reinstalls).toBe(1);
  });

  it("blocks on local changes, divergence, running tasks, and an unverified remote, changing nothing", async () => {
    commit(other, "b.txt", "two\n");
    git(other, "push", "-q");
    fs.writeFileSync(path.join(clone, "a.txt"), "local edit\n");
    expect((await updater().check()).state).toBe("dirty");
    git(clone, "checkout", "--", "a.txt");
    commit(clone, "c.txt", "local commit\n");
    expect((await updater().check()).state).toBe("diverged");
    git(clone, "reset", "-q", "--hard", "HEAD~1");
    fs.writeFileSync(path.join(clone, "untracked-sdd.md"), "keep me\n");
    expect((await updater().check()).state).toBe("available");

    running = ["cf-1"];
    expect(updater().apply().message).toMatch(/Tasks are running/);
    running = [];

    git(clone, "remote", "set-url", "origin", "https://github.com/evil/fork.git");
    expect((await updater().check()).state).toBe("unverified_remote");
    expect(fs.readFileSync(path.join(clone, "untracked-sdd.md"), "utf8")).toBe("keep me\n");
    expect(fs.existsSync(path.join(clone, "b.txt"))).toBe(false);
  });

  it("resumes a failed install after the merge without fetching again", async () => {
    commit(other, "b.txt", "two\n");
    git(other, "push", "-q");
    const failing = updater({ dependencies: noop, build: [process.execPath, ["-e", "process.exit(1)"]] });
    failing.apply();
    await failing.settled();
    expect(failing.status().apply).toMatchObject({ ok: false, stage: "dependencies" });
    // Origin unreachable now: a retry must not need it.
    git(clone, "config", `url./nonexistent.insteadOf`, URL);
    git(clone, "config", "--unset", `url.${origin}.insteadOf`);
    const retry = updater();
    retry.apply();
    await retry.settled();
    expect(retry.status().apply).toMatchObject({ ok: true, stage: "installed" });
    expect(reinstalls).toBe(1);
  });
});
