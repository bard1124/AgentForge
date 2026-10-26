import { format } from "node:util";

export function out(...args: unknown[]): void {
  process.stdout.write(`${format(...args)}\n`);
}

// The Cursor SDK logs through console.log; on stdout that corrupts the MCP
// JSON-RPC stream and `run --json` output.
export function routeConsoleToStderr(): void {
  console.log = console.info = console.debug = console.error;
}
