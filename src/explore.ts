/**
 * What the subagent knows about the environment: bundled experiences, the MCP tool
 * registry, and the MCP client used to list and call tools.
 */

import { EXPERIENCES_RENDER, render } from "./prompts.generated.js";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SandboxConfig } from "./types.js";
import { storeRoot } from "./util.js";
import { spawn } from "node:child_process";

// =============================================================================
// ── experiences ──
// =============================================================================

/**
 * Per-MCP-server recovery experiences: learned, verified backup guidance
 * (e.g. "delete a post" → "set it to private") that the backup subagent
 * prompt includes so it prefers a cheap in-place reversal when one applies.
 * Stored at .backupper/experiences/<server>.json.
 * Modeled on NVIDIA ToolShield's per-server "experiences", but for recoverability rather than safety.
 */

export interface RecoveryPattern {
  /** The destructive / mutating action this covers. */
  action: string;
  /** Verified branch guidance for this action: either an in-place reversal
   *  or a capture recipe. Absent for creation-only patterns. */
  skill?: string;
  /** Which tool(s) it applies to, if specific. */
  applies_to?: string;
  /** Short keyword for the mutating action this pattern covers (e.g.
   *  "delete comment"); remote actions matching it are backed up. */
  trigger?: string;
  /** true = verified against the real target, false = verification failed,
   *  undefined = proposed only. */
  verified?: boolean;
  /** Minimal tool allowlist (read + inverse/write) for backing up this
   *  operation; narrows the capture subagent's MCP schema. */
  capture_tools?: string[];
  /** Deterministic inverse of a create: delete exactly the created entity,
   *  pinned by an identifier captured at create time (never by recency). */
  reverter?: {
    /** Prose/CLI inverse; exactly one of commands / mcp_calls is set. */
    commands?: string[];
    /** Fixed MCP call on this server; exactly one of commands / mcp_calls is set. */
    mcp_calls?: { tool: string; args: Record<string, unknown> }[];
    /** Identifier to pin at create time (e.g. "title", "id"). */
    pin: string;
    /** true when reversal requires rewriting the destructive call into a
     *  reversible soft form; otherwise the inverse is applied at restore time. */
    action_rewrite?: boolean;
  };
}

export interface ServerExperiences {
  server: string;
  /** Tool names observed for this server. */
  observed_tools: string[];
  patterns: RecoveryPattern[];
  /** Server-level backup playbook assembled from the verified patterns and
   *  injected into the backup subagent prompt; rebuilt on every save. */
  skill?: string;
  /** Learned read-only tool names; the gate skips backup for these, except
   *  names containing a mutating verb. */
  readOnlyTools?: string[];
  /** MCP server(s) whose tools this experience covers (e.g. ["playwright"]
   *  for a website driven through the browser). */
  appliesTo?: string[];
}

/**
 * Build the {mcp-server → experience-name} map from every experience file's
 * `appliesTo` (falling back to its own server name).
 */
export function serverToExperienceMap(config: SandboxConfig): Record<string, string> {
  const dir = experiencesDir(config);
  const map: Record<string, string> = {};
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return map;
  }
  // Collect every file that claims each key; resolution does not depend on file order.
  const claims = new Map<string, Set<string>>();
  for (const f of files) {
    try {
      const exp = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as ServerExperiences;
      if (!exp.server) continue;
      const servers = (exp.appliesTo && exp.appliesTo.length) ? exp.appliesTo : [exp.server];
      for (const s of servers) {
        if (!s) continue;
        const key = String(s);
        let owners = claims.get(key);
        if (!owners) {
          owners = new Set<string>();
          claims.set(key, owners);
        }
        owners.add(exp.server);
      }
    } catch { /* skip unreadable */ }
  }
  // A single claimant wins; among several, the file whose own server is the key wins; otherwise unmapped.
  for (const [key, owners] of claims) {
    if (owners.size === 1) map[key] = [...owners][0];
    else if (owners.has(key)) map[key] = key;
  }
  return map;
}

export function experiencesDir(config: SandboxConfig): string {
  return path.join(storeRoot(config), "experiences");
}

export function experiencePath(config: SandboxConfig, server: string): string {
  return path.join(experiencesDir(config), `${server}.json`);
}

/**
 * Extract the MCP server name from a tool name, e.g.
 * mcp__notion__create_page → "notion"; a bare browser_* tool → "playwright".
 * Returns null for non-remote tools.
 */
export function serverFromToolName(toolName: string): string | null {
  if (!toolName) return null;
  const m = toolName.match(/^mcp__([^_]+(?:_[^_]+)*?)__/);
  if (m) return m[1];
  if (/^browser_/.test(toolName)) return "playwright";
  return null;
}

export function loadExperiences(config: SandboxConfig, server: string): ServerExperiences | null {
  try {
    const p = experiencePath(config, server);
    if (!fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, "utf-8")) as ServerExperiences;
    return Array.isArray(data.patterns) ? data : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the experience file name for a server: config override, then the
 * appliesTo map, then a file named after the server, else null.
 */
export function experienceNameForServer(config: SandboxConfig, server: string): string | null {
  const override = (config as { experienceForServer?: Record<string, string> }).experienceForServer?.[server];
  if (override) return override;
  const mapped = serverToExperienceMap(config)[server];
  if (mapped) return mapped;
  return fs.existsSync(experiencePath(config, server)) ? server : null;
}

/** Compiled matchers for one server's experience: read-only tool names
 *  (skip backup) and a trigger regex (back up). */
export interface ServerMatchers {
  readOnlyTools: Set<string>;
  triggerRegex: RegExp | null;
}

// Per-server cache keyed by directory and experience name, validated by the file's mtime.
const serverMatcherCache = new Map<string, { sig: string; m: ServerMatchers }>();

/** Escape regex metacharacters so `s` matches literally. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word regex over the trigger keywords (3-60 characters); null when there are none. */
function buildKeywordRegex(values: Iterable<string>): RegExp | null {
  const keywords = new Set<string>();
  for (const s of values) {
    const k = String(s).trim().toLowerCase();
    if (k.length >= 3 && k.length <= 60) keywords.add(k);
  }
  if (!keywords.size) return null;
  const escaped = [...keywords].map(escapeRegex);
  // Whole-word match on both sides (`create` must not match `created_at`).
  return new RegExp(`\\b(${escaped.join("|")})\\b`, "i");
}

/**
 * Compile the matchers for a single server's experience file (cached);
 * empty matchers when the server has no experience.
 */
export function serverMatchers(config: SandboxConfig, expName: string): ServerMatchers {
  const key = `${experiencesDir(config)}::${expName}`;
  const p = experiencePath(config, expName);
  let sig: string;
  try {
    sig = String(fs.statSync(p).mtimeMs);
  } catch {
    sig = "none";
  }
  const cached = serverMatcherCache.get(key);
  if (cached && cached.sig === sig) return cached.m;

  const empty: ServerMatchers = { readOnlyTools: new Set(), triggerRegex: null };
  const data = loadExperiences(config, expName);
  if (!data) {
    serverMatcherCache.set(key, { sig, m: empty });
    return empty;
  }

  const tools = new Set<string>();
  for (const t of data.readOnlyTools ?? []) {
    const lc = String(t).trim().toLowerCase();
    if (!lc) continue;
    tools.add(lc);
    const seg = lc.split("__").pop();
    if (seg && seg !== lc) tools.add(seg);
  }
  const m: ServerMatchers = {
    readOnlyTools: tools,
    triggerRegex: buildKeywordRegex((data.patterns ?? []).map((x) => String(x.trigger ?? ""))),
  };
  serverMatcherCache.set(key, { sig, m });
  return m;
}

/**
 * Find the learned pattern covering an action: first by a tool name in
 * applies_to that only one pattern claims, then by the longest trigger
 * keyword found in rawDesc. Returns null when nothing matches.
 */
export function matchPattern(
  config: SandboxConfig,
  expName: string,
  toolName: string,
  rawDesc: string,
): RecoveryPattern | null {
  const data = loadExperiences(config, expName);
  if (!data || !Array.isArray(data.patterns) || !data.patterns.length) return null;

  const lc = (toolName || "").toLowerCase();
  const seg = (lc.split("__").pop() || lc); // action segment, e.g. "move_file"
  const desc = (rawDesc || "").toLowerCase();

  // Trailing one or two underscore segments of an identifier, e.g.
  // mcp_filesystem_create_directory → create_directory.
  const tailSegments = (id: string): string[] => {
    const s = id.toLowerCase().replace(/^mcp__?/, "").split("__").pop() || id.toLowerCase();
    const parts = s.split("_").filter(Boolean);
    const out: string[] = [];
    if (parts.length) out.push(parts.join("_"));
    if (parts.length >= 2) out.push(parts.slice(-2).join("_"));
    if (parts.length >= 1) out.push(parts.slice(-1).join("_"));
    return [...new Set(out)];
  };
  const actionForms = new Set(tailSegments(seg));

  // 1. Tool-name match, restricted to forms claimed by exactly one pattern;
  //    the longest form wins.
  const formOwners = new Map<string, number>();
  for (const p of data.patterns) {
    if (!p.applies_to) continue;
    for (const form of tailSegments(p.applies_to)) {
      formOwners.set(form, (formOwners.get(form) ?? 0) + 1);
    }
  }
  let bestP: RecoveryPattern | null = null;
  let bestFormLen = 0;
  for (const p of data.patterns) {
    if (!p.applies_to) continue;
    for (const form of tailSegments(p.applies_to)) {
      if (formOwners.get(form) !== 1) continue;   // shared by several patterns → verb must decide
      if (actionForms.has(form) && form.length > bestFormLen) {
        bestP = p;
        bestFormLen = form.length;
      }
    }
  }
  if (bestP) return bestP;

  // 2. trigger keyword match against rawDesc, longest trigger wins.
  let best: RecoveryPattern | null = null;
  let bestLen = -1;
  for (const p of data.patterns) {
    const trig = String(p.trigger ?? "").trim().toLowerCase();
    if (trig.length < 3) continue;
    // Whole-word match, consistent with buildKeywordRegex.
    const re = new RegExp(`\\b${escapeRegex(trig)}\\b`, "i");
    if (re.test(desc) && trig.length > bestLen) {
      best = p;
      bestLen = trig.length;
    }
  }
  return best;
}

/**
 * Render a server's learned backup playbook as a prompt fragment, falling
 * back to per-pattern lines; empty when nothing is verified.
 */
export function renderExperiencesForPrompt(exp: ServerExperiences | null): string {
  if (!exp) return "";
  // Learned strings are rendered inside a data fence as reference material.
  const sanitize = (s: string, cap = 600) => String(s).replace(/```/g, "ʼʼʼ").slice(0, cap);
  // The server name is sanitized too so it cannot escape the fence.
  const wrap = (body: string) => "\n" + render(EXPERIENCES_RENDER.body, {
    SERVER: sanitize(exp.server, 60).replace(/[\r\n"]/g, ""), BODY: body,
  }) + "\n";

  // Preferred: the server-level playbook.
  if (exp.skill && exp.skill.trim()) return wrap(sanitize(exp.skill, Number.POSITIVE_INFINITY));

  // Fallback: per-pattern lines.
  if (!exp.patterns.length) return "";
  const usable = exp.patterns.filter((p) => p.verified === true);
  if (!usable.length) return "";
  const lines = usable.map((p, i) => {
    let how: string;
    if (p.skill) {
      how = sanitize(p.skill);
    } else if (p.reverter) {
      const inverse = p.reverter.mcp_calls ?? p.reverter.commands ?? [];
      how = render(EXPERIENCES_RENDER.sections["pattern-reverter"], {
        INVERSE: sanitize(JSON.stringify(inverse)),
        PIN: sanitize(p.reverter.pin),
      });
    } else {
      how = EXPERIENCES_RENDER.sections["pattern-none"];
    }
    return render(EXPERIENCES_RENDER.sections["pattern-line"], { N: i + 1, ACTION: sanitize(p.action), HOW: how });
  });
  return wrap(lines.join("\n"));
}

// =============================================================================
// ── tool registry ──
// =============================================================================

/**
 * The {mcp-server → [tool functions]} registry, used to resolve a tool name
 * to its owning server by membership.
 */

export interface ToolRegistry { [server: string]: string[]; }

/** The built-in {server → tools} registry for the supported MCP servers. */
export const DEFAULT_TOOL_REGISTRY: ToolRegistry = {
  playwright: [
    "browser_close", "browser_resize", "browser_console_messages",
    "browser_handle_dialog", "browser_evaluate", "browser_file_upload",
    "browser_drop", "browser_fill_form", "browser_press_key", "browser_type",
    "browser_navigate", "browser_navigate_back", "browser_network_requests",
    "browser_network_request", "browser_run_code_unsafe", "browser_take_screenshot",
    "browser_snapshot", "browser_click", "browser_drag", "browser_hover",
    "browser_select_option", "browser_tabs", "browser_wait_for",
  ],
  postgres: [
    "list_schemas", "list_objects", "get_object_details", "explain_query",
    "analyze_workload_indexes", "analyze_query_indexes", "analyze_db_health",
    "get_top_queries", "execute_sql",
  ],
};

export function registryPath(config: SandboxConfig): string {
  return path.join(storeRoot(config), "tool-registry.json");
}

/** DEFAULT_TOOL_REGISTRY, extended and overridden by a project-local
 *  tool-registry.json when present. */
export function loadToolRegistry(config: SandboxConfig): ToolRegistry {
  try {
    const p = registryPath(config);
    if (fs.existsSync(p)) {
      const fromFile = JSON.parse(fs.readFileSync(p, "utf-8")) as ToolRegistry;
      return { ...DEFAULT_TOOL_REGISTRY, ...fromFile };
    }
  } catch { /* fall through to the default */ }
  return DEFAULT_TOOL_REGISTRY;
}

/** Resolve a tool name to its MCP server: registry membership first, then the
 *  `mcp__<server>__` name prefix. */
export function serverForTool(toolName: string, registry: ToolRegistry | null): string | null {
  if (!toolName) return null;
  const bare = toolName.includes("__") ? (toolName.split("__").pop() || toolName) : toolName;
  if (registry) {
    for (const [server, tools] of Object.entries(registry)) {
      if (tools.includes(bare) || tools.includes(toolName)) return server;
    }
  }
  const m = toolName.match(/^mcp__([^_]+(?:_[^_]+)*?)__/);
  if (m && (!registry || registry[m[1]])) return m[1];
  return null;
}

// =============================================================================
// ── list mcp tools ──
// =============================================================================

/**
 * Call ONE tool on an MCP server and return its result: stdio servers over
 * JSON-RPC on a spawned child (initialize -> tools/call), HTTP servers over
 * the Streamable HTTP transport.
 */

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
