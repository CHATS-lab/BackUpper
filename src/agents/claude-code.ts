/**
 * Claude Code adapter: registers hooks and deny rules in `.claude/settings.local.json` (the
 * per-user, uncommitted settings file, since hook commands carry absolute paths), copies the
 * slash commands into `.claude/commands/`, and installs the side-panel plugin (claude-plugin/)
 * at local scope, which adds `/backupper-panel`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { CAN_REWRITE, captureCommandPrefix } from "./capabilities.js";
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

/**
 * Chain mode (a non-bypass permission mode) prepends `node <dist>/hooks/capture.js <copies> &&`
 * to a destructive command. Claude Code checks that segment on its own; this rule lets it run
 * without a prompt. The script only copies into a trash folder the hook has just recorded.
 */
function captureAllowRule(): string {
  return `Bash(${captureCommandPrefix()}:*)`;
}
function isCaptureAllowRule(r: unknown): boolean {
  return typeof r === "string" && /^Bash\(node "?[^"]*[\\/]hooks[\\/]capture\.js"?:\*\)$/.test(r);
}

type HookGroup = { matcher?: string; hooks?: Array<{ type?: string; command?: string }> };

/** The side-panel plugin and the marketplace (this package's folder) it is installed from. */
const PLUGIN_MARKETPLACE = "backupper";
const PLUGIN_ID = `backupper@${PLUGIN_MARKETPLACE}`;

/** `claude plugin <args>` in the project; null when `claude` cannot run. */
function claudePlugin(projectRoot: string, args: string[]): { ok: boolean; out: string } | null {
  if (process.env.BACKUPPER_SKIP_CLAUDE_PLUGIN === "1") return null;
  const r = spawnSync("claude", ["plugin", ...args], { cwd: projectRoot, encoding: "utf-8", timeout: 60_000 });
  if (r.error) return null;
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

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
  if (perms && Array.isArray(perms.allow)) {
    const kept = (perms.allow as string[]).filter((r) => !isCaptureAllowRule(r));
    if (kept.length !== perms.allow.length) changed = true;
    if (kept.length) perms.allow = kept;
    else delete perms.allow;
  }
  if (perms && Array.isArray(perms.deny)) {
    const kept = (perms.deny as string[]).filter((r) => !DENY_RULES.includes(r));
    if (kept.length !== perms.deny.length) changed = true;
    if (kept.length) perms.deny = kept;
    else delete perms.deny;
    if (Object.keys(perms).length === 0) delete settings.permissions;
  }
  // The side-panel plugin's local-scope entries, in case `claude plugin uninstall` could not run.
  for (const [key, id] of [["enabledPlugins", PLUGIN_ID], ["extraKnownMarketplaces", PLUGIN_MARKETPLACE]] as const) {
    const map = settings[key] as Record<string, unknown> | undefined;
    if (!map || typeof map !== "object") continue;
    if (id in map) { delete map[id]; changed = true; }
    if (Object.keys(map).length === 0) { delete settings[key]; changed = true; }
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
    const allow = Array.isArray(perms.allow) ? (perms.allow as string[]) : [];
    if (!allow.includes(captureAllowRule())) allow.push(captureAllowRule());
    perms.allow = allow;
    settings.permissions = perms;
    writeJson(file, settings);
    log.push(`Hooks written to ${SETTINGS} (PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit)`);

    const cmds = shippedCommands(pkgRoot);
    if (cmds.length) {
      const dest = path.join(projectRoot, COMMANDS_DIR);
      fs.mkdirSync(dest, { recursive: true });
      // Drop commands an older version shipped (backupper-panel.md is now the plugin's).
      for (const f of fs.readdirSync(dest)) if (/^backupper-.*\.md$/.test(f) && !cmds.includes(f)) fs.rmSync(path.join(dest, f), { force: true });
      for (const f of cmds) fs.copyFileSync(path.join(pkgRoot, "..", "commands", f), path.join(dest, f));
      log.push(`Slash commands copied to ${COMMANDS_DIR}/: ${cmds.map((f) => "/" + f.replace(/\.md$/, "")).join(" ")}`);
    }

    // Side panel: a Claude Code plugin that draws the pane beside the transcript.
    const pkgDir = path.resolve(pkgRoot, "..");
    const add = claudePlugin(projectRoot, ["marketplace", "add", pkgDir, "--scope", "local"]);
    const inst = add?.ok ? claudePlugin(projectRoot, ["install", PLUGIN_ID, "--scope", "local"]) : add;
    if (inst?.ok) {
      log.push(`Side panel plugin ${PLUGIN_ID} installed for this project: type /backupper-panel in Claude Code`);
    } else {
      log.push(
        `Side panel plugin not installed${inst ? ` (${inst.out.split("\n").pop()})` : ""}. To add /backupper-panel, run here:`,
        `  claude plugin marketplace add "${pkgDir}" --scope local && claude plugin install ${PLUGIN_ID} --scope local`,
      );
    }
    return { log };
  },

  uninstall(projectRoot: string): AgentInstallResult {
    const log: string[] = [];
    if (claudePlugin(projectRoot, ["uninstall", PLUGIN_ID, "--scope", "local"])?.ok) log.push(`Uninstalled the side panel plugin ${PLUGIN_ID}`);
    claudePlugin(projectRoot, ["marketplace", "remove", PLUGIN_MARKETPLACE, "--scope", "local"]);
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
