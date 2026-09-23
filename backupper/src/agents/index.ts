/**
 * Agent adapter registry.
 *
 * Each supported coding agent (Claude Code, Hermes, Codex, OpenCode, …)
 * has its own install/uninstall recipe — Claude Code uses
 * `.claude/settings.json` hooks, Hermes uses `.hermes/plugins/*.py`,
 * etc. The adapter pattern keeps `cli.ts` agent-agnostic: the user runs
 * `chats-sandbox install <agent>` and we dispatch to the adapter.
 *
 * Adding a new agent: write `src/agents/<name>.ts`, export an
 * `AgentAdapter`, register it in `ALL_ADAPTERS` below.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface AgentInstallResult {
  /** Lines printed by the adapter — surfaced verbatim by the CLI */
  log: string[];
}

export interface AgentAdapter {
  /** Canonical name, used by `chats-sandbox install <name>` */
  name: string;

  /** Short description used in --help */
  description: string;

  /**
   * Returns true if this agent's config / install footprint is
   * detected in the project. Used by --auto detection.
   */
  detectInstalled(projectRoot: string): boolean;

  /** Wire hooks / plugins for this agent. */
  install(projectRoot: string, pkgRoot: string): AgentInstallResult;

  /** Tear down everything install() did. */
  uninstall(projectRoot: string): AgentInstallResult;
}

import { claudeCodeAdapter } from "./claude-code.js";
import { hermesAdapter } from "./hermes.js";
import { openclawAdapter } from "./openclaw.js";
import { openhandsAdapter } from "./openhands.js";
import { codexAdapter } from "./codex.js";
import { cursorAdapter } from "./cursor.js";

export const ALL_ADAPTERS: AgentAdapter[] = [
  claudeCodeAdapter,
  hermesAdapter,
  openclawAdapter,
  openhandsAdapter,
  codexAdapter,
  cursorAdapter,
];

export function findAdapter(name: string): AgentAdapter | undefined {
  return ALL_ADAPTERS.find((a) => a.name === name);
}

/** Heuristic auto-detection — return adapters whose config is visible. */
export function detectAdapters(projectRoot: string): AgentAdapter[] {
  return ALL_ADAPTERS.filter((a) => a.detectInstalled(projectRoot));
}

/** Helper used by adapters that need to append to .gitignore. */
export function appendGitignore(projectRoot: string, entry: string): void {
  const p = path.join(projectRoot, ".gitignore");
  if (fs.existsSync(p)) {
    const content = fs.readFileSync(p, "utf-8");
    if (!content.includes(entry)) {
      fs.appendFileSync(p, `\n${entry}\n`);
    }
  }
}
