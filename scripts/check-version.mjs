#!/usr/bin/env node
// Fails unless HEAD's package.json version is higher than <base>'s and package-lock.json agrees with it.
// Every push to main ships to users through the board's updater, which shows this version.
// Usage: node scripts/check-version.mjs <base-ref> [<head-ref>]
import { execFileSync } from "node:child_process";

const [base, head = "HEAD"] = process.argv.slice(2);
if (!base || /^0+$/.test(base)) process.exit(0);

const show = (ref, file) => JSON.parse(execFileSync("git", ["show", `${ref}:${file}`], { encoding: "utf8" }));
// Semver order: 0.6.2-beta.1 < 0.6.2-beta.2 < 0.6.2.
const parse = (v) => {
  const [core, pre] = v.split("-", 2);
  return { core: core.split(".").map(Number), pre: pre === undefined ? undefined : pre.split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)) };
};
const newer = (a, b) => {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] > y.core[i];
  if (!x.pre || !y.pre) return !x.pre && !!y.pre;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === q) continue;
    if (p === undefined) return false;
    if (q === undefined) return true;
    return typeof p === typeof q ? p > q : typeof p === "string";
  }
  return false;
};

if (execFileSync("git", ["rev-list", "--count", `${base}..${head}`], { encoding: "utf8" }).trim() === "0") process.exit(0);
const before = show(base, "package.json").version;
const after = show(head, "package.json").version;
const lock = show(head, "package-lock.json");
const manifest = show(head, "plugin/.claude-plugin/plugin.json");
const errors = [];
if (!newer(after, before)) errors.push(`package.json version is ${after}, not higher than ${before} at ${base}.`);
if (lock.version !== after || lock.packages?.[""]?.version !== after) errors.push(`package-lock.json says ${lock.version}; it must match package.json (${after}).`);
if (manifest.version !== after) errors.push(`plugin/.claude-plugin/plugin.json says ${manifest.version}; it must match package.json (${after}).`);
if (errors.length) {
  console.error(`Version check failed:\n- ${errors.join("\n- ")}\nBump it with \`npm run bump\` (patch; or \`-- minor\`, \`-- beta\`), commit, then push.`);
  process.exit(1);
}
console.log(`Version ${before} -> ${after}.`);
