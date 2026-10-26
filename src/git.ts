import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ChangeSummary, GitBaseline } from "./types.js";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

const STATUS_ARGS = ["status", "--porcelain=v1", "-z", "--untracked-files=all"];

/** Parses `git status --porcelain=v1 -z` output into status/path pairs. */
export function parsePorcelain(raw: string): { status: string; path: string }[] {
  const entries = raw.split("\0").filter(Boolean);
  const out: { status: string; path: string }[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const status = entry.slice(0, 2).trim() || "?";
    out.push({ status, path: entry.slice(3) });
    // Renames and copies carry the original path as the next NUL-separated entry.
    if (status.startsWith("R") || status.startsWith("C")) i++;
  }
  return out;
}

/** Git's well-known empty tree; the baseline for repositories with no commits yet. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

async function headOrEmptyTree(cwd: string): Promise<string> {
  try {
    return (await git(cwd, ["rev-parse", "--verify", "-q", "HEAD"])).trim() || EMPTY_TREE;
  } catch {
    return EMPTY_TREE;
  }
}

export async function captureBaseline(cwd: string): Promise<GitBaseline> {
  try {
    await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return { isRepo: false, dirty: [] };
  }
  const head = await headOrEmptyTree(cwd);
  const branch = (await git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "HEAD")).trim() || "HEAD";
  const dirty = parsePorcelain(await git(cwd, STATUS_ARGS)).map((e) => e.path);
  return { isRepo: true, head, branch, dirty };
}

export async function summarizeChanges(cwd: string, baseline: GitBaseline): Promise<ChangeSummary> {
  if (!baseline.isRepo || !baseline.head) {
    return { isRepo: false, commits: [], diffStat: "", files: [] };
  }
  const currentHead = await headOrEmptyTree(cwd);
  const range = baseline.head === EMPTY_TREE ? "HEAD" : `${baseline.head}..HEAD`;
  const commits =
    currentHead === baseline.head ? [] : (await git(cwd, ["log", "--oneline", range])).split("\n").filter(Boolean);
  const diffStat = (await git(cwd, ["diff", "--stat", baseline.head])).trim();
  const preExisting = new Set(baseline.dirty);
  const committed = (await git(cwd, ["diff", "--name-status", baseline.head, currentHead]))
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status = "?", ...rest] = line.split("\t");
      return { status: status.charAt(0), path: rest.at(-1) ?? "" };
    });
  const working = parsePorcelain(await git(cwd, STATUS_ARGS));
  const byPath = new Map<string, string>();
  for (const f of [...committed, ...working]) byPath.set(f.path, f.status);
  const files = [...byPath].map(([p, status]) => ({ status, path: p, preExisting: preExisting.has(p) }));
  return { isRepo: true, baseHead: baseline.head, currentHead, commits, diffStat, files };
}

async function untrackedDiff(cwd: string, file: string): Promise<string> {
  try {
    await git(cwd, ["diff", "--no-index", "--", "/dev/null", file]);
    return "";
  } catch (err) {
    // `git diff --no-index` exits 1 whenever the files differ.
    return (err as { stdout?: string }).stdout ?? "";
  }
}

export async function diffFor(cwd: string, baseline: GitBaseline, paths: string[], maxChars: number): Promise<string> {
  if (!baseline.isRepo || !baseline.head) return "";
  const untracked = new Set(
    parsePorcelain(await git(cwd, [...STATUS_ARGS, "--", ...paths]))
      .filter((e) => e.status === "??")
      .map((e) => e.path),
  );
  const tracked = paths.filter((p) => !untracked.has(p));
  let out = tracked.length ? await git(cwd, ["diff", baseline.head, "--", ...tracked]) : "";
  for (const file of untracked) out += await untrackedDiff(cwd, file);
  return out.length > maxChars ? `${out.slice(0, maxChars)}\n... [truncated ${out.length - maxChars} chars]` : out;
}
