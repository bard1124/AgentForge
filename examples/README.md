# Examples

## Cart demo

`cart-demo/` is a tiny shopping-cart module with a bug: `SAVE10` applies its 10% discount twice, so 1 of its 4 tests fails. `run-cart-demo.sh` copies it into a scratch git repo and asks a worker to fix the bug and add a `BULK10` code with tests.

```bash
npm run build
./examples/run-cart-demo.sh             # agentforge run: Cursor fixes it, `npm test` accepts it
./examples/run-cart-demo.sh --claude    # Claude Code supervises through /forge (its own edit tools disabled)
WORKER=echo ./examples/run-cart-demo.sh # offline dry run, no Cursor account needed
```

With `agentforge run`, the steps stream in the terminal as the worker reads, edits, and runs tests. The run ends with the worker's report, the changed files, the verification result, and token usage. In another terminal, `agentforge watch <task_id>` follows the same task.

## Worker plugin

`workers/echo-worker.mjs` is the smallest possible worker. A plugin is an ES module that exports `createWorker(config)` and returns `{ name, create, resume }`. Sessions `send()` prompts and return runs that stream SDK-shaped messages. See `src/workers/worker.ts` for the interface.

```bash
export AGENTFORGE_WORKERS=$PWD/examples/workers/echo-worker.mjs
node dist/cli.js run --worker echo "say hello"
```

Claude Code sees plugin workers in `forge_capabilities` and can pick one with `forge_dispatch`'s `worker` argument.

## MCP servers for workers

`mcp.example.json` shows how to give workers extra tools. Copy it to `~/.agentforge/mcp.json` (or point `AGENTFORGE_MCP_CONFIG` at it). Then pass server names with `forge_dispatch` (`mcp_servers: ["github"]`) or `agentforge run --mcp github`. Task records store only the names. Credentials stay in the config file and are loaded again whenever a session starts or resumes.
