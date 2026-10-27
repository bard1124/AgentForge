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

/** Before 0.5.1 the variables were prefixed `CLAUDEFORGE_`; those still apply when the new name is unset. */
const LEGACY_PREFIX = "CLAUDEFORGE_";

/** `AGENTFORGE_<name>`, falling back to the pre-rename variable. */
export function envVar(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[`AGENTFORGE_${name}`] ?? env[`${LEGACY_PREFIX}${name}`];
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = Number.parseInt(envVar(env, name) ?? "", 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

function list(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function setting(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return envVar(env, name)?.trim() || undefined;
}

export const HOME_DIR = path.join(os.homedir(), ".agentforge");
/** The data directory before 0.5.1; `install` moves it to HOME_DIR. */
export const LEGACY_HOME_DIR = path.join(os.homedir(), ".claudeforge");

export function defaultHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = envVar(env, "HOME");
  if (explicit) return explicit;
  return !fs.existsSync(HOME_DIR) && fs.existsSync(LEGACY_HOME_DIR) ? LEGACY_HOME_DIR : HOME_DIR;
}

/**
 * Loads `AGENTFORGE_ENV_FILE`, or `<home>/.env` when it exists. Variables already set in the
 * environment win. The project's own `.env` is deliberately not read: it belongs to the repo being
 * worked on, not to AgentForge.
 */
export function loadEnvFiles(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = envVar(env, "ENV_FILE");
  const file = explicit ?? path.join(defaultHome(env), ".env");
  if (!fs.existsSync(file)) {
    if (explicit) throw new Error(`AGENTFORGE_ENV_FILE not found: ${file}`);
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
  /** Automatic continuations after a transient turn failure; 0 or 1. */
  autoRetry: number;
  mcpConfigPath: string;
  workerModules: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ForgeConfig {
  const home = defaultHome(env);
  return {
    home,
    apiKey: env.CURSOR_API_KEY?.trim() || undefined,
    worker: setting(env, "WORKER") ?? "cursor",
    model: setting(env, "MODEL") ?? "composer-2.5",
    modelParams: parseModelParams(setting(env, "MODEL_PARAMS")),
    settingSources: parseSettingSources(envVar(env, "SETTING_SOURCES")),
    autoReview: envVar(env, "AUTO_REVIEW") === "1",
    maxRework: intEnv(env, "MAX_REWORK", 3),
    maxTurns: intEnv(env, "MAX_TURNS", 20),
    maxTaskMs: intEnv(env, "MAX_TASK_MINUTES", 60) * 60_000,
    maxStepsKept: intEnv(env, "MAX_STEPS", 300),
    verifyTimeoutMs: intEnv(env, "VERIFY_TIMEOUT_SEC", 900) * 1000,
    stallWarnSec: intEnv(env, "STALL_WARN_SEC", 120),
    startTimeoutMs: intEnv(env, "START_TIMEOUT_SEC", 300) * 1000,
    autoRetry: Math.min(intEnv(env, "AUTO_RETRY", 1), 1),
    mcpConfigPath: envVar(env, "MCP_CONFIG") ?? path.join(home, "mcp.json"),
    workerModules: list(envVar(env, "WORKERS")),
  };
}
