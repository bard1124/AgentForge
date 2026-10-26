import { parseArgs } from "node:util";
import { loadConfig, parseModelParams } from "../config.js";
import { Forge, type StatusView } from "../forge.js";
import { out } from "../output.js";
import { formatResult, formatStatusLine, formatStep, StepTail } from "../printer.js";
import { describeError } from "../server.js";
import { TaskStore } from "../store.js";
import { loadWorkers } from "../workers/registry.js";

export const RUN_HELP = `agentforge run [options] <task...>     (or pipe the task on stdin)

Dispatch a task straight to a worker without Claude Code, stream its steps,
and print the result. With --verify, the command is run as acceptance; failures
are sent back for rework (up to --max-rework) before giving up.

Options:
  --cwd <dir>           Working directory (default: current directory)
  --title <text>        Short label
  --acceptance <text>   Acceptance criteria passed to the worker
  --verify <cmd>        Acceptance command, e.g. "npm test"
  --context <text>      Extra context for the worker
  --worker <name>       Worker to use (default: cursor)
  --model <id>          Model id
  --param <id=value>    Model parameter, repeatable (see \`agentforge models\`)
  --mcp <name>          MCP server from the AgentForge MCP config, repeatable
  --max-turns <n>       Turn budget
  --max-minutes <n>     Worker time budget
  --max-rework <n>      Automatic rework rounds on failed verification
  --quiet               Do not stream steps
  --json                Print the final result as JSON

Exit codes: 0 finished/accepted, 1 could not start, 2 failed/rejected/cancelled, 130 interrupted.`;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function int(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a non-negative number`);
  return n;
}

export async function runCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      cwd: { type: "string" },
      title: { type: "string" },
      acceptance: { type: "string" },
      verify: { type: "string" },
      context: { type: "string" },
      worker: { type: "string" },
      model: { type: "string" },
      param: { type: "string", multiple: true },
      mcp: { type: "string", multiple: true },
      "max-turns": { type: "string" },
      "max-minutes": { type: "string" },
      "max-rework": { type: "string" },
      quiet: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    out(RUN_HELP);
    return 0;
  }
  let taskText = positionals.join(" ").trim();
  if ((!taskText || taskText === "-") && !process.stdin.isTTY) taskText = (await readStdin()).trim();
  if (!taskText) {
    console.error(RUN_HELP);
    return 1;
  }

  const config = loadConfig();
  const forge = new Forge(config, new TaskStore(config.home), await loadWorkers(config));
  const log = (line: string) => {
    if (!values.quiet) (values.json ? console.error : out)(line);
  };

  let taskId: string;
  try {
    const { task, warnings } = await forge.dispatch({
      task: taskText,
      cwd: values.cwd ?? process.cwd(),
      title: values.title,
      acceptance: values.acceptance,
      verifyCommand: values.verify,
      context: values.context,
      worker: values.worker,
      model: values.model,
      modelParams: parseModelParams(values.param?.join(",")),
      mcpServers: values.mcp,
      maxTurns: int(values["max-turns"], "max-turns"),
      maxMinutes: int(values["max-minutes"], "max-minutes"),
      maxRework: int(values["max-rework"], "max-rework"),
    });
    taskId = task.id;
    log(`task ${task.id}  worker=${task.worker}  model=${task.model}  agent=${task.agentId}  cwd=${task.cwd}`);
    for (const w of warnings) log(`warning: ${w}`);
  } catch (err) {
    console.error(describeError(err));
    await forge.shutdown();
    return 1;
  }

  let interrupted = false;
  process.once("SIGINT", () => {
    interrupted = true;
    log("\ninterrupt: cancelling the running turn...");
    void forge.cancel(taskId).catch(() => undefined);
  });

  const tail = new StepTail();
  const flush = (active: boolean) => {
    for (const step of tail.take(forge.get(taskId).steps, active)) log(formatStep(step));
  };
  const follow = async (): Promise<StatusView> => {
    for (;;) {
      const settled = await forge.wait(taskId, 1);
      flush(!settled);
      if (settled) {
        const status = forge.status(taskId);
        log(formatStatusLine(status));
        return status;
      }
    }
  };

  let status = await follow();
  if (values.verify && status.status === "finished" && !interrupted) {
    for (;;) {
      try {
        const { action } = await forge.accept(taskId, {});
        flush(false);
        if (action !== "rework") break;
        log(`verification failed; rework round sent to the worker`);
        status = await follow();
        if (status.status !== "finished" || interrupted) break;
      } catch (err) {
        log(describeError(err));
        break;
      }
    }
  }

  const result = await forge.result(taskId);
  if (values.json) out(JSON.stringify(result, null, 2));
  else out(formatResult(result));
  await forge.shutdown();

  if (interrupted) return 130;
  return result.status === "accepted" || (result.status === "finished" && !values.verify) ? 0 : 2;
}
