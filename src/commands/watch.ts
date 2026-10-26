import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { out } from "../output.js";
import { formatStep, StepTail } from "../printer.js";
import { TaskStore } from "../store.js";

export const WATCH_HELP = `agentforge watch <task_id> [--since <seq>] [--no-follow]

Print a task's steps as they happen, from any terminal, while Claude Code (or
\`agentforge run\`) drives it. Exits when the task leaves the running state.`;

const ACTIVE = new Set(["running", "queued"]);

export async function watchCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      since: { type: "string" },
      "no-follow": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const id = positionals[0];
  if (values.help || !id) {
    out(WATCH_HELP);
    return id || values.help ? 0 : 1;
  }
  const store = new TaskStore(loadConfig().home);
  const tail = new StepTail(Number(values.since ?? 0));
  let header = false;
  for (;;) {
    const task = store.get(id);
    if (!task) {
      console.error(`No task ${id}`);
      return 1;
    }
    if (!header) {
      out(`${task.id}  ${task.title}\ncwd=${task.cwd}  worker=${task.worker}  model=${task.model}`);
      header = true;
    }
    const done = !ACTIVE.has(task.status) || !!values["no-follow"];
    for (const step of tail.take(task.steps, !done)) out(formatStep(step));
    if (done) {
      out(`-- ${task.status} after ${task.turns.length} turn(s)`);
      return 0;
    }
    await sleep(1000);
  }
}
