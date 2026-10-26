import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ForgeConfig } from "../config.js";
import { CursorWorker } from "./cursor.js";
import type { Worker, WorkerFactory } from "./worker.js";

/** Built-in Cursor worker plus any plugin modules listed in AGENTFORGE_WORKERS. */
export async function loadWorkers(config: ForgeConfig): Promise<Record<string, Worker>> {
  const workers: Record<string, Worker> = { cursor: new CursorWorker(config) };
  for (const spec of config.workerModules) {
    const url = spec.startsWith(".") || path.isAbsolute(spec) ? pathToFileURL(path.resolve(spec)).href : spec;
    const mod = (await import(url)) as { default?: WorkerFactory; createWorker?: WorkerFactory };
    const factory = mod.createWorker ?? mod.default;
    if (typeof factory !== "function") throw new Error(`Worker module ${spec} must export createWorker(config)`);
    const worker = await factory(config);
    if (!worker?.name || typeof worker.create !== "function" || typeof worker.resume !== "function") {
      throw new Error(`Worker module ${spec} returned an object without name/create/resume`);
    }
    if (workers[worker.name]) throw new Error(`Duplicate worker name "${worker.name}" from ${spec}`);
    workers[worker.name] = worker;
  }
  return workers;
}
