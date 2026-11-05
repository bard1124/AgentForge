import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const RELEASE_REPO = "bard1124/AgentForge";

export type Channel = "stable" | "beta";

export interface ReleaseInfo {
  version: string;
  prerelease: boolean;
  notes: string;
  /** Asset file name to download URL. */
  assets: Record<string, string>;
}

/** The asset suffix for this machine, e.g. darwin-arm64 or win32-x64. */
export function platformId(platform: string = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`;
}

export const assetName = (version: string, platform = platformId()) => `agentforge-${version}-${platform}.tar.gz`;
export const SUMS_ASSET = "SHA256SUMS";

type Parsed = { core: number[]; pre?: (number | string)[] };
const parse = (v: string): Parsed => {
  const [core = "", pre] = v.replace(/^v/, "").split("-", 2);
  return { core: core.split(".").map(Number), pre: pre === undefined ? undefined : pre.split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)) };
};

/** Semver order: negative when a < b. 0.6.2-beta.1 < 0.6.2-beta.2 < 0.6.2. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if ((x.core[i] ?? 0) !== (y.core[i] ?? 0)) return (x.core[i] ?? 0) - (y.core[i] ?? 0);
  if (!x.pre || !y.pre) return x.pre ? -1 : y.pre ? 1 : 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === q) continue;
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (typeof p === typeof q) return p < q ? -1 : 1;
    return typeof p === "number" ? -1 : 1;
  }
  return 0;
}

export const isPrerelease = (version: string) => version.includes("-");

type Fetch = typeof fetch;

export async function listReleases(fetchFn: Fetch = fetch, repo = RELEASE_REPO): Promise<ReleaseInfo[]> {
  const res = await fetchFn(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "agentforge-updater" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GitHub releases: HTTP ${res.status}`);
  const body = (await res.json()) as { tag_name: string; draft: boolean; prerelease: boolean; body?: string; assets: { name: string; browser_download_url: string }[] }[];
  return body
    .filter((r) => !r.draft && /^v\d/.test(r.tag_name))
    .map((r) => ({
      version: r.tag_name.slice(1),
      prerelease: r.prerelease || isPrerelease(r.tag_name),
      notes: (r.body ?? "").trim(),
      assets: Object.fromEntries(r.assets.map((a) => [a.name, a.browser_download_url])),
    }));
}

const onChannel = (r: ReleaseInfo, channel: Channel) => channel === "beta" || !r.prerelease;

/** The newest release on the channel above `current` (or at it, with `orEqual`) that ships this platform's asset. */
export function pickRelease(releases: ReleaseInfo[], current: string, channel: Channel, platform = platformId(), orEqual = false): ReleaseInfo | undefined {
  return releases
    .filter((r) => onChannel(r, channel) && compareVersions(r.version, current) >= (orEqual ? 0 : 1) && r.assets[assetName(r.version, platform)] && r.assets[SUMS_ASSET])
    .sort((a, b) => compareVersions(b.version, a.version))[0];
}

/** Notes of the releases after `current` up to `target`, newest first. */
export function notesBetween(releases: ReleaseInfo[], current: string, target: ReleaseInfo, channel: Channel): string {
  return releases
    .filter((r) => onChannel(r, channel) && compareVersions(r.version, current) > 0 && compareVersions(r.version, target.version) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version))
    .slice(0, 10)
    .map((r) => `${r.version}\n${r.notes || "- (no notes)"}`)
    .join("\n\n");
}

export const versionsDir = (home: string) => path.join(home, "versions");

/** Where release installs live; a backend running from here updates by release, not git. */
export function isReleaseInstall(root: string, home: string): boolean {
  const rel = path.relative(versionsDir(home), root);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** A developer's clone, marked by a `.agentforge-dev` file; it keeps updating with git. */
export function isDevCheckout(root: string): boolean {
  return fs.existsSync(path.join(root, ".git")) && fs.existsSync(path.join(root, ".agentforge-dev"));
}

export interface ReleaseState {
  current?: { version: string; cli: string };
  previous?: { version: string; cli: string };
}

const stateFile = (home: string) => path.join(home, "release.json");

export function readReleaseState(home: string): ReleaseState {
  try {
    return JSON.parse(fs.readFileSync(stateFile(home), "utf8")) as ReleaseState;
  } catch {
    return {};
  }
}

export function writeReleaseState(home: string, state: ReleaseState): void {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(stateFile(home), `${JSON.stringify(state, null, 2)}\n`);
}

async function download(fetchFn: Fetch, url: string, file: string): Promise<void> {
  const res = await fetchFn(url, { headers: { "user-agent": "agentforge-updater" }, redirect: "follow", signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok) throw new Error(`Download ${path.basename(file)}: HTTP ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

/** Expected sha256 for `name` from a SHA256SUMS file (`<hex>  <name>` lines). */
export function checksumFor(sums: string, name: string): string | undefined {
  for (const line of sums.split("\n")) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(line.trim());
    if (m && m[2] === name) return m[1]!.toLowerCase();
  }
  return undefined;
}

/**
 * Downloads this platform's package, checks it against SHA256SUMS, and unpacks it into
 * `versions/<version>`. Returns that version's cli. Nothing outside the versions directory changes.
 */
export async function fetchRelease(home: string, release: ReleaseInfo, fetchFn: Fetch = fetch, platform = platformId()): Promise<string> {
  const name = assetName(release.version, platform);
  const url = release.assets[name];
  const sumsUrl = release.assets[SUMS_ASSET];
  if (!url || !sumsUrl) throw new Error(`Release ${release.version} has no package for ${platform}.`);
  const dir = versionsDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const archive = path.join(dir, `.download-${name}`);
  const staging = path.join(dir, `.unpack-${release.version}`);
  const target = path.join(dir, release.version);
  try {
    const sumsFile = `${archive}.sums`;
    await download(fetchFn, sumsUrl, sumsFile);
    const expected = checksumFor(fs.readFileSync(sumsFile, "utf8"), name);
    fs.rmSync(sumsFile, { force: true });
    if (!expected) throw new Error(`SHA256SUMS of ${release.version} lists no ${name}.`);
    await download(fetchFn, url, archive);
    const actual = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
    if (actual !== expected) throw new Error(`Checksum mismatch for ${name}; the download is corrupt or was altered.`);
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    await run("tar", ["-xzf", archive, "-C", staging], { timeout: 5 * 60_000, windowsHide: true });
    if (!fs.existsSync(path.join(staging, "dist", "cli.js"))) throw new Error(`Package ${name} has no dist/cli.js.`);
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
  } finally {
    fs.rmSync(archive, { force: true });
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return path.join(target, "dist", "cli.js");
}

/** Removes installed versions other than the ones kept (current and previous). */
export function pruneVersions(home: string, keep: string[]): void {
  const dir = versionsDir(home);
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith(".") || keep.includes(entry)) continue;
    try {
      fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    } catch {
      // Windows keeps files of a running process locked; the next update removes it.
    }
  }
}
