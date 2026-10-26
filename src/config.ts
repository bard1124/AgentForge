import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelParameterValue, SettingSource } from "@cursor/sdk";

const SETTING_SOURCES: readonly SettingSource[] = ["project", "user", "team", "mdm", "plugins", "all"];

function parseSettingSources(raw: string | undefined): SettingSource[] {
  if (raw === undefined) return ["project"];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is SettingSource => (SETTING_SOURCES as readonly string[]).includes(s));
}

/** Parses `id=value,id=value` into model parameters. */
export function parseModelParams(raw: string | undefined): ModelParameterValue[] {
  if (!raw?.trim()) return [];
  return raw.split(",").map((pair) => {
    const [id, ...rest] = pair.split("=");
    const value = rest.join("=").trim();
    if (!id?.trim() || !value) throw new Error(`Invalid model param "${pair}", expected id=value`);
    return { id: id.trim(), value };
  });
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = Number.parseInt(env[name] ?? "", 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

function list(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function setting(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}

export function defaultHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDEFORGE_HOME ?? path.join(os.homedir(), ".claudeforge");
}

/**
 * Loads `CLAUDEFORGE_ENV_FILE`, or `<home>/.env` when it exists. Variables already set in the
 * environment win. The project's own `.env` is deliberately not read: it belongs to the repo being
 * worked on, not to AgentForge.
 */
export function loadEnvFiles(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = env.CLAUDEFORGE_ENV_FILE ?? path.join(defaultHome(env), ".env");
  if (!fs.existsSync(file)) {
    if (env.CLAUDEFORGE_ENV_FILE) throw new Error(`CLAUDEFORGE_ENV_FILE not found: ${file}`);
    return undefined;
  }
  process.loadEnvFile(file);
  return file;
}

export interface ForgeConfig {
  home: string;
  apiKey?: string;
  /** Executor used until the board picks one. */
  worker: string;
  model: string;
  modelParams: ModelParameterValue[];
  settingSources: SettingSource[];
  autoReview: boolean;
  maxRework: number;
  maxTurns: number;
  maxTaskMs: number;
  maxStepsKept: number;
  verifyTimeoutMs: number;
  stallWarnSec: number;
  startTimeoutMs: number;
  mcpConfigPath: string;
  workerModules: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ForgeConfig {
  const home = defaultHome(env);
  return {
    home,
    apiKey: env.CURSOR_API_KEY?.trim() || undefined,
    worker: setting(env, "CLAUDEFORGE_WORKER") ?? "cursor",
    model: setting(env, "CLAUDEFORGE_MODEL") ?? "composer-2.5",
    modelParams: parseModelParams(setting(env, "CLAUDEFORGE_MODEL_PARAMS")),
    settingSources: parseSettingSources(env.CLAUDEFORGE_SETTING_SOURCES),
    autoReview: env.CLAUDEFORGE_AUTO_REVIEW === "1",
    maxRework: intEnv(env, "CLAUDEFORGE_MAX_REWORK", 3),
    maxTurns: intEnv(env, "CLAUDEFORGE_MAX_TURNS", 20),
    maxTaskMs: intEnv(env, "CLAUDEFORGE_MAX_TASK_MINUTES", 60) * 60_000,
    maxStepsKept: intEnv(env, "CLAUDEFORGE_MAX_STEPS", 300),
    verifyTimeoutMs: intEnv(env, "CLAUDEFORGE_VERIFY_TIMEOUT_SEC", 900) * 1000,
    stallWarnSec: intEnv(env, "CLAUDEFORGE_STALL_WARN_SEC", 120),
    startTimeoutMs: intEnv(env, "CLAUDEFORGE_START_TIMEOUT_SEC", 300) * 1000,
    mcpConfigPath: env.CLAUDEFORGE_MCP_CONFIG ?? path.join(home, "mcp.json"),
    workerModules: list(env.CLAUDEFORGE_WORKERS),
  };
}
