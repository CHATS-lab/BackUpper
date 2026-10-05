/**
 * Agent adapters: per-host capabilities, the Claude Code, Codex and Hermes install/uninstall
 * recipes, and the adapter registry with the shared hook-command helpers.
 */

import * as fs from "node:fs";
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
 * Claude Code does; the Hermes plugin copies it into the live call arguments before dispatch;
 * Codex does when the same output also carries `permissionDecision: "allow"` (the pre-tool hook
 * adds it for Codex only; Codex still applies its approval policy and sandbox to the rewritten
 * command). On a host that cannot rewrite, tier 1 runs in
 * backup-only mode: it captures a restorable copy and executes nothing itself, so the host's
 * own run of the command is the only one.
 */

export const CAN_REWRITE: Readonly<Record<string, boolean>> = {
  "claude-code": true,
  hermes: true,
  codex: true,
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
 *   bypass / full-auto permission mode, or when the host does not report a mode at all
 *   (older hosts and plugins; unchanged behaviour).
 * - "chain": the hook executes nothing; it returns `<copy commands> && <original command>`, so
 *   the host's own deny rules, exec policy and approval dialog still see (and can stop) the
 *   original command, and a failed copy stops it via `&&`.
 * - "backup-only": capture in the hook, never rewrite (BACKUPPER_NO_REWRITE=1, unknown host).
 */
export type Tier1Mode = "rewrite" | "chain" | "backup-only";

export function tier1Mode(
  permissionMode: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Tier1Mode {
  if (!tier1CanRewrite(env)) return "backup-only";
  if (env.BACKUPPER_NO_REWRITE === "0") return "rewrite";
  if (!permissionMode || permissionMode === "bypassPermissions") return "rewrite";
  return "chain";
}

/**
 * The command that runs chain-mode copies: `node <dist>/hook.js capture`, with the path
 * double-quoted only when it needs quoting. `backupper install claude-code` allows exactly this
 * prefix (`Bash(<prefix>:*)`), so the copies need no approval of their own.
 */
export function captureCommandPrefix(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const p = require("node:path").join(__dirname, "hook.js") as string;
  return /^[\w\/.@+-]+$/.test(p) ? `node ${p} capture` : `node "${p}" capture`;
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

/**
 * Chain mode (a non-bypass permission mode) prepends `node <dist>/hook.js capture <copies> &&`
 * to a destructive command. Claude Code checks that segment on its own; this rule lets it run
 * without a prompt. The script only copies into a trash folder the hook has just recorded.
 */
function captureAllowRule(): string {
  return `Bash(${captureCommandPrefix()}:*)`;
}
function isCaptureAllowRule(r: unknown): boolean {
  // The current form (hook.js capture), and the hooks/capture.js form of older installs.
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
    const pkgDir = path.resolve(pkgRoot, "..", "claude-plugin");
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
// ── hermes ──
// =============================================================================

/**
 * Hermes adapter: installs a directory plugin at `.hermes/plugins/backupper/` whose
 * pre_tool_call / post_tool_call / pre_llm_call hooks forward each call to the Node hooks in the
 * Claude Code JSON shape. Hermes loads project plugins only when HERMES_ENABLE_PROJECT_PLUGINS=1.
 */

const PLUGIN_DIR = path.join(".hermes", "plugins", "backupper");
const MARKER = "# backupper-plugin";

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
applied to the live args dict; a deny rewrites a terminal command into a failing no-op. Messages
the pre-tool hook addresses to the agent are delivered at the next model call. The
/backupper-panel slash command toggles the side panel without a model turn.
"""

from __future__ import annotations

import json
import logging
import os
import shlex
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
    if hso.get("permissionDecision") == "deny":
        reason = str(hso.get("permissionDecisionReason") or "blocked by BackUpper")
        if mapped == "Bash" and "command" in args:
            args["command"] = "echo " + shlex.quote(reason) + " >&2; exit 1"
        else:
            logger.warning("backupper: cannot block %s on Hermes: %s", mapped, reason)


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
  description: "Hermes (plugin in .hermes/plugins/backupper/)",
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
    return {
      log: [
        `Plugin written to ${PLUGIN_DIR}/`,
        "Hermes loads project plugins only with HERMES_ENABLE_PROJECT_PLUGINS=1 in its environment.",
      ],
    };
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
    return { log: [`Removed ${PLUGIN_DIR}/`] };
  },
};

// =============================================================================
// ── index ──
// =============================================================================

/**
 * Agent adapter registry: each supported agent (Claude Code, Codex, Hermes) provides its own
 * install/uninstall recipe and reports whether its hooks are in place.
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


export const ALL_ADAPTERS: AgentAdapter[] = [claudeCodeAdapter, codexAdapter, hermesAdapter];

/** Accepted spellings for each agent on the command line. */
const ALIASES: Record<string, string> = { claude: "claude-code", "claude-code": "claude-code", codex: "codex", hermes: "hermes" };

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
 * True for a hook command written by this package: the current `hook.js <hook>` form, or
 * the `hooks/<hook>.js` form of older installs (so that reinstall and uninstall replace them).
 */
export function isOurCommand(cmd: unknown): boolean {
  return typeof cmd === "string" &&
    (/[\\/]hook\.js"?\s+(pre|post|prompt)\s+--agent\s+[a-z-]+/.test(cmd) ||
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
