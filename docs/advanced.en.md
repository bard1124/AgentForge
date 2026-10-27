# Advanced guide

[简体中文](advanced.md) | **English** · [Back to README](../README.en.md)

[Architecture](#architecture) · [Board settings](#board-settings) · [MCP tools](#mcp-tools) · [Task states](#task-states) · [Budgets and usage](#budgets-and-usage) · [Models](#models) · [Worker tools (MCP)](#worker-tools-mcp) · [Worker plugins](#worker-plugins) · [Configuration](#configuration) · [Backend](#backend) · [Monitor](#monitor) · [Running without Claude Code](#running-without-claude-code) · [Updates and uninstall](#updates-and-uninstall) · [Limitations](#limitations) · [Development](#development)

## Architecture

```
Claude Code sessions (supervisor: plan, brief, review)        board pane (/forge-board)
   │  MCP stdio: forge_* / sdd_task tools                         │  function hooks, /api/*
   ▼                                                              ▼
agentforge serve (thin stdio relay) ──── HTTP ────► agentforge-backend (one per AGENTFORGE_HOME)
                                                     ├─ task store (~/.agentforge/tasks)
                                                     ├─ board settings, SDD documents, plugin updater
                                                     ▼  @cursor/sdk (local runtime)
                                                   Cursor agent (edits files, runs commands in cwd)
```

Every Claude Code session and the board talk to one shared background process, so several open sessions never start several sets of workers, and a task keeps running when the session that dispatched it closes. Claude Code does the reasoning, `forge_*` calls are the actions, and status, results, and verification output are fed back to it.

## Board settings

| Control | What it does |
|---|---|
| Auto-dispatch | **ON**: Claude Code plans, splits, briefs, and accepts; the executor implements. **OFF** (default): Claude Code works as usual; explicit requests ("hand this to Cursor", `/forge`) still dispatch. |
| Hook state | `Hook active` once the `UserPromptSubmit` hook has run since the last change; `Pending` until the next message picks it up; a warning when `disableAllHooks` is set. A saved switch is not proof that the hook ran. |
| Token savings (estimate) | Per period (today, last 7 days, all time): (delegated − Claude) / delegated, or `—` with nothing delegated. Delegated sums the executor's turn usage by task creation time; Claude is estimated from each MCP tool call's arguments and returned text (~4 ASCII chars or 1 CJK char per token), logged to `~/.agentforge/claude-traffic.jsonl`. It assumes Claude would have spent about what the worker spent and ignores Claude's later re-reads of tool results; it can be negative. Hidden on mobile. |
| Executor | Cursor, or a worker plugin (`AGENTFORGE_WORKERS`). Switching clears the model, effort, and permission chosen for the previous one. |
| Model | Follow the executor default, or a fixed model from its live catalog. An offline executor or a failed catalog read is reported; a model that left the catalog stays selected with a warning instead of being swapped silently. |
| Thinking effort | Only the efforts the catalog lists for the fixed model; otherwise the model default. Nothing is invented. |
| New-session permission | Shown when the executor supports it (Cursor: sandbox, auto-review, both). Applies once, when a new agent is created for a task; follow-ups keep it. A permission the executor cannot apply blocks the dispatch. |
| SDD documents | Separate switch, workspace, and editor for task documents. |
| Tasks | The 100 most recent tasks, 8 rows at a time with ▲ / ▼ to page, the position (such as `9–16 / 40`) and how many are running. A running task offers **Pause** (stops the turn but keeps the agent; the task becomes `paused`) and **Cancel** (ends it); a paused task offers **Resume** (re-sends the stopped turn on the same agent) and **Cancel**; any other task offers **Delete** (removes its record and event log). **Clear finished** deletes every task that is neither running nor paused. Deletes ask for Confirm first. Text only on mobile. |
| Plugin update | Collapsed section; see [Updates and uninstall](#updates-and-uninstall). |

The switch takes effect from the next message: the hook adds a one-line ON/OFF note to each prompt, and Claude Code still decides per task whether delegating fits. The board pauses polling while hidden; on Claude Code mobile it is text only. Every section but Dispatch collapses with ▾ / ▸ to a one-line summary; the collapsed list is stored as `board.collapsed` in `delegation.json`, shared by all sessions, and does not count as a settings change for the hook state.

Without the board the settings live in `~/.agentforge/delegation.json` and change through the backend:

```bash
agentforge on | off
agentforge config show
agentforge config set executor=cursor model=gpt-5.5 effort=high permission=sandbox
agentforge config set model=default effort=default permission=default sdd=false sdd-workspace=/abs/dir
```

SDD documents are laid out as:

```
<workspace>/<project-uuid>/project.json
<workspace>/<project-uuid>/<task-uuid>/task.md   (Goal, Scope, Plan, Acceptance)
<workspace>/<project-uuid>/<task-uuid>/meta.json
```

The workspace defaults to `~/.agentforge/sdd` and is set on the board or with `config set sdd-workspace=`; Claude Code can read it but never move it or flip the switch. Every save carries the revision it was read at: a document changed since then is refused with a conflict, and the board keeps your draft. Turning SDD off from the board saves a pending draft first, and stays on if that save fails. With SDD off, documents stay readable and every write is refused.

## MCP tools

| Tool | Purpose |
|---|---|
| `forge_capabilities` | Available workers, MCP servers from `mcp.json`, default model, params, and budgets, and the board's current settings. |
| `forge_runtime_info` | Whether each executor is online, its default model, model catalog with efforts, and supported permissions; submits nothing. |
| `forge_dispatch` | Start a background agent with a brief, acceptance criteria, and a `verify_command`. Takes an `order_id` (UUID) for idempotent retries. Unset `worker` / `model` / effort / permission follow the board; optional `mcp_servers`, `max_turns`, `max_minutes`, `max_rework`. Returns `task_id`, `order_status`, and `conversation_id` once the agent has started. |
| `forge_status` | Status, `order_status`, current turn, recent steps (messages, thinking summaries, tool calls), the tool call still running and for how long (`currentTool`), and `idleSec` since the worker's last event. Pass `since` to get only new steps. |
| `forge_wait` | Block until the current turn ends, up to 240s per call, returning only the steps emitted during that wait. For long tasks, run the `wait_command` that `forge_dispatch` returns (`agentforge wait <task_id>`) as a background shell command instead: Claude Code tells you when it ends, with no polling. |
| `forge_followup` | Message the same agent. Steered into a running turn when possible, otherwise queued; resumes idle, interrupted, or accepted tasks. |
| `forge_result` | Final report, git changes since dispatch (including new files), and an optional diff. Files dirty before dispatch are flagged `preExisting`. |
| `forge_accept` | Run the verification command. Pass: accepted. Fail: output plus feedback sent back for rework until `max_rework`, then rejected. |
| `forge_retry` | Re-send the last failed or interrupted turn on the same agent, for transient errors (`lastError.retryable`). Also resumes a `paused` task, when the user asks. |
| `forge_cancel` | Stop the running turn; a paused task is ended as `cancelled`. |
| `forge_conversations` | List the executor's agent conversations; archive or restore one. |
| `sdd_task` | Read and write SDD documents: workspace, projects, tasks, create, read, save against a revision. |
| `forge_list` | Recent tasks with their order ids and statuses. |

Status, wait, result, and cancel take `task_id` or `order_id`. In Claude Code the tools are named `mcp__plugin_agentforge_agentforge__<tool>`.

Errors from Cursor carry `error_type` and a `retryable` verdict: tool errors in the error text, failed turns in `lastError`. The verdict combines the SDK's `isRetryable` flag, the error class (network or rate limit), and connection-failure messages, because the SDK often reports `isRetryable: false` on plain connection drops. A worker that has not started its run within `AGENTFORGE_START_TIMEOUT_SEC` fails the same way; `forge_retry` keeps waiting on the same agent instead of opening a second one.

A turn that fails with a retryable connection error (for example `Agent turn stopped after repeated resume attempts made no progress`, which the SDK raises when the stream to Cursor keeps dropping) is continued once automatically on the same agent, with an instruction to pick up where it stopped; the task stays `running` meanwhile. If that fails too, `forge_status` says the connection keeps dropping and suggests smaller tasks. `AGENTFORGE_AUTO_RETRY=0` turns this off.

When the SDK resumes after a reconnect it can run the last tool calls again. AgentForge spots a call that completes twice, adds a step, and lists it under `replayed` in `forge_result`: a replayed edit may have applied twice. `forge_result` also marks files another task in the same directory edited (`byOtherTask`) and leaves them out of the diff.

## Task states

`forge_dispatch` takes an `order_id`: a fresh UUID per piece of work. Retrying with the same `order_id` and arguments returns the existing task (`reused: true`) instead of starting a second agent; the same id with different arguments is refused.

Each task has an `order_status`: `queued`, `dispatching`, `executing`, `paused` (paused on the board: not counted as running, does not block a backend restart, stays paused across one; Claude Code should not re-dispatch it, resume it from the board), `completed`, `failed`, `blocked` (a budget ran out), `cancelled`, or `uncertain`. `uncertain` means the turn was cut off (for example the backend stopped mid-run): check the agent's conversation and the files before doing anything, and look the task up by its original `order_id` rather than creating a new one. `conversation_id` is the Cursor agent id, different from the order id.

## Project worker notes

Put environment facts every task would otherwise need repeating (build commands, offline Maven, shell, directories to leave alone) in `.agentforge/worker.md` in the repository, and anything that applies everywhere in `~/.agentforge/worker.md`. On dispatch the nearest repository file, searched from `cwd` up to the repository root, and the global file are added to the brief as a "Project notes" section; `forge_dispatch` lists the files used in its warnings. To keep the file out of the repository, add `.agentforge/` to `.git/info/exclude`. `AGENTS.md` and `.cursor/rules`, which Cursor reads itself, need not be repeated here.

## Parallel tasks and worktree isolation

When several tasks change one repository at the same time, pass `isolation: "worktree"` to `forge_dispatch`. The task gets a git worktree from the current HEAD at `~/.agentforge/worktrees/<task_id>` on branch `agentforge/<task_id>`; the agent edits only there, and its diff holds only its own changes. Once `forge_accept` passes, the changes are applied to the original directory as uncommitted edits and the worktree and branch are removed. If they conflict, the worktree stays and the patch is left at `~/.agentforge/worktrees/<task_id>.patch` for a manual `git apply --3way`, after which you delete the task.

A worktree starts from HEAD: uncommitted changes in the original directory are not in it, and neither are ignored files such as `node_modules` or build output, so the agent or `verify_command` has to install or build there first if it needs them.

## Budgets and usage

Each task has a turn budget (`max_turns`, default 20) and a worker time budget (`max_minutes`, default 60, counting only time a turn is running). A turn that runs past the time budget is cancelled; once either budget is used up, new turns are refused with a message telling Claude Code to ask you first. `forge_status` and `forge_result` show `budget` as `used/max`.

`forge_result` reports token usage summed over the task's turns. When the Cursor account exposes billing, the billed totals (and `chargedUsd`) are used instead.

## Models

`agentforge models` lists the models and their parameters. The board's model and effort apply to every dispatch that does not name its own; below that, `AGENTFORGE_MODEL` and `AGENTFORGE_MODEL_PARAMS` (`reasoning=high,fast=true`) are the defaults. Override per task with `forge_dispatch`'s `model` / `model_params` or `run --model ... --param id=value`.

## Worker tools (MCP)

Workers can get extra tools from MCP servers listed in `~/.agentforge/mcp.json` (or `AGENTFORGE_MCP_CONFIG`). The file takes the usual `{"mcpServers": {...}}` shape with `command`/`args`/`env` (stdio) or `url`/`headers` (HTTP) entries, and `${VAR}` / `${VAR:-default}` references are filled from the environment. Pick servers per task by name (`mcp_servers: ["github"]`, `run --mcp github`). Task records store only the names, so credentials stay out of `~/.agentforge/tasks`. See [`examples/mcp.example.json`](../examples/mcp.example.json).

## Worker plugins

`AGENTFORGE_WORKERS` takes a comma-separated list of ES modules that export `createWorker(config)` (or a default factory) returning a `Worker` (`src/workers/worker.ts`). Plugin workers appear in `forge_capabilities` and on the board, and are chosen with `worker`. See [`examples/workers/echo-worker.mjs`](../examples/workers/echo-worker.mjs).

## Configuration

Settings come from the environment first, then from `AGENTFORGE_ENV_FILE` or `~/.agentforge/.env` (copy [`.env.example`](../.env.example)). Existing environment variables win, and the worked-on project's `.env` is never read.

| Env var | Default | |
|---|---|---|
| `CURSOR_API_KEY` | - | Otherwise the key from `agentforge login` (`~/.cursor/sdk/auth.json`) is used |
| `CURSOR_BACKEND_URL` | Cursor's | Alternative Cursor backend, read by the SDK; the API key must come from that backend |
| `AGENTFORGE_WORKER` | `cursor` | Executor for a fresh board; the board's choice wins afterwards |
| `AGENTFORGE_MODEL` | `composer-2.5` | Executor default model (see `agentforge models`); a fixed model on the board wins |
| `AGENTFORGE_MODEL_PARAMS` | - | Default model parameters, `id=value,...`; the board's effort wins for its parameter |
| `AGENTFORGE_SETTING_SOURCES` | `project` | Cursor settings layers the worker loads (project rules, AGENTS.md) |
| `AGENTFORGE_AUTO_REVIEW` | off | `1` enables Cursor Auto-review for tool calls |
| `AGENTFORGE_MAX_TURNS` | `20` | Turn budget per task |
| `AGENTFORGE_MAX_TASK_MINUTES` | `60` | Worker time budget per task |
| `AGENTFORGE_MAX_REWORK` | `3` | Automatic rework rounds after a failed verification |
| `AGENTFORGE_VERIFY_TIMEOUT_SEC` | `900` | Timeout of the verification command |
| `AGENTFORGE_STALL_WARN_SEC` | `120` | Silence after which `forge_status` hints that the worker may be stalled |
| `AGENTFORGE_START_TIMEOUT_SEC` | `300` | Limit for creating the agent and for starting each run |
| `AGENTFORGE_AUTO_RETRY` | `1` | Continue a turn that failed with a connection error once automatically; `0` turns it off |
| `AGENTFORGE_OPEN_PROGRESS` | `cursor` | Editor command that opens a task's progress page when it starts; `off` turns it off |
| `AGENTFORGE_MONITOR_PORT` | `18862` | Port of the read-only monitor page the backend serves; `0` turns it off |
| `AGENTFORGE_MCP_CONFIG` | `~/.agentforge/mcp.json` | MCP servers workers may use (absolute path) |
| `AGENTFORGE_WORKERS` | - | Worker plugin modules, comma separated |
| `AGENTFORGE_ENV_FILE` | `~/.agentforge/.env` | Must exist when set |
| `AGENTFORGE_HOME` | `~/.agentforge` | Task records, event logs, board settings, SDD workspace default, backend files |

## Backend

```bash
agentforge backend status          # pid, port, version, start time, MCP sessions, running tasks
agentforge backend restart         # refused while tasks run; --force to restart anyway
agentforge backend stop | start
```

The first MCP connection or board starts `agentforge-backend` on demand; it listens on 127.0.0.1 with a per-home bearer token (`~/.agentforge/backend.token`, mode 0600). Connected sessions reconnect on their own after a restart. Stopping the backend does not uninstall the plugin; a turn it was running shows `uncertain` (`interrupted`) and `forge_followup` resumes the same agent.

## Monitor

```bash
agentforge monitor                 # live terminal view: ↑↓/j k select, f filter, r refresh, q quit
agentforge monitor --once          # one snapshot (also what a non-TTY gets); --json for the raw data
agentforge monitor --web           # read-only page on http://127.0.0.1:18862 (--port to change)
```

The monitor reads the task files and settings as they are: it never starts the backend, creates the data folder, or changes a task. Active tasks are marked `*` when no backend answers, since their real state is unknown until one does. The web page accepts only local GET requests. While it runs, the backend serves the same page on `http://127.0.0.1:18862` itself (`AGENTFORGE_MONITOR_PORT` to change, `0` to turn off; a busy port is only logged), so it can stay open in Cursor's built-in browser.

### Following one task in Cursor

Agents the Cursor SDK starts do not appear in the Cursor client's agent list (Repositories); the SDK has no way to add them. Instead AgentForge keeps a progress page per task at `~/.agentforge/progress/<task_id>.md`: status, elapsed time, edited files, the latest 40 steps (newest first), the error and the worker's report, refreshed at most once a second while it runs. Once the task starts, the backend opens it in the last active Cursor window with `cursor --reuse-window`, and the editor follows the file as it changes; `forge_dispatch` also returns it as `progress_file`. `AGENTFORGE_OPEN_PROGRESS=off` stops the automatic opening; another command or an absolute path uses that editor. Deleting the task deletes the page.

Cancel and pause record where they came from in the task's steps: the board, the supervisor's `forge_cancel`, or Ctrl+C in the terminal.

## Running without Claude Code

```bash
agentforge run --cwd ~/repo --verify "npm test" "Fix the SAVE10 double discount and add a test"
echo "Rename the config loader" | agentforge run --cwd ~/repo --json > result.json
agentforge watch cf-20261023-abc123     # follow any task (also one Claude Code started) from another terminal
agentforge tasks | show <task_id>
```

`run` streams the worker's steps, runs `--verify` with automatic rework rounds, and prints the report, changed files, verification, budget, and token usage. It exits with 0 when the task finishes (or is accepted with `--verify`), 2 when it fails or is rejected, 1 when it cannot start, and 130 on Ctrl-C, which cancels the turn. `--json` keeps stdout to the result JSON and sends progress to stderr. `agentforge run --help` lists every option (`--model`, `--param`, `--mcp`, `--worker`, `--max-turns`, `--max-minutes`, ...). See [`examples/`](../examples/README.md) for a runnable demo.

## Updates and uninstall

The board's **Plugin update** section, or `agentforge update status|check|apply`, updates this checkout from `origin`. Opening the board checks at most once a day (shared across boards); **Check for updates** checks right away; viewing the status only reads the local cache. `origin` must be the repository named in `package.json`.

An update is a fast-forward of the current branch followed by `npm ci`, `npm run build`, and a reinstall of the plugin. It runs only when tracked files are clean, the branch can fast-forward, and no task is running; local changes, a diverged branch, being offline, or busy tasks block it with the reason. It never stashes, resets, force-pushes, or touches untracked files such as SDD documents. If dependencies or the reinstall failed, **Retry install** resumes from that step. Afterwards restart the backend (the board offers it) and run `/reload-plugins`.

`agentforge uninstall [--claude <path>]` removes the plugin and its marketplace; task records and settings in `~/.agentforge` stay.

## Limitations

- Workers run inside the shared backend. Closing a Claude Code session does not stop them; stopping or restarting the backend mid-turn does, and the task shows `uncertain` until `forge_followup` resumes the same Cursor agent.
- The board needs Claude Code's function hooks (`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, early access). Without them the tools, the prompt hook, and `agentforge config` still work.
- `verify_command` runs in the system shell: `/bin/sh` on macOS, `cmd.exe` on Windows. For both, write commands that run in either, such as `npm test` or `node ...`.
- On Windows, plugin updates use `npm install` instead of `npm ci`: Windows locks native modules the backend has loaded, so `node_modules` cannot be deleted.
- The hook note is advice to Claude Code, not a lock: with auto-dispatch on it may still answer questions or make trivial edits itself, and with it off it still delegates when you ask.
- Parallel tasks in the same `cwd` can overwrite each other's edits. `forge_dispatch` warns about this but does not prevent it.
- The Cursor worker runs with the permissions of your user account. Give it the same trust you would give Cursor's agent mode.
- Starting a Cursor agent usually takes 10-60s, and with MCP servers attached it has taken several minutes. `forge_dispatch` returns once the agent has started, and `AGENTFORGE_START_TIMEOUT_SEC` bounds the wait.
- Billing totals depend on the Cursor account; accounts without the usage API show token counts only.

## Development

```bash
npm test            # unit tests with a fake worker
npm run dev         # tsc --watch
node dist/cli.js install && claude plugin test ~/.agentforge/marketplace/agentforge   # board pane tests
(cd plugin && npx -p typescript@5 tsc -p tsconfig.json)   # type-check the board; copy claude-code.d.ts to plugin/.claude-plugin/types/claude-code/index.d.ts first
```
