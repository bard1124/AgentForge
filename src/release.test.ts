import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assetName, checksumFor, compareVersions, isReleaseInstall, notesBetween, pickRelease, pruneVersions, type ReleaseInfo, SUMS_ASSET } from "./release.js";

const rel = (version: string, prerelease = version.includes("-"), platforms = ["darwin-arm64"]): ReleaseInfo => ({
  version,
  prerelease,
  notes: `- notes for ${version}`,
  assets: Object.fromEntries([...platforms.map((p) => [assetName(version, p), `https://x/${version}/${p}`]), [SUMS_ASSET, `https://x/${version}/sums`]]),
});

describe("release versions", () => {
  it("orders semver with prereleases before their release", () => {
    const sorted = ["0.6.2", "0.6.10", "0.6.2-beta.1", "0.6.2-beta.0", "0.7.0-beta.0", "0.6.9"].sort(compareVersions);
    expect(sorted).toEqual(["0.6.2-beta.0", "0.6.2-beta.1", "0.6.2", "0.6.9", "0.6.10", "0.7.0-beta.0"]);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
  });

  it("picks the newest release on the channel that ships this platform", () => {
    const releases = [rel("0.6.3-beta.0"), rel("0.6.2"), rel("0.6.1"), rel("0.6.4", false, ["win32-x64"])];
    expect(pickRelease(releases, "0.6.1", "stable", "darwin-arm64")?.version).toBe("0.6.2");
    expect(pickRelease(releases, "0.6.1", "beta", "darwin-arm64")?.version).toBe("0.6.3-beta.0");
    expect(pickRelease(releases, "0.6.2", "stable", "darwin-arm64")).toBeUndefined();
    expect(pickRelease(releases, "0.6.2", "stable", "darwin-arm64", true)?.version).toBe("0.6.2");
    expect(pickRelease(releases, "0.6.2", "stable", "win32-x64")?.version).toBe("0.6.4");
  });

  it("collects notes between the current and the target version, newest first", () => {
    const releases = [rel("0.6.3-beta.0"), rel("0.6.2"), rel("0.6.1"), rel("0.6.0")];
    const notes = notesBetween(releases, "0.6.0", releases[1]!, "stable");
    expect(notes).toBe("0.6.2\n- notes for 0.6.2\n\n0.6.1\n- notes for 0.6.1");
  });

  it("reads checksums and recognizes release installs", () => {
    const hex = "a".repeat(64);
    expect(checksumFor(`${hex}  agentforge-1.0.0-darwin-arm64.tar.gz\n${"b".repeat(64)} *other`, "agentforge-1.0.0-darwin-arm64.tar.gz")).toBe(hex);
    expect(checksumFor("", "x")).toBeUndefined();
    expect(isReleaseInstall("/h/versions/1.0.0", "/h")).toBe(true);
    expect(isReleaseInstall("/src/AgentForge", "/h")).toBe(false);
    expect(isReleaseInstall("/h/versions", "/h")).toBe(false);
  });

  it("prunes versions except the kept ones and partial downloads", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cf-rel-"));
    for (const d of ["0.6.0", "0.6.1", "0.6.2", ".unpack-0.6.3"]) fs.mkdirSync(path.join(home, "versions", d), { recursive: true });
    pruneVersions(home, ["0.6.2", "0.6.1"]);
    expect(fs.readdirSync(path.join(home, "versions")).sort()).toEqual([".unpack-0.6.3", "0.6.1", "0.6.2"]);
    fs.rmSync(home, { recursive: true, force: true });
  });
});
