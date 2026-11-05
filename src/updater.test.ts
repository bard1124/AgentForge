import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { assetName, readReleaseState } from "./release.js";
import { githubRepo, recordRollback, type RestartTarget, Updater } from "./updater.js";

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

/** git on Windows checks files out with CRLF. */
const read = (dir: string, file: string) => fs.readFileSync(path.join(dir, file), "utf8").replace(/\r\n/g, "\n");

const noop: [string, string[]] = [process.execPath, ["-e", ""]];
function updater(steps = { dependencies: noop, build: noop }) {
  return new Updater({ root: clone, home: path.join(tmp, "home"), running: () => running, reinstall: async () => void reinstalls++, steps, source: "git" });
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

  it("updates in one call: fetches, installs, and restarts the backend once no task runs", async () => {
    let restarts = 0;
    const u = new Updater({ root: clone, home: path.join(tmp, "home"), running: () => running, reinstall: async () => void reinstalls++, restart: () => void restarts++, steps: { dependencies: noop, build: noop }, source: "git" });
    const before = await u.head();
    u.apply();
    await u.settled();
    expect(u.status().apply).toBeUndefined();
    expect(u.status()).toMatchObject({ state: "up_to_date", message: "Up to date." });

    commit(other, "b.txt", "two\n");
    git(other, "push", "-q");
    u.apply();
    await u.settled();
    expect(u.status()).toMatchObject({ state: "up_to_date", apply: { ok: true, stage: "installed" } });
    expect(u.status().message).toMatch(/restarts by itself/);
    expect(await u.head()).not.toBe(before);
    expect(restarts).toBe(1);
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

  it("restores a rewritten package-lock.json instead of blocking, and lists other changed files", async () => {
    commit(other, "package-lock.json", "{\"lockfileVersion\":3}\n");
    git(other, "push", "-q");
    git(clone, "pull", "-q");
    commit(other, "b.txt", "two\n");
    git(other, "push", "-q");
    fs.writeFileSync(path.join(clone, "package-lock.json"), "{\"rewritten\":true}\n");
    const u = updater();
    const checked = await u.check();
    expect(checked).toMatchObject({ state: "available" });
    expect(checked.message).toMatch(/package-lock.json was rewritten locally; the update restores it/);
    expect(checked.notes).toBe("- b.txt");
    u.apply();
    await u.settled();
    expect(u.status().apply).toMatchObject({ ok: true });
    expect(read(clone, "package-lock.json")).toBe("{\"lockfileVersion\":3}\n");

    fs.writeFileSync(path.join(clone, "a.txt"), "mine\n");
    const dirty = await u.check();
    expect(dirty).toMatchObject({ state: "dirty", dirtyFiles: ["a.txt"] });
    expect(dirty.message).toMatch(/Local changes in .*: a\.txt\. .*Stash & update/);
  });

  it("stashes local changes on request and updates", async () => {
    commit(other, "b.txt", "two\n");
    git(other, "push", "-q");
    fs.writeFileSync(path.join(clone, "a.txt"), "mine\n");
    const u = updater();
    u.apply({ stash: true });
    await u.settled();
    expect(u.status().apply).toMatchObject({ ok: true });
    expect(fs.existsSync(path.join(clone, "b.txt"))).toBe(true);
    expect(git(clone, "stash", "list")).toMatch(/agentforge-update/);
    expect(read(clone, "a.txt")).toBe("one\n");
  });
});

describe("Updater from releases", () => {
  const platform = "test-x64";
  let root: string;
  let home: string;
  let files: Record<string, Buffer>;
  let listing: unknown[];
  let installs: string[];
  let restarts: (RestartTarget | undefined)[];

  /** A release package the way CI packs it: dist/cli.js at the top, plus package.json. */
  function publish(version: string, opts: { prerelease?: boolean; corrupt?: boolean } = {}) {
    const stage = fs.mkdtempSync(path.join(tmp, "pkg-"));
    fs.mkdirSync(path.join(stage, "dist"));
    fs.writeFileSync(path.join(stage, "dist", "cli.js"), "// cli\n");
    fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify({ version }));
    const name = assetName(version, platform);
    const archive = path.join(tmp, name);
    execFileSync("tar", ["-czf", archive, "-C", stage, "."]);
    const bytes = fs.readFileSync(archive);
    const sum = crypto.createHash("sha256").update(opts.corrupt ? Buffer.from("other") : bytes).digest("hex");
    files[`https://dl/${version}/${name}`] = bytes;
    files[`https://dl/${version}/SHA256SUMS`] = Buffer.from(`${sum}  ${name}\n`);
    listing.unshift({
      tag_name: `v${version}`,
      draft: false,
      prerelease: !!opts.prerelease,
      body: `- change in ${version}`,
      assets: [
        { name, browser_download_url: `https://dl/${version}/${name}` },
        { name: "SHA256SUMS", browser_download_url: `https://dl/${version}/SHA256SUMS` },
      ],
    });
  }

  const fakeFetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("api.github.com")) return new Response(JSON.stringify(listing));
    const body = files[u];
    return body ? new Response(body) : new Response("missing", { status: 404 });
  }) as typeof fetch;

  const make = (r = root) =>
    new Updater({
      root: r,
      home,
      running: () => running,
      reinstall: async () => undefined,
      source: "release",
      platform,
      fetch: fakeFetch,
      installFrom: async (cli) => void installs.push(cli),
      restart: (target) => void restarts.push(target),
    });

  beforeEach(() => {
    root = path.join(tmp, "checkout");
    home = path.join(tmp, "home");
    fs.mkdirSync(path.join(root, "dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.6.1" }));
    files = {};
    listing = [];
    installs = [];
    restarts = [];
  });

  it("moves a git checkout to the newest stable release, then restarts into it with a rollback", async () => {
    publish("0.6.1");
    publish("0.6.2");
    publish("0.6.3-beta.0", { prerelease: true });
    const u = make();
    const checked = await u.check();
    expect(checked).toMatchObject({ state: "available", source: "release", channel: "stable", local: "0.6.1", remote: "0.6.2" });
    expect(checked.message).toMatch(/moves AgentForge from .* to a release install/);
    expect(checked.notes).toContain("- change in 0.6.2");
    expect(checked.notes).not.toContain("0.6.3-beta.0");

    u.apply();
    await u.settled();
    const cli = path.join(home, "versions", "0.6.2", "dist", "cli.js");
    expect(u.status()).toMatchObject({ state: "up_to_date", local: "0.6.2", apply: { ok: true, stage: "installed", from: "0.6.1", to: "0.6.2" } });
    expect(fs.existsSync(cli)).toBe(true);
    expect(installs).toEqual([cli]);
    expect(restarts).toEqual([{ cli, rollback: path.join(root, "dist", "cli.js") }]);
    expect(readReleaseState(home)).toEqual({ current: { version: "0.6.2", cli }, previous: { version: "0.6.1", cli: path.join(root, "dist", "cli.js") } });
    expect(u.installedVersion()).toBe("0.6.2");
    expect(u.restartTarget()).toEqual({ cli, rollback: path.join(root, "dist", "cli.js") });

    const next = make(path.join(home, "versions", "0.6.2"));
    expect((await next.check()).state).toBe("up_to_date");
    next.settings({ channel: "beta" });
    expect(await next.check()).toMatchObject({ state: "available", remote: "0.6.3-beta.0", channel: "beta" });
  });

  it("refuses a package whose checksum does not match and switches nothing", async () => {
    publish("0.6.2", { corrupt: true });
    const u = make();
    u.apply();
    await u.settled();
    expect(u.status().apply).toMatchObject({ ok: false, to: "0.6.2" });
    expect(u.status().message).toMatch(/Checksum mismatch.*Nothing was switched/);
    expect(fs.existsSync(path.join(home, "versions", "0.6.2"))).toBe(false);
    expect(readReleaseState(home)).toEqual({});
    expect(installs).toEqual([]);
  });

  it("installs stable releases automatically when idle, never betas", async () => {
    publish("0.6.2-beta.0", { prerelease: true });
    const u = make();
    u.settings({ channel: "beta" });
    let stop = u.startAuto(60_000, 0);
    await new Promise((r) => setTimeout(r, 300));
    stop();
    expect(u.status()).toMatchObject({ state: "available", remote: "0.6.2-beta.0" });
    expect(installs).toEqual([]);

    publish("0.6.2");
    stop = u.startAuto(60_000, 0);
    for (let i = 0; i < 50 && !installs.length; i++) await new Promise((r) => setTimeout(r, 100));
    await u.settled();
    stop();
    expect(installs).toHaveLength(1);
    expect(u.status().apply).toMatchObject({ ok: true, to: "0.6.2" });

    u.settings({ auto: false });
    expect(u.status().auto).toBe(false);

    recordRollback(path.join(tmp, "home"), "backend did not start");
    expect(u.status().apply).toMatchObject({ ok: false, rolledBack: true, to: "0.6.2", error: "backend did not start" });
  });
});

