#!/usr/bin/env node
// Installs the latest AgentForge release for this machine into ~/.agentforge/versions/<version>,
// registers the plugin with Claude Code, and (re)starts the backend. install.sh / install.ps1 run this.
// Env: AGENTFORGE_HOME (default ~/.agentforge), AGENTFORGE_CHANNEL=stable|beta, AGENTFORGE_VERSION=x.y.z
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = "bard1124/AgentForge";
const home = process.env.AGENTFORGE_HOME || path.join(os.homedir(), ".agentforge");
const channel = process.env.AGENTFORGE_CHANNEL === "beta" ? "beta" : "stable";
const wanted = process.env.AGENTFORGE_VERSION?.replace(/^v/, "");
const platform = `${process.platform}-${process.arch}`;
const headers = { "user-agent": "agentforge-installer" };

const fail = (msg) => {
  console.error(`AgentForge install failed: ${msg}`);
  process.exit(1);
};

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) fail(`Node ${process.versions.node} is too old; install Node 22.13 or newer.`);

async function get(url, accept) {
  const res = await fetch(url, { headers: { ...headers, ...(accept ? { accept } : {}) }, redirect: "follow" });
  if (!res.ok) fail(`${url} answered ${res.status}.`);
  return res;
}

const releases = await (await get(`https://api.github.com/repos/${REPO}/releases?per_page=30`, "application/vnd.github+json")).json();
const asset = (r, name) => r.assets?.find((a) => a.name === name)?.browser_download_url;
const version = (r) => String(r.tag_name).replace(/^v/, "");
const release = releases.find(
  (r) => !r.draft && (wanted ? version(r) === wanted : channel === "beta" || !r.prerelease) && asset(r, `agentforge-${version(r)}-${platform}.tar.gz`) && asset(r, "SHA256SUMS"),
);
if (!release) fail(`no ${wanted ? `v${wanted}` : `${channel} release`} with a package for ${platform}.`);

const v = version(release);
const name = `agentforge-${v}-${platform}.tar.gz`;
console.log(`Downloading AgentForge ${v} (${platform})…`);
const sums = await (await get(asset(release, "SHA256SUMS"))).text();
const expected = sums.split("\n").map((l) => /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(l.trim())).find((m) => m?.[2] === name)?.[1];
if (!expected) fail(`SHA256SUMS has no entry for ${name}.`);
const archive = Buffer.from(await (await get(asset(release, name))).arrayBuffer());
if (crypto.createHash("sha256").update(archive).digest("hex") !== expected.toLowerCase()) fail(`checksum mismatch for ${name}; nothing was installed.`);

const versions = path.join(home, "versions");
const target = path.join(versions, v);
const cli = path.join(target, "dist", "cli.js");
if (!fs.existsSync(cli)) {
  const unpack = path.join(versions, `.unpack-${v}`);
  fs.rmSync(unpack, { recursive: true, force: true });
  fs.mkdirSync(unpack, { recursive: true });
  const file = path.join(unpack, name);
  fs.writeFileSync(file, archive);
  execFileSync("tar", ["-xzf", file, "-C", unpack]);
  fs.rmSync(file);
  if (!fs.existsSync(path.join(unpack, "dist", "cli.js"))) fail("the package has no dist/cli.js.");
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(unpack, target);
}

const stateFile = path.join(home, "release.json");
let state = {};
try {
  state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
} catch {}
const previous = state.current && state.current.version !== v ? state.current : state.previous;
fs.writeFileSync(stateFile, `${JSON.stringify({ current: { version: v, cli }, ...(previous ? { previous } : {}) }, null, 2)}\n`);

const env = { ...process.env, AGENTFORGE_HOME: home, NODE_NO_WARNINGS: "1" };
const run = (args) => execFileSync(process.execPath, [cli, ...args], { cwd: home, env, stdio: "inherit" });
console.log("Registering the plugin with Claude Code…");
run(["install"]);
try {
  run(["backend", "restart"]);
} catch {
  console.error("The backend was not restarted (tasks may be running). Run `agentforge backend restart` once they finish.");
}
console.log(`\nAgentForge ${v} is installed in ${target}.\nIn Claude Code, run /reload-plugins (or start a new session).`);
