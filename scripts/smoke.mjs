#!/usr/bin/env node
// End-to-end smoke test of an installed AgentForge on this machine (CI runs it on macOS and Windows).
// Needs a built dist/ and the Claude Code CLI on PATH; no Cursor account: tasks use the echo worker.
//
//   node scripts/smoke.mjs [--claude <path>] [--skip-claude]

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "dist", "cli.js");
const argv = process.argv.slice(2);
const claudeFlag = argv.includes("--claude") ? argv[argv.indexOf("--claude") + 1] : undefined;
const skipClaude = argv.includes("--skip-claude");
const isWindows = process.platform === "win32";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentforge-smoke-"));
const home = path.join(tmp, "home");
const env = { ...process.env, AGENTFORGE_HOME: home, AGENTFORGE_WORKERS: path.join(root, "examples", "workers", "echo-worker.mjs"), NO_COLOR: "1" };
delete env.CLAUDEFORGE_HOME;

const results = [];
async function step(name, fn) {
  const started = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name} (${Date.now() - started}ms)${note ? `  ${note}` : ""}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}\n      ${String(err instanceof Error ? err.message : err).replaceAll("\n", "\n      ")}`);
  }
}

function agentforge(args, options = {}) {
  const res = spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8", timeout: 120_000, windowsHide: true, ...options });
  return { code: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function expectOk(res, what) {
  if (res.code !== 0) throw new Error(`${what} exited ${res.code}:\n${res.out.trim()}`);
  return res.out;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`AgentForge smoke test on ${process.platform} ${os.release()} (node ${process.version}), home ${home}`);

await step("platform helper runs npm through its .cmd shim", async () => {
  const { commandLine } = await import(new URL(`file://${path.join(root, "dist", "platform.js").replaceAll("\\", "/")}`).href);
  const line = commandLine("npm", ["--version"]);
  const version = execFileSync(line.file, line.args, { shell: line.shell, encoding: "utf8", windowsHide: true }).trim();
  if (!/^\d+\.\d+/.test(version)) throw new Error(`unexpected npm --version output: ${version}`);
  return `npm ${version}, shell=${line.shell}`;
});

if (!skipClaude) {
  const claudeArgs = claudeFlag ? ["--claude", claudeFlag] : [];

  await step("install registers the plugin with Claude Code", () => {
    const out = expectOk(agentforge(["install", "--scope", "user", ...claudeArgs]), "agentforge install");
    if (!/Installed the agentforge@agentforge-local plugin/.test(out)) throw new Error(out);
  });

  const pluginDir = path.join(home, "marketplace", "agentforge");

  await step("installed plugin passes claude plugin validate", () => {
    const res = spawnSync(claudeFlag ?? "claude", ["plugin", "validate", pluginDir], { encoding: "utf8", shell: isWindows && !claudeFlag?.endsWith(".exe"), windowsHide: true });
    if (res.status !== 0) throw new Error(`${res.stdout}${res.stderr}`);
  });

  await step("hook command from hooks.json runs in the system shell", () => {
    const { hooks } = JSON.parse(fs.readFileSync(path.join(pluginDir, "hooks", "hooks.json"), "utf8"));
    const command = hooks.UserPromptSubmit[0].hooks[0].command;
    const res = spawnSync(command, { shell: true, input: JSON.stringify({ session_id: "smoke", cwd: tmp, prompt: "hi" }), encoding: "utf8", windowsHide: true });
    if (!res.stdout.includes("AgentForge auto-dispatch")) throw new Error(`command: ${command}\nexit ${res.status}\n${res.stdout}${res.stderr}`);
    return isWindows ? "cmd.exe" : "/bin/sh";
  });

  const gitBash = isWindows ? ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe"].find((p) => fs.existsSync(p)) : undefined;
  if (gitBash) {
    await step("hook command from hooks.json runs in Git Bash", () => {
      const { hooks } = JSON.parse(fs.readFileSync(path.join(pluginDir, "hooks", "hooks.json"), "utf8"));
      const command = hooks.UserPromptSubmit[0].hooks[0].command;
      const res = spawnSync(gitBash, ["-c", command], { input: "{}", encoding: "utf8", windowsHide: true });
      if (!res.stdout.includes("AgentForge auto-dispatch")) throw new Error(`exit ${res.status}\n${res.stdout}${res.stderr}`);
    });
  }

  await step("MCP config points at this checkout's node and cli", () => {
    const mcp = JSON.parse(fs.readFileSync(path.join(pluginDir, ".mcp.json"), "utf8")).agentforge;
    if (!fs.existsSync(mcp.command) || !fs.existsSync(mcp.args[0])) throw new Error(JSON.stringify(mcp));
    if (mcp.env.AGENTFORGE_HOME !== home) throw new Error(`AGENTFORGE_HOME is ${mcp.env.AGENTFORGE_HOME}`);
  });
}

await step("backend starts detached and answers", async () => {
  const out = expectOk(agentforge(["backend", "start"]), "backend start");
  const status = expectOk(agentforge(["backend", "status"]), "backend status");
  return `${out.trim().split("\n").pop()} | ${status.includes("mcp sessions") ? "status ok" : status}`;
});

await step("board settings change through the backend", () => {
  expectOk(agentforge(["on"]), "agentforge on");
  const shown = JSON.parse(expectOk(agentforge(["config", "show"]), "config show"));
  if (shown.enabled !== true) throw new Error(JSON.stringify(shown));
  expectOk(agentforge(["off"]), "agentforge off");
});

await step("backend stops cleanly (graceful shutdown removes backend.json)", async () => {
  const info = JSON.parse(fs.readFileSync(path.join(home, "backend.json"), "utf8"));
  expectOk(agentforge(["backend", "stop"]), "backend stop");
  for (let i = 0; i < 50 && isAlive(info.pid); i++) await sleep(100);
  if (isAlive(info.pid)) throw new Error(`pid ${info.pid} still alive`);
  if (fs.existsSync(path.join(home, "backend.json"))) throw new Error("backend.json left behind: the backend was killed, not shut down");
  if (fs.existsSync(path.join(home, "backend.lock"))) throw new Error("backend.lock left behind");
});

const repo = path.join(tmp, "repo");
fs.mkdirSync(repo);
execFileSync("git", ["init", "-q"], { cwd: repo });

await step("run with a passing verify command is accepted", () => {
  const res = agentforge(["run", "--worker", "echo", "--cwd", repo, "--quiet", "--verify", "node --version", "say hi"]);
  if (res.code !== 0) throw new Error(`exit ${res.code}\n${res.out}`);
});

await step("failing verify command triggers rework, then rejects", () => {
  const res = agentforge(["run", "--worker", "echo", "--cwd", repo, "--verify", "exit 1", "--max-rework", "1", "fail"]);
  if (res.code !== 2 || !/rework round sent/.test(res.out)) throw new Error(`exit ${res.code}\n${res.out}`);
});

await step("verify timeout kills the whole process tree", async () => {
  const pidFile = path.join(tmp, "grandchild.pid");
  const sleeper = path.join(tmp, "sleeper.mjs");
  fs.writeFileSync(
    sleeper,
    `import { spawn } from "node:child_process";
import fs from "node:fs";
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
setTimeout(() => {}, 120000);
`,
  );
  const started = Date.now();
  const res = agentforge(["run", "--worker", "echo", "--cwd", repo, "--quiet", "--verify", `node "${sleeper}"`, "--max-rework", "0", "hang"], {
    env: { ...env, AGENTFORGE_VERIFY_TIMEOUT_SEC: "3" },
  });
  const took = Date.now() - started;
  const id = /== (cf-\S+)/.exec(res.out)?.[1];
  const record = id ? expectOk(agentforge(["show", id]), "agentforge show") : "";
  if (res.code !== 2 || !/killed after 3s timeout/.test(record)) throw new Error(`exit ${res.code} after ${took}ms\n${res.out}`);
  const grandchild = Number(fs.readFileSync(pidFile, "utf8"));
  for (let i = 0; i < 50 && isAlive(grandchild); i++) await sleep(100);
  if (isAlive(grandchild)) {
    process.kill(grandchild);
    throw new Error(`grandchild pid ${grandchild} survived the timeout`);
  }
  return `finished in ${took}ms`;
});

if (!skipClaude) {
  await step("uninstall removes the plugin", () => {
    expectOk(agentforge(["uninstall", ...(claudeFlag ? ["--claude", claudeFlag] : [])]), "agentforge uninstall");
  });
}

agentforge(["backend", "stop", "--force"]);
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed on ${process.platform}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = results.map((r) => `| ${r.ok ? "✅" : "❌"} | ${r.name} |`).join("\n");
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Smoke test on ${process.platform}: ${results.length - failed.length}/${results.length} passed\n\n| | Step |\n|---|---|\n${rows}\n\n`);
}
process.exit(failed.length ? 1 : 0);
