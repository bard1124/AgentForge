#!/usr/bin/env node
// Fails unless HEAD's package.json version is higher than <base>'s and package-lock.json agrees with it.
// Every push to main ships to users through the board's updater, which shows this version.
// Usage: node scripts/check-version.mjs <base-ref> [<head-ref>]
import { execFileSync } from "node:child_process";

const [base, head = "HEAD"] = process.argv.slice(2);
if (!base || /^0+$/.test(base)) process.exit(0);

const show = (ref, file) => JSON.parse(execFileSync("git", ["show", `${ref}:${file}`], { encoding: "utf8" }));
const parts = (v) => v.split(/[.-]/).slice(0, 3).map(Number);
const newer = (a, b) => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

if (execFileSync("git", ["rev-list", "--count", `${base}..${head}`], { encoding: "utf8" }).trim() === "0") process.exit(0);
const before = show(base, "package.json").version;
const after = show(head, "package.json").version;
const lock = show(head, "package-lock.json");
const errors = [];
if (!newer(after, before)) errors.push(`package.json version is ${after}, not higher than ${before} at ${base}.`);
if (lock.version !== after || lock.packages?.[""]?.version !== after) errors.push(`package-lock.json says ${lock.version}; it must match package.json (${after}).`);
if (errors.length) {
  console.error(`Version check failed:\n- ${errors.join("\n- ")}\nBump it with \`npm run bump\` (patch; or \`npm run bump -- minor\`), commit, then push.`);
  process.exit(1);
}
console.log(`Version ${before} -> ${after}.`);
