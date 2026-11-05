#!/usr/bin/env node
// Raises the version in package.json and package-lock.json: `npm run bump` (patch) or `npm run bump -- minor|major`.
import { execFileSync } from "node:child_process";

const level = process.argv[2] ?? "patch";
if (!["patch", "minor", "major"].includes(level)) throw new Error(`Unknown level "${level}"; use patch, minor or major.`);
execFileSync("npm", ["version", level, "--no-git-tag-version"], { stdio: "inherit", shell: process.platform === "win32" });
