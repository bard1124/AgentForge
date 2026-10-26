import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/** Read from disk each time, so a running backend notices an update installed under it. */
export function packageVersion(): string {
  return (JSON.parse(fs.readFileSync(path.join(packageRoot(), "package.json"), "utf8")) as { version: string }).version;
}
