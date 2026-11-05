#!/usr/bin/env node
// Raises the version in package.json, package-lock.json and the plugin manifest.
//   npm run bump                 patch: 0.6.1 -> 0.6.2, or a beta's stable release: 0.6.2-beta.1 -> 0.6.2
//   npm run bump -- minor|major
//   npm run bump -- beta         prerelease on the beta channel: 0.6.1 -> 0.6.2-beta.0, 0.6.2-beta.0 -> 0.6.2-beta.1
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const level = process.argv[2] ?? "patch";
const current = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const args = {
  patch: ["patch"],
  minor: ["minor"],
  major: ["major"],
  beta: current.includes("-beta.") ? ["prerelease", "--preid=beta"] : ["prepatch", "--preid=beta"],
}[level];
if (!args) throw new Error(`Unknown level "${level}"; use patch, minor, major or beta.`);
execFileSync("npm", ["version", ...args, "--no-git-tag-version"], { stdio: "inherit", shell: process.platform === "win32" });

const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const manifest = "plugin/.claude-plugin/plugin.json";
fs.writeFileSync(manifest, fs.readFileSync(manifest, "utf8").replace(/"version": "[^"]*"/, `"version": "${version}"`));
