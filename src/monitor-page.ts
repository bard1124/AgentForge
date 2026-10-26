export const MONITOR_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentForge monitor</title>
<style>
  :root { color-scheme: light dark; --line: #8884; --dim: #888; --ok: #2a9d4b; --warn: #c98a00; --bad: #d64545; }
  html, body { background: Canvas; color: CanvasText; }
  body { font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 24px; max-width: 1200px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .dim { color: var(--dim); }
  .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: baseline; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin: 16px 0; }
  .card { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
  .card b { display: block; font-size: 22px; }
  .pill { border-radius: 999px; padding: 1px 8px; border: 1px solid var(--line); font-size: 12px; }
  .on { color: var(--ok); } .off { color: var(--dim); } .bad { color: var(--bad); } .warn { color: var(--warn); }
  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  tbody tr { cursor: pointer; } tbody tr.sel { background: #8882; }
  td.mono, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  nav button { font: inherit; color: inherit; border: 1px solid var(--line); background: none; border-radius: 6px; padding: 2px 10px; cursor: pointer; }
  nav button[aria-pressed="true"] { background: #8883; }
  #detail { border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin-top: 16px; white-space: pre-wrap; }
  #warnings { margin-top: 12px; }
</style>
</head>
<body>
  <h1>AgentForge <span class="dim">· read-only monitor</span></h1>
  <div class="row"><span id="backend" class="pill">backend …</span><span id="delegation" class="dim"></span></div>
  <p class="dim">Auto-dispatch and the other settings change on the board in Claude Code (/forge-board) or with <span class="mono">agentforge config</span>; this page only reads.</p>
  <div class="cards">
    <div class="card"><span class="dim">Tasks</span><b id="n-total">–</b></div>
    <div class="card"><span class="dim">Active</span><b id="n-active">–</b></div>
    <div class="card"><span class="dim">Completed</span><b id="n-completed">–</b></div>
    <div class="card"><span class="dim">Need attention</span><b id="n-problems">–</b></div>
    <div class="card"><span class="dim">Cancelled</span><b id="n-cancelled">–</b></div>
  </div>
  <h2 style="font-size:15px">Agent conversations</h2>
  <div class="scroll"><table><thead><tr><th>Agent</th><th>Worker</th><th>Model</th><th>Tasks</th><th>Latest</th></tr></thead><tbody id="agents"></tbody></table></div>
  <div class="row" style="margin-top:20px"><h2 style="font-size:15px;margin:0">Tasks</h2>
    <nav><button data-filter="all" aria-pressed="true">All</button> <button data-filter="active">Active</button> <button data-filter="problems">Need attention</button></nav>
  </div>
  <div class="scroll"><table><thead><tr><th>Task</th><th>Status</th><th>Title</th><th>Model</th><th>Elapsed</th></tr></thead><tbody id="tasks"></tbody></table></div>
  <div id="detail" class="dim">Select a task.</div>
  <div id="warnings" class="warn"></div>
  <p class="dim" id="stamp"></p>
  <script src="/monitor.js" defer></script>
</body>
</html>
`;

export const MONITOR_CLIENT = `"use strict";
const ACTIVE = new Set(["queued", "dispatching", "executing"]);
const PROBLEMS = new Set(["failed", "blocked", "uncertain"]);
let filter = "all";
let selected = null;
let snapshot = null;

const $ = (id) => document.getElementById(id);
function cell(tr, text, cls) { const td = document.createElement("td"); td.textContent = text; if (cls) td.className = cls; tr.appendChild(td); return td; }
function elapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m " + (s % 60) + "s";
  return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m";
}
function statusClass(status) { return PROBLEMS.has(status) ? "bad" : ACTIVE.has(status) ? "warn" : status === "completed" ? "on" : "off"; }

function render() {
  const s = snapshot;
  if (!s) return;
  const b = $("backend");
  b.textContent = s.backend.online ? "backend ● pid " + s.backend.pid + " · v" + s.backend.version : "backend ○ offline";
  b.className = "pill " + (s.backend.online ? "on" : "off");
  const d = s.delegation;
  $("delegation").textContent = "Auto-dispatch " + (d.enabled ? "ON" : "OFF") + " · " + d.executor + " · " + (d.route ? d.route.model : "default model")
    + (d.effort ? " · effort " + d.effort : "") + (d.permission ? " · " + d.permission : "") + " · SDD " + (d.sdd.enabled ? "on" : "off");
  for (const k of ["total", "active", "completed", "problems", "cancelled"]) $("n-" + k).textContent = s.summary[k];

  const agents = $("agents");
  agents.replaceChildren();
  if (!s.agents.length) { const tr = agents.insertRow(); const td = cell(tr, "None yet; they appear once a task is dispatched.", "dim"); td.colSpan = 5; }
  for (const a of s.agents) {
    const tr = agents.insertRow();
    cell(tr, a.id, "mono"); cell(tr, a.worker); cell(tr, a.model); cell(tr, String(a.tasks)); cell(tr, a.latestStatus + " · " + a.latestTitle);
  }

  const list = s.tasks.filter((t) => filter === "all" || (filter === "active" ? ACTIVE.has(t.orderStatus) : PROBLEMS.has(t.orderStatus)));
  const tasks = $("tasks");
  tasks.replaceChildren();
  if (!list.length) { const tr = tasks.insertRow(); const td = cell(tr, "No matching tasks.", "dim"); td.colSpan = 5; }
  for (const t of list) {
    const tr = tasks.insertRow();
    if (t.id === selected) tr.className = "sel";
    tr.addEventListener("click", () => { selected = t.id; render(); });
    cell(tr, t.id, "mono"); cell(tr, t.orderStatus + (t.stale ? " *" : ""), statusClass(t.orderStatus)); cell(tr, t.title); cell(tr, t.model); cell(tr, elapsed(t.elapsedMs));
  }

  const current = s.tasks.find((t) => t.id === selected);
  const detail = $("detail");
  if (!current) { detail.className = "dim"; detail.textContent = "Select a task."; }
  else {
    detail.className = "";
    detail.textContent = [
      "Task: " + current.title,
      "Status: " + current.orderStatus + (current.stale ? "  (no backend answers; state unknown)" : ""),
      "Order: " + (current.orderId || "—") + "   Agent: " + (current.agentId || "not created yet") + "   Turns: " + current.turns,
      "Worker: " + current.worker + " · " + current.model + (current.permission ? " · " + current.permission : ""),
      "Directory: " + current.cwd,
      "Updated: " + current.updatedAt,
      "",
      "Latest: " + (current.latest || "no result yet"),
    ].join("\\n");
  }
  $("warnings").textContent = s.warnings.join("\\n");
  $("stamp").textContent = "Updated " + new Date(s.generatedAt).toLocaleTimeString();
}

async function poll() {
  try {
    const res = await fetch("/api/snapshot", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    snapshot = await res.json();
    render();
  } catch (err) {
    $("stamp").textContent = "Read failed: " + err.message + "; retrying.";
  }
}

for (const button of document.querySelectorAll("nav button")) {
  button.addEventListener("click", () => {
    filter = button.dataset.filter;
    for (const b of document.querySelectorAll("nav button")) b.setAttribute("aria-pressed", String(b === button));
    render();
  });
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) void poll(); });
setInterval(() => { if (!document.hidden) void poll(); }, 2000);
void poll();
`;
