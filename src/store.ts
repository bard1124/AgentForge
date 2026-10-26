import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Task } from "./types.js";

/** File-backed task store: one JSON document per task plus a raw event log. */
export class TaskStore {
  private readonly dir: string;

  constructor(home: string) {
    this.dir = path.join(home, "tasks");
    fs.mkdirSync(this.dir, { recursive: true });
  }

  newId(): string {
    const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    return `cf-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
  }

  save(task: Task): void {
    const file = this.taskFile(task.id);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(task, null, 2));
    fs.renameSync(tmp, file);
  }

  get(id: string): Task | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.taskFile(id), "utf8")) as Task;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  list(): Task[] {
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => this.get(f.slice(0, -".json".length)))
      .filter((t): t is Task => t !== undefined)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  appendEvent(id: string, event: unknown): void {
    fs.appendFileSync(this.eventFile(id), JSON.stringify({ at: new Date().toISOString(), event }) + "\n");
  }

  eventFile(id: string): string {
    return path.join(this.dir, `${id}.events.jsonl`);
  }

  private taskFile(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error(`Invalid task id: ${id}`);
    return path.join(this.dir, `${id}.json`);
  }
}
