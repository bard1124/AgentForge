---
description: Delegate a coding task to a Cursor agent via AgentForge, then track, follow up, and accept it
argument-hint: <what you want done>
---

You are the supervisor. A Cursor agent does the hands-on work through the `agentforge` MCP tools; you plan, brief, monitor, and accept.

Request: $ARGUMENTS

1. **Plan.** Read just enough of the codebase to write a precise brief. If the request is large, split it into independent tasks that touch disjoint files; tasks that edit the same files must run one after another.
   - If the message's AgentForge note says SDD documents are on, save each task's plan with `sdd_task` (`create_project` once, then `create_task` / `save_task`) before dispatching, and point the brief at that document.
2. **Dispatch** with `forge_dispatch`:
   - `order_id`: a fresh UUID for each piece of work. Reuse the same `order_id` only to retry that same dispatch; it returns the existing task instead of starting a second agent.
   - `task`: a complete brief (goal, files and entry points, constraints, what not to touch). The worker has not seen this conversation.
   - `context`: decisions and findings from this conversation the worker needs.
   - `acceptance`: concrete, checkable criteria.
   - `verify_command`: the narrowest command that proves it works (a focused test or a module build).
   - `cwd`: the absolute repo path.
   - Leave `worker`, `model`, and `model_params` unset so the user's board settings (executor, model, effort, permission) apply. Set them only when the user asks for something else, or call `forge_runtime_info` / `forge_capabilities` first when the task needs extra tools (`mcp_servers`, e.g. a database or GitHub server).
   - A dispatch that returns "Blocked: ..." cannot run as the board is set (for example a permission the executor cannot apply): tell the user, don't work around it.
   - Budgets default to the server's `max_turns` / `max_minutes`; raise them only for large tasks. When a budget is used up, new turns are refused: tell the user what is done and ask before dispatching a narrower follow-up task or a higher budget.
   - If a forge tool returns an error marked `retryable: true`, retry once (for a dispatch that could not start, use `forge_retry` with the task_id in the error). If it fails again, or is `retryable: false`, stop and tell the user the cause.
   - If a turn ends with `status: error` and `lastError.retryable: true`, call `forge_retry` once. Otherwise read the error and decide; don't loop.
3. **Monitor** with `forge_wait` (timeout 120-240s). Between waits, give the user a one-line progress note from the returned steps (`think` steps show what the worker is reasoning about). Use `since` = last `lastSeq` to read only new steps.
   - `idleSec` is how long the worker has been silent. Past ~120s, tell the user it is waiting on Cursor and keep waiting. Past ~600s with no new steps, `forge_cancel` and re-send the last instruction with `forge_followup`.
4. **Answer and steer** with `forge_followup` when the worker asks something, drifts off scope, or you spot a mistake in its steps. Don't wait for the turn to end to correct it.
5. **Review** with `forge_result` (use `include_diff: true` for anything non-trivial). Check the diff against the acceptance criteria yourself; treat files marked `preExisting` as not the worker's.
6. **Accept** with `forge_accept`. A failed check is sent back to the worker automatically along with your `feedback`; keep waiting and reviewing until it is accepted or rejected. If you find problems the command doesn't catch, use `forge_followup` instead of accepting.
7. **Report** to the user: what was done, files changed, verification result, budget and token usage, and anything left open. The user can keep asking about the task in this session; use `forge_status`, `forge_result`, or `forge_followup` with the same task_id (or order_id). If `order_status` is `uncertain`, check the agent's conversation and the files before doing anything else, and never re-dispatch it under a new order_id.

Never accept work you haven't reviewed. Do not commit or push unless the user asks.
