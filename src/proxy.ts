import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { CWD_HEADER, ensureBackend } from "./backend.js";

const REPLAY_ID = "agentforge-reconnect";

function requestId(message: JSONRPCMessage): string | number | undefined {
  return "id" in message && "method" in message ? message.id : undefined;
}

/**
 * What Claude Code launches: relays MCP between stdio and the shared backend,
 * starting the backend when needed. If the backend restarts, the session is
 * re-initialized with the original handshake and the failed message re-sent.
 */
export async function serveStdio(home: string, cwd: string): Promise<void> {
  const stdio = new StdioServerTransport();
  let http: StreamableHTTPClientTransport | undefined;
  let connecting: Promise<StreamableHTTPClientTransport> | undefined;
  let initialize: JSONRPCMessage | undefined;
  let initialized: JSONRPCMessage | undefined;

  const drop = (transport: StreamableHTTPClientTransport | undefined) => {
    if (transport && http === transport) http = undefined;
    void transport?.close().catch(() => undefined);
  };

  const open = async (replay: boolean): Promise<StreamableHTTPClientTransport> => {
    const { info, token } = await ensureBackend(home);
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${info.port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}`, [CWD_HEADER]: cwd } },
    });
    let handshake: ((m: JSONRPCMessage) => void) | undefined;
    transport.onmessage = (message) => {
      if ("id" in message && message.id === REPLAY_ID && !("method" in message)) return handshake?.(message);
      void stdio.send(message);
    };
    transport.onerror = (err) => {
      console.error(`agentforge proxy: ${err.message}`);
      // The notification stream gave up (backend gone); the next message reconnects.
      if (/Maximum reconnection attempts/.test(err.message)) drop(transport);
    };
    await transport.start();
    if (replay && initialize && "method" in initialize) {
      const answered = new Promise<JSONRPCMessage>((resolve) => (handshake = resolve));
      await transport.send({ ...initialize, id: REPLAY_ID } as JSONRPCMessage);
      await answered;
      if (initialized) await transport.send(initialized);
    }
    return transport;
  };

  const connection = (replay: boolean): Promise<StreamableHTTPClientTransport> => {
    connecting ??= open(replay)
      .then((t) => (http = t))
      .finally(() => (connecting = undefined));
    return connecting;
  };

  // Clients pipeline messages behind `initialize`; they need the session id its answer carries.
  let sessionReady: Promise<void> | undefined;

  const forward = async (message: JSONRPCMessage): Promise<void> => {
    if ("method" in message && message.method === "initialize") initialize = message;
    if ("method" in message && message.method === "notifications/initialized") initialized = message;
    const isHandshake = message === initialize;
    if (isHandshake) {
      sessionReady = (async () => (http ?? (await connection(false))).send(message))();
      return sessionReady;
    }
    await sessionReady?.catch(() => undefined);
    try {
      await (http ?? (await connection(initialize !== undefined && !isHandshake))).send(message);
    } catch (first) {
      if (isHandshake) throw first;
      // The backend restarted or the session expired: reconnect once and re-send.
      drop(http);
      await (await connection(true)).send(message);
    }
  };

  stdio.onmessage = (message) => {
    forward(message).catch((err: Error) => {
      const id = requestId(message);
      if (id !== undefined) {
        void stdio.send({ jsonrpc: "2.0", id, error: { code: -32603, message: `AgentForge backend unavailable: ${err.message}` } });
      }
    });
  };
  stdio.onclose = () => {
    void http?.terminateSession().catch(() => undefined).finally(() => process.exit(0));
    if (!http) process.exit(0);
  };
  await stdio.start();
}
