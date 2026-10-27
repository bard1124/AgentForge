import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { Forge } from "./forge.js";
import { createServer, waitCommand } from "./server.js";
import { TaskStore } from "./store.js";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cf-server-"));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

async function connect() {
  const config = { ...loadConfig({}), home, mcpConfigPath: path.join(home, "mcp.json") };
  const server = createServer(new Forge(config, new TaskStore(home), {}), home, config);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    return JSON.parse((res.content as { text: string }[])[0]!.text) as Record<string, unknown>;
  };
  return { client, call };
}

describe("sdd_task", () => {
  it("does not echo the document back on create or save", async () => {
    const { client, call } = await connect();
    const project = await call("sdd_task", { action: "create_project", project_name: "p" });
    const created = await call("sdd_task", { action: "create_task", project_id: project.id, title: "t", content: "# t\n\nlong plan" });
    expect(created).toMatchObject({ id: expect.any(String), path: expect.any(String), revision: expect.any(String) });
    expect(created).not.toHaveProperty("content");

    const read = await call("sdd_task", { action: "read_task", project_id: project.id, task_id: created.id });
    expect(read.content).toBe("# t\n\nlong plan");
    const saved = await call("sdd_task", { action: "save_task", project_id: project.id, task_id: created.id, content: "# t\n\nv2", base_revision: read.revision });
    expect(saved).not.toHaveProperty("content");
    expect(saved.revision).not.toBe(read.revision);
    await client.close();
  });
});

describe("waitCommand", () => {
  it("runs this CLI's wait for the task under the same home", () => {
    const cmd = waitCommand("/tmp/h", "cf-20260101-abcdef");
    expect(cmd).toMatch(/^AGENTFORGE_HOME="\/tmp\/h" ".+" ".+cli\.js" wait cf-20260101-abcdef$/);
  });
});
