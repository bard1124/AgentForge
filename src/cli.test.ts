import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const cli = path.resolve("dist/cli.js");
const plugin = path.resolve("examples/workers/echo-worker.mjs");
let home: string;
let repo: string;

function run(args: string[], input?: string) {
  const res = spawnSync(process.execPath, ["--no-warnings", cli, ...args], {
    encoding: "utf8",
    input,
    env: { ...process.env, AGENTFORGE_HOME: home, AGENTFORGE_WORKERS: plugin, NO_COLOR: "1" },
  });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cf-cli-home-"));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "cf-cli-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("agentforge run / watch (echo plugin, built dist)", () => {
  it("streams steps, prints the report, and exits 0", () => {
    const { code, out } = run(["run", "--worker", "echo", "--cwd", repo, "add", "a", "README"]);
    expect(code).toBe(0);
    expect(out).toMatch(/think\s+Echoing the task back/);
    expect(out).toMatch(/tool\s+\+ echo add a README/);
    expect(out).not.toMatch(/not a git repository/);
    expect(out).toMatch(/Echo: add a README/);
    expect(out).toMatch(/budget turns=1\/30/);
    expect(out).toMatch(/tokens in=\d+/);
  });

  it("reads the task from stdin, accepts with --verify, and prints JSON", () => {
    const { code, out } = run(["run", "--worker", "echo", "--cwd", repo, "--verify", "true", "--json", "--quiet"], "from stdin");
    expect(code).toBe(0);
    const result = JSON.parse(out);
    expect(result.status).toBe("accepted");
    expect(result.finalReport).toBe("Echo: from stdin");
  });

  it("exits 2 when verification keeps failing", () => {
    const { code, out } = run(["run", "--worker", "echo", "--cwd", repo, "--verify", "exit 1", "--max-rework", "1", "fail"]);
    expect(code).toBe(2);
    expect(out).toMatch(/rework round sent/);
    expect(out).toMatch(/status: rejected/);
  });

  it("wait prints one line for a settled task and exits by outcome", () => {
    const dir = path.join(home, "tasks");
    const ids = fs.readdirSync(dir).filter((f) => /^cf-.*\.json$/.test(f)).map((f) => f.slice(0, -5));
    const record = (id: string) => JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8"));
    const accepted = ids.find((id) => record(id).status === "accepted")!;
    const rejected = ids.find((id) => record(id).status === "rejected")!;
    expect(run(["wait", accepted])).toMatchObject({ code: 0, out: expect.stringMatching(new RegExp(`^${accepted} accepted after \\d+ turn\\(s\\), [\\d.]+ min\\. Next: forge_result`)) });
    expect(run(["wait", rejected]).code).toBe(2);
    expect(run(["wait", "cf-00000000-000000"]).code).toBe(1);
  });

  it("exits 1 with a readable error when the task cannot start", () => {
    const { code, err } = run(["run", "--worker", "nope", "--cwd", repo, "x"]);
    expect(code).toBe(1);
    expect(err).toMatch(/Unknown worker "nope". Available: cursor, echo/);
  });

  it("watch replays a finished task", () => {
    const id = run(["tasks"]).out.split("\n")[0]!.split(" ")[0]!;
    const { code, out } = run(["watch", id]);
    expect(code).toBe(0);
    expect(out).toContain(id);
    expect(out).toMatch(/-- (accepted|rejected|finished) after \d+ turn/);
  });
});
