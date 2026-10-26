import { AuthenticationError, CursorSdkError } from "@cursor/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ForgeConfig } from "./config.js";
import { isRetryableError } from "./errors.js";
import { Forge, ForgeError, orderStatus } from "./forge.js";
import { recordTraffic } from "./savings.js";
import { SddError, SddStore } from "./sdd.js";
import { estimateTokens } from "./tokens.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export function describeError(err: unknown): string {
  const forgeErr = err instanceof ForgeError ? err : undefined;
  const cause = forgeErr ? forgeErr.cause : err;
  // ForgeErrors without a cause are input/state errors (unknown task, bad cwd); the message says it all.
  if (forgeErr && cause === undefined) return forgeErr.message;
  if (!(cause instanceof Error)) return `Unexpected error: ${String(err)}`;
  const fromWorker = forgeErr !== undefined || cause instanceof CursorSdkError || isRetryableError(cause);
  if (!fromWorker) return `Unexpected error: ${cause.stack ?? cause.message}`;

  const lines = [forgeErr?.message ?? `Cursor worker error: ${cause.message}`, `error_type: ${cause.name}`];
  if (cause instanceof AuthenticationError) {
    lines.push("retryable: false. Cursor credentials are missing or expired; ask the user to run `agentforge login` or set CURSOR_API_KEY.");
  } else if (isRetryableError(cause)) {
    lines.push("retryable: true. This is a transient failure; retrying the same call once is safe.");
  } else {
    lines.push("retryable: false. Retrying will fail the same way; report the cause to the user.");
  }
  return lines.join("\n");
}

function fail(err: unknown): ToolResult {
  return { content: [{ type: "text", text: describeError(err) }], isError: true };
}

/** Wraps tool bodies as ToolResults and logs each exchange's estimated tokens to the Claude traffic ledger. */
function handler(home: string) {
  return <A>(tool: string, fn: (args: A) => Promise<unknown>) =>
    async (args: A): Promise<ToolResult> => {
      let result: ToolResult;
      try {
        result = ok(await fn(args));
      } catch (err) {
        result = fail(err);
      }
      try {
        recordTraffic(home, tool, estimateTokens(JSON.stringify(args ?? {})) + estimateTokens(result.content.map((c) => c.text).join("")));
      } catch {
        // the ledger never fails a tool call
      }
      return result;
    };
}

export const INSTRUCTIONS = [
  "AgentForge hands coding work to a background agent (Cursor by default) and lets you track, steer, and accept it.",
  'Each user message carries a "AgentForge auto-dispatch: ON/OFF" note set from the user\'s board; follow the latest one. When OFF, use these tools only if the user explicitly asks for an agent.',
  "When dispatching: split work into tasks that touch disjoint files; give forge_dispatch a complete brief, acceptance criteria, a narrow verify_command, cwd, and a fresh UUID order_id. Track with forge_wait/forge_status, steer with forge_followup, review with forge_result (include_diff for anything non-trivial), accept with forge_accept.",
  "Status `uncertain` means the driving process stopped mid-turn: check forge_result and the files before doing anything, and never re-dispatch the same change under a new order_id. Never commit or push unless the user asks.",
].join("\n");

export function createServer(forge: Forge, defaultCwd: string, config: ForgeConfig): McpServer {
  const server = new McpServer({ name: "agentforge", version: "0.5.1" }, { instructions: INSTRUCTIONS });
  const sdd = new SddStore(config.home, config.worker);
  const workers = forge.workerNames();
  const handle = handler(config.home);

  server.registerTool(
    "forge_capabilities",
    {
      title: "List workers and tools",
      description: "Workers that can take tasks, MCP servers that can be attached to them, and default budgets and model settings.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    handle("forge_capabilities", async () => forge.capabilities()),
  );
  const taskId = z.string().describe("Task id returned by forge_dispatch (cf-YYYYMMDD-xxxxxx).");
  const lookup = {
    task_id: taskId.optional(),
    order_id: z.string().optional().describe("The order_id given to forge_dispatch; an alternative to task_id."),
  };
  const resolve = (a: { task_id?: string; order_id?: string }): string => {
    if (a.task_id) return a.task_id;
    if (!a.order_id) throw new ForgeError("Pass task_id or order_id.");
    const task = forge.findOrder(a.order_id);
    if (!task) throw new ForgeError(`No task was created for order_id ${a.order_id}; if its dispatch failed before starting, dispatch again with the same order_id.`);
    return task.id;
  };

  server.registerTool(
    "forge_dispatch",
    {
      title: "Dispatch a task to a Cursor agent",
      description:
        "Hand a concrete, self-contained coding task to a background Cursor agent working in `cwd`. Returns a task_id once the agent has started (usually under a minute); " +
        "the agent keeps working while you continue. Write the task as a complete brief: goal, relevant files, constraints. " +
        "Set acceptance and verify_command so the work can be checked with forge_accept.",
      inputSchema: {
        order_id: z
          .string()
          .optional()
          .describe("A UUID you generate (crypto.randomUUID()) before the first attempt. Retrying with the same order_id and identical arguments returns the original task instead of dispatching twice."),
        task: z.string().min(1).describe("Full task brief for the worker."),
        cwd: z.string().optional().describe(`Absolute working directory. Defaults to ${defaultCwd}.`),
        title: z.string().optional().describe("Short label for listings."),
        acceptance: z.string().optional().describe("Acceptance criteria the worker must satisfy."),
        verify_command: z.string().optional().describe("Shell command run by forge_accept, e.g. `npm test` or `mvn -q -pl X test`."),
        context: z.string().optional().describe("Extra context from this conversation (decisions, findings, links)."),
        worker: z.string().optional().describe(`Which worker runs the task. Available: ${workers.join(", ")}. Defaults to the executor chosen on the board.`),
        model: z.string().optional().describe("Worker model id. Defaults to the board's model, else the executor's default."),
        model_params: z
          .record(z.string(), z.string())
          .optional()
          .describe("Model parameters as id -> value, e.g. {\"reasoning\": \"high\"}. Valid ids per model: `agentforge models`."),
        mcp_servers: z
          .array(z.string())
          .optional()
          .describe("Names of MCP servers from the AgentForge MCP config to give the worker (see forge_capabilities)."),
        max_rework: z.number().int().min(0).max(10).optional().describe("Automatic rework rounds forge_accept may trigger on failed verification."),
        max_turns: z.number().int().min(1).max(100).optional().describe("Cap on worker turns (dispatch + follow-ups + rework)."),
        max_minutes: z.number().min(1).max(600).optional().describe("Cap on cumulative worker running time; a turn over budget is cancelled."),
      },
    },
    handle("forge_dispatch", async (a) => {
      const { task, warnings, reused } = await forge.dispatch({
        orderId: a.order_id,
        task: a.task,
        cwd: a.cwd ?? defaultCwd,
        title: a.title,
        acceptance: a.acceptance,
        verifyCommand: a.verify_command,
        context: a.context,
        worker: a.worker,
        model: a.model,
        modelParams: a.model_params && Object.entries(a.model_params).map(([id, value]) => ({ id, value })),
        mcpServers: a.mcp_servers,
        maxRework: a.max_rework,
        maxTurns: a.max_turns,
        maxMinutes: a.max_minutes,
      });
      return {
        task_id: task.id,
        order_id: task.orderId,
        reused: reused ? "This order_id was dispatched before; this is the original task, nothing new was started." : undefined,
        status: task.status,
        order_status: orderStatus(task),
        worker: task.worker,
        conversation_id: task.agentId,
        cwd: task.cwd,
        model: task.model,
        model_params: task.modelParams,
        permission: task.permission ?? "executor default",
        mcp_servers: task.mcpServers,
        budget: { max_turns: task.maxTurns, max_minutes: task.maxTaskMs / 60_000 },
        baseline: task.baseline.isRepo ? { branch: task.baseline.branch, head: task.baseline.head } : null,
        warnings,
        next: "Use forge_wait or forge_status to follow progress.",
      };
    }),
  );

  server.registerTool(
    "forge_status",
    {
      title: "Check task progress",
      description:
        "Snapshot of a task: status, current turn, recent steps (tool calls, messages, thinking), idle time, budget used, and token usage. " +
        "Pass `since` = previous lastSeq to get only new steps. orderStatus is one of queued, dispatching, executing, completed, failed, blocked, cancelled, uncertain; agentId is the native conversation id.",
      inputSchema: {
        ...lookup,
        since: z.number().int().min(0).optional().describe("Return steps with seq greater than this."),
        limit: z.number().int().min(1).max(200).optional().describe("Max steps to return (default 30)."),
      },
      annotations: { readOnlyHint: true },
    },
    handle("forge_status", async (a) => forge.status(resolve(a), a.since, a.limit)),
  );

  server.registerTool(
    "forge_wait",
    {
      title: "Wait for a task",
      description: "Block until the task's current turn ends or timeout_sec elapses, then return its status. Prefer this over repeated forge_status polling.",
      inputSchema: {
        ...lookup,
        timeout_sec: z.number().int().min(1).max(240).optional().describe("Default 120, at most 240; call again to keep waiting."),
        since: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    handle("forge_wait", async (a) => {
      const id = resolve(a);
      const settled = await forge.wait(id, a.timeout_sec ?? 120);
      return { settled, ...forge.status(id, a.since) };
    }),
  );

  server.registerTool(
    "forge_followup",
    {
      title: "Follow up with the worker",
      description:
        "Send a message to the task's agent with full conversation context: answer its question, ask for changes, or ask about its work. " +
        "If it is mid-turn the message is steered into the turn when possible, otherwise queued for right after it.",
      inputSchema: { task_id: taskId, message: z.string().min(1) },
    },
    handle("forge_followup", async (a) => ({ task_id: a.task_id, delivery: await forge.followup(a.task_id, a.message) })),
  );

  server.registerTool(
    "forge_result",
    {
      title: "Get task output",
      description:
        "Worker's final report plus git changes since dispatch (commits, diff stat, files; preExisting marks files dirty before dispatch), " +
        "budget used, and token usage with billed cost when available. include_diff adds the patch.",
      inputSchema: {
        ...lookup,
        include_diff: z.boolean().optional(),
        paths: z.array(z.string()).optional().describe("Limit the diff to these paths."),
        max_diff_chars: z.number().int().min(1000).max(200_000).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    handle("forge_result", async (a) => forge.result(resolve(a), { includeDiff: a.include_diff, paths: a.paths, maxDiffChars: a.max_diff_chars })),
  );

  server.registerTool(
    "forge_accept",
    {
      title: "Verify and accept",
      description:
        "Run the verification command in the task cwd. On pass the task is accepted and the agent released. " +
        "On fail, by default the failure output (plus your feedback) is sent back for another round, up to max_rework; then it is rejected. " +
        "Review forge_result yourself before accepting: a passing command is necessary, not sufficient.",
      inputSchema: {
        task_id: taskId,
        verify_command: z.string().optional().describe("Overrides the command given at dispatch."),
        feedback: z.string().optional().describe("Review notes to send along if rework is triggered."),
        rework_on_fail: z.boolean().optional().describe("Default true."),
      },
    },
    handle("forge_accept", async (a) => {
      const { task, verification, action } = await forge.accept(a.task_id, {
        verifyCommand: a.verify_command,
        feedback: a.feedback,
        reworkOnFail: a.rework_on_fail,
      });
      return { task_id: task.id, action, status: task.status, rework: `${task.reworkCount}/${task.maxRework}`, verification };
    }),
  );

  server.registerTool(
    "forge_retry",
    {
      title: "Retry the failed turn",
      description:
        "Re-send the last failed or interrupted turn's instruction on the same agent. Use once when forge_status shows lastError.retryable=true. " +
        "For interrupted tasks, check forge_result first: the earlier attempt may have left partial changes.",
      inputSchema: { task_id: taskId },
    },
    handle("forge_retry", async (a) => {
      const turn = await forge.retry(a.task_id);
      return { task_id: a.task_id, turn: turn.index, status: "running", next: "Use forge_wait to follow progress." };
    }),
  );

  server.registerTool(
    "forge_cancel",
    {
      title: "Cancel the running turn",
      description:
        "Stop the agent's current turn and drop queued follow-ups; the only way to stop work (turning auto-dispatch off or closing the session cancels nothing). " +
        "Returns the status after the stop; the agent can still be resumed with forge_followup.",
      inputSchema: lookup,
      annotations: { destructiveHint: true },
    },
    handle("forge_cancel", async (a) => {
      const task = await forge.cancel(resolve(a));
      return { task_id: task.id, status: task.status, order_status: orderStatus(task), stopped: task.status !== "running" };
    }),
  );

  server.registerTool(
    "forge_runtime_info",
    {
      title: "Executor status and model catalog",
      description:
        "Whether each executor is reachable, its model catalog (with the thinking efforts each model offers), supported new-session permissions, and the board's current dispatch settings. Submits nothing.",
      inputSchema: { executor: z.string().optional().describe(`Limit to one executor: ${workers.join(", ")}.`) },
      annotations: { readOnlyHint: true },
    },
    handle("forge_runtime_info", async (a) => forge.runtimeInfo(a.executor)),
  );

  server.registerTool(
    "forge_conversations",
    {
      title: "Manage native agent conversations",
      description:
        "List, archive, or restore the executor's native conversations (for Cursor, local agents; id = Cursor agent id = a task's conversation_id). Renaming is not supported by Cursor.",
      inputSchema: {
        action: z.enum(["list", "archive", "restore", "rename"]),
        executor: z.string().optional().describe("Defaults to the board's executor."),
        id: z.string().optional().describe("Conversation id, for archive/restore."),
        cwd: z.string().optional().describe("Workspace whose conversations to list; defaults to this session's directory."),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    handle("forge_conversations", async (a) => forge.conversation({ ...a, cwd: a.cwd ?? (a.action === "list" ? defaultCwd : undefined) })),
  );

  server.registerTool(
    "sdd_task",
    {
      title: "Save and read SDD task documents",
      description:
        "Task contracts (goal, scope, plan, acceptance) in the SDD workspace chosen on the board, one task.md per task, grouped by project name. Dispatches nothing. " +
        "get_workspace: dir and whether SDD is on. create_project: by name, returns the existing project if the name exists. create_task: pass the full plan as content (otherwise a template is written). " +
        "save_task: replaces task.md only if base_revision matches the current revision (read_task first); a conflict saves nothing. Writes are refused while SDD is switched off; reads still work. " +
        "Hand the returned path to forge_dispatch.",
      inputSchema: {
        action: z.enum(["get_workspace", "list_projects", "create_project", "list_tasks", "create_task", "read_task", "save_task"]),
        project_id: z.string().optional(),
        project_name: z.string().optional().describe("For create_project."),
        task_id: z.string().optional(),
        title: z.string().optional().describe("For create_task."),
        content: z.string().optional().describe("Markdown for create_task / save_task."),
        base_revision: z.string().optional().describe("For save_task: the revision read_task returned."),
      },
    },
    handle("sdd_task", async (a) => {
      const need = (v: string | undefined, name: string) => {
        if (!v) throw new ForgeError(`${name} is required for ${a.action}.`);
        return v;
      };
      try {
        switch (a.action) {
          case "get_workspace":
            return sdd.workspace();
          case "list_projects":
            return { projects: sdd.listProjects() };
          case "create_project":
            return sdd.createProject(need(a.project_name, "project_name"));
          case "list_tasks":
            return { tasks: sdd.listTasks(need(a.project_id, "project_id")) };
          case "create_task":
            return sdd.createTask(need(a.project_id, "project_id"), { title: need(a.title, "title"), content: a.content, createdBy: "claude" });
          case "read_task":
            return sdd.readTask(need(a.project_id, "project_id"), need(a.task_id, "task_id"));
          case "save_task":
            return sdd.saveTask(need(a.project_id, "project_id"), need(a.task_id, "task_id"), need(a.content, "content"), need(a.base_revision, "base_revision"));
        }
      } catch (err) {
        if (err instanceof SddError) throw new ForgeError(err.message);
        throw err;
      }
    }),
  );

  server.registerTool(
    "forge_list",
    {
      title: "List tasks",
      description: "Recent AgentForge tasks, newest first.",
      inputSchema: {
        status: z.string().optional().describe("Filter by status, e.g. running."),
        cwd: z.string().optional().describe("Filter by working directory."),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    handle("forge_list", async (a) =>
      forge
        .list()
        .filter((t) => !a.status || t.status === a.status)
        .filter((t) => !a.cwd || t.cwd === a.cwd)
        .slice(0, a.limit ?? 20)
        .map((t) => ({
          task_id: t.id,
          order_id: t.orderId,
          title: t.title,
          status: t.status,
          order_status: orderStatus(t),
          worker: t.worker,
          conversation_id: t.agentId,
          cwd: t.cwd,
          turns: t.turns.length,
          updatedAt: t.updatedAt,
        })),
    ),
  );

  return server;
}