/**
 * Call ONE tool on an MCP server and return its result: stdio servers over
 * JSON-RPC on a spawned child (initialize -> tools/call), HTTP servers over
 * the Streamable HTTP transport.
 */
import { spawn } from "node:child_process";

/** Result of one tools/call: `ok` is false on a transport, protocol or tool error. */
type McpCallResult = { ok: boolean; result?: unknown; error?: string };

/** The JSON-RPC initialize request sent before tools/call. */
const INITIALIZE_REQUEST = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "backupper", version: "1" },
  },
};

/** Call ONE tool on a stdio MCP server (initialize → tools/call) and resolve
 *  with the result object (or {error} on failure). */
export function callMcpTool(
  command: string,
  args: string[],
  toolName: string,
  toolArgs: Record<string, unknown>,
  timeoutMs = 30000,
): Promise<McpCallResult> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (out: McpCallResult) => {
      if (done) return;
      done = true;
      try {
        child.kill("SIGKILL");
      } catch { /* already exited */ }
      resolve(out);
    };
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"] });
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let newline: number;
      while ((newline = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, newline);
        buf = buf.slice(newline + 1);
        try {
          const m = JSON.parse(line);
          if (m.id === 3) {
            if (m.error) finish({ ok: false, error: JSON.stringify(m.error) });
            else finish({ ok: !(m.result && m.result.isError), result: m.result });
          }
        } catch { /* incomplete / non-JSON line */ }
      }
    });
    child.on("error", (e: Error) => finish({ ok: false, error: e.message }));
    const send = (message: unknown) => {
      try {
        child.stdin.write(JSON.stringify(message) + "\n");
      } catch { /* stdin closed */ }
    };
    send(INITIALIZE_REQUEST);
    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: toolName, arguments: toolArgs } });
    }, 1000);
    setTimeout(() => finish({ ok: false, error: "timeout" }), timeoutMs);
  });
}

/** Call ONE tool on an HTTP MCP server (Streamable HTTP): initialize, then
 *  tools/call. Network errors resolve to {ok:false,error}; never throws. */
export async function callMcpToolHttp(
  url: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
  timeoutMs = 30000,
): Promise<McpCallResult> {
  const accept = "application/json, text/event-stream";

  // Parse a JSON-RPC body that may be bare JSON or an SSE `data:` stream.
  type RpcMessage = { result?: unknown; error?: unknown };
  const parseBody = (raw: string): RpcMessage | null => {
    const trimmed = raw.trim();
    try {
      return JSON.parse(trimmed) as RpcMessage;
    } catch { /* not bare JSON: try SSE */ }
    for (const line of trimmed.split(/\r?\n/)) {
      const m = line.match(/^data:\s*(.+)$/);
      if (!m) continue;
      try {
        return JSON.parse(m[1]) as RpcMessage;
      } catch { /* try the next data line */ }
    }
    return null;
  };

  const post = async (
    body: unknown,
    extraHeaders: Record<string, string>,
  ): Promise<Response> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: accept, ...extraHeaders },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    // 1. initialize — capture the session id from the response header.
    const initResp = await post(INITIALIZE_REQUEST, {});
    const sid = (initResp.headers.get("mcp-session-id") ?? "").trim();
    // Drain the init body so the connection can be reused/closed cleanly.
    await initResp.text();

    const sessionHeaders: Record<string, string> = sid ? { "mcp-session-id": sid } : {};

    // Some servers require an `initialized` notification before tools/call.
    try {
      const note = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionHeaders);
      await note.text();
    } catch { /* optional — ignore */ }

    // 2. tools/call.
    const callResp = await post(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: toolName, arguments: toolArgs } },
      sessionHeaders,
    );
    const raw = await callResp.text();
    const msg = parseBody(raw);
    if (!msg) return { ok: false, error: `unparseable response (HTTP ${callResp.status})` };
    if (msg.error) return { ok: false, error: JSON.stringify(msg.error) };
    const result = msg.result as { isError?: boolean } | undefined;
    return { ok: !(result && result.isError), result: msg.result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
