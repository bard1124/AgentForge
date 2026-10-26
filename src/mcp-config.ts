import fs from "node:fs";
import type { McpServerConfig } from "@cursor/sdk";

export class McpConfigError extends Error {}

/** Expands `${VAR}` and `${VAR:-default}` in every string, like Claude Code's `.mcp.json`. */
function expand(value: unknown, env: NodeJS.ProcessEnv, where: string): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, fallback: string | undefined) => {
      const v = env[name] ?? fallback;
      if (v === undefined) throw new McpConfigError(`${where} references \${${name}}, which is not set`);
      return v;
    });
  }
  if (Array.isArray(value)) return value.map((v) => expand(v, env, where));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v, env, where)]));
  }
  return value;
}

/**
 * Named MCP servers a worker may be given, in the same shape as Claude Code's
 * `.mcp.json` (`{ "mcpServers": { name: { command, args, env } | { url, headers } } }`).
 * Tasks store only the names, so secrets in `env` / `headers` never land in task records.
 */
export function loadMcpServers(file: string): Record<string, McpServerConfig> {
  if (!fs.existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new McpConfigError(`Cannot parse MCP config ${file}: ${(err as Error).message}`);
  }
  const root = (parsed as { mcpServers?: unknown }).mcpServers ?? parsed;
  if (!root || typeof root !== "object" || Array.isArray(root)) throw new McpConfigError(`MCP config ${file} must be an object of servers`);
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(root as Record<string, unknown>)) {
    const v = value as Record<string, unknown>;
    if (typeof v?.command === "string" || typeof v?.url === "string") servers[name] = v as unknown as McpServerConfig;
    else throw new McpConfigError(`MCP server "${name}" in ${file} needs a "command" (stdio) or "url" (http/sse)`);
  }
  return servers;
}

export function pickMcpServers(file: string, names: string[], env: NodeJS.ProcessEnv = process.env): Record<string, McpServerConfig> | undefined {
  if (!names.length) return undefined;
  const all = loadMcpServers(file);
  const missing = names.filter((n) => !all[n]);
  if (missing.length) {
    const known = Object.keys(all);
    throw new McpConfigError(
      `Unknown MCP server(s): ${missing.join(", ")}. ${known.length ? `Defined in ${file}: ${known.join(", ")}` : `No servers defined; create ${file}`}.`,
    );
  }
  // Only the servers actually used need their variables set.
  return Object.fromEntries(names.map((n) => [n, expand(all[n], env, `MCP server "${n}"`) as McpServerConfig]));
}
