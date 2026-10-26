import { expect, test } from "claude-code/testing";
import type { Engine } from "claude-code/testing";
import type { On } from "claude-code";

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

type Call = { method: string; path: string; body?: Record<string, unknown> };

/** An in-memory agentforge-backend answering the board's /api routes. */
function backend(on: On, opts: { conflict?: boolean } = {}) {
  const calls: Call[] = [];
  const settings: Record<string, unknown> = { enabled: false, executor: "cursor", sdd: { enabled: true, workspace: WS } };
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
    calls.push({ method, path: url.pathname, body });
    switch (`${method} ${url.pathname}`) {
      case "GET /api/health":
        return json(200, { ok: true });
      case "GET /api/board":
        return json(200, { settings, executors: ["cursor"], hook: { state: "active", detail: "", lastRunAt: "2026-10-23T10:00:00.000Z" }, backend: { pid: 42, version: "0.4.0" }, running: 1 });
      case "GET /api/tasks":
        return json(200, [{ id: "t-1", title: "Build login", orderStatus: "executing", worker: "cursor", model: "composer-2.5", updatedAt: "" }]);
      case "GET /api/runtime":
        return json(200, { executors: { cursor: runtime } });
      case "POST /api/settings": {
        const c = body!;
        if (c.enabled !== undefined) settings.enabled = c.enabled;
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
        return json(200, { state: "up_to_date", message: "Up to date.", local: "abc1234", remote: "abc1234", backendVersion: "0.4.0", installedVersion: "0.4.0" });
      case "POST /api/update/check-daily":
        return json(200, { state: "up_to_date", message: "Up to date." });
      default:
        return json(404, { error: `no route ${method} ${url.pathname}` });
    }
  });
  return { calls, settings, opened };
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
  expect(await ui.find({ key: "upd-apply" })).toBeUndefined();
  expect(await ui.find({ key: "upd-check" })).toBeDefined();
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

test("the board on mobile is text only", async ($, on) => {
  backend(on);
  await openBoard($);
  const ui = await $.ui.mount({ ...PANE, surface: "mobile" });
  expect((await ui.find({ type: "Text", text: /Auto-dispatch OFF/ }))?.text).toMatch(/SDD on/);
  expect(await ui.findAll({ type: "Button" })).toHaveLength(0);
  await ui.unmount();
});
