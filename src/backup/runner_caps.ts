/**
 * Per-runner capability table for the tier-4 backup/restore subagent: how
 * each runner CLI can be given MCP access, whether its tool surface can be
 * narrowed, and whether it has a turn cap. The prompt and invocation builders
 * consult it so a runner without MCP is told so rather than asked to use it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SandboxConfig, SubagentRunnerName } from "../types.js";

export type SubagentRunner = SubagentRunnerName;

/** The runner each supported host agent brings with it. */
const HOST_RUNNER: Record<string, SubagentRunner> = {
  "claude-code": "claude",
  codex: "codex",
  hermes: "hermes",
};

/** The host agent a hook was registered for (`--agent <name>` on the hook command line). */
export function hostAgent(): string | undefined {
  const env = String(process.env.BACKUPPER_HOST_AGENT ?? "").trim();
  return env || undefined;
}

/**
 * The runner for the tier-4 subagent. An explicit `subagentRunner` wins; "auto" follows the
 * host agent, and outside a hook (e.g. `backupper restore`) the agent installed in the project.
 */
export function resolveRunner(config: Pick<SandboxConfig, "subagentRunner">, host?: string): SubagentRunner {
  const r = config.subagentRunner;
  if (r === "claude" || r === "codex" || r === "hermes") return r;
  const h = host ?? hostAgent();
  if (h && HOST_RUNNER[h]) return HOST_RUNNER[h];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { installedAdapters } = require("../agents/index.js");
    const names: string[] = installedAdapters(process.cwd()).map((a: { name: string }) => a.name);
    if (names.length === 1 && HOST_RUNNER[names[0]]) return HOST_RUNNER[names[0]];
  } catch { /* detection is optional */ }
  return "claude";
}

/**
 * The model passed to `runner`: `subagentModel` when set (it overrides every runner), else the
 * runner's entry in `subagentModels`, else "" (the runner's own default).
 */
export function subagentModelFor(
  config: Pick<SandboxConfig, "subagentModel"> & { subagentModels?: SandboxConfig["subagentModels"] },
  runner: SubagentRunner,
): string {
  if (config.subagentModel) return config.subagentModel;
  const m = config.subagentModels && typeof config.subagentModels === "object" ? config.subagentModels[runner] : undefined;
  return typeof m === "string" ? m : "";
}

export interface RunnerCaps {
  /** How the runner is provisioned with the action's MCP server:
   *  filtered-home (cloned home keeping only that server), config-flag
   *  (filtered config file on the CLI), home-config (config file in the
   *  runner's home), or none. */
  mcp: "filtered-home" | "config-flag" | "home-config" | "none";
  /** Whether the learned capture_tools allowlist can narrow the subagent's
   *  MCP tool surface. */
  toolAllow: boolean;
  /** Whether the runner CLI has a hard turn-cap flag. */
  maxTurns: boolean;
}

const CAPS: Record<SubagentRunner, RunnerCaps> = {
  hermes:   { mcp: "filtered-home", toolAllow: true,  maxTurns: true  },
  claude:   { mcp: "config-flag",   toolAllow: true,  maxTurns: false },
  codex:    { mcp: "home-config",   toolAllow: false, maxTurns: false },
};

export function capabilitiesFor(runner: string | undefined): RunnerCaps {
  return CAPS[(runner ?? "claude") as SubagentRunner] ?? CAPS.claude;
}

/** Resolve the MCP config source for the claude runner: the explicit config
 *  setting, else the workspace .mcp.json when it defines the needed server. */
export function mcpConfigSource(config: SandboxConfig, neededServer?: string | null): string | null {
  if (config.subagentMcpConfig) return config.subagentMcpConfig;
  const workspaceMcp = path.join(process.cwd(), ".mcp.json");
  try {
    if (!fs.existsSync(workspaceMcp)) return null;
    if (!neededServer) return workspaceMcp; // unfiltered use
    const parsed = JSON.parse(fs.readFileSync(workspaceMcp, "utf-8")) as { mcpServers?: Record<string, unknown> };
    return parsed?.mcpServers?.[neededServer] ? workspaceMcp : null;
  } catch { return null; } // unreadable fallback is treated as absent
}

/**
 * Whether this call's subagent will have the action's MCP server. Checked
 * before building the prompt and after parsing the result; browser actions
 * pass neededServer=null.
 */
export function mcpAvailableFor(
  runner: string | undefined,
  config: SandboxConfig,
  neededServer: string | null | undefined,
): boolean {
  if (!neededServer) return true; // no MCP needed
  const caps = capabilitiesFor(runner);
  if (caps.mcp === "none") return false;
  if (caps.mcp === "filtered-home") {
    // hermes: no config.yaml means no MCP servers are configured.
    try {
      const hermesHome = process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
      return fs.existsSync(path.join(hermesHome, "config.yaml"));
    } catch { return false; }
  }
  // config-flag (claude): user-scope servers cannot be detected cheaply, so
  // availability is assumed.
  return true;
}
