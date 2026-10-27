import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildBrief, readProjectNotes } from "./prompts.js";

const dirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-prompts-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("readProjectNotes", () => {
  it("finds the repo's notes from a subdirectory and adds the global notes", () => {
    const repo = tmp();
    const home = tmp();
    fs.mkdirSync(path.join(repo, ".git"));
    fs.mkdirSync(path.join(repo, ".agentforge"));
    fs.writeFileSync(path.join(repo, ".agentforge", "worker.md"), "Use mvn -o.\n");
    fs.writeFileSync(path.join(home, "worker.md"), "Shell is zsh.");
    const sub = path.join(repo, "a", "b");
    fs.mkdirSync(sub, { recursive: true });

    const notes = readProjectNotes(sub, home);
    expect(notes?.text).toBe("Use mvn -o.\n\nShell is zsh.");
    expect(notes?.files).toHaveLength(2);
  });

  it("stops at the repository root and returns nothing without notes", () => {
    const outer = tmp();
    fs.mkdirSync(path.join(outer, ".agentforge"));
    fs.writeFileSync(path.join(outer, ".agentforge", "worker.md"), "outer");
    const repo = path.join(outer, "repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    expect(readProjectNotes(repo, tmp())).toBeUndefined();
  });
});

describe("buildBrief", () => {
  it("puts project notes before the supervisor context and keeps the reading rule", () => {
    const brief = buildBrief({ task: "Do it", cwd: "/w", context: "ctx", projectNotes: "Use mvn -o." });
    expect(brief.indexOf("## Project notes")).toBeGreaterThan(-1);
    expect(brief.indexOf("## Project notes")).toBeLessThan(brief.indexOf("## Context from the supervisor"));
    expect(brief).toContain("read only the line ranges you need");
  });
});
