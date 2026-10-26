import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readDelegation } from "./delegation.js";

/**
 * Lightweight SDD workspace: `<workspace>/<projectId>/project.json` and one
 * `<taskId>/task.md` per task (goal, scope, plan, acceptance). The board and
 * the model's sdd_task tool share it; code and other docs stay in their projects.
 */

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DOC_BYTES = 512 * 1024;

export class SddError extends Error {
  constructor(
    message: string,
    readonly code: "disabled" | "not_found" | "conflict" | "invalid" | "workspace_changed" = "invalid",
  ) {
    super(message);
  }
}

export interface SddProject {
  id: string;
  name: string;
  createdAt: string;
  tasks: number;
  path: string;
}

export interface SddTaskSummary {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  revision: string;
  path: string;
}

export interface SddTaskDoc extends SddTaskSummary {
  content: string;
}

export function revisionOf(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export function taskTemplate(title: string): string {
  return `# ${title}\n\n## Goal\n\n## Scope\n\nIn scope:\n\nOut of scope / must not change:\n\n## Plan\n\n1. \n\n## Acceptance\n\n- [ ] \n`;
}

function titleOf(content: string, fallback: string): string {
  return /^#\s+(.+)$/m.exec(content)?.[1]?.trim() || fallback;
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export class SddStore {
  constructor(
    private readonly home: string,
    private readonly fallbackExecutor = "cursor",
  ) {}

  /** Read fresh on every call, so a switch flipped on the board applies at once. */
  settings(): { enabled: boolean; dir: string; corrupt?: string } {
    const read = readDelegation(this.home, this.fallbackExecutor);
    return { enabled: read.settings.sdd.enabled && !read.corrupt, dir: read.settings.sdd.workspace, corrupt: read.corrupt };
  }

  /** `expectDir` guards board requests made against a workspace the settings have since moved away from. */
  private dir(expectDir?: string): string {
    const { dir } = this.settings();
    if (expectDir !== undefined && path.resolve(expectDir) !== dir) {
      throw new SddError(`The SDD workspace changed to ${dir}; reload before continuing.`, "workspace_changed");
    }
    return dir;
  }

  private writable(expectDir?: string): string {
    const s = this.settings();
    if (s.corrupt) throw new SddError(`SDD writes are refused while the settings file is unreadable (${s.corrupt}).`, "disabled");
    if (!s.enabled) throw new SddError("SDD task documents are switched off on the board; reading still works, saving does not.", "disabled");
    return this.dir(expectDir);
  }

  private projectDir(dir: string, projectId: string): string {
    if (!ID.test(projectId)) throw new SddError(`Invalid project id "${projectId}".`);
    const p = path.join(dir, projectId);
    if (!fs.existsSync(path.join(p, "project.json"))) throw new SddError(`No SDD project ${projectId} in ${dir}.`, "not_found");
    return p;
  }

  private taskDir(dir: string, projectId: string, taskId: string): string {
    if (!ID.test(taskId)) throw new SddError(`Invalid task id "${taskId}".`);
    const p = path.join(this.projectDir(dir, projectId), taskId);
    if (!fs.existsSync(path.join(p, "task.md"))) throw new SddError(`No SDD task ${taskId} in project ${projectId}.`, "not_found");
    return p;
  }

  workspace(): { dir: string; enabled: boolean; corrupt?: string; projects: number } {
    const s = this.settings();
    return { ...s, projects: this.listProjects().length };
  }

  listProjects(expectDir?: string): SddProject[] {
    const dir = this.dir(expectDir);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && ID.test(e.name))
      .flatMap((e) => {
        const meta = readJson<{ id: string; name: string; createdAt: string }>(path.join(dir, e.name, "project.json"));
        if (!meta) return [];
        const tasks = fs.readdirSync(path.join(dir, e.name), { withFileTypes: true }).filter((t) => t.isDirectory() && ID.test(t.name)).length;
        return [{ id: e.name, name: meta.name, createdAt: meta.createdAt, tasks, path: path.join(dir, e.name) }];
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Projects are categories by name: creating an existing name returns that project. */
  createProject(name: string, expectDir?: string): SddProject {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 120) throw new SddError("Project name must be 1-120 characters.");
    const dir = this.writable(expectDir);
    const same = this.listProjects().find((p) => p.name.toLowerCase() === trimmed.toLowerCase());
    if (same) return same;
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    writeAtomic(path.join(dir, id, "project.json"), `${JSON.stringify({ id, name: trimmed, createdAt }, null, 2)}\n`);
    return { id, name: trimmed, createdAt, tasks: 0, path: path.join(dir, id) };
  }

  private summary(dir: string, projectId: string, taskId: string): SddTaskDoc {
    const p = this.taskDir(dir, projectId, taskId);
    const file = path.join(p, "task.md");
    const content = fs.readFileSync(file, "utf8");
    const meta = readJson<{ createdAt?: string; createdBy?: string; title?: string }>(path.join(p, "meta.json")) ?? {};
    return {
      id: taskId,
      projectId,
      title: titleOf(content, meta.title ?? taskId),
      createdAt: meta.createdAt ?? fs.statSync(file).birthtime.toISOString(),
      updatedAt: fs.statSync(file).mtime.toISOString(),
      createdBy: meta.createdBy ?? "unknown",
      revision: revisionOf(content),
      path: file,
      content,
    };
  }

  listTasks(projectId: string, expectDir?: string): SddTaskSummary[] {
    const dir = this.dir(expectDir);
    const p = this.projectDir(dir, projectId);
    return fs
      .readdirSync(p, { withFileTypes: true })
      .filter((e) => e.isDirectory() && ID.test(e.name) && fs.existsSync(path.join(p, e.name, "task.md")))
      .map((e) => {
        const { content: _content, ...rest } = this.summary(dir, projectId, e.name);
        return rest;
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  createTask(projectId: string, input: { title: string; content?: string; createdBy: string }, expectDir?: string): SddTaskDoc {
    const dir = this.writable(expectDir);
    const p = this.projectDir(dir, projectId);
    const title = input.title.trim();
    if (!title || title.length > 200) throw new SddError("Task title must be 1-200 characters.");
    const content = input.content?.trim() ? input.content : taskTemplate(title);
    this.checkSize(content);
    const id = crypto.randomUUID();
    writeAtomic(path.join(p, id, "meta.json"), `${JSON.stringify({ id, title, createdAt: new Date().toISOString(), createdBy: input.createdBy }, null, 2)}\n`);
    writeAtomic(path.join(p, id, "task.md"), content);
    return this.summary(dir, projectId, id);
  }

  readTask(projectId: string, taskId: string, expectDir?: string): SddTaskDoc {
    return this.summary(this.dir(expectDir), projectId, taskId);
  }

  /** Saves only when the document is still at `baseRevision`, so another editor's changes are never overwritten. */
  saveTask(projectId: string, taskId: string, content: string, baseRevision: string, expectDir?: string): SddTaskDoc {
    const dir = this.writable(expectDir);
    this.checkSize(content);
    const current = this.summary(dir, projectId, taskId);
    if (current.revision !== baseRevision) {
      throw new SddError(
        `task.md changed since revision ${baseRevision} (now ${current.revision}); nothing was saved. Read the latest version, merge, and save against it.`,
        "conflict",
      );
    }
    writeAtomic(current.path, content);
    return this.summary(dir, projectId, taskId);
  }

  private checkSize(content: string): void {
    if (Buffer.byteLength(content) > MAX_DOC_BYTES) throw new SddError(`task.md is limited to ${MAX_DOC_BYTES / 1024} KB.`);
  }
}
