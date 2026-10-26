import { atom, read, update } from "claude-code";
import type { EngineInterface, Register, RenderChildren } from "claude-code";

import type { BoardModel, ExecutorRuntime, Permission, Settings, SddView, UpdateView } from "../types/index";

const PANE = "agentforge-board";
const COMMAND = "forge-board";
const DEFAULT = "__default__";

const EMPTY: BoardModel = { loaded: false, executors: [], running: 0, runtime: {}, tasks: [], sddOpen: false, updateOpen: false };
// Change the tag when BoardModel's fields change: it declines what an earlier version stored.
const board = atom({ plugin: "agentforge", key: "board" } as const, EMPTY, { shape: "board-1" });

type Install = { home: string; node: string; cli: string };
type Conn = { port: number; token: string };

let install: Install | undefined;
let conn: Conn | undefined;
let timer: { cancel: () => void } | undefined;

const PERMISSION_LABELS: Record<Permission | typeof DEFAULT, string> = {
  [DEFAULT]: "Executor default",
  sandbox: "Sandbox (writes confined)",
  "auto-review": "Auto-review tool calls",
  "sandbox+auto-review": "Sandbox + auto-review",
};

async function installation($: EngineInterface): Promise<Install> {
  install ??= JSON.parse(await $.fs.read(`${$.plugin.root}/hooks/home.json`)) as Install;
  return install;
}

async function readConn($: EngineInterface): Promise<Conn | undefined> {
  const { home } = await installation($);
  try {
    const info = JSON.parse(await $.fs.read(`${home}/backend.json`)) as { port: number };
    const token = (await $.fs.read(`${home}/backend.token`)).trim();
    return { port: info.port, token };
  } catch {
    return undefined;
  }
}

/** The shared backend's address; starts it when no backend answers. */
async function connect($: EngineInterface, restart = false): Promise<Conn> {
  if (conn && !restart) return conn;
  const found = await readConn($);
  if (found && !restart) {
    const health = await $.http.fetch(`http://127.0.0.1:${found.port}/api/health`).catch(() => undefined);
    if (health?.ok) return (conn = found);
  }
  const { node, cli, home } = await installation($);
  const started = await $.process.run([node, cli, "backend", "start"], { env: { CLAUDEFORGE_HOME: home }, timeoutMs: 30_000 });
  if (started.exitCode !== 0) throw new Error(`Could not start agentforge-backend: ${started.stderr.trim() || started.stdout.trim()}`);
  const fresh = await readConn($);
  if (!fresh) throw new Error("agentforge-backend started but left no address.");
  return (conn = fresh);
}

async function api<T>($: EngineInterface, method: string, route: string, body?: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const c = await connect($, attempt > 0);
    let res;
    try {
      res = await $.http.fetch(`http://127.0.0.1:${c.port}${route}`, {
        method,
        headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      conn = undefined;
      if (attempt === 0) continue;
      throw err;
    }
    const payload = (res.text ? JSON.parse(res.text) : {}) as T & { error?: string };
    if (!res.ok) throw new Error(payload.error ?? `HTTP ${res.status}`);
    return payload;
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const set = ($: EngineInterface, fn: (m: BoardModel) => BoardModel) => update($, board, fn);
const notice = ($: EngineInterface, text: string | undefined) => set($, (m) => ({ ...m, notice: text }));

type BoardResponse = Pick<BoardModel, "settings" | "corrupt" | "executors" | "hook" | "backend" | "running">;

async function refresh($: EngineInterface): Promise<void> {
  try {
    const [b, tasks, hooksDisabled] = await Promise.all([
      api<BoardResponse>($, "GET", "/api/board"),
      api<BoardModel["tasks"]>($, "GET", "/api/tasks?limit=5"),
      $.settings.read({ key: "disableAllHooks" }).catch(() => undefined),
    ]);
    const current = await read($, board);
    await set($, (m) => ({ ...m, ...b, tasks, hooksDisabled: hooksDisabled === true, loaded: true, error: undefined }));
    if (b.settings && !current.runtime[b.settings.executor]) void loadRuntime($, b.settings.executor);
    if (current.updateOpen && current.update?.busy) void refreshUpdate($);
    $.ui.status(b.settings ? `AgentForge: auto-dispatch ${b.settings.enabled ? "ON" : "OFF"} · ${b.settings.executor}` : undefined);
  } catch (err) {
    await set($, (m) => ({ ...m, loaded: true, error: message(err) }));
  }
}

async function loadRuntime($: EngineInterface, executor: string): Promise<void> {
  await set($, (m) => ({ ...m, runtime: { ...m.runtime, [executor]: { loading: true } } }));
  try {
    const info = await api<{ executors: Record<string, ExecutorRuntime> }>($, "GET", `/api/runtime?executor=${encodeURIComponent(executor)}`);
    const entry = info.executors[executor];
    if (entry) await set($, (m) => ({ ...m, runtime: { ...m.runtime, [executor]: entry } }));
  } catch (err) {
    await set($, (m) => ({ ...m, runtime: { ...m.runtime, [executor]: { online: false, defaultModel: "", permissions: [], error: message(err) } } }));
  }
}

async function change($: EngineInterface, body: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await api<{ settings: Settings; hook: BoardModel["hook"] }>($, "POST", "/api/settings", body);
    await set($, (m) => ({ ...m, settings: res.settings, hook: res.hook, notice: undefined }));
    if (body.executor) void loadRuntime($, res.settings.executor);
    if (body.sddWorkspace !== undefined || body.sddEnabled !== undefined) void loadSdd($);
    return true;
  } catch (err) {
    await notice($, message(err));
    return false;
  }
}

async function refreshUpdate($: EngineInterface, method = "GET", route = "/api/update"): Promise<void> {
  try {
    const status = await api<UpdateView>($, method, route);
    const full = method === "GET" ? status : { ...(await api<UpdateView>($, "GET", "/api/update")), ...status };
    await set($, (m) => ({ ...m, update: full }));
  } catch (err) {
    await notice($, message(err));
  }
}

// --- SDD ---------------------------------------------------------------------

const q = (v: string) => encodeURIComponent(v);

async function loadSdd($: EngineInterface, keep?: Pick<SddView, "projectId" | "taskId">): Promise<void> {
  try {
    const ws = await api<{ dir: string; enabled: boolean; corrupt?: string }>($, "GET", "/api/sdd/workspace");
    const projects = await api<SddView["projects"]>($, "GET", `/api/sdd/projects?workspace=${q(ws.dir)}`);
    const projectId = keep?.projectId && projects.some((p) => p.id === keep.projectId) ? keep.projectId : undefined;
    const tasks = projectId ? await api<SddView["tasks"]>($, "GET", `/api/sdd/tasks?project=${q(projectId)}&workspace=${q(ws.dir)}`) : [];
    await set($, (m) => {
      const prev = m.sdd;
      const sameDoc = prev?.taskId === keep?.taskId && prev?.dir === ws.dir;
      return { ...m, sdd: { ...ws, projects, projectId, tasks, taskId: keep?.taskId, doc: sameDoc ? prev?.doc : undefined, draft: sameDoc ? prev?.draft : undefined, conflict: sameDoc ? prev?.conflict : undefined } };
    });
  } catch (err) {
    await notice($, message(err));
  }
}

async function openTask($: EngineInterface, projectId: string, taskId: string): Promise<void> {
  const s = (await read($, board)).sdd;
  if (!s) return;
  if (s.draft !== undefined && s.doc && s.draft !== s.doc.content && s.taskId !== taskId) {
    await notice($, "Save or discard the unsaved draft first.");
    return;
  }
  try {
    const doc = await api<SddView["doc"] & { id: string }>($, "GET", `/api/sdd/task?project=${q(projectId)}&task=${q(taskId)}&workspace=${q(s.dir)}`);
    await set($, (m) => ({ ...m, sdd: m.sdd && { ...m.sdd, projectId, taskId, doc, draft: undefined, conflict: undefined } }));
  } catch (err) {
    await notice($, message(err));
  }
}

/** Saves the draft against the revision it was read at; a conflict keeps the draft. */
async function saveDraft($: EngineInterface): Promise<boolean> {
  const s = (await read($, board)).sdd;
  if (!s?.doc || !s.projectId || !s.taskId || s.draft === undefined || s.draft === s.doc.content) return true;
  try {
    const doc = await api<NonNullable<SddView["doc"]>>($, "POST", "/api/sdd/save", { project: s.projectId, task: s.taskId, content: s.draft, baseRevision: s.doc.revision, workspace: s.dir });
    await set($, (m) => ({ ...m, notice: "Saved task.md.", sdd: m.sdd && { ...m.sdd, doc, draft: undefined, conflict: undefined } }));
    void loadSdd($, { projectId: s.projectId, taskId: s.taskId });
    return true;
  } catch (err) {
    const text = message(err);
    await set($, (m) => ({ ...m, sdd: m.sdd && { ...m.sdd, conflict: /changed since revision/.test(text) ? text : undefined }, notice: text }));
    return false;
  }
}

async function toggleSdd($: EngineInterface, on: boolean): Promise<void> {
  // Switching off protects an unsaved draft first; a failed save leaves the switch as it was.
  if (!on && !(await saveDraft($))) return;
  await change($, { sddEnabled: on });
}

// --- drawing -----------------------------------------------------------------

type El = ReturnType<EngineInterface["ui"]["resolve"]>;
type Full = Extract<El, { Select: unknown; Input: unknown }>;
type Surface = "terminal" | "desktop" | "vscode" | "mobile";

/** What one drawing needs: the elements, the surface, and the body's width. */
type Ctx = { E: El; surface: Surface; columns: number };

const STATUS_COLOR: Record<string, string> = {
  queued: "suggestion",
  dispatching: "suggestion",
  executing: "suggestion",
  completed: "success",
  failed: "error",
  blocked: "error",
  uncertain: "warning",
  cancelled: "inactive",
};

const UPDATE_LABEL: Record<string, { text: string; color: string }> = {
  up_to_date: { text: "Up to date", color: "success" },
  available: { text: "Update available", color: "suggestion" },
  ahead: { text: "Local commits not on origin", color: "inactive" },
  dirty: { text: "Local changes block updates", color: "warning" },
  diverged: { text: "Diverged from origin", color: "warning" },
  offline: { text: "Origin unreachable", color: "warning" },
  no_upstream: { text: "No upstream branch", color: "warning" },
  unverified_remote: { text: "Origin not verified", color: "error" },
  error: { text: "Check failed", color: "error" },
};

const time = (iso?: string) => (iso ? iso.slice(11, 16) : "?");
const stamp = (iso?: string) => (iso ? iso.slice(0, 16).replace("T", " ") : "");

/** The hairline gray of Claude Code's own cards; the terminal keeps its theme's dim border. */
const LINE = "#E7E5E0";
const line = (c: Ctx) => (c.surface === "terminal" ? { borderColor: "subtle", borderDimColor: true } : { borderColor: LINE });

const RULE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="1" viewBox="0 0 4000 1" preserveAspectRatio="none"><rect width="4000" height="1" fill="${LINE}"/></svg>`;

/** A hairline between rows: a 1px rule where the surface draws SVG, a dim line on the terminal. */
function rule(c: Ctx) {
  const { Text } = c.E;
  if (c.surface === "terminal") return <Text dimColor>{"─".repeat(Math.max(10, c.columns - 8))}</Text>;
  const { Svg } = c.E as Extract<El, { Svg: unknown }>;
  return <Svg source={RULE_SVG} alt="" height={1} />;
}

/** A settings group: a semibold heading, optional text at its end, then rows split by rules. */
function section(c: Ctx, title: string, rows: RenderChildren[], aside?: RenderChildren) {
  const { Box, Text } = c.E;
  const kept = rows.filter((r) => r !== null && r !== undefined && r !== false);
  return (
    <Box flexDirection="column" gap="sm">
      <Box flexDirection="row" justifyContent="space-between" alignItems="center">
        <Text weight="semibold">{title}</Text>
        {aside ?? null}
      </Box>
      <Box flexDirection="column" borderStyle="round" {...line(c)} paddingX="md">
        {kept.flatMap((r, i) => (i === 0 ? [r] : [rule(c), r]))}
      </Box>
    </Box>
  );
}

/** One setting: title and description on the left, the control on the right. */
function row(c: Ctx, title: RenderChildren, description: RenderChildren | undefined, control?: RenderChildren, below?: RenderChildren) {
  const { Box, Text } = c.E;
  return (
    <Box flexDirection="column" paddingY="sm" gap="sm">
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap="lg">
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {typeof title === "string" ? <Text weight="medium">{title}</Text> : title}
          {description === undefined ? null : typeof description === "string" ? (
            <Text size="footnote" dimColor wrap="wrap">{description}</Text>
          ) : (
            description
          )}
        </Box>
        {control === undefined ? null : <Box flexShrink={0}>{control}</Box>}
      </Box>
      {below ?? null}
    </Box>
  );
}

/** A segmented control, as Claude Code's settings draw one: the chosen option raised, the rest plain. */
function segmented(c: Ctx, key: string, options: { value: string; label: string }[], value: string, onPick: (v: string) => void) {
  const { Box, Button } = c.E;
  return (
    <Box flexDirection="row" borderStyle="round" {...line(c)} columnGap="xs">
      {options.map((o) =>
        o.value === value ? (
          <Button key={`${key}-${o.value}`} variant="secondary" onPress={() => undefined}>
            {o.label}
          </Button>
        ) : (
          <Button key={`${key}-${o.value}`} plain dimColor onPress={() => onPick(o.value)}>
            {o.label}
          </Button>
        ),
      )}
    </Box>
  );
}

const ON_OFF = [
  { value: "off", label: "Off" },
  { value: "on", label: "On" },
];

function onOff(c: Ctx, key: string, on: boolean, set: (on: boolean) => void) {
  return segmented(c, key, ON_OFF, on ? "on" : "off", (v) => set(v === "on"));
}

function dispatchSection($: EngineInterface, c: Ctx, m: BoardModel) {
  const { E } = c;
  const { Box, Text } = E;
  const s = m.settings!;
  const hook = m.hooksDisabled
    ? { color: "error", text: "✕ Hooks are disabled in Claude Code settings (disableAllHooks); auto-dispatch cannot apply." }
    : m.hook?.state === "active"
      ? { color: "success", text: `● Hook active · last run ${time(m.hook.lastRunAt)}` }
      : { color: "warning", text: `◐ Pending · ${m.hook?.detail ?? "waiting for the next message."}` };
  return section(c, "Dispatch", [
    row(
      c,
      "Auto-dispatch",
      <Box flexDirection="column">
        <Text size="footnote" dimColor wrap="wrap">
          {s.enabled
            ? "Claude plans and accepts; a background agent implements. Questions and discussion stay with Claude."
            : "Claude works as usual. Explicit requests still dispatch, and running tasks continue."}
        </Text>
        <Text size="footnote" color={hook.color} wrap="wrap">{hook.text}</Text>
      </Box>,
      onOff(c, "auto", s.enabled, (on) => void change($, { enabled: on })),
    ),
  ]);
}

function executorSection($: EngineInterface, c: Ctx, m: BoardModel) {
  const { E } = c;
  const { Text, Select } = E as Full;
  const s = m.settings!;
  const rt = m.runtime[s.executor];
  const loading = rt !== undefined && "loading" in rt;
  const runtime = rt && !("loading" in rt) ? rt : undefined;
  const models = runtime?.models ?? [];
  const model = s.route ? models.find((x) => x.id === s.route!.model) : undefined;
  const efforts = model?.efforts ?? [];
  const permissions = runtime?.permissions ?? [];
  const aside = loading ? (
    <Text size="footnote" dimColor>Loading catalog…</Text>
  ) : runtime?.online === false ? (
    <Text size="footnote" color="error">● Offline</Text>
  ) : runtime ? (
    <Text size="footnote" color="success">{`● online · ${models.length} models`}</Text>
  ) : undefined;

  const modelNote =
    runtime?.online === false
      ? `Catalog unavailable: ${runtime.error ?? "unknown error"}`
      : s.route && runtime?.models && !model
        ? `${s.route.model} left the catalog; it stays selected until you change it.`
        : "A fixed model, or whatever the executor uses by default.";

  return section(
    c,
    "Executor",
    [
      row(c, "Executor", "Where dispatched work runs.", <Select key="executor" value={s.executor} options={m.executors.map((x) => ({ value: x }))} onSelect={(v) => void change($, { executor: v })} />),
      row(
        c,
        "Model",
        modelNote,
        <Select
          key="model"
          value={s.route?.model ?? DEFAULT}
          options={[
            { value: DEFAULT, label: `Executor default (${runtime?.defaultModel || "default"})` },
            ...(s.route && !models.some((x) => x.id === s.route!.model) ? [{ value: s.route.model, label: `${s.route.model} (unavailable)` }] : []),
            ...models.map((x) => ({ value: x.id, label: x.displayName && x.displayName !== x.id ? `${x.displayName} (${x.id})` : x.id })),
          ]}
          onSelect={(v) => void change($, { model: v === DEFAULT ? null : v })}
        />,
      ),
      row(
        c,
        "Thinking effort",
        s.route && efforts.length ? "Only the levels the catalog lists for this model." : s.route ? "This model offers no levels; it follows the model default." : "Pick a fixed model to set a level.",
        s.route && efforts.length ? (
          <Select
            key="effort"
            value={s.effort ?? DEFAULT}
            options={[{ value: DEFAULT, label: "Model default" }, ...efforts.map((x) => ({ value: x }))]}
            onSelect={(v) => void change($, { effort: v === DEFAULT ? null : v })}
          />
        ) : (
          <Text dimColor>Model default</Text>
        ),
      ),
      permissions.length
        ? row(
            c,
            "New-session permission",
            "Applied once, when a task creates its agent; follow-ups keep it.",
            <Select
              key="permission"
              value={s.permission ?? DEFAULT}
              options={[DEFAULT, ...permissions].map((x) => ({ value: x, label: PERMISSION_LABELS[x as Permission | typeof DEFAULT] ?? x }))}
              onSelect={(v) => void change($, { permission: v === DEFAULT ? null : v })}
            />,
          )
        : null,
    ],
    aside,
  );
}

function tasksSection(c: Ctx, m: BoardModel) {
  const { E } = c;
  const { Box, Text } = E;
  const rows = m.tasks.length
    ? m.tasks.map((t) =>
        row(
          c,
          <Text weight="medium" wrap="truncate-end">{t.title}</Text>,
          <Text size="footnote" dimColor mono wrap="truncate-end">{`${t.id}${t.updatedAt ? ` · ${stamp(t.updatedAt)}` : ""}`}</Text>,
          <Box flexDirection="row" columnGap="xs">
            <Text size="footnote" color={STATUS_COLOR[t.orderStatus] ?? "inactive"}>●</Text>
            <Text size="footnote" color={STATUS_COLOR[t.orderStatus] ?? "inactive"}>{t.orderStatus}</Text>
          </Box>,
        ),
      )
    : [row(c, <Text dimColor>No tasks yet.</Text>, undefined)];
  return section(c, "Recent tasks", rows, <Text size="footnote" color={m.running ? "suggestion" : undefined} dimColor={!m.running}>{`${m.running} running`}</Text>);
}

function sddSection($: EngineInterface, c: Ctx, m: BoardModel) {
  const { E, columns } = c;
  const { Box, Text, Button, Input } = E as Full;
  const s = m.settings!;
  const d = m.sdd;
  const showButton = (
    <Button key="sdd-open" variant="secondary" onPress={() => void set($, (x) => ({ ...x, sddOpen: !x.sddOpen })).then(() => (m.sddOpen ? undefined : loadSdd($, m.sdd)))}>
      {m.sddOpen ? "Hide" : "Browse"}
    </Button>
  );
  const rows: RenderChildren[] = [
    row(
      c,
      "Task documents",
      "Save each dispatched task's plan as Markdown (goal, scope, plan, acceptance) before handing it over.",
      onOff(c, "sdd", s.sdd.enabled, (on) => void toggleSdd($, on)),
    ),
    row(c, "Workspace", <Text size="footnote" dimColor mono wrap="truncate-start">{s.sdd.workspace}</Text>, showButton),
  ];
  if (m.sddOpen && !d) rows.push(row(c, <Text dimColor>Loading…</Text>, undefined));
  if (m.sddOpen && d) {
    const project = d.projects.find((p) => p.id === d.projectId);
    const dirty = d.doc !== undefined && d.draft !== undefined && d.draft !== d.doc.content;
    if (!d.enabled) rows.push(row(c, <Text color="warning">{d.corrupt ? "Settings unreadable" : "Read-only"}</Text>, d.corrupt ? `Writes refused (${d.corrupt}).` : "Turn task documents on to create or edit them."));
    rows.push(
      row(c, "Move workspace", "An absolute path; documents already there stay put.", undefined, <Input key="sdd-dir" value={d.dir} submitLabel="Set" onSubmit={(v) => void change($, { sddWorkspace: v })} />),
    );
    rows.push(
      row(
        c,
        "Projects",
        d.projects.length ? undefined : "None yet.",
        undefined,
        <Box flexDirection="column" gap="sm">
          {d.projects.length ? (
            <Box flexDirection="row" flexWrap="wrap" columnGap="sm" rowGap="xs">
              {d.projects.map((p) => (
                <Button key={`p-${p.id}`} variant={p.id === d.projectId ? "primary" : "secondary"} onPress={() => void loadSdd($, { projectId: p.id })}>
                  {`${p.name} · ${p.tasks}`}
                </Button>
              ))}
            </Box>
          ) : null}
          {d.enabled ? (
            <Input
              key="sdd-new-project"
              placeholder="New project name"
              submitLabel="Create"
              onSubmit={(v) =>
                void api<{ id: string }>($, "POST", "/api/sdd/project", { name: v, workspace: d.dir })
                  .then((p) => loadSdd($, { projectId: p.id }))
                  .catch((err) => notice($, message(err)))
              }
            />
          ) : null}
        </Box>,
      ),
    );
    if (project) {
      rows.push(
        row(
          c,
          `Tasks in ${project.name}`,
          d.tasks.length ? undefined : "None yet.",
          undefined,
          <Box flexDirection="column" gap="xs">
            {d.tasks.map((t) => (
              <Button key={`t-${t.id}`} plain dimColor={t.id !== d.taskId} onPress={() => void openTask($, project.id, t.id)}>
                {`${t.id === d.taskId ? "●" : "○"}  ${t.title}  `}
                <Text size="footnote" dimColor>{stamp(t.updatedAt)}</Text>
              </Button>
            ))}
            {d.enabled ? (
              <Input
                key="sdd-new-task"
                placeholder="New task title"
                submitLabel="Create"
                onSubmit={(v) =>
                  void api<{ id: string }>($, "POST", "/api/sdd/task", { project: project.id, title: v, workspace: d.dir })
                    .then((t) => loadSdd($, { projectId: project.id, taskId: t.id }).then(() => openTask($, project.id, t.id)))
                    .catch((err) => notice($, message(err)))
                }
              />
            ) : null}
          </Box>,
        ),
      );
    }
    if (d.doc) {
      rows.push(
        row(
          c,
          <Text weight="medium" wrap="truncate-end">{d.doc.title}</Text>,
          <Text size="footnote" dimColor mono wrap="truncate-start">{d.doc.path}</Text>,
          <Text size="footnote" color={d.conflict ? "error" : dirty ? "warning" : "success"}>{d.conflict ? "● conflict" : dirty ? "● unsaved" : "✓ saved"}</Text>,
          <Box flexDirection="column" gap="sm">
            {d.conflict ? <Text size="footnote" color="error" wrap="wrap">{`Conflict: ${d.conflict} Your draft is kept; copy what you need, then reload.`}</Text> : null}
            <Input
              key="sdd-editor"
              rows={Math.max(8, Math.min(20, Math.floor(columns / 4)))}
              value={d.draft ?? d.doc.content}
              submitLabel="Save"
              onInput={(v) => void set($, (x) => ({ ...x, sdd: x.sdd && { ...x.sdd, draft: v } }))}
              onSubmit={(v) => void set($, (x) => ({ ...x, sdd: x.sdd && { ...x.sdd, draft: v } })).then(() => saveDraft($))}
            />
            <Box flexDirection="row" columnGap="sm" justifyContent="flex-end">
              <Button key="sdd-copy" plain dimColor onPress={(e) => void $.ui.copy({ text: d.doc!.path, surface: e.surface }).then(() => notice($, "Path copied."))}>
                Copy path
              </Button>
              <Button key="sdd-reload" variant="secondary" onPress={() => void set($, (x) => ({ ...x, sdd: x.sdd && { ...x.sdd, draft: undefined } })).then(() => openTask($, d.projectId!, d.taskId!))}>
                {dirty ? "Discard & reload" : "Reload"}
              </Button>
              {d.enabled ? (
                <Button key="sdd-save" variant={dirty ? "primary" : "secondary"} onPress={() => void saveDraft($)}>
                  {dirty ? "Save" : "Saved"}
                </Button>
              ) : null}
            </Box>
          </Box>,
        ),
      );
    }
  }
  return section(c, "SDD documents", rows);
}

function updateSection($: EngineInterface, c: Ctx, m: BoardModel) {
  const { E } = c;
  const { Box, Text, Button } = E;
  const u = m.update;
  const label = u ? (UPDATE_LABEL[u.state] ?? { text: u.state, color: "inactive" }) : undefined;
  const status = u?.busy ? (
    <Text size="footnote" color="suggestion">{u.busy === "apply" ? "Installing…" : "Checking…"}</Text>
  ) : label ? (
    <Text size="footnote" color={label.color}>{`● ${label.text}`}</Text>
  ) : (
    <Text size="footnote" dimColor>Not checked yet</Text>
  );
  const toggleDetails = (
    <Button key="upd-open" variant="secondary" onPress={() => void set($, (x) => ({ ...x, updateOpen: !x.updateOpen })).then(() => (m.updateOpen ? undefined : refreshUpdate($)))}>
      {m.updateOpen ? "Hide" : "Details"}
    </Button>
  );
  const rows: RenderChildren[] = [
    row(c, `AgentForge ${m.backend ? `v${m.backend.version}` : ""}`.trim(), status, toggleDetails),
  ];
  if (m.updateOpen) {
    const stale = u?.backendVersion && u.installedVersion && u.backendVersion !== u.installedVersion;
    const failed = u?.apply && !u.apply.ok;
    rows.push(
      row(
        c,
        u ? <Text wrap="wrap">{u.message}</Text> : <Text dimColor>Reading local status…</Text>,
        u?.local ? <Text size="footnote" dimColor mono>{`local ${u.local} · origin ${u.remote ?? "?"}${u.checkedAt ? ` · checked ${stamp(u.checkedAt)}` : ""}`}</Text> : undefined,
        undefined,
        <Box flexDirection="column" gap="sm">
          {failed ? <Text size="footnote" color="warning" wrap="wrap">{`Last install stopped${u!.apply!.stage ? ` after ${u!.apply!.stage}` : ""}: ${u!.apply!.error ?? ""}`}</Text> : null}
          {stale ? <Text size="footnote" color="warning" wrap="wrap">{`Backend runs ${u!.backendVersion}, installed ${u!.installedVersion}: restart the backend, then /reload-plugins.`}</Text> : null}
          <Box flexDirection="row" columnGap="sm" flexWrap="wrap" justifyContent="flex-end">
            <Button key="upd-refresh" plain dimColor onPress={() => void refreshUpdate($)}>Refresh status</Button>
            <Button key="upd-check" variant="secondary" onPress={() => void refreshUpdate($, "POST", "/api/update/check")}>Check for updates</Button>
            {stale ? (
              <Button key="upd-restart" variant="secondary" onPress={() => void api($, "POST", "/api/backend/restart").then(() => (conn = undefined)).catch((err) => notice($, message(err)))}>
                Restart backend
              </Button>
            ) : null}
            {u?.state === "available" || failed ? (
              <Button key="upd-apply" variant="primary" onPress={() => void refreshUpdate($, "POST", "/api/update/apply")}>
                {failed ? "Retry install" : "Install update"}
              </Button>
            ) : null}
          </Box>
        </Box>,
      ),
    );
  }
  return section(c, "Plugin update", rows);
}

/** One footnote line at the top: backend and where dispatched work goes. */
function header(c: Ctx, m: BoardModel) {
  const { Box, Text } = c.E;
  const s = m.settings;
  return (
    <Box flexDirection="row" justifyContent="space-between" columnGap="lg" flexWrap="wrap">
      {m.backend ? (
        <Text size="footnote" color="success">{"● Connected"}<Text dimColor>{` · backend pid ${m.backend.pid}`}</Text></Text>
      ) : (
        <Text size="footnote" color={m.error ? "error" : "inactive"}>{m.error ? "○ Backend offline" : "Connecting…"}</Text>
      )}
      {s ? <Text size="footnote" dimColor wrap="truncate-end">{`${s.executor} · ${s.route?.model ?? "default model"}${s.effort ? ` · ${s.effort}` : ""}`}</Text> : null}
    </Box>
  );
}

type BoardMode = "auto" | "button" | "command";
const boardMode = (raw: unknown): BoardMode => (raw === "auto" || raw === "command" ? raw : "button");

let paneOpen = false;
let closedByPerson = false;

async function openBoard($: EngineInterface, focus: boolean) {
  const opened = await $.ui.open({ id: PANE, title: "AgentForge", columns: 64, ...(focus ? { focus: true as const } : {}) });
  paneOpen = true;
  timer?.cancel();
  timer = $.clock.every(3000, () => void refresh($));
  void refresh($);
  void refreshUpdate($, "POST", "/api/update/check-daily");
  return opened;
}

export const register: Register = (on, options) => {
  const mode = boardMode(options.board);

  on("session.start", async ($, e, next) => {
    await $.command.register({ name: COMMAND, immediate: true, description: "Open the AgentForge board: auto-dispatch, executor, model, effort, permission, SDD documents, plugin update" });
    paneOpen = false;
    closedByPerson = false;
    void refresh($);
    if (mode === "auto") void openBoard($, false).catch(() => undefined);
    return next(e);
  });

  on("command.run", { command: COMMAND }, async ($) => {
    const opened = await openBoard($, true);
    return { text: opened.isPlaced ? "AgentForge board opened." : `AgentForge board could not be placed: ${"reason" in opened ? opened.reason : "no room"}.` };
  });

  // Hidden boards stop polling; tasks keep running in the backend.
  on("ui.close", { id: PANE }, async ($, e, next) => {
    timer?.cancel();
    timer = undefined;
    paneOpen = false;
    if (e.origin.kind === "person") closedByPerson = true;
    return next(e);
  });

  // With the board closed, one row above the prompt shows where dispatch stands and opens it.
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (mode !== "button" || paneOpen || e.props.hasSurvey) return next(e);
    const m = await read($, board);
    const { Box, Text, Button } = $.ui.resolve(e);
    const s = m.settings;
    const summary = s
      ? [`Auto-dispatch ${s.enabled ? "on" : "off"}`, s.executor, s.route?.model ?? "default model", m.running ? `${m.running} running` : ""].filter(Boolean).join(" · ")
      : m.error
        ? "Backend offline"
        : "Connecting…";
    return (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap="md">
        <Text wrap="truncate-end">
          <Text weight="medium">AgentForge</Text>
          <Text dimColor>{`  ${summary}`}</Text>
        </Text>
        <Button key="open-board" variant="secondary" onPress={() => void openBoard($, true)}>
          Open board
        </Button>
      </Box>
    );
  });

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const E = $.ui.resolve(e);
    const { Box, Text } = E;
    const m = await read($, board);
    const c: Ctx = { E, surface: e.surface as Surface, columns: e.props.bodyColumns ?? 60 };
    const head = header(c, m);
    const page = (...children: RenderChildren[]) => (
      <Box flexDirection="column" gap="lg" paddingX="sm" paddingY="sm">
        {children}
      </Box>
    );
    if (!m.loaded) return page(head, <Text dimColor>Connecting to agentforge-backend…</Text>);
    if (m.error && !m.settings) return page(head, <Text color="error" wrap="wrap">{m.error}</Text>);
    if (m.corrupt) {
      return page(
        head,
        section(c, "Settings", [
          row(c, <Text weight="medium" color="error">Settings unreadable</Text>, `${m.corrupt}. Everything reads as off; fix or delete ~/.claudeforge/delegation.json, then run \`agentforge config set enabled=false\`.`),
        ]),
      );
    }
    if (e.surface === "mobile") {
      const s = m.settings!;
      return page(head, <Text>{`Auto-dispatch ${s.enabled ? "ON" : "OFF"} · SDD ${s.sdd.enabled ? "on" : "off"}`}</Text>, tasksSection(c, m));
    }
    return page(
      head,
      m.notice ? <Text size="footnote" color="warning" wrap="wrap">{m.notice}</Text> : null,
      dispatchSection($, c, m),
      executorSection($, c, m),
      sddSection($, c, m),
      tasksSection(c, m),
      updateSection($, c, m),
    );
  });
};
