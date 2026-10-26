import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const cli = path.resolve("dist/cli.js");
let home: string;

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cf-proxy-"));
});
afterAll(() => {
  try {
    execFileSync(process.execPath, [cli, "backend", "stop", "--force"], { env: { ...process.env, AGENTFORGE_HOME: home } });
  } catch {
    // already stopped
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe("stdio relay", () => {
  it("holds messages pipelined behind initialize until the session exists", async () => {
    const child = spawn(process.execPath, [cli, "serve"], { env: { ...process.env, AGENTFORGE_HOME: home, NODE_NO_WARNINGS: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

    const deadline = Date.now() + 20_000;
    while (out.trim().split("\n").filter(Boolean).length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    child.kill();
    const replies = out.trim().split("\n").map((l) => JSON.parse(l) as { id: number; error?: unknown; result?: { tools?: unknown[] } });
    expect(replies.map((r) => r.id).sort()).toEqual([1, 2]);
    expect(replies.every((r) => !r.error)).toBe(true);
    expect(replies.find((r) => r.id === 2)?.result?.tools?.length).toBeGreaterThan(5);
    expect(err).not.toMatch(/Unknown MCP session/);
  }, 30_000);
});
