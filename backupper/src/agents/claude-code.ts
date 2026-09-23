/**
 * Claude Code adapter.
 *
 * Wires into Claude Code's hook system via .claude/settings.json
 * and installs slash commands into .claude/commands/.
 *
 * This is the "reference" adapter — its public contract (write to
 * config files Claude Code already reads) is what new agent adapters
 * mirror in their own way (Hermes: .hermes/plugins/, etc.).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentAdapter, AgentInstallResult } from "./index.js";
import { appendGitignore } from "./index.js";
import { loadConfig, saveConfig, getConfigDir } from "../config/load.js";
import { DEFAULT_CONFIG } from "../types.js";

const SETTINGS_PATH = ".claude/settings.json";

function loadSettings(projectRoot: string): Record<string, unknown> {
  const p = path.join(projectRoot, SETTINGS_PATH);
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); }
  catch { return {}; }
}

function saveSettings(projectRoot: string, settings: Record<string, unknown>): void {
  const dir = path.join(projectRoot, ".claude");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, SETTINGS_PATH), JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

const DENY_RULES = [
  "Read(.chats-sandbox/**)",
  "Edit(.chats-sandbox/**)",
  "Write(.chats-sandbox/**)",
  "Glob(.chats-sandbox/**)",
  "Grep(.chats-sandbox/**)",
];

/**
 * Is this settings.json hook entry ours?
 *
 * Two independent signals, because either one alone has a hole:
 *   - the command path contains "chats-sandbox" (true for a normal
 *     install, where pkgRoot lives under a chats-sandbox directory), and
 *   - the command path is one we are about to write (true even when the
 *     package was cloned into a differently named directory, which is
 *     exactly when the substring test misses and a re-install would
 *     otherwise append a duplicate).
 *
 * `ourPaths` is empty on uninstall (we no longer know pkgRoot there), so
 * that call falls back to the substring signal alone — the historical
 * behavior.
 */
function isOurHookEntry(entry: unknown, ourPaths: string[]): boolean {
  const h = entry as Record<string, unknown> | null;
  const innerHooks = h?.hooks as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(innerHooks)) return false;
  return innerHooks.some((ih) => {
    if (typeof ih.command !== "string") return false;
    const cmd = ih.command;
    if (cmd.toLowerCase().includes("chats-sandbox")) return true;
    return ourPaths.some((p) => p !== "" && cmd.includes(p));
  });
}

const SLASH_COMMAND_FILES = [
  "sandbox:status.md", "sandbox:restore.md", "sandbox:restore_direct.md",
  "sandbox:diff.md", "sandbox:backups.md", "sandbox:config.md",
  "sandbox:history.md", "sandbox:clear.md", "sandbox:dashboard.md",
];

export const claudeCodeAdapter: AgentAdapter = {
  name: "claude-code",
  description: "Anthropic's Claude Code CLI (via .claude/settings.json hooks)",

  detectInstalled(projectRoot: string): boolean {
    return fs.existsSync(path.join(projectRoot, ".claude"));
  },

  install(projectRoot: string, pkgRoot: string): AgentInstallResult {
    const log: string[] = [];
    const preToolPath = path.join(pkgRoot, "hooks", "pre-tool.js");
    const postToolPath = path.join(pkgRoot, "hooks", "post-tool.js");
    const userPromptPath = path.join(pkgRoot, "hooks", "user-prompt.js");

    const settings = loadSettings(projectRoot);
    const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;

    const mkHookEntry = (cmd: string) => ({
      matcher: "*",
      hooks: [{ type: "command", command: `node ${cmd}` }],
    });

    /**
     * MERGE, never assign. A plain `hooks.PreToolUse = [ours]` silently
     * DELETED every co-installed hook on that event — another guard, or
     * the user's own PreToolUse command — and the loss is invisible
     * until the day that hook was supposed to fire. We keep every
     * foreign entry, drop any previous entry OF OURS (so re-installing
     * is idempotent instead of appending a duplicate), and append the
     * current one last so the existing hooks keep their relative order.
     */
    const ourPaths = [preToolPath, postToolPath, userPromptPath];
    const mergeHook = (event: string, cmd: string): void => {
      const existing = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
      const foreign = existing.filter((e) => !isOurHookEntry(e, ourPaths));
      hooks[event] = [...foreign, mkHookEntry(cmd)];
    };

    mergeHook("PreToolUse", preToolPath);
    mergeHook("PostToolUse", postToolPath);
    mergeHook("PostToolUseFailure", postToolPath);
    mergeHook("UserPromptSubmit", userPromptPath);
    settings.hooks = hooks;

    // Deny rules — block Claude from reading our internal state dir.
    const permissions = (settings.permissions ?? {}) as Record<string, unknown>;
    const denyList = Array.isArray(permissions.deny) ? (permissions.deny as string[]) : [];
    for (const rule of DENY_RULES) {
      if (!denyList.includes(rule)) denyList.push(rule);
    }
    permissions.deny = denyList;
    settings.permissions = permissions;

    saveSettings(projectRoot, settings);

    // Sandbox config + backups dir.
    const configDir = getConfigDir(projectRoot);
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    saveConfig(DEFAULT_CONFIG, projectRoot);

    // Slash commands.
    const commandsSrcDir = path.join(pkgRoot, "..", "commands");
    const commandsDestDir = path.join(projectRoot, ".claude", "commands");
    if (fs.existsSync(commandsSrcDir)) {
      if (!fs.existsSync(commandsDestDir)) fs.mkdirSync(commandsDestDir, { recursive: true });
      const cmdFiles = fs.readdirSync(commandsSrcDir).filter((f) => f.endsWith(".md"));
      for (const f of cmdFiles) {
        fs.copyFileSync(path.join(commandsSrcDir, f), path.join(commandsDestDir, f));
      }
      log.push(`  Slash commands installed: ${cmdFiles.map((f) => "/" + f.replace(".md", "")).join(", ")}`);
    }

    appendGitignore(projectRoot, ".chats-sandbox/");

    log.push("CHATS-Sandbox installed successfully for Claude Code!");
    log.push(`  Hooks wired into ${SETTINGS_PATH}`);
    log.push(`  Config at ${configDir}/config.json`);
    log.push(`  Backups will be stored in ${DEFAULT_CONFIG.backupDir}/`);
    log.push("");
    log.push("Slash commands available in Claude Code:");
    log.push("  /sandbox:status          Show sandbox state");
    log.push("  /sandbox:history         Timeline of recent actions");
    log.push("  /sandbox:restore         Reverse-loop restore");
    log.push("  /sandbox:restore_direct  Direct jump restore");
    log.push("  /sandbox:diff            Diff against action");
    log.push("  /sandbox:backups         List backup artifacts");
    log.push("  /sandbox:config          Show/edit configuration");
    log.push("  /sandbox:clear           Delete all backups and shadow repo");
    log.push("  /sandbox:dashboard       Launch the local web dashboard");
    log.push("");
    log.push("To configure: chats-sandbox config");
    log.push("To disable:   chats-sandbox uninstall claude-code");

    return { log };
  },

  uninstall(projectRoot: string): AgentInstallResult {
    const log: string[] = [];
    const settings = loadSettings(projectRoot);
    const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;

    // Remove our hook entries (identified by chats-sandbox in command path).
    for (const event of ["PreToolUse", "PostToolUse", "PostToolUseFailure", "UserPromptSubmit"]) {
      if (Array.isArray(hooks[event])) {
        hooks[event] = (hooks[event] as unknown[]).filter(
          (entry) => !isOurHookEntry(entry, []),
        );
        if ((hooks[event] as unknown[]).length === 0) delete hooks[event];
      }
    }
    settings.hooks = hooks;

    // Remove our deny rules.
    const permissions = settings.permissions as Record<string, unknown> | undefined;
    if (permissions && Array.isArray(permissions.deny)) {
      permissions.deny = (permissions.deny as string[]).filter((r) => !DENY_RULES.includes(r));
      if ((permissions.deny as string[]).length === 0) delete permissions.deny;
      if (Object.keys(permissions).length === 0) delete settings.permissions;
    }

    saveSettings(projectRoot, settings);

    // Remove slash commands.
    const commandsDir = path.join(projectRoot, ".claude", "commands");
    for (const f of SLASH_COMMAND_FILES) {
      const p = path.join(commandsDir, f);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }

    // Silence the loadConfig import lint (used elsewhere; keep symbol).
    void loadConfig;

    log.push("CHATS-Sandbox uninstalled from Claude Code.");
    log.push("  Hooks removed from .claude/settings.json");
    log.push("  Slash commands removed from .claude/commands/");
    log.push("  Config and backups left in .chats-sandbox/ (delete manually if desired)");
    return { log };
  },
};
