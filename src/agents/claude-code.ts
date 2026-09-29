/**
 * Claude Code adapter: registers hooks and deny rules in `.claude/settings.local.json` (the
 * per-user, uncommitted settings file, since hook commands carry absolute paths) and copies the
 * slash commands into `.claude/commands/`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CAN_REWRITE } from "./capabilities.js";
import type { AgentAdapter, AgentInstallResult, HookStatus } from "./index.js";
import { hookCommand, isOurCommand, readJsonObject, removeEmptyDirs, scriptOf, writeJson } from "./index.js";

const SETTINGS = path.join(".claude", "settings.local.json");
/** Also cleaned on uninstall, in case hooks were moved there by hand. */
const SHARED_SETTINGS = path.join(".claude", "settings.json");
const COMMANDS_DIR = path.join(".claude", "commands");
const EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "UserPromptSubmit"] as const;
const HOOK_FOR: Record<(typeof EVENTS)[number], "pre-tool" | "post-tool" | "user-prompt"> = {
  PreToolUse: "pre-tool",
  PostToolUse: "post-tool",
  PostToolUseFailure: "post-tool",
  UserPromptSubmit: "user-prompt",
};

/** Keep the agent's own file tools out of the backup store. */
const DENY_RULES = [
  "Read(.backupper/**)",
  "Edit(.backupper/**)",
  "Write(.backupper/**)",
  "Glob(.backupper/**)",
  "Grep(.backupper/**)",
];

type HookGroup = { matcher?: string; hooks?: Array<{ type?: string; command?: string }> };

function groupIsOurs(g: unknown): boolean {
  const hooks = (g as HookGroup | null)?.hooks;
  return Array.isArray(hooks) && hooks.some((h) => isOurCommand(h?.command));
}

/** Remove our hook groups and deny rules from one settings object; true when anything changed. */
function stripSettings(settings: Record<string, unknown>): boolean {
  let changed = false;
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (hooks && typeof hooks === "object") {
    for (const ev of Object.keys(hooks)) {
      if (!Array.isArray(hooks[ev])) continue;
      const kept = hooks[ev].filter((g) => !groupIsOurs(g));
      if (kept.length !== hooks[ev].length) changed = true;
      if (kept.length) hooks[ev] = kept;
      else delete hooks[ev];
    }
    if (Object.keys(hooks).length === 0) delete settings.hooks;
  }
  const perms = settings.permissions as Record<string, unknown> | undefined;
  if (perms && Array.isArray(perms.deny)) {
    const kept = (perms.deny as string[]).filter((r) => !DENY_RULES.includes(r));
    if (kept.length !== perms.deny.length) changed = true;
    if (kept.length) perms.deny = kept;
    else delete perms.deny;
    if (Object.keys(perms).length === 0) delete settings.permissions;
  }
  return changed;
}

/** The slash-command files shipped with the package. */
function shippedCommands(pkgRoot: string): string[] {
  const dir = path.join(pkgRoot, "..", "commands");
  try {
    return fs.readdirSync(dir).filter((f) => /^backupper-.*\.md$/.test(f));
  } catch {
    return [];
  }
}

export const claudeCodeAdapter: AgentAdapter = {
  name: "claude-code",
  description: "Claude Code (hooks in .claude/settings.local.json)",
  bin: "claude",
  runner: "claude",
  canRewrite: CAN_REWRITE["claude-code"],

  hookStatus(projectRoot: string): HookStatus {
    const scripts: string[] = [];
    for (const rel of [SETTINGS, SHARED_SETTINGS]) {
      let s: Record<string, unknown>;
      try { s = readJsonObject(path.join(projectRoot, rel)); } catch { continue; }
      const hooks = (s.hooks ?? {}) as Record<string, HookGroup[]>;
      for (const groups of Object.values(hooks)) {
        if (!Array.isArray(groups)) continue;
        for (const g of groups) for (const h of g?.hooks ?? []) {
          if (isOurCommand(h?.command)) scripts.push(scriptOf(h.command as string));
        }
      }
    }
    return { installed: scripts.length > 0, location: SETTINGS, hookScripts: [...new Set(scripts)] };
  },

  install(projectRoot: string, pkgRoot: string): AgentInstallResult {
    const log: string[] = [];
    const file = path.join(projectRoot, SETTINGS);
    const settings = readJsonObject(file);
    stripSettings(settings); // re-install replaces our previous entries
    const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
    for (const ev of EVENTS) {
      const existing = Array.isArray(hooks[ev]) ? hooks[ev] : [];
      hooks[ev] = [...existing, {
        matcher: "*",
        hooks: [{ type: "command", command: hookCommand(pkgRoot, HOOK_FOR[ev], "claude-code") }],
      }];
    }
    settings.hooks = hooks;
    const perms = (settings.permissions ?? {}) as Record<string, unknown>;
    const deny = Array.isArray(perms.deny) ? (perms.deny as string[]) : [];
    for (const r of DENY_RULES) if (!deny.includes(r)) deny.push(r);
    perms.deny = deny;
    settings.permissions = perms;
    writeJson(file, settings);
    log.push(`Hooks written to ${SETTINGS} (PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit)`);

    const cmds = shippedCommands(pkgRoot);
    if (cmds.length) {
      const dest = path.join(projectRoot, COMMANDS_DIR);
      fs.mkdirSync(dest, { recursive: true });
      for (const f of cmds) fs.copyFileSync(path.join(pkgRoot, "..", "commands", f), path.join(dest, f));
      log.push(`Slash commands copied to ${COMMANDS_DIR}/: ${cmds.map((f) => "/" + f.replace(/\.md$/, "")).join(" ")}`);
    }
    return { log };
  },

  uninstall(projectRoot: string): AgentInstallResult {
    const log: string[] = [];
    for (const rel of [SETTINGS, SHARED_SETTINGS]) {
      const file = path.join(projectRoot, rel);
      let settings: Record<string, unknown>;
      try { settings = readJsonObject(file); } catch {
        if (fs.existsSync(file)) log.push(`Could not parse ${rel}; left untouched`);
        continue;
      }
      if (!stripSettings(settings)) continue;
      if (Object.keys(settings).length === 0) {
        fs.rmSync(file, { force: true });
        log.push(`Removed ${rel} (it held only BackUpper entries)`);
      } else {
        writeJson(file, settings);
        log.push(`Removed BackUpper hooks and deny rules from ${rel}`);
      }
    }
    const dir = path.join(projectRoot, COMMANDS_DIR);
    let removed = 0;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (/^backupper-.*\.md$/.test(f)) { fs.rmSync(path.join(dir, f), { force: true }); removed++; }
      }
    } catch { /* no commands dir */ }
    if (removed) log.push(`Removed ${removed} slash command(s) from ${COMMANDS_DIR}/`);
    removeEmptyDirs(dir, projectRoot);
    return { log };
  },
};
