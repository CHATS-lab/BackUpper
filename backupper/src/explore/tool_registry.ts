/**
 * The {mcp-server → [tool functions]} registry — listed ONCE from the MCP
 * schemas (see list_mcp_tools) and saved so the runtime can resolve any
 * action's tool to its owning server by MEMBERSHIP, instead of string-
 * splitting the tool name (which breaks on bare names like `browser_click`).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { SandboxConfig } from "../types.js";
import { listMcpTools } from "./list_mcp_tools.js";

export interface ToolRegistry { [server: string]: string[]; }

/**
 * The default {server → tools} dict, baked into the code — the MCP tool sets
 * are static, so this lives here rather than in a generated file. Discovered
 * once via `build-registry` (stdio tools/list) and committed. The runtime uses
 * this unless a project-local tool-registry.json overrides it (for servers not
 * listed here). Extend this when a new MCP server is added to the benchmark.
 */
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
  return path.join(path.dirname(path.resolve(config.backupDir)), "tool-registry.json");
}

/** Parse an MCP config (claude `{mcpServers:{name:{command,args}}}` JSON) and
 *  query each server for its tool list. Async — driven by the CLI, not the hook. */
export async function buildToolRegistry(mcpConfigPath: string): Promise<ToolRegistry> {
  const raw = JSON.parse(fs.readFileSync(mcpConfigPath, "utf-8")) as {
    mcpServers?: Record<string, { command: string; args?: string[] }>;
  };
  const servers = raw.mcpServers ?? {};
  const registry: ToolRegistry = {};
  for (const [name, def] of Object.entries(servers)) {
    if (!def?.command) continue;
    const tools = await listMcpTools(def.command, def.args ?? []);
    if (tools.length) registry[name] = tools;
  }
  return registry;
}

export function saveToolRegistry(config: SandboxConfig, registry: ToolRegistry): string {
  const p = registryPath(config);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(registry, null, 2) + "\n", "utf-8");
  return p;
}

/** The registry the runtime uses: the baked-in DEFAULT_TOOL_REGISTRY, extended
 *  (and overridden) by a project-local tool-registry.json if one was built.
 *  Always returns a usable dict — no null, no generated file required. */
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

/** Resolve a tool name to its owning MCP server using the registry.
 *  Membership first (works for bare `browser_click` AND `mcp__x__browser_click`),
 *  then the `mcp__<server>__` name segment as a fallback. */
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
