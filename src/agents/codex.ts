/**
 * Codex adapter: registers hooks in the project's `.codex/hooks.json`, which follows the Claude
 * Code hook stdin/stdout contract. Codex runs a new hook only after it is trusted (reviewed once
 * in an interactive session) or under `--dangerously-bypass-hook-trust`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CAN_REWRITE } from "./capabilities.js";
import type { AgentAdapter, AgentInstallResult, HookStatus } from "./index.js";
import { hookCommand, isOurCommand, readJsonObject, removeEmptyDirs, scriptOf, writeJson } from "./index.js";

const HOOKS = path.join(".codex", "hooks.json");
/** Generous, so a tier-4 capture is never cut off by the agent before its own timeout. */
const HOOK_TIMEOUT_SEC = 600;
const EVENTS = { PreToolUse: "pre-tool", PostToolUse: "post-tool", UserPromptSubmit: "user-prompt" } as const;

interface HookEntry { type: "command"; command: string; timeout?: number }
interface MatcherGroup { matcher?: string; hooks: HookEntry[] }

/** Drop our commands from every event; true when anything changed. */
function strip(hooks: Record<string, MatcherGroup[]>): boolean {
  let changed = false;
  for (const ev of Object.keys(hooks)) {
    if (!Array.isArray(hooks[ev])) continue;
    const groups = hooks[ev]
      .map((g) => {
        const kept = (g.hooks ?? []).filter((h) => !isOurCommand(h.command));
        if (kept.length !== (g.hooks ?? []).length) changed = true;
        return { ...g, hooks: kept };
      })
      .filter((g) => g.hooks.length > 0);
    if (groups.length) hooks[ev] = groups;
    else delete hooks[ev];
  }
  return changed;
}

export const codexAdapter: AgentAdapter = {
  name: "codex",
  description: "Codex CLI (hooks in .codex/hooks.json)",
  bin: "codex",
  runner: "codex",
  canRewrite: CAN_REWRITE["codex"],

  hookStatus(projectRoot: string): HookStatus {
    const scripts: string[] = [];
    try {
      const doc = readJsonObject(path.join(projectRoot, HOOKS));
      for (const groups of Object.values((doc.hooks ?? {}) as Record<string, MatcherGroup[]>)) {
        if (!Array.isArray(groups)) continue;
        for (const g of groups) for (const h of g.hooks ?? []) {
          if (isOurCommand(h.command)) scripts.push(scriptOf(h.command));
        }
      }
    } catch { /* unparseable: reported as not installed */ }
    return { installed: scripts.length > 0, location: HOOKS, hookScripts: [...new Set(scripts)] };
  },

  install(projectRoot: string, pkgRoot: string): AgentInstallResult {
    const file = path.join(projectRoot, HOOKS);
    const doc = readJsonObject(file);
    const hooks = (doc.hooks ?? {}) as Record<string, MatcherGroup[]>;
    strip(hooks);
    for (const [ev, hook] of Object.entries(EVENTS)) {
      hooks[ev] = [
        ...(hooks[ev] ?? []),
        { hooks: [{ type: "command", command: hookCommand(pkgRoot, hook, "codex"), timeout: HOOK_TIMEOUT_SEC }] },
      ];
    }
    doc.hooks = hooks;
    writeJson(file, doc);
    return {
      log: [
        `Hooks written to ${HOOKS} (PreToolUse, PostToolUse, UserPromptSubmit)`,
        "Codex runs new hooks only once trusted: open `codex` interactively in this project and",
        "approve them, or pass --dangerously-bypass-hook-trust for vetted automation.",
      ],
    };
  },

  uninstall(projectRoot: string): AgentInstallResult {
    const log: string[] = [];
    const file = path.join(projectRoot, HOOKS);
    if (!fs.existsSync(file)) return { log };
    let doc: Record<string, unknown>;
    try { doc = readJsonObject(file); } catch {
      return { log: [`Could not parse ${HOOKS}; left untouched`] };
    }
    const hooks = (doc.hooks ?? {}) as Record<string, MatcherGroup[]>;
    if (!strip(hooks)) return { log };
    if (Object.keys(hooks).length) doc.hooks = hooks;
    else delete doc.hooks;
    if (Object.keys(doc).length === 0) {
      fs.rmSync(file, { force: true });
      removeEmptyDirs(path.dirname(file), projectRoot);
      log.push(`Removed ${HOOKS} (it held only BackUpper hooks)`);
    } else {
      writeJson(file, doc);
      log.push(`Removed BackUpper hooks from ${HOOKS}`);
    }
    return { log };
  },
};
