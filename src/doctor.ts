import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelParameterValue } from "@cursor/sdk";
import { probe } from "./backend.js";
import type { ForgeConfig } from "./config.js";
import { readDelegation } from "./delegation.js";
import type { Worker } from "./workers/worker.js";

export interface ProbeResult {
  model: string;
  /** Time to create the agent. */
  createMs?: number;
  /** Time from sending the prompt to the worker's first event other than a status change. */
  firstEventMs?: number;
  totalMs: number;
  status: "finished" | "error" | "cancelled" | "timeout";
  error?: string;
}

const PROBE_PROMPT = "Reply with exactly: OK. Do not use any tools.";

/** One tiny turn in an empty directory, timed: what every task pays before it does real work. */
export async function probeWorker(worker: Worker, opts: { model: string; modelParams?: ModelParameterValue[]; timeoutMs: number }): Promise<ProbeResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentforge-doctor-"));
  const started = Date.now();
  const result: ProbeResult = { model: opts.model, totalMs: 0, status: "timeout" };
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  try {
    const creating = worker.create({ cwd: dir, model: opts.model, modelParams: opts.modelParams });
    const session = await Promise.race([
      creating,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          void creating.then((s) => s.close()).catch(() => undefined);
          reject(new Error("timed out creating the agent"));
        }, opts.timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    result.createMs = Date.now() - started;
    try {
      const sent = Date.now();
      const run = await session.send(PROBE_PROMPT);
      timer = setTimeout(() => {
        timedOut = true;
        void run.cancel().catch(() => undefined);
      }, Math.max(0, opts.timeoutMs - (Date.now() - started)));
      for await (const message of run.messages()) {
        if (result.firstEventMs === undefined && message.type !== "status") result.firstEventMs = Date.now() - sent;
      }
      const res = await run.wait();
      result.status = timedOut ? "timeout" : res.status;
      result.error = res.error;
    } finally {
      await session.close().catch(() => undefined);
    }
  } catch (err) {
    result.status = timedOut ? "timeout" : "error";
    result.error = (err as Error).message;
  } finally {
    clearTimeout(timer);
    result.totalMs = Date.now() - started;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return result;
}

const sec = (ms: number | undefined) => (ms === undefined ? "-" : `${(ms / 1000).toFixed(1)}s`);

/** Verdict lines for a probe; `slow` when tasks on this connection are likely to stall. */
export function assessProbe(r: ProbeResult): { ok: boolean; slow: boolean; lines: string[] } {
  const lines = [`Probe turn on ${r.model}: agent created ${sec(r.createMs)}, first event ${sec(r.firstEventMs)}, total ${sec(r.totalMs)} (${r.status}).`];
  if (r.status === "error") {
    lines.push(`Failed: ${r.error ?? "unknown error"}`);
    lines.push("Check `agentforge whoami` (sign in with `agentforge login` or set CURSOR_API_KEY), the model id (`agentforge models`), and your network.");
    return { ok: false, slow: false, lines };
  }
  if (r.status !== "finished") {
    lines.push("The probe did not finish in time. Tasks will stall on this connection: check proxy/VPN settings, or try again later.");
    return { ok: false, slow: true, lines };
  }
  const slow = (r.firstEventMs ?? 0) > 60_000 || (r.createMs ?? 0) > 60_000;
  const sluggish = (r.firstEventMs ?? 0) > 20_000;
  if (slow) {
    lines.push("Slow: a healthy connection answers within about 20s. Long tasks will likely be cut off; a proxy/VPN that buffers or drops long connections is the usual cause. Try without it, a different network, or another model.");
  } else if (sluggish) {
    lines.push("Somewhat slow (healthy is under about 20s). Keep tasks small.");
  } else {
    lines.push("Connection looks healthy.");
  }
  return { ok: true, slow, lines };
}

const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"];

export async function doctor(config: ForgeConfig, workers: Record<string, Worker>, opts: { model?: string; timeoutMs?: number }, print: (line: string) => void): Promise<number> {
  const { settings } = readDelegation(config.home);
  const backend = await probe(config.home);
  print(backend ? `Backend: running, pid ${backend.pid}, version ${backend.version}.` : "Backend: not running (it starts with the next Claude Code session or `agentforge backend start`).");
  print(config.apiKey ? "Auth: CURSOR_API_KEY is set." : "Auth: no CURSOR_API_KEY; using the `agentforge login` key if there is one.");
  const proxies = PROXY_VARS.filter((v) => process.env[v]);
  print(proxies.length ? `Proxy variables: ${proxies.map((v) => `${v}=${process.env[v]}`).join(", ")}` : "Proxy variables: none set.");

  const worker = workers[settings.executor] ?? workers[config.worker];
  if (!worker) {
    print(`Worker "${settings.executor}" is not available.`);
    return 1;
  }
  const model = opts.model ?? settings.route?.model ?? config.model;
  const modelParams = !opts.model && settings.route && settings.effort ? [{ id: "effort", value: settings.effort }] : config.modelParams;
  print(`Running a probe turn on ${worker.name} / ${model} …`);
  const verdict = assessProbe(await probeWorker(worker, { model, modelParams, timeoutMs: opts.timeoutMs ?? 180_000 }));
  for (const line of verdict.lines) print(line);
  return !verdict.ok ? 1 : verdict.slow ? 2 : 0;
}
