/**
 * The {mcp-server → [tool functions]} registry, used to resolve a tool name
 * to its owning server by membership.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { SandboxConfig } from "../types.js";

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
  return path.join(path.dirname(path.resolve(config.backupDir)), "tool-registry.json");
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
