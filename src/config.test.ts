import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, loadEnvFiles, parseModelParams } from "./config.js";
import { loadWorkers } from "./workers/registry.js";

describe("parseModelParams", () => {
  it("parses id=value pairs", () => {
    expect(parseModelParams("reasoning=high, fast=true")).toEqual([
      { id: "reasoning", value: "high" },
      { id: "fast", value: "true" },
    ]);
    expect(parseModelParams(undefined)).toEqual([]);
    expect(() => parseModelParams("reasoning")).toThrow(/expected id=value/);
  });
});

describe("loadEnvFiles", () => {
  it("loads <home>/.env without overriding variables already set", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cf-env-"));
    fs.writeFileSync(path.join(home, ".env"), "CF_ENV_A=file\nCF_ENV_B=file\n");
    process.env.CF_ENV_A = "shell";
    try {
      expect(loadEnvFiles({ CLAUDEFORGE_HOME: home })).toBe(path.join(home, ".env"));
      expect(process.env.CF_ENV_A).toBe("shell");
      expect(process.env.CF_ENV_B).toBe("file");
    } finally {
      delete process.env.CF_ENV_A;
      delete process.env.CF_ENV_B;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("is a no-op without a file but fails loudly on an explicit missing file", () => {
    expect(loadEnvFiles({ CLAUDEFORGE_HOME: "/nonexistent-cf-home" })).toBeUndefined();
    expect(() => loadEnvFiles({ CLAUDEFORGE_ENV_FILE: "/nonexistent.env" })).toThrow(/not found/);
  });
});

describe("worker defaults", () => {
  it("read CLAUDEFORGE_* and treat empty values as unset", () => {
    expect(loadConfig({ CLAUDEFORGE_MODEL: "env-model", CLAUDEFORGE_WORKER: "echo", CLAUDEFORGE_MODEL_PARAMS: "reasoning=high" })).toMatchObject({
      model: "env-model",
      worker: "echo",
      modelParams: [{ id: "reasoning", value: "high" }],
    });
    expect(loadConfig({ CLAUDEFORGE_MODEL: "", CLAUDEFORGE_WORKER: " " })).toMatchObject({ model: "composer-2.5", worker: "cursor" });
  });
});

describe("loadWorkers", () => {
  it("loads plugin workers next to the built-in one", async () => {
    const plugin = path.resolve("examples/workers/echo-worker.mjs");
    const workers = await loadWorkers({ ...loadConfig({}), workerModules: [plugin] });
    expect(Object.keys(workers)).toEqual(["cursor", "echo"]);
    await expect(loadWorkers({ ...loadConfig({}), workerModules: [plugin, plugin] })).rejects.toThrow(/Duplicate worker name "echo"/);
  });
});
