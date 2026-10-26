#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Cursor } from "@cursor/sdk";
import { type ForgeConfig, loadConfig, loadEnvFiles } from "./config.js";
import { type DelegationChange, delegationFile, readDelegation, writeDelegation } from "./delegation.js";
import { out, routeConsoleToStderr } from "./output.js";
import { commandLine, isWindows } from "./platform.js";
import { TaskStore } from "./store.js";

const HELP = `AgentForge - let Claude Code dispatch work to Cursor agents.

Usage:
  agentforge serve                 MCP on stdio, relayed to the shared backend (what Claude Code launches)
  agentforge backend status|start|stop|restart [--force]
                                    Manage the shared agentforge-backend (one per CLAUDEFORGE_HOME)
  agentforge run [options] <task>  Dispatch a task without Claude Code and stream it (run --help)
  agentforge watch <task_id>       Follow a task's steps live from another terminal
  agentforge monitor [--once | --json | --web [--port 18862]] [--limit n]
                                    Read-only monitor: live terminal view, one snapshot, JSON, or a local web page
  agentforge tasks                 List recent tasks
  agentforge show <task_id>        Print a task record as JSON
  agentforge login                 Sign in to Cursor in the browser (stores an SDK API key)
  agentforge logout
  agentforge whoami                Show Cursor auth status
  agentforge models                List Cursor models and their parameters
  agentforge install [--scope user|project|local] [--worker <name>] [--claude <path>]
                                    Install the plugin (MCP tools, prompt hook, board, /forge) into Claude Code
  agentforge on | off              Turn auto-dispatch on or off (same switch as the board; next message)
  agentforge config [show | set key=value ...]
                                    Board settings: enabled, executor, model, effort, permission, sdd, sdd-workspace
  agentforge uninstall [--claude <path>]
                                    Remove the plugin
  agentforge update [status|check|apply]
                                    Plugin updates from origin: fast-forward only, never with local changes or running tasks

Configuration is read from the environment, then from CLAUDEFORGE_ENV_FILE or
~/.claudeforge/.env (see .env.example). Main variables:
  CURSOR_API_KEY                    Cursor API key (otherwise uses \`agentforge login\`)
  CLAUDEFORGE_MODEL                 Default worker model (composer-2.5)
  CLAUDEFORGE_MODEL_PARAMS          Default model parameters, e.g. reasoning=high
  CLAUDEFORGE_MAX_TURNS             Turn budget per task (20)
  CLAUDEFORGE_MAX_TASK_MINUTES      Worker time budget per task (60)
  CLAUDEFORGE_MCP_CONFIG            MCP servers workers may use (~/.claudeforge/mcp.json)
  CLAUDEFORGE_WORKERS               Extra worker plugin modules, comma separated
  CLAUDEFORGE_HOME                  State directory (~/.claudeforge)
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const MARKETPLACE = "agentforge-local";
const PLUGIN = `agentforge@${MARKETPLACE}`;

interface Installation {
  claude: string;
  scope: string;
  installedAt: string;
}

const installationFile = (home: string) => path.join(home, "plugin-installation.json");

function readInstallation(home: string): Installation | undefined {
  try {
    return JSON.parse(fs.readFileSync(installationFile(home), "utf8")) as Installation;
  } catch {
    return undefined;
  }
}

/** The Claude Code CLI: `--claude`, then the one recorded at install, then PATH. */
function claudeBin(args: string[], home: string): string {
  return flag(args, "--claude") ?? readInstallation(home)?.claude ?? "claude";
}

let claudeCli = "claude";

function claude(args: string[], quiet = false): boolean {
  try {
    const run = commandLine(claudeCli, args);
    execFileSync(run.file, run.args, { stdio: quiet ? "ignore" : "inherit", shell: run.shell, windowsHide: true });
    return true;
  } catch (err) {
    // cmd.exe reports a missing command as exit status 9009.
    if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as { status?: number }).status === 9009) {
      throw new Error(`Claude Code CLI not found at "${claudeCli}". Pass its path with --claude <path>.`);
    }
    return false;
  }
}

/** Quotes a hook argument; on Windows the hook may run under cmd.exe or Git Bash, and forward slashes read the same in both. */
function quote(arg: string): string {
  if (isWindows) return `"${arg.replaceAll("\\", "/")}"`;
  return `"${arg.replaceAll(/(["\\$`])/g, "\\$1")}"`;
}

/** The product was named ClaudeForge before 0.5; its plugin, marketplace, and bare MCP server used that name. */
const LEGACY_NAME = "claudeforge";
const LEGACY_MARKETPLACE = `${LEGACY_NAME}-local`;

/** Earlier versions registered a bare MCP server, a user command, and a plugin under the old name; the plugin replaces them. */
function removeLegacyInstall(scope: string, home: string): void {
  claude(["mcp", "remove", "--scope", scope, LEGACY_NAME], true);
  claude(["plugin", "uninstall", `${LEGACY_NAME}@${LEGACY_MARKETPLACE}`, "--scope", scope], true);
  claude(["plugin", "marketplace", "remove", LEGACY_MARKETPLACE], true);
  fs.rmSync(path.join(home, "marketplace", LEGACY_NAME), { recursive: true, force: true });
  const legacyCommand = path.join(os.homedir(), ".claude", "commands", "forge.md");
  if (fs.existsSync(legacyCommand) && /ClaudeForge|AgentForge/.test(fs.readFileSync(legacyCommand, "utf8"))) fs.rmSync(legacyCommand);
}

/** Writes a local marketplace holding the plugin; the MCP server runs from this checkout's dist/. */
function writeMarketplace(home: string): string {
  const entry = fileURLToPath(import.meta.url);
  const root = path.resolve(path.dirname(entry), "..");
  const dir = path.join(home, "marketplace");
  const pluginDir = path.join(dir, "agentforge");
  fs.rmSync(pluginDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  const authoringTypes = path.join(root, "plugin", ".claude-plugin", "types");
  fs.cpSync(path.join(root, "plugin"), pluginDir, { recursive: true, filter: (src) => !src.startsWith(authoringTypes) });
  fs.mkdirSync(path.join(pluginDir, "commands"), { recursive: true });
  fs.copyFileSync(path.join(root, "commands", "forge.md"), path.join(pluginDir, "commands", "forge.md"));

  const env: Record<string, string> = { NODE_NO_WARNINGS: "1", CLAUDEFORGE_HOME: home };
  const mcp = { agentforge: { command: process.execPath, args: [entry, "serve"], env } };
  fs.writeFileSync(path.join(pluginDir, ".mcp.json"), `${JSON.stringify(mcp, null, 2)}\n`);

  const hookCommand = [process.execPath, path.join(root, "dist", "hook.js"), "--home", home].map(quote).join(" ");
  const hooks: Record<string, unknown> = {
    description: "Adds the AgentForge board's dispatch preference to each message; the board pane needs CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1",
    hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: hookCommand, timeout: 10 }] }] },
  };
  if (fs.existsSync(path.join(pluginDir, "hooks", "register.tsx"))) hooks.modules = ["./register.tsx"];
  fs.mkdirSync(path.join(pluginDir, "hooks"), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "hooks", "hooks.json"), `${JSON.stringify(hooks, null, 2)}\n`);
  const install = { home, node: process.execPath, cli: entry };
  fs.writeFileSync(path.join(pluginDir, "hooks", "home.json"), `${JSON.stringify(install, null, 2)}\n`);

  const { displayName, version, description } = JSON.parse(fs.readFileSync(path.join(root, "plugin", ".claude-plugin", "plugin.json"), "utf8"));
  const marketplace = { name: MARKETPLACE, owner: { name: "AgentForge" }, plugins: [{ name: "agentforge", displayName, source: "./agentforge", version, description }] };
  fs.writeFileSync(path.join(dir, ".claude-plugin", "marketplace.json"), `${JSON.stringify(marketplace, null, 2)}\n`);
  return dir;
}

function install(args: string[], home: string): void {
  const scope = flag(args, "--scope") ?? readInstallation(home)?.scope ?? "user";
  removeLegacyInstall(scope, home);
  const dir = writeMarketplace(home);
  if (!claude(["plugin", "marketplace", "add", dir], true) && !claude(["plugin", "marketplace", "update", MARKETPLACE])) {
    throw new Error(`Could not register the marketplace at ${dir}`);
  }
  if (!claude(["plugin", "install", PLUGIN, "--scope", scope]) && !claude(["plugin", "update", PLUGIN, "--scope", scope])) {
    throw new Error(`Could not install ${PLUGIN}`);
  }
  // An existing install keeps the version and description it recorded until updated.
  claude(["plugin", "update", PLUGIN, "--scope", scope], true);
  const worker = flag(args, "--worker");
  if (worker || !fs.existsSync(delegationFile(home))) {
    const { settings } = readDelegation(home, worker ?? "cursor");
    writeDelegation(home, { ...settings, executor: worker ?? settings.executor });
  }
  const installation: Installation = { claude: claudeCli, scope, installedAt: new Date().toISOString() };
  fs.writeFileSync(installationFile(home), `${JSON.stringify(installation, null, 2)}\n`);
  out(`Installed the ${PLUGIN} plugin (${scope} scope).`);
  out("Restart Claude Code, then open the board with /forge-board (needs CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1) and turn on auto-dispatch.");
  out("Without the board: `agentforge on` / `agentforge off` and `agentforge config` change the same settings; they apply from the next message.");
}

function uninstall(args: string[], home: string): void {
  const scope = flag(args, "--scope") ?? "user";
  removeLegacyInstall(scope, home);
  claude(["plugin", "uninstall", PLUGIN, "--scope", scope]);
  claude(["plugin", "marketplace", "remove", MARKETPLACE], true);
}

const CONFIG_KEYS: Record<string, keyof DelegationChange> = {
  enabled: "enabled",
  executor: "executor",
  model: "model",
  effort: "effort",
  permission: "permission",
  sdd: "sddEnabled",
  "sdd-workspace": "sddWorkspace",
};

/** The board's settings from a terminal. Model and effort are checked against the catalog by the backend. */
async function configCommand(args: string[], config: ForgeConfig): Promise<number> {
  const home = config.home;
  if ((args[0] ?? "show") === "show") {
    const read = readDelegation(home, config.worker);
    out(JSON.stringify({ ...read.settings, corrupt: read.corrupt }, null, 2));
    return 0;
  }
  if (args[0] !== "set" || args.length < 2) throw new Error(`Usage: agentforge config [show | set key=value ...]; keys: ${Object.keys(CONFIG_KEYS).join(", ")} (empty value or "default" clears)`);
  const change: DelegationChange & { reset?: boolean } = {};
  for (const pair of args.slice(1)) {
    const [key = "", ...rest] = pair.split("=");
    const raw = rest.join("=");
    const field = CONFIG_KEYS[key];
    if (!field) throw new Error(`Unknown key "${key}". Keys: ${Object.keys(CONFIG_KEYS).join(", ")}`);
    const value = field === "enabled" || field === "sddEnabled" ? /^(1|true|on|yes)$/i.test(raw) : raw === "" || raw === "default" ? null : raw;
    (change as Record<string, unknown>)[field] = value;
  }
  const backend = await import("./backend.js");
  await backend.ensureBackend(home);
  const { settings } = await backend.backendRequest<{ settings: unknown }>(home, "POST", "/api/settings", change);
  out(JSON.stringify(settings, null, 2));
  out("Applies from the next message in every Claude Code session using this home.");
  return 0;
}

/** Plugin updates go through the backend, which knows whether tasks are running. */
async function updateCommand(args: string[], config: ForgeConfig): Promise<number> {
  const backend = await import("./backend.js");
  const home = config.home;
  await backend.ensureBackend(home);
  type Status = { state: string; message: string; busy?: string; local?: string; remote?: string; behind?: number; apply?: { ok: boolean; stage?: string; error?: string } };
  const show = (s: Status) => {
    out(`${s.state}: ${s.message}`);
    if (s.local) out(`  local ${s.local}  origin ${s.remote ?? "?"}${s.behind ? `  (${s.behind} behind)` : ""}`);
    if (s.apply) out(`  last install: ${s.apply.ok ? "ok" : `failed${s.apply.stage ? ` after ${s.apply.stage}` : ""}: ${s.apply.error ?? ""}`}`);
  };
  switch (args[0] ?? "status") {
    case "status":
      show(await backend.backendRequest<Status>(home, "GET", "/api/update"));
      return 0;
    case "check":
      show(await backend.backendRequest<Status>(home, "POST", "/api/update/check"));
      return 0;
    case "apply": {
      let s = await backend.backendRequest<Status>(home, "POST", "/api/update/apply");
      if (s.busy !== "apply") {
        show(s);
        return 1;
      }
      out("Installing...");
      while (s.busy) {
        await new Promise((r) => setTimeout(r, 1000));
        s = await backend.backendRequest<Status>(home, "GET", "/api/update");
      }
      show(s);
      return s.apply?.ok ? 0 : 1;
    }
    default:
      throw new Error("Usage: agentforge update [status|check|apply]");
  }
}

async function backendCommand(args: string[], config: ForgeConfig): Promise<number> {
  const backend = await import("./backend.js");
  const home = config.home;
  const force = args.includes("--force");
  const refuseIfBusy = async () => {
    const status = await backend.backendRequest<{ running: string[] }>(home, "GET", "/api/status").catch(() => undefined);
    if (status?.running.length && !force) {
      throw new Error(`Tasks still running: ${status.running.join(", ")}. Stopping the backend cancels them; wait, or pass --force.`);
    }
  };
  switch (args[0] ?? "status") {
    case "run":
      await backend.runBackend(config);
      return -1;
    case "start": {
      const after = Number(flag(args, "--after"));
      for (let i = 0; after && backend.isAlive(after) && i < 300; i++) await new Promise((r) => setTimeout(r, 100));
      const { info } = await backend.ensureBackend(home);
      out(`${backend.BACKEND_TITLE} running: pid ${info.pid}, 127.0.0.1:${info.port}, version ${info.version}`);
      return 0;
    }
    case "status": {
      const info = await backend.probe(home);
      if (!info) {
        out(`${backend.BACKEND_TITLE} is not running (home ${home}). It starts with the first Claude Code session, or \`agentforge backend start\`.`);
        return 1;
      }
      const status = await backend.backendRequest<{ mcpSessions: number; running: string[] }>(home, "GET", "/api/status");
      out(`${backend.BACKEND_TITLE} running`);
      out(`  pid:          ${info.pid}`);
      out(`  address:      127.0.0.1:${info.port}`);
      out(`  version:      ${info.version}${info.version !== backend.packageVersion() ? ` (installed ${backend.packageVersion()}; restart to apply)` : ""}`);
      out(`  started:      ${info.startedAt}`);
      out(`  mcp sessions: ${status.mcpSessions}`);
      out(`  running:      ${status.running.length ? status.running.join(", ") : "none"}`);
      out(`  home:         ${home}`);
      return 0;
    }
    case "stop": {
      await refuseIfBusy();
      const pid = await backend.stopBackend(home);
      out(pid ? `Stopped ${backend.BACKEND_TITLE} (pid ${pid}).` : `${backend.BACKEND_TITLE} was not running.`);
      return 0;
    }
    case "restart": {
      await refuseIfBusy();
      await backend.stopBackend(home);
      const { info } = await backend.ensureBackend(home);
      out(`Restarted ${backend.BACKEND_TITLE}: pid ${info.pid}, 127.0.0.1:${info.port}, version ${info.version}`);
      return 0;
    }
    default:
      throw new Error("Usage: agentforge backend status|start|stop|restart [--force]");
  }
}

async function main(): Promise<number> {
  const [cmd = "serve", ...args] = process.argv.slice(2);
  routeConsoleToStderr();
  loadEnvFiles();
  const config = loadConfig();
  switch (cmd) {
    case "serve": {
      const { serveStdio } = await import("./proxy.js");
      await serveStdio(config.home, process.env.CLAUDEFORGE_DEFAULT_CWD ?? process.cwd());
      return -1;
    }
    case "backend":
      return backendCommand(args, config);
    case "update":
      return updateCommand(args, config);
    case "run": {
      const { runCommand } = await import("./commands/run.js");
      return runCommand(args);
    }
    case "watch": {
      const { watchCommand } = await import("./commands/watch.js");
      return watchCommand(args);
    }
    case "monitor": {
      const { monitorTerminal, monitorWeb } = await import("./monitor.js");
      const limit = Number(flag(args, "--limit") ?? 0) || undefined;
      if (!args.includes("--web")) {
        await monitorTerminal(config.home, { once: args.includes("--once"), json: args.includes("--json"), limit });
        return 0;
      }
      const port = flag(args, "--port");
      const web = await monitorWeb(config.home, { port: port === undefined ? 18862 : Number(port), limit });
      out(`AgentForge monitor (read-only): ${web.url}  — Ctrl+C to stop.`);
      await new Promise<void>((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
      });
      await web.close();
      return 0;
    }
    case "login": {
      const res = await Cursor.auth.login({ apiKeyName: `agentforge@${os.hostname()}` });
      out(`Logged in${res.email ? ` as ${res.email}` : ""}; key expires ${new Date(res.apiKeyExpiresAtMs).toISOString()}.`);
      return 0;
    }
    case "logout":
      await Cursor.auth.logout();
      out("Logged out.");
      return 0;
    case "whoami": {
      if (config.apiKey) out("Using CURSOR_API_KEY from environment.");
      out(JSON.stringify(await Cursor.auth.status(), null, 2));
      return 0;
    }
    case "models": {
      for (const m of await Cursor.models.list({ apiKey: config.apiKey })) {
        out(`${m.id}${m.displayName && m.displayName !== m.id ? `  (${m.displayName})` : ""}`);
        for (const p of m.parameters ?? []) {
          out(`    --param ${p.id}=<${p.values.map((v) => v.value).join("|")}>`);
        }
      }
      return 0;
    }
    case "install":
      claudeCli = claudeBin(args, config.home);
      install(args, config.home);
      return 0;
    case "uninstall":
      claudeCli = claudeBin(args, config.home);
      uninstall(args, config.home);
      return 0;
    case "on":
    case "off":
      return configCommand(["set", `enabled=${cmd === "on"}`], config);
    case "config":
      return configCommand(args, config);
    case "tasks": {
      for (const t of new TaskStore(config.home).list().slice(0, 30)) {
        out(`${t.id}  ${t.status.padEnd(11)}  ${t.updatedAt}  ${t.title}`);
      }
      return 0;
    }
    case "show": {
      const task = args[0] && new TaskStore(config.home).get(args[0]);
      if (!task) throw new Error(`No task ${args[0] ?? ""}`);
      out(JSON.stringify(task, null, 2));
      return 0;
    }
    case "help":
    case "--help":
    case "-h":
      out(HELP);
      return 0;
    default:
      console.error(HELP);
      return 1;
  }
}

main().then(
  (code) => {
    // serve keeps running on stdio; everything else exits when done.
    if (code >= 0) process.exit(code);
  },
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
