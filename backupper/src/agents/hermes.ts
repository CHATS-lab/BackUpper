/**
 * Hermes adapter.
 *
 * Hermes scans `~/.hermes/plugins/*.py` and `<project>/.hermes/plugins/*.py`
 * on ToolRegistry init. Each plugin defines `attach(registry)` and
 * registers pre/post hooks. We write one file: a plugin that shells
 * out to our Node hooks (same JSON contract used by Claude Code's
 * hook system), preserving full reuse of the tier-0..3 backup logic.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentAdapter, AgentInstallResult } from "./index.js";
import { appendGitignore } from "./index.js";
import { saveConfig, getConfigDir } from "../config/load.js";
import { DEFAULT_CONFIG } from "../types.js";

const PLUGINS_DIR = ".hermes/plugins";
const PLUGIN_FILENAME = "chats_sandbox.py";

function pluginSource(pkgRoot: string): string {
  const preToolJs  = JSON.stringify(path.join(pkgRoot, "hooks", "pre-tool.js"));
  const postToolJs = JSON.stringify(path.join(pkgRoot, "hooks", "post-tool.js"));
  return `"""CHATS-Sandbox plugin for Hermes.

Installed by \`chats-sandbox install hermes\`. Do not edit by hand —
the file is regenerated on every \`install\`.

When Hermes's ToolRegistry boots, this plugin's attach(registry) is
called. We register pre+post hooks that shell out to the same Node
hooks Claude Code uses (dist/hooks/pre-tool.js and post-tool.js),
so tier-0 / tier-1 / tier-2 / tier-3 backup logic is fully reused
across agents.

The JSON contract we send on stdin mirrors Claude Code's PreToolUse /
PostToolUse hook input shape:

    {
      "hook_event": "PreToolUse" | "PostToolUse",
      "tool_name": <str>,
      "tool_input": <dict>,
      "tool_output": <any>           # only on PostToolUse
    }
"""

from __future__ import annotations

import json
import logging
import subprocess
import os

logger = logging.getLogger(__name__)

_PRE_TOOL_HOOK  = ${preToolJs}
_POST_TOOL_HOOK = ${postToolJs}

# Recursion guard env var. CHATS_SANDBOX_NO_HOOK=1 tells the Node hook
# "you're inside a chats-sandbox-spawned subagent, exit early." We
# honor it on the way IN (skip firing if Hermes was itself launched
# inside a backup subagent) and clear it on the way OUT (the hook
# we're about to run isn't a subagent, it's a real top-level hook).
_NO_HOOK_ENV = "CHATS_SANDBOX_NO_HOOK"


def _run_hook(hook_path: str, payload: dict) -> dict | None:
    """Pipe JSON into the Node hook; return its parsed JSON output.

    The pre-tool hook's stdout matters: tier-0 policy rules execute the
    destructive command themselves (e.g. rm -> mv to trash) and return
    hookSpecificOutput.updatedInput with the command rewritten to a
    no-op. The caller applies that rewrite to the live args dict so the
    agent doesn't run the destructive command a second time.

    The timeout must be GENEROUS — a tier-3 subagent that scrapes
    remote state (e.g. a Hermes subagent driving Playwright MCP) can
    legitimately take 1-3 minutes. It must stay larger than
    config.subagentTimeoutSeconds, otherwise this wrapper kills the
    Node hook mid-backup and the artifact is lost. Past the cap we
    move on rather than block tool execution forever.
    """
    if os.environ.get(_NO_HOOK_ENV) == "1":
        return None
    if not os.path.exists(hook_path):
        # Plugin installed but Node hooks missing — log once and skip.
        logger.warning("chats-sandbox hook missing: %s", hook_path)
        return None
    # IMPORTANT: do NOT propagate CHATS_SANDBOX_NO_HOOK=1 into the
    # hook's own env. That flag is meant for subagents spawned BY the
    # hook (tier-3) — setting it here would make the hook itself exit
    # early and no backup would ever happen. Strip if present.
    child_env = {k: v for k, v in os.environ.items() if k != _NO_HOOK_ENV}
    try:
        proc = subprocess.run(
            ["node", hook_path],
            input=json.dumps(payload).encode("utf-8"),
            timeout=600.0,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
            env=child_env,
        )
        out = (proc.stdout or b"").decode("utf-8", "replace").strip()
        if out:
            try:
                return json.loads(out)
            except Exception:
                return None
        return None
    except Exception as e:
        logger.warning("chats-sandbox hook failed (%s): %s", hook_path, e)
        return None


# Set by attach(). Used to detect MCP tools so their names can be
# normalized — see _normalize_tool_name.
_registry = None


def _toolset_of(tool_name: str):
    """Return the registry toolset name for a tool, or '' if unknown."""
    reg = _registry
    if reg is None:
        return ""
    # Prefer the public-ish accessor; fall back to the _tools dict.
    getter = getattr(reg, "get_toolset_for_tool", None)
    if callable(getter):
        try:
            ts = getter(tool_name)
            if ts:
                return str(ts)
        except Exception:
            pass
    try:
        entry = getattr(reg, "_tools", {}).get(tool_name)
        if entry is not None:
            return str(getattr(entry, "toolset", "") or "")
    except Exception:
        pass
    return ""


def _normalize_tool_name(tool_name: str) -> str:
    """Map a Hermes MCP tool name to the mcp__<server>__<tool> form the
    Node hooks expect.

    Two remote-state cases get normalized:

      1. MCP tools — Hermes registers these under a toolset named
         'mcp-<server>' (tools/mcp_tool.py: toolset_name = f"mcp-{name}").

      2. Hermes's built-in 'browser' toolset — web automation whose
         browser_* tools mutate remote page state exactly like a
         Playwright MCP would. Same risk profile, so it gets the same
         tier-3 treatment.

    The CHATS-Sandbox hooks key tier-3 (remote-state) detection on the
    Claude-Code 'mcp__' double-underscore prefix; without this rewrite
    those actions never trigger the tier-3 subagent on Hermes.

    Non-remote tools fall through to _BUILTIN_NAME_MAP below.
    """
    toolset = _toolset_of(tool_name)
    server = None
    for sep in ("mcp-", "mcp_"):
        if toolset.startswith(sep):
            server = toolset[len(sep):]
            break
    # Built-in browser automation toolset → treat as a remote namespace.
    if not server and toolset == "browser":
        server = "browser"
    if not server:
        return tool_name
    # Strip a redundant mcp_<server>_ / mcp__<server>__ prefix that some
    # Hermes versions bake into the tool name itself, then re-wrap in
    # the canonical double-underscore form.
    bare = tool_name
    for pre in (f"mcp__{server}__", f"mcp_{server}_"):
        if bare.startswith(pre):
            bare = bare[len(pre):]
            break
    normalized = f"mcp__{server}__{bare}"
    if normalized != tool_name:
        logger.debug("chats-sandbox: normalized %s -> %s (toolset=%s)",
                     tool_name, normalized, toolset)
    return normalized


# Hermes built-in tool names → the Claude-Code names the Node hooks key
# their logic on. Without this every tier-0 rule (which matches
# toolName "Bash"/"Write") is dead on Hermes, read-only calls
# (read_file/search_files) create noise actions, and outside-workspace
# Bash detection never fires.
_BUILTIN_NAME_MAP = {
    "terminal": "Bash",
    "write_file": "Write",
    "patch": "Edit",
    "read_file": "Read",
    "search_files": "Grep",
}


def _hook_payload_input(tool_name: str, args: dict) -> dict:
    """Build the tool_input for the hook payload.

    Hermes's write_file/patch use "path" where Claude Code uses
    "file_path" — mirror it so path-keyed logic (outside-workspace
    Write rule, file labels) sees the expected key. The copy never
    mutates the live args dict.
    """
    payload = dict(args)
    if tool_name in ("write_file", "patch") and "path" in payload:
        payload.setdefault("file_path", payload["path"])
    return payload


def _pre_hook(tool_name: str, args: dict) -> None:
    mapped = _normalize_tool_name(tool_name)
    if mapped == tool_name:
        mapped = _BUILTIN_NAME_MAP.get(tool_name, tool_name)
    out = _run_hook(_PRE_TOOL_HOOK, {
        "hook_event": "PreToolUse",
        "tool_name": mapped,
        "tool_input": _hook_payload_input(tool_name, args),
    })
    # Tier-0 run-and-rewrite: the hook already executed the destructive
    # command reversibly and rewrote the input. Hermes pre-hooks share the
    # args dict with the tool handler, so applying the rewrite here is what
    # stops the original from running a second time. ALL updatedInput keys
    # are applied (today's tier-0 rules only ever rewrite "command", but the
    # hook contract allows any key — dropping the rest would silently
    # diverge from the Claude Code adapter, which applies the whole object).
    # Only keys already present in args are touched: the hook rewrites
    # existing inputs, it does not invent new parameters for the tool.
    try:
        hso = (out or {}).get("hookSpecificOutput", {}) or {}
        upd = hso.get("updatedInput")
        if isinstance(upd, dict):
            for k, v in upd.items():
                if k in args and args[k] != v:
                    logger.debug("chats-sandbox: tier-0 rewrite %s: %r -> %r",
                                 k, args[k], v)
                    args[k] = v
        # SURFACE backup feedback. The Node hook reports a failed / UNVERIFIED
        # / needed tier-3 backup via additionalContext, and a deny decision via
        # permissionDecision. The Hermes plugin API cannot inject context into
        # the agent's turn or block the tool, so at minimum LOG it at WARNING —
        # otherwise a destructive action whose backup FAILED (or that we wanted
        # to deny) proceeds with no signal anywhere. (Claude Code / Cursor get
        # this natively via additionalContext / permission:deny.)
        ctx = hso.get("additionalContext")
        if isinstance(ctx, str) and ctx.strip():
            logger.warning("chats-sandbox: %s", ctx.strip())
        if hso.get("permissionDecision") == "deny":
            logger.warning("chats-sandbox: hook requested DENY of %s but the "
                           "Hermes plugin cannot block a tool call — it will "
                           "run. Reason: %s", mapped,
                           hso.get("permissionDecisionReason", "(none)"))
    except Exception:
        pass  # never block the tool


def _post_hook(tool_name: str, args: dict, result: str) -> None:
    mapped = _normalize_tool_name(tool_name)
    if mapped == tool_name:
        mapped = _BUILTIN_NAME_MAP.get(tool_name, tool_name)
    # The post hook also accepts hook_event="PostToolUseFailure" — but
    # Hermes's dispatch swallows tool errors into a JSON error string
    # and still returns a result, so we always send PostToolUse.
    _run_hook(_POST_TOOL_HOOK, {
        "hook_event": "PostToolUse",
        "tool_name": mapped,
        "tool_input": _hook_payload_input(tool_name, args),
        "tool_output": result,
    })


def attach(registry) -> None:
    """Hermes calls this at ToolRegistry init time."""
    global _registry
    _registry = registry
    registry.add_pre_hook(_pre_hook)
    registry.add_post_hook(_post_hook)
    logger.info("chats-sandbox plugin attached")
`;
}

export const hermesAdapter: AgentAdapter = {
  name: "hermes",
  description: "Hermes agent (via .hermes/plugins/chats_sandbox.py)",

  detectInstalled(projectRoot: string): boolean {
    // Detect a hermes project by either an installed plugin dir or
    // a hermes-shaped config we'd recognize. Plugin dir alone is the
    // strongest signal a user has wired Hermes here.
    return fs.existsSync(path.join(projectRoot, PLUGINS_DIR));
  },

  install(projectRoot: string, pkgRoot: string): AgentInstallResult {
    const log: string[] = [];

    // Ensure the plugins dir + write the plugin file.
    const pluginsDir = path.join(projectRoot, PLUGINS_DIR);
    fs.mkdirSync(pluginsDir, { recursive: true });
    const pluginFile = path.join(pluginsDir, PLUGIN_FILENAME);
    fs.writeFileSync(pluginFile, pluginSource(pkgRoot), "utf-8");

    // Sandbox config + backup dir. The tier-3 subagent runs as a
    // headless `hermes chat` subagent (not `claude -p`), so a Hermes
    // deployment with no Claude CLI still gets working out-of-workspace
    // / remote-state backup. The subagent's provider API key is read
    // from the environment at run time — never written to config.
    const configDir = getConfigDir(projectRoot);
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    const hermesConfig = {
      ...DEFAULT_CONFIG,
      subagentRunner: "hermes" as const,
      subagentHermesModel: "anthropic/claude-haiku-4.5",
      subagentHermesProvider: "openrouter",
    };
    saveConfig(hermesConfig, projectRoot);

    appendGitignore(projectRoot, ".chats-sandbox/");

    log.push("CHATS-Sandbox installed successfully for Hermes!");
    log.push(`  Plugin written to ${PLUGINS_DIR}/${PLUGIN_FILENAME}`);
    log.push(`  Config at ${configDir}/config.json`);
    log.push(`  Backups will be stored in ${DEFAULT_CONFIG.backupDir}/`);
    log.push("");
    log.push("On the next Hermes session, ToolRegistry will auto-load");
    log.push("this plugin and wrap every tool call with backup hooks.");
    log.push("");
    log.push("Tier-3 (out-of-workspace / remote) backup runs a headless");
    log.push(`Hermes subagent: ${hermesConfig.subagentHermesModel}`);
    log.push(`via ${hermesConfig.subagentHermesProvider}. It needs:`);
    log.push("  - the `hermes` CLI on PATH");
    log.push("  - a provider API key in the environment (e.g.");
    log.push("    OPENROUTER_API_KEY) — inherited from the Hermes process.");
    log.push("Change the subagent model/provider with:");
    log.push("  chats-sandbox config set subagentHermesModel <id>");
    log.push("  chats-sandbox config set subagentHermesProvider <name>");
    log.push("");
    log.push("To check backup state: chats-sandbox status");
    log.push("To view timeline:      chats-sandbox dashboard");
    log.push("To disable:            chats-sandbox uninstall hermes");
    return { log };
  },

  uninstall(projectRoot: string): AgentInstallResult {
    const log: string[] = [];
    const pluginFile = path.join(projectRoot, PLUGINS_DIR, PLUGIN_FILENAME);
    if (fs.existsSync(pluginFile)) {
      fs.unlinkSync(pluginFile);
      log.push(`  Removed ${PLUGINS_DIR}/${PLUGIN_FILENAME}`);
    }
    // Don't delete .hermes/plugins/ itself — user might have other plugins.
    log.push("CHATS-Sandbox uninstalled from Hermes.");
    log.push("  Config and backups left in .chats-sandbox/ (delete manually if desired)");
    return { log };
  },
};
