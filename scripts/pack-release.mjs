#!/usr/bin/env node
// Packs one release archive per platform from a built checkout, plus SHA256SUMS and notes.md.
// Production dependencies are installed per platform with npm's --os/--cpu, so one runner packs all.
//   node scripts/pack-release.mjs <out-dir> [<previous-tag>]
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PLATFORMS = ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64", "linux-arm64"];
const FILES = ["dist", "plugin", "commands", "examples", ".env.example", "package.json", "package-lock.json", "README.md", "README.en.md"];

const [out = "release", previousTag] = process.argv.slice(2);
const { version } = JSON.parse(fs.readFileSync("package.json", "utf8"));
if (!fs.existsSync("dist/cli.js")) throw new Error("Build first: dist/cli.js is missing.");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

/** Windows extracts symlinks only with privileges; the package needs none (node_modules/.bin is unused). */
function dropSymlinks(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) fs.rmSync(full, { force: true });
    else if (entry.isDirectory()) dropSymlinks(full);
  }
}

const sums = [];
for (const platform of PLATFORMS) {
  const [osName, cpu] = platform.split("-");
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), `agentforge-${platform}-`));
  for (const f of FILES) if (fs.existsSync(f)) fs.cpSync(f, path.join(stage, f), { recursive: true });
  fs.rmSync(path.join(stage, "plugin", ".claude-plugin", "types"), { recursive: true, force: true });
  execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", `--os=${osName}`, `--cpu=${cpu}`], { cwd: stage, stdio: "inherit" });
  if (!fs.existsSync(path.join(stage, "node_modules", "@cursor", `sdk-${platform}`))) throw new Error(`No @cursor/sdk-${platform} after npm ci.`);
  dropSymlinks(path.join(stage, "node_modules"));
  const name = `agentforge-${version}-${platform}.tar.gz`;
  execFileSync("tar", ["-czf", path.join(out, name), "-C", stage, "."]);
  sums.push(`${crypto.createHash("sha256").update(fs.readFileSync(path.join(out, name))).digest("hex")}  ${name}`);
  fs.rmSync(stage, { recursive: true, force: true });
  console.log(`packed ${name}`);
}
fs.writeFileSync(path.join(out, "SHA256SUMS"), `${sums.join("\n")}\n`);

const tagExists = (tag) => {
  try { execFileSync("git", ["rev-parse", "--verify", "--quiet", `${tag}^{commit}`], { stdio: "ignore" }); return true; } catch { return false; }
};
const range = previousTag && tagExists(previousTag) ? `${previousTag}..HEAD` : "HEAD";
const log = execFileSync("git", ["log", "--first-parent", "--pretty=- %s", "--max-count=50", range], { encoding: "utf8" }).trim();
fs.writeFileSync(path.join(out, "notes.md"), `${log || "- No changes listed."}\n`);
console.log(`notes from ${range}`);
