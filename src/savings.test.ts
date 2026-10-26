import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { Forge } from "./forge.js";
import { readTraffic, savingsSummary, trafficFile } from "./savings.js";
import { createServer } from "./server.js";
import { TaskStore } from "./store.js";
import type { Turn } from "./types.js";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cf-savings-"));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const now = new Date(2026, 9, 26, 14, 0);
const local = (daysAgo: number, hour: number) => new Date(2026, 9, 26 - daysAgo, hour).toISOString();
const turn = (totalTokens: number): Turn => ({
  index: 0,
  prompt: "p",
  status: "finished",
  startedAt: "",
  usage: { inputTokens: totalTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens },
});
const ledger = (lines: string[]) => fs.writeFileSync(trafficFile(home), `${lines.join("\n")}\n`);
const line = (at: string, tokens: number) => JSON.stringify({ at, tool: "forge_status", tokens });

describe("savingsSummary", () => {
  it("splits by local day: today since midnight, the week as the last 7 days, and all time", () => {
    const tasks = [
      { createdAt: local(0, 0), turns: [turn(1000), turn(1000)] },
      { createdAt: local(1, 23), turns: [turn(4000)] },
      { createdAt: local(6, 0), turns: [turn(1000)] },
      { createdAt: local(7, 23), turns: [turn(2000)] },
    ];
    ledger([line(local(0, 9), 500), line(local(1, 23), 1000), line(local(6, 0), 100), line(local(30, 12), 9000)]);
    const s = savingsSummary(home, tasks, now);
    expect(s.today).toEqual({ delegatedTokens: 2000, claudeTokens: 500, savedPct: 75 });
    expect(s.week).toEqual({ delegatedTokens: 7000, claudeTokens: 1600, savedPct: 77 });
    expect(s.all).toEqual({ delegatedTokens: 9000, claudeTokens: 10600, savedPct: -18 });
  });

  it("is null when nothing was delegated, even with Claude traffic", () => {
    ledger([line(local(0, 9), 300)]);
    const s = savingsSummary(home, [{ createdAt: local(0, 1), turns: [{ ...turn(0), usage: undefined }] }], now);
    expect(s.today).toEqual({ delegatedTokens: 0, claudeTokens: 300, savedPct: null });
  });

  it("reads a missing ledger as empty and skips corrupt lines", () => {
    expect(savingsSummary(home, [], now).all).toEqual({ delegatedTokens: 0, claudeTokens: 0, savedPct: null });
    ledger([line(local(0, 9), 10), "{not json", JSON.stringify({ at: "yesterday", tokens: 5 }), JSON.stringify({ at: local(0, 9), tokens: "7" }), '{"at":"', line(local(0, 10), 20)]);
    expect(readTraffic(home)).toHaveLength(2);
    expect(savingsSummary(home, [], now).today.claudeTokens).toBe(30);
  });
});

describe("Claude traffic ledger", () => {
  it("gets one line per MCP tool call, errors included", async () => {
    const config = { ...loadConfig({}), home, mcpConfigPath: path.join(home, "mcp.json") };
    const forge = new Forge(config, new TaskStore(home), {});
    const server = createServer(forge, home, config);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(clientSide);

    const listed = await client.callTool({ name: "forge_list", arguments: {} });
    const failed = await client.callTool({ name: "forge_status", arguments: { task_id: "cf-nope" } });
    expect(failed.isError).toBe(true);
    await client.close();

    const entries = readTraffic(home);
    expect(entries.map((e) => e.tool)).toEqual(["forge_list", "forge_status"]);
    expect(entries[0]!.tokens).toBe(1 + Math.ceil((listed.content as { text: string }[])[0]!.text.length / 4));
    expect(entries[1]!.tokens).toBeGreaterThan(0);
  });
});
