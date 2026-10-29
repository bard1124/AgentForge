import { expect, test } from "claude-code/testing";
import type { Engine } from "claude-code/testing";
import type { On } from "claude-code";
import type { TaskRow } from "../types/index";

const PANE = {
  plugin: "agentforge",
  component: "Pane",
  requestId: "agentforge-board",
  props: { title: "AgentForge", isFocused: true, bodyColumns: 60, placement: "dock", scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const;

const HOME = "/home/u/.agentforge";
const WS = `${HOME}/sdd`;
const P1 = "11111111-1111-4111-8111-111111111111";
const T1 = "22222222-2222-4222-8222-222222222222";

type Call = { method: string; path: string; search?: string; body?: Record<string, unknown> };
type Row = TaskRow;

const ORDER_OF: Record<string, string> = { running: "executing", paused: "paused", finished: "completed", cancelled: "cancelled" };
const taskRow = (id: string, title: string, status: string): Row => ({ id, title, status, orderStatus: ORDER_OF[status] ?? status, worker: "cursor", model: "composer-2.5", updatedAt: "" });

/** An in-memory agentforge-backend answering the board's /api routes. */
function backend(on: On, opts: { conflict?: boolean; savingsDown?: boolean; tasks?: Row[]; collapsed?: string[]; settingsDown?: boolean; installedCommit?: string } = {}) {
  const calls: Call[] = [];
  const tasks = opts.tasks ?? [taskRow("t-1", "Build login", "running")];
  const settings: Record<string, unknown> = { enabled: false, executor: "cursor", sdd: { enabled: true, workspace: WS }, ...(opts.collapsed ? { board: { collapsed: opts.collapsed } } : {}) };
  let doc = { id: T1, title: "Login page", path: `${WS}/${P1}/${T1}/task.md`, revision: "r1", content: "# Login page\n" };
  const runtime = {
    online: true,
    defaultModel: "composer-2.5",
    permissions: ["sandbox", "auto-review", "sandbox+auto-review"],
    models: [
      { id: "gpt-5.5", displayName: "GPT 5.5", effortParam: "reasoning", efforts: ["low", "high"] },
      { id: "composer-2.5", efforts: [] },
    ],
  };
  const json = (status: number, body: unknown) => ({ value: { status, ok: status < 400, headers: {}, text: JSON.stringify(body) } });

  on("fs.read", (_$, e) => {
    if (e.path.endsWith("/hooks/home.json")) return { value: JSON.stringify({ home: HOME, node: "/bin/node", cli: "/x/dist/cli.js" }) };
    if (e.path === `${HOME}/backend.json`) return { value: JSON.stringify({ pid: 42, port: 7777, version: "0.4.0" }) };
    if (e.path === `${HOME}/backend.token`) return { value: "secret\n" };
    return { deny: "ENOENT" };
  });
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("settings.read", () => ({ value: {} }));
  on("clock.every", () => ({ value: undefined }));
  on("ui.status", () => ({ value: undefined }));
  const opened = { count: 0 };
  on("ui.open", () => {
    opened.count++;
    return { value: { isPlaced: true } };
  });
  on("command.register", () => ({ value: { command: "forge-board" } }));
  on("http.fetch", (_$, e) => {
    const url = new URL(e.url);
    const method = e.init?.method ?? "GET";
    const body = e.init?.body ? (JSON.parse(String(e.init.body)) as Record<string, unknown>) : undefined;
    expect(url.host).toBe("127.0.0.1:7777");
    if (url.pathname !== "/api/health") expect(e.init?.headers).toMatchObject({ authorization: "Bearer secret" });
    calls.push({ method, path: url.pathname, search: url.search, body });
    const control = url.pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(pause|resume|cancel))?$/);
    if (control && url.pathname !== "/api/tasks/clear") {
      const i = tasks.findIndex((t) => t.id === control[1]);
      if (i < 0) return json(404, { error: `No task with id ${control[1]}` });
      const next = { pause: "paused", resume: "running", cancel: "cancelled" }[control[2] ?? ""];
      if (method === "DELETE") tasks.splice(i, 1);
      else if (next) tasks[i] = taskRow(tasks[i]!.id, tasks[i]!.title, next);
      return json(200, { id: control[1] });
    }
    switch (`${method} ${url.pathname}`) {
      case "GET /api/health":
        return json(200, { ok: true });
      case "GET /api/board":
        return json(200, { settings, executors: ["cursor"], hook: { state: "active", detail: "", lastRunAt: "2026-10-23T10:00:00.000Z" }, backend: { pid: 42, version: "0.4.0" }, running: 1 });
      case "GET /api/tasks":
        return json(200, tasks);
      case "POST /api/tasks/clear": {
        const kept = tasks.filter((t) => t.status === "running" || t.status === "paused");
        const deleted = tasks.length - kept.length;
        tasks.splice(0, tasks.length, ...kept);
        return json(200, { deleted });
      }
      case "GET /api/savings":
        if (opts.savingsDown) return json(500, { error: "ledger unreadable" });
        return json(200, {
          today: { delegatedTokens: 0, claudeTokens: 120, savedPct: null },
          week: { delegatedTokens: 12_400, claudeTokens: 3_100, savedPct: 75 },
          all: { delegatedTokens: 3_400_000, claudeTokens: 3_600_000, savedPct: -6 },
        });
      case "GET /api/runtime":
        return json(200, { executors: { cursor: runtime } });
      case "POST /api/settings": {
        const c = body!;
        if (opts.settingsDown) return json(409, { error: "Settings file is unreadable" });
        if (c.enabled !== undefined) settings.enabled = c.enabled;
        if (c.collapsed !== undefined) settings.board = { collapsed: c.collapsed };
        if (c.model !== undefined) {
          if (c.model === null) delete settings.route;
          else settings.route = { model: c.model };
          delete settings.effort;
        }
        if (c.effort !== undefined) settings.effort = c.effort ?? undefined;
        if (c.permission !== undefined) settings.permission = c.permission ?? undefined;
        if (c.sddEnabled !== undefined) settings.sdd = { ...(settings.sdd as object), enabled: c.sddEnabled };
        return json(200, { settings, hook: { state: "pending", detail: "Saved; takes effect from the next message." } });
      }
      case "GET /api/sdd/workspace":
        return json(200, { dir: WS, enabled: (settings.sdd as { enabled: boolean }).enabled });
      case "GET /api/sdd/projects":
        return json(200, [{ id: P1, name: "Shop", tasks: 1 }]);
      case "GET /api/sdd/tasks":
        return json(200, [{ id: T1, title: doc.title, updatedAt: "2026-10-23T10:00:00.000Z", path: doc.path, revision: doc.revision }]);
      case "GET /api/sdd/task":
        return json(200, doc);
      case "POST /api/sdd/save":
        if (opts.conflict || body!.baseRevision !== doc.revision) return json(409, { error: `Task changed since revision ${body!.baseRevision}; reload it.` });
        doc = { ...doc, content: String(body!.content), revision: "r2" };
        return json(200, doc);
      case "GET /api/update":
        return json(200, { state: "up_to_date", message: "Up to date.", local: "abc1234", remote: "abc1234", backendVersion: "0.4.0", installedVersion: "0.4.0", backendCommit: "abc1234", installedCommit: opts.installedCommit ?? "abc1234" });
      case "POST /api/update/check-daily":
        return json(200, { state: "up_to_date", message: "Up to date." });
      default:
        return json(404, { error: `no route ${method} ${url.pathname}` });
    }
  });
  return { calls, settings, opened, tasks };
}

/** A session start registers the command and reads the board once. */
async function openBoard($: Engine) {
  await $.session.start({ cwd: "/w", surface: "terminal", isInteractive: true });
}

for (const surface of ["terminal", "desktop"] as const) {
  test(`the board shows the settings and changes them (${surface})`, async ($, on) => {
    const b = backend(on);
    await openBoard($);
    const ui = await $.ui.mount({ ...PANE, surface });

    expect(await ui.find({ key: "auto-on" })).toBeDefined();
    expect(await ui.find({ key: "auto-off" })).toBeDefined();
    expect((await ui.find({ type: "Text", text: /Hook active/ }))?.text).toBeDefined();
    expect((await ui.find({ type: "Text", text: /Build login/ }))?.text).toBe("Build login");
    expect((await ui.find({ type: "Text", text: /^executing$/ }))?.text).toBe("executing");
    expect((await ui.find({ type: "Text", text: /online · 2 models/ }))?.text).toBeDefined();

    await ui.press({ key: "auto-on" });
    expect(b.settings.enabled).toBe(true);
        expect((await ui.find({ type: "Text", text: /Pending/ }))?.text).toMatch(/next message/);

    // No fixed model: the effort is a note, not a choice.
    expect(await ui.find({ key: "effort" })).toBeUndefined();
    await ui.select({ key: "model", value: "gpt-5.5" });
    expect(b.settings.route).toEqual({ model: "gpt-5.5" });
    await ui.select({ key: "effort", value: "high" });
    expect(b.settings.effort).toBe("high");
    await ui.select({ key: "permission", value: "sandbox" });
    expect(b.settings.permission).toBe("sandbox");

    // A model with no efforts hides the Select.
    await ui.select({ key: "model", value: "composer-2.5" });
    expect(await ui.find({ key: "effort" })).toBeUndefined();
    await ui.unmount();
  });

  test(`the board edits an SDD task and keeps a conflicting draft (${surface})`, async ($, on) => {
    const b = backend(on, { conflict: true });
    await openBoard($);
    const ui = await $.ui.mount({ ...PANE, surface });

    await ui.press({ key: "sdd-open" });
    await ui.press({ key: `p-${P1}` });
    await ui.press({ key: `t-${T1}` });
    await ui.input({ key: "sdd-editor", text: "# Login page\nmy edit\n", kind: "change" });
    await ui.press({ key: "sdd-save" });

    expect(b.calls.some((c) => c.path === "/api/sdd/save" && c.body?.baseRevision === "r1")).toBe(true);
    expect((await ui.find({ type: "Text", text: /^Conflict/ }))?.text).toMatch(/draft is kept/);
    expect((await ui.find({ key: "sdd-save" }))?.text).toBe("Save");

    // Turning SDD off first tries to save the draft; the failed save leaves the switch on.
    await ui.press({ key: "sdd-off" });
    expect((b.settings.sdd as { enabled: boolean }).enabled).toBe(true);
    await ui.unmount();
  });
}

test("the board saves an SDD task against its revision", async ($, on) => {
  const b = backend(on);
  await openBoard($);
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  await ui.press({ key: "sdd-open" });
  await ui.press({ key: `p-${P1}` });
  await ui.press({ key: `t-${T1}` });
  await ui.input({ key: "sdd-editor", text: "# Login page\nsaved\n", kind: "change" });
  await ui.press({ key: "sdd-save" });
  expect((await ui.find({ key: "sdd-save" }))?.text).toBe("Saved");
  expect((await ui.find({ type: "Text", text: /Saved task\.md/ }))?.text).toBeDefined();
  expect(b.calls.filter((c) => c.path === "/api/sdd/save")).toHaveLength(1);
  await ui.unmount();
});

test("the update section checks daily and shows the local status", async ($, on) => {
  const b = backend(on);
  await openBoard($);
  await $.command.run({ command: "forge-board", args: "", origin: { kind: "person" }, presentation: "default" } as never);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect(b.calls.some((c) => c.method === "POST" && c.path === "/api/update/check-daily")).toBe(true);
  await ui.press({ key: "upd-open" });
  expect((await ui.find({ type: "Text", text: /Up to date/ }))?.text).toMatch(/●/);
  expect((await ui.find({ key: "upd-apply" }))?.text).toBe("Update to latest");
  expect(await ui.find({ key: "upd-check" })).toBeDefined();
  expect(await ui.find({ key: "upd-restart" })).toBeUndefined();
  await ui.unmount();
});

test("a backend older than the installed commit offers a restart even with the same version", async ($, on) => {
  backend(on, { installedCommit: "def5678" });
  await openBoard($);
  await $.command.run({ command: "forge-board", args: "", origin: { kind: "person" }, presentation: "default" } as never);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await ui.press({ key: "upd-open" });
  expect((await ui.find({ type: "Text", text: /Backend runs abc1234, installed def5678/ }))?.text).toBeDefined();
  expect(await ui.find({ key: "upd-restart" })).toBeDefined();
  await ui.unmount();
});

const BAND = {
  plugin: "agentforge",
  component: "AbovePrompt",
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80 },
} as const;

test("by default, a status row with Open board sits above the prompt", async ($, on) => {
  const b = backend(on);
  await openBoard($);
  expect(b.opened.count).toBe(0);
  const band = await $.ui.mount({ ...BAND, surface: "desktop" } as never);
  expect((await band.find({ type: "Text", text: /Auto-dispatch off · cursor/ }))?.text).toBeDefined();
  await band.press({ key: "open-board" });
  expect(b.opened.count).toBe(1);
  await band.unmount();
});

test("auto mode opens the board when the session starts", { options: { board: "auto" } }, async ($, on) => {
  const b = backend(on);
  await openBoard($);
  expect(b.opened.count).toBe(1);
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  expect(await ui.find({ key: "auto-on" })).toBeDefined();
  await ui.unmount();
});

test("the board shows estimated token savings per period", async ($, on) => {
  backend(on);
  await openBoard($);
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  expect((await ui.find({ type: "Text", text: /^Token savings \(estimate\)$/ }))?.text).toBeDefined();
  expect((await ui.find({ type: "Text", text: /^delegated 0 · Claude ~120$/ }))?.text).toBeDefined();
  expect((await ui.find({ type: "Text", text: /^—$/ }))?.text).toBeDefined();
  expect((await ui.find({ type: "Text", text: /^delegated 12\.4k · Claude ~3\.1k$/ }))?.text).toBeDefined();
  expect((await ui.find({ type: "Text", text: /^75% saved$/ }))?.text).toBeDefined();
  expect((await ui.find({ type: "Text", text: /^delegated 3\.4M · Claude ~3\.6M$/ }))?.text).toBeDefined();
  expect((await ui.find({ type: "Text", text: /^-6% saved$/ }))?.text).toBeDefined();
  await ui.unmount();
});

test("a failed savings fetch hides the section and keeps the board", async ($, on) => {
  backend(on, { savingsDown: true });
  await openBoard($);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect(await ui.find({ type: "Text", text: /Token savings/ })).toBeUndefined();
  expect(await ui.find({ key: "auto-on" })).toBeDefined();
  await ui.unmount();
});

test("the board on mobile is text only", async ($, on) => {
  backend(on);
  await openBoard($);
  const ui = await $.ui.mount({ ...PANE, surface: "mobile" });
  expect((await ui.find({ type: "Text", text: /Auto-dispatch OFF/ }))?.text).toMatch(/SDD on/);
  expect(await ui.findAll({ type: "Button" })).toHaveLength(0);
  expect(await ui.find({ type: "Text", text: /Token savings/ })).toBeUndefined();
  await ui.unmount();
});

const title = (ui: { find: (q: { type: "Text"; text: RegExp }) => Promise<unknown> }, text: string) => ui.find({ type: "Text", text: new RegExp(`^${text}$`) });

test("the task card shows 8 rows at a time and pages with ▲ / ▼", async ($, on) => {
  const b = backend(on, { tasks: Array.from({ length: 20 }, (_, i) => taskRow(`t-${i + 1}`, `Task ${i + 1}`, "finished")) });
  await openBoard($);
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  expect(b.calls.find((c) => c.path === "/api/tasks")?.search).toBe("?limit=100");

  expect(await title(ui, "Task 8")).toBeDefined();
  expect(await title(ui, "Task 9")).toBeUndefined();
  expect(await ui.find({ type: "Text", text: /^1–8 \/ 20$/ })).toBeDefined();
  expect(await ui.find({ key: "tasks-up" })).toBeUndefined();

  await ui.press({ key: "tasks-down" });
  expect(await ui.find({ type: "Text", text: /^9–16 \/ 20$/ })).toBeDefined();
  expect(await title(ui, "Task 8")).toBeUndefined();
  expect(await title(ui, "Task 9")).toBeDefined();
  expect(await title(ui, "Task 16")).toBeDefined();

  await ui.press({ key: "tasks-down" });
  expect(await ui.find({ type: "Text", text: /^17–20 \/ 20$/ })).toBeDefined();
  expect(await ui.find({ key: "tasks-down" })).toBeUndefined();

  await ui.press({ key: "tasks-up" });
  expect(await ui.find({ type: "Text", text: /^9–16 \/ 20$/ })).toBeDefined();
  await ui.unmount();
});

test("task rows show the estimate with elapsed or actual time, warning once a running task is past it", async ($, on) => {
  const MIN = 60_000;
  backend(on, {
    tasks: [
      { ...taskRow("a", "On time", "running"), estimateMs: 15 * MIN, estimateSource: "worker", elapsedMs: 6 * MIN },
      { ...taskRow("b", "Late", "running"), estimateMs: 10 * MIN, estimateSource: "history", elapsedMs: 75 * MIN },
      { ...taskRow("c", "Done", "finished"), estimateMs: 15 * MIN, estimateSource: "worker", elapsedMs: 22 * MIN },
      taskRow("d", "Before estimates", "finished"),
    ],
  });
  await openBoard($);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect((await ui.find({ type: "Text", text: "· est ~15m · 6m elapsed" }))?.props.color).toBeUndefined();
  expect((await ui.find({ type: "Text", text: "· est ~10m · 1h 15m elapsed" }))?.props.color).toBe("warning");
  expect(await ui.find({ type: "Text", text: "· est 15m · took 22m" })).toBeDefined();
  expect(await ui.findAll({ type: "Text", text: /^· est / })).toHaveLength(3);
  await ui.unmount();
});

test("each task row offers the controls its status allows", async ($, on) => {
  const b = backend(on, { tasks: [taskRow("a", "Runs", "running"), taskRow("b", "Rests", "paused"), taskRow("c", "Done", "finished")] });
  await openBoard($);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  for (const key of ["task-pause-a", "task-cancel-a", "task-resume-b", "task-cancel-b", "task-delete-c"]) expect(await ui.find({ key })).toBeDefined();
  for (const key of ["task-delete-a", "task-delete-b", "task-pause-b", "task-pause-c", "tasks-down"]) expect(await ui.find({ key })).toBeUndefined();

  await ui.press({ key: "task-pause-a" });
  expect(b.calls.some((c) => c.method === "POST" && c.path === "/api/tasks/a/pause")).toBe(true);
  expect(await ui.find({ key: "task-resume-a" })).toBeDefined();

  await ui.press({ key: "task-cancel-b" });
  expect(b.calls.some((c) => c.method === "POST" && c.path === "/api/tasks/b/cancel")).toBe(true);
  expect(await ui.find({ key: "task-delete-b" })).toBeDefined();
  await ui.unmount();
});

test("deleting a task or clearing finished ones asks to confirm first", async ($, on) => {
  const b = backend(on, { tasks: [taskRow("a", "Runs", "running"), taskRow("c", "Done", "finished"), taskRow("d", "Also done", "cancelled")] });
  await openBoard($);
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  const deletes = () => b.calls.filter((c) => c.method === "DELETE" || c.path === "/api/tasks/clear");

  await ui.press({ key: "task-delete-c" });
  expect(await ui.find({ key: "task-delete-c" })).toBeUndefined();
  expect(await ui.find({ key: "task-delete-c-keep" })).toBeDefined();
  await ui.press({ key: "task-delete-c-keep" });
  expect(await ui.find({ key: "task-delete-c" })).toBeDefined();
  expect(deletes()).toHaveLength(0);

  await ui.press({ key: "task-delete-c" });
  await ui.press({ key: "task-delete-c-confirm" });
  expect(deletes()).toEqual([expect.objectContaining({ method: "DELETE", path: "/api/tasks/c" })]);
  expect(await title(ui, "Done")).toBeUndefined();

  await ui.press({ key: "tasks-clear" });
  expect(deletes()).toHaveLength(1);
  await ui.press({ key: "tasks-clear-confirm" });
  expect(deletes()).toHaveLength(2);
  expect(b.tasks.map((t) => t.id)).toEqual(["a"]);
  expect(await ui.find({ type: "Text", text: /^Deleted 1 finished task\.$/ })).toBeDefined();
  expect(await ui.find({ key: "tasks-clear" })).toBeUndefined();
  await ui.unmount();
});

const many = () => Array.from({ length: 12 }, (_, i) => taskRow(`t-${i + 1}`, `Task ${i + 1}`, i === 0 ? "running" : "finished"));

test("every section but Dispatch collapses to its summary and saves the choice", async ($, on) => {
  const b = backend(on, { tasks: many() });
  await openBoard($);
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  const posted = () => b.calls.filter((c) => c.path === "/api/settings").map((c) => c.body?.collapsed);
  expect(await ui.find({ key: "fold-dispatch" })).toBeUndefined();
  expect((await ui.findAll({ type: "Button", text: /^[⏷⏵]$/ })).filter((b) => String(b.key).startsWith("fold-"))).toHaveLength(5);

  await ui.press({ key: "fold-savings" });
  expect(await ui.find({ type: "Text", text: /^75% saved$/ })).toBeUndefined();
  expect(await ui.find({ type: "Text", text: /^Today —$/ })).toBeDefined();

  await ui.press({ key: "fold-executor" });
  expect(await ui.find({ key: "model" })).toBeUndefined();
  expect(await ui.find({ type: "Text", text: /^cursor · default model$/ })).toBeDefined();

  await ui.press({ key: "sdd-open" });
  expect(await ui.find({ type: "Text", text: /^On$/ })).toBeUndefined();
  await ui.press({ key: "fold-sdd" });
  expect(await ui.find({ key: "sdd-open" })).toBeUndefined();
  expect(await ui.find({ key: `p-${P1}` })).toBeUndefined();
  expect(await ui.find({ type: "Text", text: /^On$/ })).toBeDefined();

  expect(await ui.find({ key: "tasks-down" })).toBeDefined();
  await ui.press({ key: "fold-tasks" });
  expect(await title(ui, "Task 1")).toBeUndefined();
  for (const key of ["tasks-down", "tasks-clear"]) expect(await ui.find({ key })).toBeUndefined();
  expect(await ui.find({ type: "Text", text: /^1 running$/ })).toBeDefined();
  expect(await ui.find({ type: "Text", text: /^1–8 \/ 12$/ })).toBeDefined();

  // Nothing known about updates yet: no summary.
  await ui.press({ key: "fold-update" });
  expect(await ui.find({ key: "upd-open" })).toBeUndefined();
  expect(await ui.find({ type: "Text", text: /^Up to date$/ })).toBeUndefined();
  await ui.press({ key: "fold-update" });
  await ui.press({ key: "upd-open" });
  await ui.press({ key: "fold-update" });
  expect(await ui.find({ key: "upd-check" })).toBeUndefined();
  expect(await ui.find({ type: "Text", text: /^Up to date$/ })).toBeDefined();

  const all = ["savings", "executor", "sdd", "tasks", "update"];
  expect(posted()).toEqual([1, 2, 3, 4, 5, 4, 5].map((n) => all.slice(0, n)));
  expect(await ui.find({ key: "auto-on" })).toBeDefined();

  await ui.press({ key: "fold-executor" });
  expect(await ui.find({ key: "model" })).toBeDefined();
  expect(b.settings.board).toEqual({ collapsed: ["savings", "sdd", "tasks", "update"] });
  await ui.unmount();
});

test("sections saved as collapsed load collapsed", async ($, on) => {
  backend(on, { collapsed: ["executor", "tasks"] });
  await openBoard($);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect((await ui.find({ key: "fold-executor" }))?.text).toBe("⏵");
  expect((await ui.find({ key: "fold-sdd" }))?.text).toBe("⏷");
  expect(await ui.find({ key: "model" })).toBeUndefined();
  expect(await title(ui, "Build login")).toBeUndefined();
  expect(await ui.find({ key: "sdd-open" })).toBeDefined();
  await ui.unmount();
});

test("a refused collapse puts the section back and shows why", async ($, on) => {
  backend(on, { settingsDown: true });
  await openBoard($);
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  await ui.press({ key: "fold-executor" });
  expect((await ui.find({ key: "fold-executor" }))?.text).toBe("⏷");
  expect(await ui.find({ key: "model" })).toBeDefined();
  expect(await ui.find({ type: "Text", text: /^Settings file is unreadable$/ })).toBeDefined();
  await ui.unmount();
});
