/**
 * Per-runner CAPABILITY TABLE for the tier-3 backup/restore subagent.
 *
 * The backup "brain" (gate, pattern matching, prompt building, verification)
 * is runner-agnostic, but what each runner CLI can actually be provisioned
 * with is not: hermes gets a filtered per-call home (only the action's MCP
 * server, tool schema narrowed to the learned capture_tools), claude can be
 * handed a filtered --mcp-config file, and codex/openclaw currently get no
 * MCP at all. Silently dropping those features per-runner is how backups
 * fabricate: a subagent INSTRUCTED to read pre-state through an MCP it does
 * not have will either flail (burning its turn budget) or invent a
 * confident-empty recovery.
 *
 * This table is the single source of truth the shared brain consults so it
 * can DEGRADE HONESTLY instead: skip tool narrowing where unsupported, tell
 * the prompt when the runner has no MCP (so the subagent is told not to
 * fabricate), and refuse to record confident remote recoveries produced
 * without MCP access (see runSubagentBackup's verification gate).
 *
 * Provisioning itself (filteredHermesHome / filteredClaudeMcpConfig) stays in
 * subagent.ts — this module only answers WHAT a runner supports, cheaply and
 * without side effects, so both the prompt builder and the invocation builder
 * agree on one story.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SandboxConfig } from "../types.js";

export type SubagentRunner = "claude" | "hermes" | "openclaw" | "codex" | "openhands";

export interface RunnerCaps {
  /** How the runner can be provisioned with the action's MCP server:
   *  filtered-home — clone the runner's home, keep only the needed server
   *                  (hermes: HERMES_HOME/HOME env override);
   *  config-flag   — pass a filtered config file on the CLI (claude:
   *                  --mcp-config + --strict-mcp-config);
   *  home-config   — the runner resolves MCP servers from a config file in
   *                  its own home (codex: $CODEX_HOME/config.toml). Verified
   *                  on a real install: the server declared there reaches the
   *                  subagent model's tool surface. Availability is answered
   *                  by reading that file for the SERVER THE ACTION NEEDS, so
   *                  an install without it still degrades honestly;
   *  none          — the runner branch cannot wire MCP (openclaw until its
   *                  provisioning is implemented AND verified on a real
   *                  install). */
  mcp: "filtered-home" | "config-flag" | "home-config" | "none";
  /** Whether the learned capture_tools allowlist can narrow the subagent's
   *  MCP tool surface. hermes: mcp_servers.<s>.tools.include (schemas dropped
   *  from the request — token savings AND permission). claude: verified live
   *  (2.1.199) — --disallowedTools hard-blocks calls (verbatim "No such tool
   *  available" even on forced attempts) AND removes the tool from ToolSearch
   *  discovery; schemas are ToolSearch-deferred in this version anyway, so
   *  this is permission/attack-surface narrowing, not token savings. */
  toolAllow: boolean;
  /** Whether the runner CLI has a hard turn cap flag (hermes --max-turns).
   *  claude 2.1.199 has none — the result watcher + timeout bound the run. */
  maxTurns: boolean;
}

const CAPS: Record<SubagentRunner, RunnerCaps> = {
  hermes:   { mcp: "filtered-home", toolAllow: true,  maxTurns: true  },
  claude:   { mcp: "config-flag",   toolAllow: true,  maxTurns: false },
  codex:    { mcp: "home-config",   toolAllow: false, maxTurns: false },
  openclaw: { mcp: "none",          toolAllow: false, maxTurns: false },
  openhands:{ mcp: "config-flag",   toolAllow: false, maxTurns: true  },
};

export function capabilitiesFor(runner: string | undefined): RunnerCaps {
  return CAPS[(runner ?? "claude") as SubagentRunner] ?? CAPS.claude;
}

/** Resolve the MCP-config SOURCE for the claude runner: the explicit
 *  config knob wins; otherwise fall back to the workspace's own .mcp.json
 *  (the file Claude Code itself reads), so a claude-code user gets MCP-wired
 *  backup subagents out of the box instead of silently MCP-less ones
 *  (subagentMcpConfig is unset in DEFAULT_CONFIG).
 *
 *  The FALLBACK is used only when it actually DEFINES the needed server:
 *  the claude branch pairs the source with --strict-mcp-config, and a
 *  workspace .mcp.json that lacks the server would strict-filter to
 *  {"mcpServers":{}} — hard-blocking a USER-scope server that loaded fine
 *  before this fallback existed (project/user scope splits are common).
 *  No fallback → no flags → claude auto-loads user scope, the exact HEAD
 *  behavior. An EXPLICIT subagentMcpConfig keeps its historical semantics
 *  (strict, even if the server is absent) — the operator asked for it. */
export function mcpConfigSource(config: SandboxConfig, neededServer?: string | null): string | null {
  if (config.subagentMcpConfig) return config.subagentMcpConfig;
  const workspaceMcp = path.join(process.cwd(), ".mcp.json");
  try {
    if (!fs.existsSync(workspaceMcp)) return null;
    if (!neededServer) return workspaceMcp; // unfiltered use — no strict-empty risk
    const parsed = JSON.parse(fs.readFileSync(workspaceMcp, "utf-8")) as { mcpServers?: Record<string, unknown> };
    return parsed?.mcpServers?.[neededServer] ? workspaceMcp : null;
  } catch { return null; } // unreadable/unparseable fallback → behave as absent
}

/**
 * Will THIS backup call's subagent actually have the action's MCP server?
 * Consulted BEFORE the prompt is built (so the prompt can carry the no-MCP
 * directive instead of unfollowable capture instructions) and AFTER the
 * result is parsed (so a confident remote recovery produced without MCP
 * access is downgraded, never trusted verbatim).
 *
 * Browser actions are OUT OF SCOPE here (pass neededServer=null): their
 * subagent is deliberately MCP-less by design and works from the PAGE_STATE
 * snapshot, with its own fabrication gates.
 */
export function mcpAvailableFor(
  runner: string | undefined,
  config: SandboxConfig,
  neededServer: string | null | undefined,
): boolean {
  if (!neededServer) return true; // no MCP needed → nothing can be missing
  const caps = capabilitiesFor(runner);
  if (caps.mcp === "none") return false;
  if (caps.mcp === "filtered-home") {
    // hermes: without ~/.hermes/config.yaml there are no MCP servers
    // configured AT ALL (provisioning clones that file), so the subagent is
    // truly MCP-less.
    try {
      const hermesHome = process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
      return fs.existsSync(path.join(hermesHome, "config.yaml"));
    } catch { return false; }
  }
  // config-flag (claude): TRUE even when no config source was found. claude
  // auto-loads USER-scope MCP servers (~/.claude.json etc.) that we cannot
  // cheaply detect from here — returning false would downgrade working
  // backups to UNVERIFIED on a guess. Distrust is reserved for runners that
  // PROVABLY cannot have MCP (caps.mcp === "none"); uncertainty preserves
  // the existing trust behavior.
  return true;
}
