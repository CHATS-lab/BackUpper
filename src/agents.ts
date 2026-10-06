/**
 * Agent adapters: per-host capabilities, the install/uninstall recipes for Claude Code, Codex,
 * Hermes, OpenHands, DeepSeek Harness and OpenClaw, and the adapter registry with the shared
 * hook-command helpers.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { SubagentRunnerName } from "./types.js";
import { readJsonObject, writeJson } from "./util.js";

// =============================================================================
// ── capabilities ──
// =============================================================================

/**
 * Per-host capabilities that change how the hook behaves.
 *
 * canRewrite: the host applies a PreToolUse hook's rewritten tool input (`updatedInput`).
 * Claude Code does; the Hermes plugin copies it into the live call arguments before dispatch, and
 * the OpenClaw plugin returns it as the `before_tool_call` params rewrite;
 * Codex does when the same output also carries `permissionDecision: "allow"` (the pre-tool hook
 * adds it for Codex only; Codex still applies its approval policy and sandbox to the rewritten
 * command). OpenHands and DeepSeek Harness never apply a rewritten input. On a host that cannot
 * rewrite, tier 1 runs in backup-only mode (see tier1Mode): the host's own run of the command
 * is the only one.
 */

export const CAN_REWRITE: Readonly<Record<string, boolean>> = {
  "claude-code": true,
  hermes: true,
  codex: true,
  openhands: false,
  "deepseek-harness": false,
  openclaw: true,
};

/**
 * Whether tier 1 may rewrite the call for the host whose hook fired (BACKUPPER_HOST_AGENT,
 * set from the hook's `--agent` tag). BACKUPPER_NO_REWRITE=1 forces backup-only mode and
 * BACKUPPER_NO_REWRITE=0 forces rewriting. An unknown host gets backup-only mode, which is
 * correct on every host.
 */
export function tier1CanRewrite(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.BACKUPPER_NO_REWRITE === "1") return false;
  if (env.BACKUPPER_NO_REWRITE === "0") return true;
  const host = env.BACKUPPER_HOST_AGENT ?? "";
  return CAN_REWRITE[host] === true;
}

/**
 * How tier 1 treats a matching call:
 * - "rewrite": run the backup (and, for most rules, the effect) inside the hook and hand the
 *   agent a no-op. Only safe when the host runs no approval step after the hook, i.e. in a
 *   bypass / full-auto permission mode, or when the host does not report a mode at all.
 * - "backup-only": nothing is rewritten and the host runs the original command. Rules that
 *   save small state (refs, manifests, modes) record it as tier 2; rules that protect file
 *   contents leave them to the tier-3 snapshot, plus copies of what the snapshot does not
 *   hold. The action is recorded as pending until the post-tool hook confirms the call ran.
 */
export type Tier1Mode = "rewrite" | "backup-only";

export function tier1Mode(
  permissionMode: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Tier1Mode {
  if (!tier1CanRewrite(env)) return "backup-only";
  if (env.BACKUPPER_NO_REWRITE === "0") return "rewrite";
  if (!permissionMode || permissionMode === "bypassPermissions") return "rewrite";
  return "backup-only";
}

// =============================================================================
// ── claude code ──
// =============================================================================

/**
 * Claude Code adapter: registers hooks and deny rules in `.claude/settings.local.json` (the
 * per-user, uncommitted settings file, since hook commands carry absolute paths), copies the
 * slash commands into `.claude/commands/`, and installs the side-panel plugin (claude-plugin/)
 * at local scope, which adds `/backupper-panel`.
 */

const SETTINGS = path.join(".claude", "settings.local.json");
/** Also cleaned on uninstall, in case hooks were moved there by hand. */
const SHARED_SETTINGS = path.join(".claude", "settings.json");
const COMMANDS_DIR = path.join(".claude", "commands");
const EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "UserPromptSubmit"] as const;
const HOOK_FOR: Record<(typeof EVENTS)[number], HookName> = {
  PreToolUse: "pre",
  PostToolUse: "post",
  PostToolUseFailure: "post",
  UserPromptSubmit: "prompt",
};

/** Keep the agent's own file tools out of the backup store. */
const DENY_RULES = [
  "Read(.backupper/**)",
  "Edit(.backupper/**)",
  "Write(.backupper/**)",
  "Glob(.backupper/**)",
  "Grep(.backupper/**)",
];

/** The allow rule older installs added for their copy helper; removed on install and uninstall. */
function isCaptureAllowRule(r: unknown): boolean {
  // The hook.js capture form and the hooks/capture.js form.
  return typeof r === "string" &&
    (/^Bash\(node (?:"[^"]*[\\/]hook\.js"|[^"\s]*[\\/]hook\.js) capture:\*\)$/.test(r) ||
      /^Bash\(node "?[^"]*[\\/]hooks[\\/]capture\.js"?:\*\)$/.test(r));
}

type HookGroup = { matcher?: string; hooks?: Array<{ type?: string; command?: string }> };

/** The side-panel plugin and the marketplace (claude-plugin/ in this package) it is installed from. */
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
    const pkgDir = path.resolve(pkgRoot, "..", "claude-plugin");
    const add = claudePlugin(projectRoot, ["marketplace", "add", pkgDir, "--scope", "local"]);
    const inst = add?.ok ? claudePlugin(projectRoot, ["install", PLUGIN_ID, "--scope", "local"]) : add;
    // Claude Code versions without plugin modules install the plugin but fail to load it.
    let loadError = "";
    if (inst?.ok) {
      try {
        const listed = JSON.parse(claudePlugin(projectRoot, ["list", "--json"])?.out ?? "[]") as Array<{ id?: string; errors?: string[] }>;
        loadError = listed.find((p) => p.id === PLUGIN_ID)?.errors?.[0] ?? "";
      } catch { /* list unavailable: assume it loads */ }
    }
    if (inst?.ok && loadError) {
      log.push(
        `Side panel plugin ${PLUGIN_ID} installed, but this Claude Code version cannot load it.`,
        `  Update Claude Code (\`claude update\`), then type /backupper-panel. Backups work either way.`,
      );
    } else if (inst?.ok) {
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

// =============================================================================
// ── codex ──
// =============================================================================

/**
 * Codex adapter: registers hooks in the project's `.codex/hooks.json`, which follows the Claude
 * Code hook stdin/stdout contract. Codex runs a new hook only after it is trusted (reviewed once
 * in an interactive session) or under `--dangerously-bypass-hook-trust`.
 */

const CODEX_HOOKS = path.join(".codex", "hooks.json");
/** Generous, so a tier-4 capture is never cut off by the agent before its own timeout. */
const HOOK_TIMEOUT_SEC = 600;
const CODEX_EVENTS = { PreToolUse: "pre", PostToolUse: "post", UserPromptSubmit: "prompt" } as const;

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
      const doc = readJsonObject(path.join(projectRoot, CODEX_HOOKS));
      for (const groups of Object.values((doc.hooks ?? {}) as Record<string, MatcherGroup[]>)) {
        if (!Array.isArray(groups)) continue;
        for (const g of groups) for (const h of g.hooks ?? []) {
          if (isOurCommand(h.command)) scripts.push(scriptOf(h.command));
        }
      }
    } catch { /* unparseable: reported as not installed */ }
    return { installed: scripts.length > 0, location: CODEX_HOOKS, hookScripts: [...new Set(scripts)] };
  },

  install(projectRoot: string, pkgRoot: string): AgentInstallResult {
    const file = path.join(projectRoot, CODEX_HOOKS);
    const doc = readJsonObject(file);
    const hooks = (doc.hooks ?? {}) as Record<string, MatcherGroup[]>;
    strip(hooks);
    for (const [ev, hook] of Object.entries(CODEX_EVENTS)) {
      hooks[ev] = [
        ...(hooks[ev] ?? []),
        { hooks: [{ type: "command", command: hookCommand(pkgRoot, hook, "codex"), timeout: HOOK_TIMEOUT_SEC }] },
      ];
    }
    doc.hooks = hooks;
    writeJson(file, doc);
    return {
      log: [
        `Hooks written to ${CODEX_HOOKS} (PreToolUse, PostToolUse, UserPromptSubmit)`,
        "Codex runs new hooks only once trusted: open `codex` interactively in this project and",
        "approve them, or pass --dangerously-bypass-hook-trust for vetted automation.",
      ],
    };
  },

  uninstall(projectRoot: string): AgentInstallResult {
    const log: string[] = [];
    const file = path.join(projectRoot, CODEX_HOOKS);
    if (!fs.existsSync(file)) return { log };
    let doc: Record<string, unknown>;
    try { doc = readJsonObject(file); } catch {
      return { log: [`Could not parse ${CODEX_HOOKS}; left untouched`] };
    }
    const hooks = (doc.hooks ?? {}) as Record<string, MatcherGroup[]>;
    if (!strip(hooks)) return { log };
    if (Object.keys(hooks).length) doc.hooks = hooks;
    else delete doc.hooks;
    if (Object.keys(doc).length === 0) {
      fs.rmSync(file, { force: true });
      removeEmptyDirs(path.dirname(file), projectRoot);
      log.push(`Removed ${CODEX_HOOKS} (it held only BackUpper hooks)`);
    } else {
      writeJson(file, doc);
      log.push(`Removed BackUpper hooks from ${CODEX_HOOKS}`);
    }
    return { log };
  },
};

// =============================================================================
// ── openhands ──
// =============================================================================

/**
 * OpenHands adapter: installs a project plugin at `.openhands/plugins/backupper/`, laid out like
 * the plugins in OpenHands/extensions. Every Conversation loads the plugins under the project's
 * `.openhands/plugins/` (CLI, agent server and SDK scripts alike), so nothing is passed at launch.
 * Its hooks call `backupper hook` from PATH. OpenHands runs a hook with the payload's own field
 * names and never applies a rewritten input, so tier 1 runs in backup-only mode there.
 */

/** This package's version, stamped into the plugin manifest. */
const PKG_VERSION: string = (() => {
  try { return String(readJsonObject(path.join(__dirname, "..", "package.json")).version ?? "0.0.0"); } catch { return "0.0.0"; }
})();

const OH_PLUGIN_DIR = path.join(".openhands", "plugins", "backupper");
const OH_HOOKS = path.join(OH_PLUGIN_DIR, "hooks", "hooks.json");

export const openhandsAdapter: AgentAdapter = {
  name: "openhands",
  description: "OpenHands (project plugin in .openhands/plugins/backupper/)",
  bin: "openhands",
  runner: "claude",
  canRewrite: CAN_REWRITE["openhands"],

  hookStatus(projectRoot: string): HookStatus {
    let installed = false;
    try {
      const doc = readJsonObject(path.join(projectRoot, OH_HOOKS));
      installed = Object.values((doc.hooks ?? {}) as Record<string, MatcherGroup[]>)
        .some((groups) => Array.isArray(groups) && groups.some((g) => (g.hooks ?? []).some((h) => isOurCommand(h.command))));
    } catch { /* unparseable: reported as not installed */ }
    // The hooks run `backupper` from PATH, so there is no script path to report.
    return { installed, location: OH_PLUGIN_DIR, hookScripts: [] };
  },

  install(projectRoot: string): AgentInstallResult {
    const dir = path.join(projectRoot, OH_PLUGIN_DIR);
    fs.mkdirSync(path.join(dir, ".plugin"), { recursive: true });
    writeJson(path.join(dir, ".plugin", "plugin.json"), {
      name: "backupper",
      version: PKG_VERSION,
      description: "Backs up what a tool call is about to destroy before it runs, so any step can be undone with `backupper restore`.",
      author: { name: "CHATS-lab" },
      homepage: "https://github.com/CHATS-lab/BackUpper",
      license: "MIT",
    });
    for (const link of [".claude-plugin", ".codex-plugin"]) {
      fs.rmSync(path.join(dir, link), { force: true, recursive: true });
      fs.symlinkSync(".plugin", path.join(dir, link));
    }
    const hooks: Record<string, MatcherGroup[]> = {};
    for (const [ev, hook] of Object.entries(CODEX_EVENTS)) {
      hooks[ev] = [{ matcher: "*", hooks: [{ type: "command", command: `backupper hook ${hook} --agent openhands`, timeout: HOOK_TIMEOUT_SEC }] }];
    }
    writeJson(path.join(projectRoot, OH_HOOKS), { hooks });
    return {
      log: [
        `Plugin written to ${OH_PLUGIN_DIR}/ (PreToolUse, PostToolUse, UserPromptSubmit)`,
        "OpenHands loads it in every conversation in this project (CLI, agent server and SDK scripts).",
        "Its hooks run `backupper hook`, so keep `backupper` on PATH where OpenHands runs.",
      ],
    };
  },

  uninstall(projectRoot: string): AgentInstallResult {
    if (!this.hookStatus(projectRoot).installed) return { log: [] };
    const dir = path.join(projectRoot, OH_PLUGIN_DIR);
    fs.rmSync(dir, { recursive: true, force: true });
    removeEmptyDirs(path.dirname(dir), projectRoot);
    return { log: [`Removed ${OH_PLUGIN_DIR}/`] };
  },
};

// =============================================================================
// ── hermes ──
// =============================================================================

/**
 * Hermes adapter: installs a directory plugin at `.hermes/plugins/backupper/` whose
 * pre_tool_call / post_tool_call / pre_llm_call hooks forward each call to the Node hooks in the
 * Claude Code JSON shape. Hermes scans project plugins only when HERMES_ENABLE_PROJECT_PLUGINS=1
 * and loads one only when its name is in `plugins.enabled` of `$HERMES_HOME/config.yaml`, which
 * install adds (`hermes plugins enable` does not see project plugins).
 */

const PLUGIN_DIR = path.join(".hermes", "plugins", "backupper");
const MARKER = "# backupper-plugin";
const HERMES_LAUNCH = "HERMES_ENABLE_PROJECT_PLUGINS=1 hermes";

function hermesConfigPath(): string {
  return path.join(process.env.HERMES_HOME || path.join(os.homedir(), ".hermes"), "config.yaml");
}

/** Add (on) or remove (off) "backupper" in plugins.enabled; also drops it from plugins.disabled. */
function setHermesPluginEnabled(on: boolean): boolean {
  const file = hermesConfigPath();
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const yaml = require("js-yaml");
  const cfg = ((text.trim() ? yaml.load(text) : null) ?? {}) as Record<string, unknown>;
  const plugins = (cfg.plugins && typeof cfg.plugins === "object" ? cfg.plugins : {}) as Record<string, unknown>;
  const list = (k: string) => (Array.isArray(plugins[k]) ? (plugins[k] as unknown[]) : []);
  const enabled = list("enabled");
  if (on && enabled.includes("backupper") && !list("disabled").includes("backupper")) return false;
  if (!on && !enabled.includes("backupper") && !list("disabled").includes("backupper")) return false;
  if (on && !("plugins" in cfg)) {
    // Appending keeps the rest of the file, comments included, as it was.
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${text}${text && !text.endsWith("\n") ? "\n" : ""}plugins:\n  enabled:\n  - backupper\n`, "utf-8");
    return true;
  }
  const want = {
    enabled: on ? [...enabled.filter((n) => n !== "backupper"), "backupper"] : enabled.filter((n) => n !== "backupper"),
    disabled: list("disabled").filter((n) => n !== "backupper"),
  };
  // Edit the lines in place so the user's comments and layout survive; keep the edit only when
  // it parses to exactly the intended config, else rewrite the file from the parsed config.
  const edited = editHermesPluginLines(text, on);
  if (edited !== null && sameHermesConfig(yaml.load(edited), cfg, want)) {
    fs.writeFileSync(file, edited, "utf-8");
    return true;
  }
  plugins.enabled = want.enabled;
  plugins.disabled = want.disabled;
  for (const k of ["enabled", "disabled"]) if (!on && (plugins[k] as unknown[]).length === 0) delete plugins[k];
  if (Object.keys(plugins).length) cfg.plugins = plugins;
  else delete cfg.plugins;
  fs.writeFileSync(file, Object.keys(cfg).length ? yaml.dump(cfg, { lineWidth: -1 }) : "", "utf-8");
  return true;
}

/**
 * `text` with "backupper" dropped from the block lists under `plugins:` (enabled and disabled)
 * and, when `on`, appended to `plugins.enabled`; null when the layout is not one this handles.
 */
function editHermesPluginLines(text: string, on: boolean): string | null {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^plugins:\s*(#.*)?$/.test(l));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && (/^\s/.test(lines[end]) || /^\s*(#.*)?$/.test(lines[end]))) end++;
  const isOurs = (l: string) => /^\s*-\s*["']?backupper["']?\s*(#.*)?$/.test(l);
  let section = "";
  let enabledAt = -1;
  let lastEnabledItem = -1;
  let itemIndent = "";
  const out: string[] = [];
  for (let i = start + 1; i < end; i++) {
    const key = /^(\s+)([A-Za-z_]+):\s*(.*)$/.exec(lines[i]);
    if (key) {
      section = key[2];
      if (key[3] && !key[3].startsWith("#")) return null;
      if (section === "enabled") { enabledAt = out.length; itemIndent = key[1]; }
    } else if (/^\s*-/.test(lines[i]) && (section === "enabled" || section === "disabled")) {
      if (isOurs(lines[i])) continue;
      if (section === "enabled") { lastEnabledItem = out.length; itemIndent = /^(\s*)/.exec(lines[i])![1]; }
    }
    out.push(lines[i]);
  }
  if (on) {
    if (enabledAt < 0) return null;
    out.splice((lastEnabledItem >= 0 ? lastEnabledItem : enabledAt) + 1, 0, `${itemIndent}- backupper`);
  }
  return [...lines.slice(0, start + 1), ...out, ...lines.slice(end)].join("\n");
}

/** Whether `edited` equals `orig` with plugins.enabled / plugins.disabled set to `want`. */
function sameHermesConfig(edited: unknown, orig: Record<string, unknown>, want: { enabled: unknown[]; disabled: unknown[] }): boolean {
  const norm = (c: unknown) => {
    const o = { ...((c ?? {}) as Record<string, unknown>) };
    const p = { ...((o.plugins ?? {}) as Record<string, unknown>) };
    for (const k of ["enabled", "disabled"]) if (!Array.isArray(p[k]) || (p[k] as unknown[]).length === 0) delete p[k];
    o.plugins = p;
    return JSON.stringify(o);
  };
  const plugins = { ...((orig.plugins ?? {}) as Record<string, unknown>), ...want };
  return norm(edited) === norm({ ...orig, plugins });
}

function manifest(): string {
  return [
    "name: backupper",
    "description: Captures what a tool call is about to destroy before it runs.",
    "provides_hooks: [pre_tool_call, post_tool_call, pre_llm_call]",
    "",
  ].join("\n");
}

function pluginSource(pkgRoot: string): string {
  const hook = JSON.stringify(path.join(pkgRoot, "hook.js"));
  const cli = JSON.stringify(path.join(pkgRoot, "cli.js"));
  return `${MARKER}
"""BackUpper plugin for Hermes, written by \`backupper install hermes\` (regenerated on install).

Each tool call is sent to the BackUpper Node hooks as Claude Code hook JSON. A tier-1 rewrite is
applied to the live args dict. Messages
the pre-tool hook addresses to the agent are delivered at the next model call. The
/backupper-panel slash command toggles the side panel without a model turn.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess

logger = logging.getLogger(__name__)

_HOOK = ${hook}
_CLI = ${cli}
_NO_HOOK_ENV = "BACKUPPER_NO_HOOK"
# Above the tier-4 subagent timeout, so a capture in progress is never cut off here.
_TIMEOUT_SEC = 600.0

# Hermes tool names mapped to the names the hooks key their rules on.
_NAME_MAP = {
    "terminal": "Bash",
    "write_file": "Write",
    "patch": "Edit",
    "read_file": "Read",
    "search_files": "Grep",
}

_pending_context: list[str] = []


def _run(hook: str, payload: dict) -> dict | None:
    """Pipe one payload into a hook (pre, post or prompt) and return its JSON output, or None."""
    if os.environ.get(_NO_HOOK_ENV) == "1":
        return None  # inside a BackUpper subagent
    if not os.path.exists(_HOOK):
        logger.warning("backupper: hook missing: %s (reinstall with: backupper install hermes)", _HOOK)
        return None
    env = {k: v for k, v in os.environ.items() if k != _NO_HOOK_ENV}
    try:
        proc = subprocess.run(
            ["node", _HOOK, hook, "--agent", "hermes"],
            input=json.dumps(payload).encode("utf-8"),
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            timeout=_TIMEOUT_SEC, check=False, env=env,
        )
        out = (proc.stdout or b"").decode("utf-8", "replace").strip()
        return json.loads(out) if out else None
    except Exception as e:
        logger.warning("backupper: hook failed (%s %s): %s", _HOOK, hook, e)
        return None


def _toolset_of(tool_name: str) -> str:
    try:
        from tools.registry import registry
        getter = getattr(registry, "get_toolset_for_tool", None)
        if callable(getter):
            return str(getter(tool_name) or "")
        entry = getattr(registry, "_tools", {}).get(tool_name)
        return str(getattr(entry, "toolset", "") or "")
    except Exception:
        return ""


def _hook_name(tool_name: str) -> str:
    """MCP and browser tools become mcp__<server>__<tool>; built-ins use _NAME_MAP."""
    toolset = _toolset_of(tool_name)
    server = None
    for prefix in ("mcp-", "mcp_"):
        if toolset.startswith(prefix):
            server = toolset[len(prefix):]
            break
    if not server and toolset == "browser":
        server = "browser"
    if not server:
        return _NAME_MAP.get(tool_name, tool_name)
    bare = tool_name
    for prefix in (f"mcp__{server}__", f"mcp_{server}_"):
        if bare.startswith(prefix):
            bare = bare[len(prefix):]
            break
    return f"mcp__{server}__{bare}"


def _tool_input(tool_name: str, args: dict) -> dict:
    payload = dict(args)
    if tool_name in ("write_file", "patch") and "path" in payload:
        payload.setdefault("file_path", payload["path"])
    return payload


def _permission_mode() -> str:
    """Hermes asks for approval inside the terminal tool, after this hook. Report
    "bypassPermissions" exactly when its guard approves without asking (mirrors
    tools.approval.check_all_command_guards): --yolo, approvals.mode=off, or a
    non-interactive run. Otherwise "default": BackUpper then executes nothing in the hook and
    prepends its copies to the command, so a denied command changes nothing."""
    if os.getenv("HERMES_YOLO_MODE"):
        return "bypassPermissions"
    try:
        from tools.approval import _get_approval_mode
        if _get_approval_mode() == "off":
            return "bypassPermissions"
    except Exception:
        pass
    if not (os.getenv("HERMES_INTERACTIVE") or os.getenv("HERMES_GATEWAY_SESSION")
            or os.getenv("HERMES_EXEC_ASK")):
        return "bypassPermissions"
    return "default"


def _pre_tool(tool_name: str = "", args: dict | None = None, session_id: str = "",
              tool_call_id: str = "", **_: object) -> None:
    if args is None:
        return
    mapped = _hook_name(tool_name)
    out = _run("pre", {
        "hook_event": "PreToolUse",
        "tool_name": mapped,
        "tool_input": _tool_input(tool_name, args),
        "session_id": session_id,
        "tool_use_id": tool_call_id,
        "cwd": os.getcwd(),
        "permission_mode": _permission_mode(),
    }) or {}
    hso = out.get("hookSpecificOutput") or {}
    update = hso.get("updatedInput")
    if isinstance(update, dict):
        for k, v in update.items():
            if k in args:
                args[k] = v
    ctx = hso.get("additionalContext")
    if isinstance(ctx, str) and ctx.strip():
        _pending_context.append(ctx.strip())
        logger.warning("backupper: %s", ctx.strip())


def _post_tool(tool_name: str = "", args: dict | None = None, result: object = None,
               session_id: str = "", tool_call_id: str = "", **_: object) -> None:
    _run("post", {
        "hook_event": "PostToolUse",
        "tool_name": _hook_name(tool_name),
        "tool_input": _tool_input(tool_name, args or {}),
        "tool_output": result,
        "session_id": session_id,
        "tool_use_id": tool_call_id,
        "cwd": os.getcwd(),
    })


def _pre_llm(session_id: str = "", user_message: object = None, **_: object) -> dict | None:
    out = _run("prompt", {
        "hook_event": "UserPromptSubmit",
        "prompt": user_message if isinstance(user_message, str) else "",
        "session_id": session_id,
    }) or {}
    parts = []
    ctx = (out.get("hookSpecificOutput") or {}).get("additionalContext")
    if isinstance(ctx, str) and ctx.strip():
        parts.append(ctx.strip())
    parts.extend(_pending_context)
    _pending_context.clear()
    return {"context": "\\n\\n".join(parts)} if parts else None


_PANEL_ACTIONS = ("on", "off", "toggle", "status")


def _panel(raw_args: str = "") -> str:
    """/backupper-panel [on|off|toggle|status]: runs \`backupper panel\` here, never the model."""
    action = (raw_args or "").strip().lower() or "toggle"
    if action not in _PANEL_ACTIONS:
        return "Usage: /backupper-panel [on|off|toggle|status]"
    try:
        proc = subprocess.run(
            ["node", _CLI, "panel", action],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            timeout=30, check=False, cwd=os.getcwd(),
        )
        return (proc.stdout or b"").decode("utf-8", "replace").strip() or f"backupper panel {action}: done"
    except Exception as e:
        return f"BackUpper panel: {e}"


def register(ctx) -> None:
    ctx.register_hook("pre_tool_call", _pre_tool)
    ctx.register_hook("post_tool_call", _post_tool)
    ctx.register_hook("pre_llm_call", _pre_llm)
    # Older Hermes builds have no plugin slash commands; the CLI toggle still works there.
    if callable(getattr(ctx, "register_command", None)):
        ctx.register_command(
            "backupper-panel",
            handler=_panel,
            description="Toggle the BackUpper side panel",
            args_hint="[on|off|toggle|status]",
        )
`;
}

export const hermesAdapter: AgentAdapter = {
  name: "hermes",
  description: "Hermes (project plugin in .hermes/plugins/backupper/)",
  bin: "hermes",
  runner: "hermes",
  canRewrite: CAN_REWRITE["hermes"],

  hookStatus(projectRoot: string): HookStatus {
    const init = path.join(projectRoot, PLUGIN_DIR, "__init__.py");
    let scripts: string[] = [];
    try {
      const src = fs.readFileSync(init, "utf-8");
      if (src.startsWith(MARKER)) {
        // _HOOK in the current plugin; _PRE_TOOL / _POST_TOOL / _USER_PROMPT in older ones.
        scripts = [...src.matchAll(/^_(?:HOOK|PRE_TOOL|POST_TOOL|USER_PROMPT) = "([^"]+)"$/gm)].map((m) => JSON.parse(`"${m[1]}"`));
      }
    } catch { /* not installed */ }
    return { installed: scripts.length > 0, location: PLUGIN_DIR, hookScripts: scripts };
  },

  install(projectRoot: string, pkgRoot: string): AgentInstallResult {
    const dir = path.join(projectRoot, PLUGIN_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "plugin.yaml"), manifest(), "utf-8");
    fs.writeFileSync(path.join(dir, "__init__.py"), pluginSource(pkgRoot), "utf-8");
    const log = [`Plugin written to ${PLUGIN_DIR}/`];
    if (setHermesPluginEnabled(true)) log.push(`Added backupper to plugins.enabled in ${hermesConfigPath()}`);
    log.push(`Start Hermes from this project with project plugins on: ${HERMES_LAUNCH}`);
    return { log };
  },

  uninstall(projectRoot: string): AgentInstallResult {
    const dir = path.join(projectRoot, PLUGIN_DIR);
    const init = path.join(dir, "__init__.py");
    let ours = false;
    try { ours = fs.readFileSync(init, "utf-8").startsWith(MARKER); } catch { /* absent */ }
    if (!ours) return { log: [] };
    for (const f of ["__init__.py", "plugin.yaml"]) fs.rmSync(path.join(dir, f), { force: true });
    fs.rmSync(path.join(dir, "__pycache__"), { recursive: true, force: true });
    removeEmptyDirs(dir, projectRoot);
    const log = [`Removed ${PLUGIN_DIR}/`];
    if (setHermesPluginEnabled(false)) log.push(`Removed backupper from plugins.enabled in ${hermesConfigPath()}`);
    return { log };
  },
};

// =============================================================================
// ── deepseek harness ──
// =============================================================================

/**
 * DeepSeek Harness adapter. dsh has no project-level config, so install writes a patch layer to
 * `.dsh/backupper/cordis.patch.yml` that the user passes at launch with `--patch`. The layer
 * mounts two things:
 * - a native plugin (`plugin.mjs`) on `tools/execute`, which runs the pre-tool hook after dsh's
 *   own approval and right before the tool body, so a call the user rejects is never backed up;
 * - the bundled Claude Code hook bridge on `hooks.json`, for PostToolUse and UserPromptSubmit.
 * dsh never applies a rewritten input, so tier 1 runs in backup-only mode.
 */

const DSH_DIR = path.join(".dsh", "backupper");
const DSH_HOOKS = path.join(DSH_DIR, "hooks.json");
const DSH_PLUGIN = path.join(DSH_DIR, "plugin.mjs");
const DSH_PATCH = path.join(DSH_DIR, "cordis.patch.yml");
const DSH_LAUNCH = `dsh --patch ${DSH_PATCH}`;
const DSH_MARKER = "// backupper-plugin";
const DSH_EVENTS = { PostToolUse: "post", UserPromptSubmit: "prompt" } as const;

function dshPluginSource(pkgRoot: string): string {
  const hook = JSON.stringify(path.join(pkgRoot, "hook.js"));
  return `${DSH_MARKER}
/**
 * BackUpper plugin for DeepSeek Harness, written by \`backupper install deepseek-harness\`
 * (regenerated on install). Runs the BackUpper pre-tool hook from tools/execute, after dsh's
 * approval and right before the tool body.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const HOOK = ${hook};
const NO_HOOK_ENV = "BACKUPPER_NO_HOOK";
// Above the tier-4 subagent timeout, so a capture in progress is never cut off here.
const TIMEOUT_MS = 600_000;

export const name = "backupper";

/** Pipe one payload into the pre-tool hook and wait for it to finish. */
function pre(payload, cwd) {
  const env = { ...process.env };
  delete env[NO_HOOK_ENV];
  return new Promise((resolve) => {
    const child = spawn("node", [HOOK, "pre", "--agent", "deepseek-harness"], { cwd, env, stdio: ["pipe", "ignore", "ignore"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.stdin.on("error", () => {});
    child.on("error", () => { clearTimeout(timer); resolve(); });
    child.on("close", () => { clearTimeout(timer); resolve(); });
    child.stdin.end(JSON.stringify(payload));
  });
}

export function apply(ctx) {
  ctx.on("tools/execute", async (exec, next) => {
    if (process.env[NO_HOOK_ENV] !== "1" && existsSync(HOOK)) {
      const header = exec.agent?.session?.header ?? {};
      const cwd = header.cwd ?? process.cwd();
      await pre({
        session_id: header.id ?? "",
        cwd,
        hook_event_name: "PreToolUse",
        tool_name: exec.name,
        tool_input: exec.arguments,
        tool_use_id: exec.callId,
      }, cwd);
    }
    return next();
  });
}
`;
}

export const deepseekHarnessAdapter: AgentAdapter = {
  name: "deepseek-harness",
  description: "DeepSeek Harness (patch layer in .dsh/backupper/, passed with dsh --patch)",
  bin: "dsh",
  runner: "claude",
  canRewrite: CAN_REWRITE["deepseek-harness"],

  hookStatus(projectRoot: string): HookStatus {
    let scripts: string[] = [];
    try {
      const src = fs.readFileSync(path.join(projectRoot, DSH_PLUGIN), "utf-8");
      if (src.startsWith(DSH_MARKER)) scripts = [...src.matchAll(/^const HOOK = ("[^"]+");$/gm)].map((m) => JSON.parse(m[1]));
    } catch { /* not installed */ }
    return { installed: scripts.length > 0, location: DSH_DIR, hookScripts: scripts };
  },

  install(projectRoot: string, pkgRoot: string): AgentInstallResult {
    const hooks: Record<string, MatcherGroup[]> = {};
    for (const [ev, hook] of Object.entries(DSH_EVENTS)) {
      hooks[ev] = [{ hooks: [{ type: "command", command: hookCommand(pkgRoot, hook, "deepseek-harness"), timeout: HOOK_TIMEOUT_SEC }] }];
    }
    writeJson(path.join(projectRoot, DSH_HOOKS), { hooks });
    fs.writeFileSync(path.join(projectRoot, DSH_PLUGIN), dshPluginSource(pkgRoot), "utf-8");
    fs.writeFileSync(path.join(projectRoot, DSH_PATCH), [
      "# Written by `backupper install deepseek-harness`: BackUpper's tools/execute plugin and the",
      "# Claude Code hook bridge on its hooks. Pass it at launch: dsh --patch <this file>.",
      "- insert:",
      "    - id: backupper",
      `      name: ${JSON.stringify(path.resolve(projectRoot, DSH_PLUGIN))}`,
      "    - id: backupper-hooks",
      "      name: '@deepseek-ai/dsh-hooks-claude-code'",
      "      config:",
      `        configPath: ${JSON.stringify(path.resolve(projectRoot, DSH_HOOKS))}`,
      "",
    ].join("\n"), "utf-8");
    return {
      log: [
        `Patch layer written to ${DSH_PATCH} (tools/execute plugin, PostToolUse, UserPromptSubmit)`,
        `Start dsh from this project with it: ${DSH_LAUNCH}   (also: dsh web --patch ${DSH_PATCH})`,
      ],
    };
  },

  uninstall(projectRoot: string): AgentInstallResult {
    if (!this.hookStatus(projectRoot).installed) return { log: [] };
    for (const f of [DSH_HOOKS, DSH_PLUGIN, DSH_PATCH]) fs.rmSync(path.join(projectRoot, f), { force: true });
    removeEmptyDirs(path.join(projectRoot, DSH_DIR), projectRoot);
    return { log: [`Removed ${DSH_DIR}/`] };
  },
};

// =============================================================================
// ── openclaw ──
// =============================================================================

/**
 * OpenClaw adapter: installs a workspace plugin at `.openclaw/extensions/backupper/` whose
 * before_tool_call / after_tool_call / before_prompt_build hooks forward each call to the Node
 * hooks in the Claude Code JSON shape. OpenClaw works in, and discovers workspace plugins from,
 * its agent workspace, and loads one only once it is enabled. Install enables the plugin; the
 * user points the workspace at this project per launch with OPENCLAW_WORKSPACE_DIR, which
 * applies when `agents.defaults.workspace` is not set. The Gateway and `openclaw agent --local`
 * run its hooks; `openclaw agent exec` loads workspace plugins for discovery only.
 */

const OC_PLUGIN_DIR = path.join(".openclaw", "extensions", "backupper");
const OC_MARKER = "// backupper-plugin";
const OC_PLUGIN_ID = "backupper";
/** OpenClaw config written by install: enable the plugin and let it add prompt context. */
const OC_CONFIG: Array<[string, string]> = [
  [`plugins.entries.${OC_PLUGIN_ID}.enabled`, "true"],
  [`plugins.entries.${OC_PLUGIN_ID}.hooks.allowConversationAccess`, "true"],
];

/** `openclaw <args>`; null when `openclaw` cannot run. */
function openclaw(projectRoot: string, args: string[]): { ok: boolean; out: string } | null {
  const r = spawnSync("openclaw", args, { cwd: projectRoot, encoding: "utf-8", timeout: 60_000 });
  if (r.error) return null;
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/** The launch line install prints: OpenClaw with this project as its agent workspace. */
export function ocLaunch(projectRoot: string): string {
  const dir = /^[\w\/.@+-]+$/.test(projectRoot) ? projectRoot : JSON.stringify(projectRoot);
  return `OPENCLAW_WORKSPACE_DIR=${dir} openclaw gateway run   (or: ... openclaw agent --local)`;
}

function ocPluginSource(pkgRoot: string): string {
  const hook = JSON.stringify(path.join(pkgRoot, "hook.js"));
  return `${OC_MARKER}
/**
 * BackUpper plugin for OpenClaw, written by \`backupper install openclaw\` (regenerated on install).
 *
 * Each tool call is sent to the BackUpper Node hooks as Claude Code hook JSON, run in the
 * workspace this plugin lives in. A tier-1 rewrite is returned as the params rewrite. Messages the pre-tool hook addresses to the agent are added to the next
 * prompt.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOOK = ${hook};
const NO_HOOK_ENV = "BACKUPPER_NO_HOOK";
// Above the tier-4 subagent timeout, so a capture in progress is never cut off here.
const TIMEOUT_MS = 600_000;

// OpenClaw tool names mapped to the names the hooks key their rules on.
const NAME_MAP = { exec: "Bash", write: "Write", edit: "Edit", apply_patch: "Edit", read: "Read" };

const pendingContext = [];

/** Pipe one payload into a hook (pre, post or prompt) and resolve its JSON output, or null. */
function run(root, hook, payload, extraEnv = {}) {
  if (process.env[NO_HOOK_ENV] === "1") return Promise.resolve(null); // inside a BackUpper subagent
  if (!existsSync(HOOK)) {
    console.warn(\`backupper: hook missing: \${HOOK} (reinstall with: backupper install openclaw)\`);
    return Promise.resolve(null);
  }
  const env = { ...process.env, ...extraEnv };
  delete env[NO_HOOK_ENV];
  return new Promise((resolve) => {
    const child = spawn("node", [HOOK, hook, "--agent", "openclaw"], { cwd: root, env, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", (e) => { clearTimeout(timer); console.warn(\`backupper: hook failed (\${hook}): \${e.message}\`); resolve(null); });
    child.on("close", () => {
      clearTimeout(timer);
      try { resolve(out.trim() ? JSON.parse(out) : null); } catch { resolve(null); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function toolInput(toolName, params) {
  const input = { ...params };
  if ((toolName === "write" || toolName === "edit") && typeof input.path === "string") input.file_path ??= input.path;
  return input;
}

function approvalDefaults() {
  const dir = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
  try { return JSON.parse(readFileSync(path.join(dir, "exec-approvals.json"), "utf-8")).defaults ?? {}; } catch { return {}; }
}

/**
 * OpenClaw applies its exec policy inside the exec tool, after this hook. Report
 * "bypassPermissions" exactly when that policy runs every command without asking
 * (security=full and ask=off in the config, the approvals defaults and the call itself).
 * Otherwise "default": BackUpper then executes nothing in the hook and prepends its copies to
 * the command, so a denied command changes nothing.
 */
function permissionMode(config, params) {
  const exec = config?.tools?.exec ?? {};
  const approvals = approvalDefaults();
  const security = [exec.security, approvals.security, params.security];
  const ask = [exec.ask, approvals.ask, params.ask];
  const open = security.every((v) => v === undefined || v === "full") && ask.every((v) => v === undefined || v === "off");
  return open ? "bypassPermissions" : "default";
}

/** Where exec runs when it is not this machine (a sandbox container or a paired node). */
function execTarget(config, params) {
  const host = params.host ?? config?.tools?.exec?.host ?? "auto";
  if (host === "sandbox" || host === "node") return host;
  const sandbox = config?.agents?.defaults?.sandbox?.mode;
  return host === "auto" && sandbox && sandbox !== "off" ? "sandbox" : "";
}

export default {
  id: "backupper",
  name: "BackUpper",
  description: "Captures what a tool call is about to destroy before it runs.",
  register(api) {
    // <workspace>/.openclaw/extensions/backupper
    const root = path.resolve(api.rootDir ?? path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");

    api.on("before_tool_call", async (event, ctx) => {
      const mapped = NAME_MAP[event.toolName] ?? event.toolName;
      const target = mapped === "Bash" ? execTarget(api.config, event.params) : "";
      const out = (await run(root, "pre", {
        hook_event: "PreToolUse",
        tool_name: mapped,
        tool_input: toolInput(event.toolName, event.params),
        session_id: ctx.sessionId ?? ctx.sessionKey ?? "",
        tool_use_id: event.toolCallId ?? "",
        cwd: root,
        permission_mode: permissionMode(api.config, event.params),
      }, target ? { BACKUPPER_EXEC_TARGET: target } : {})) ?? {};
      const hso = out.hookSpecificOutput ?? {};
      if (typeof hso.additionalContext === "string" && hso.additionalContext.trim()) {
        pendingContext.push(hso.additionalContext.trim());
      }
      const update = hso.updatedInput;
      if (update && typeof update === "object") {
        const params = { ...event.params };
        for (const [k, v] of Object.entries(update)) if (k in params) params[k] = v;
        return { params };
      }
    }, { timeoutMs: TIMEOUT_MS });

    api.on("after_tool_call", async (event, ctx) => {
      await run(root, "post", {
        hook_event: "PostToolUse",
        tool_name: NAME_MAP[event.toolName] ?? event.toolName,
        tool_input: toolInput(event.toolName, event.params ?? {}),
        tool_output: event.error ? { error: event.error } : event.result,
        session_id: ctx.sessionId ?? ctx.sessionKey ?? "",
        tool_use_id: event.toolCallId ?? "",
        cwd: root,
      });
    }, { timeoutMs: TIMEOUT_MS });

    api.on("before_prompt_build", async (event, ctx) => {
      const out = (await run(root, "prompt", {
        hook_event: "UserPromptSubmit",
        prompt: typeof event.currentUserMessage === "string" ? event.currentUserMessage : event.prompt ?? "",
        session_id: ctx.sessionId ?? ctx.sessionKey ?? "",
      })) ?? {};
      const parts = [];
      const extra = out.hookSpecificOutput?.additionalContext;
      if (typeof extra === "string" && extra.trim()) parts.push(extra.trim());
      parts.push(...pendingContext.splice(0));
      return parts.length ? { prependContext: parts.join("\\n\\n") } : undefined;
    });
  },
};
`;
}

export const openclawAdapter: AgentAdapter = {
  name: "openclaw",
  description: "OpenClaw (workspace plugin in .openclaw/extensions/backupper/, with OPENCLAW_WORKSPACE_DIR)",
  bin: "openclaw",
  runner: "claude",
  canRewrite: CAN_REWRITE["openclaw"],

  hookStatus(projectRoot: string): HookStatus {
    let scripts: string[] = [];
    try {
      const src = fs.readFileSync(path.join(projectRoot, OC_PLUGIN_DIR, "index.js"), "utf-8");
      if (src.startsWith(OC_MARKER)) {
        scripts = [...src.matchAll(/^const HOOK = ("[^"]+");$/gm)].map((m) => JSON.parse(m[1]));
      }
    } catch { /* not installed */ }
    return { installed: scripts.length > 0, location: OC_PLUGIN_DIR, hookScripts: scripts };
  },

  install(projectRoot: string, pkgRoot: string): AgentInstallResult {
    const dir = path.join(projectRoot, OC_PLUGIN_DIR);
    fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, "package.json"), {
      name: "backupper-openclaw", private: true, type: "module", openclaw: { extensions: ["./index.js"] },
    });
    writeJson(path.join(dir, "openclaw.plugin.json"), {
      id: OC_PLUGIN_ID, name: "BackUpper", activation: { onStartup: true },
      configSchema: { type: "object", additionalProperties: false },
    });
    fs.writeFileSync(path.join(dir, "index.js"), ocPluginSource(pkgRoot), "utf-8");
    const log = [`Plugin written to ${OC_PLUGIN_DIR}/`];
    const failed = OC_CONFIG.filter(([key, value]) => !openclaw(projectRoot, ["config", "set", key, value])?.ok);
    if (failed.length === 0) {
      log.push("OpenClaw config: plugin enabled");
    } else {
      log.push(
        "Could not update the OpenClaw config (is `openclaw` on PATH?). Run:",
        ...failed.map(([key, value]) => `  openclaw config set ${key} ${JSON.stringify(value)}`),
      );
    }
    log.push(`Start OpenClaw with this project as its workspace: ${ocLaunch(projectRoot)}`);
    return { log };
  },

  uninstall(projectRoot: string): AgentInstallResult {
    const dir = path.join(projectRoot, OC_PLUGIN_DIR);
    let ours = false;
    try { ours = fs.readFileSync(path.join(dir, "index.js"), "utf-8").startsWith(OC_MARKER); } catch { /* absent */ }
    if (!ours) return { log: [] };
    for (const f of ["index.js", "package.json", "openclaw.plugin.json"]) fs.rmSync(path.join(dir, f), { force: true });
    removeEmptyDirs(dir, projectRoot);
    const log = [`Removed ${OC_PLUGIN_DIR}/`];
    if (openclaw(projectRoot, ["config", "unset", `plugins.entries.${OC_PLUGIN_ID}`])?.ok) log.push("OpenClaw config: plugin entry removed");
    else log.push("To finish, run:", `  openclaw config unset plugins.entries.${OC_PLUGIN_ID}`);
    return { log };
  },
};

// =============================================================================
// ── index ──
// =============================================================================

/**
 * Agent adapter registry: each supported agent provides its own install/uninstall recipe and
 * reports whether its hooks are in place.
 */

export interface AgentInstallResult {
  /** Lines printed by the CLI. */
  log: string[];
}

export interface HookStatus {
  /** True when at least one BackUpper hook is registered for this agent in the project. */
  installed: boolean;
  /** The agent config file (or plugin directory) the hooks live in, project-relative. */
  location: string;
  /** Script paths the registered hook commands point at. */
  hookScripts: string[];
}

export interface AgentAdapter {
  /** Canonical name, used by `backupper install <name>`. */
  name: string;
  /** Short description for --help. */
  description: string;
  /** The agent's CLI executable. */
  bin: string;
  /** The CLI that runs the tier-4 subagent when this agent is the host. */
  runner: SubagentRunnerName;
  /**
   * The host applies a hook's rewritten tool input (`updatedInput`). When false, tier 1 runs
   * in backup-only mode (see the capabilities section above).
   */
  canRewrite: boolean;
  hookStatus(projectRoot: string): HookStatus;
  /** Wire hooks for this agent; `pkgRoot` is the installed dist/ directory. */
  install(projectRoot: string, pkgRoot: string): AgentInstallResult;
  /** Remove everything install() wrote into the agent's configuration. */
  uninstall(projectRoot: string): AgentInstallResult;
}


export const ALL_ADAPTERS: AgentAdapter[] = [
  claudeCodeAdapter, codexAdapter, hermesAdapter, openhandsAdapter, deepseekHarnessAdapter, openclawAdapter,
];

/** Accepted spellings for each agent on the command line. */
const ALIASES: Record<string, string> = {
  claude: "claude-code", "claude-code": "claude-code", codex: "codex", hermes: "hermes", openhands: "openhands",
  "deepseek-harness": "deepseek-harness", deepseek: "deepseek-harness", dsh: "deepseek-harness", openclaw: "openclaw",
};

export function findAdapter(name: string): AgentAdapter | undefined {
  const canonical = ALIASES[name] ?? name;
  return ALL_ADAPTERS.find((a) => a.name === canonical);
}

/** Adapters whose hooks are installed in the project. */
export function installedAdapters(projectRoot: string): AgentAdapter[] {
  return ALL_ADAPTERS.filter((a) => a.hookStatus(projectRoot).installed);
}

/** The hook.js subcommands an agent's hooks run. */
export type HookName = "pre" | "post" | "prompt";

/**
 * The hook command an agent runs: node on the absolute path of hook.js, the hook's
 * subcommand, tagged with the host agent.
 */
export function hookCommand(pkgRoot: string, hook: HookName, agent: string): string {
  return `node "${path.join(pkgRoot, "hook.js")}" ${hook} --agent ${agent}`;
}

/**
 * True for a hook command written by this package: `hook.js <hook>`, `backupper hook <hook>`, or
 * the `hooks/<hook>.js` form of older installs (so that reinstall and uninstall replace them).
 */
export function isOurCommand(cmd: unknown): boolean {
  return typeof cmd === "string" &&
    (/[\\/]hook\.js"?\s+(pre|post|prompt)\s+--agent\s+[a-z-]+/.test(cmd) ||
      /^backupper\s+hook\s+(pre|post|prompt)\s+--agent\s+[a-z-]+/.test(cmd) ||
      /[\\/]hooks[\\/](pre-tool|post-tool|user-prompt)\.js"?\s+--agent\s+[a-z-]+/.test(cmd));
}

/** The script path inside one of our hook commands. */
export function scriptOf(cmd: string): string {
  const m = cmd.match(/node\s+"([^"]+)"|node\s+(\S+)/);
  return m ? (m[1] ?? m[2]) : cmd;
}

/** Read a JSON object file; empty object when absent. Throws on a file that does not parse. */
export { readJsonObject, writeJson };

/** Remove `dir` and then its parents up to (not including) `stopAt`, while each is empty. */
export function removeEmptyDirs(dir: string, stopAt: string): void {
  let cur = path.resolve(dir);
  const stop = path.resolve(stopAt);
  while (cur.startsWith(stop + path.sep)) {
    try {
      if (fs.readdirSync(cur).length > 0) return;
      fs.rmdirSync(cur);
    } catch {
      return;
    }
    cur = path.dirname(cur);
  }
}

/** Add `.backupper/` to an existing .gitignore (idempotent); never creates the file. */
export function ignoreStore(projectRoot: string): string | null {
  const p = path.join(projectRoot, ".gitignore");
  if (!fs.existsSync(p)) return null;
  const content = fs.readFileSync(p, "utf-8");
  if (/^\s*\/?\.backupper\/?\s*$/m.test(content)) return null;
  const prefix = content && !content.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(p, `${prefix}.backupper/\n`);
  return "Added .backupper/ to .gitignore";
}
