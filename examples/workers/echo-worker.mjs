// A minimal AgentForge worker plugin. Copy it as a starting point for wiring in
// another agent (a different CLI, an internal service, a human queue, ...).
//
//   AGENTFORGE_WORKERS=/abs/path/echo-worker.mjs agentforge run --worker echo "hello"
//
// The worker does no real work: it reports the task section of the brief back
// as its result, emitting the same message shapes a real worker streams.

/** @param {import("../../dist/config.js").ForgeConfig} _config */
export function createWorker(_config) {
  let nextAgent = 0;

  const session = (agentId) => {
    let turn = 0;
    return {
      agentId,
      async send(prompt) {
        turn += 1;
        const runId = `${agentId}-run-${turn}`;
        const ids = { agent_id: agentId, run_id: runId };
        const task = /## Task\n([\s\S]*?)(\n## |$)/.exec(prompt)?.[1]?.trim() ?? prompt.trim();
        let cancelled = false;
        return {
          id: runId,
          async *messages() {
            yield { type: "status", ...ids, status: "RUNNING" };
            yield { type: "thinking", ...ids, text: "Echoing the task back." };
            yield { type: "tool_call", ...ids, call_id: `${runId}-1`, name: "echo", status: "completed", args: { text: task } };
            yield { type: "assistant", ...ids, message: { role: "assistant", content: [{ type: "text", text: `Echo: ${task}` }] } };
            yield { type: "status", ...ids, status: "FINISHED" };
          },
          async wait() {
            if (cancelled) return { status: "cancelled" };
            return {
              status: "finished",
              result: `Echo: ${task}`,
              durationMs: 1,
              usage: { inputTokens: prompt.length, outputTokens: task.length, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: prompt.length + task.length },
            };
          },
          async cancel() {
            cancelled = true;
          },
        };
      },
      async close() {},
    };
  };

  return {
    name: "echo",
    description: "Example plugin: echoes the task back without touching files.",
    async create() {
      nextAgent += 1;
      return session(`echo-${process.pid}-${nextAgent}`);
    },
    async resume(agentId) {
      return session(agentId);
    },
  };
}
