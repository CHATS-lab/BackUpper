/**
 * Hermes adapter: installs a directory plugin at `.hermes/plugins/backupper/` whose
 * pre_tool_call / post_tool_call / pre_llm_call hooks forward each call to the Node hooks in the
 * Claude Code JSON shape. Hermes loads project plugins only when HERMES_ENABLE_PROJECT_PLUGINS=1.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CAN_REWRITE } from "./capabilities.js";
import type { AgentAdapter, AgentInstallResult, HookStatus } from "./index.js";
import { removeEmptyDirs } from "./index.js";

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
  const hook = (name: string) => JSON.stringify(path.join(pkgRoot, "hooks", `${name}.js`));
  return `${MARKER}
"""BackUpper plugin for Hermes, written by \`backupper install hermes\` (regenerated on install).

Each tool call is sent to the BackUpper Node hooks as Claude Code hook JSON. A tier-1 rewrite is
applied to the live args dict; a deny rewrites a terminal command into a failing no-op. Messages
the pre-tool hook addresses to the agent are delivered at the next model call.
"""

from __future__ import annotations

import json
import logging
import os
import shlex
import subprocess

logger = logging.getLogger(__name__)

_PRE_TOOL = ${hook("pre-tool")}
_POST_TOOL = ${hook("post-tool")}
_USER_PROMPT = ${hook("user-prompt")}
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


def _run(script: str, payload: dict) -> dict | None:
    """Pipe one payload into a hook and return its JSON output, or None."""
    if os.environ.get(_NO_HOOK_ENV) == "1":
        return None  # inside a BackUpper subagent
    if not os.path.exists(script):
        logger.warning("backupper: hook missing: %s (reinstall with: backupper install hermes)", script)
        return None
    env = {k: v for k, v in os.environ.items() if k != _NO_HOOK_ENV}
    try:
        proc = subprocess.run(
            ["node", script, "--agent", "hermes"],
            input=json.dumps(payload).encode("utf-8"),
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            timeout=_TIMEOUT_SEC, check=False, env=env,
        )
        out = (proc.stdout or b"").decode("utf-8", "replace").strip()
        return json.loads(out) if out else None
    except Exception as e:
        logger.warning("backupper: hook failed (%s): %s", script, e)
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


def _pre_tool(tool_name: str = "", args: dict | None = None, session_id: str = "",
              tool_call_id: str = "", **_: object) -> None:
    if args is None:
        return
    mapped = _hook_name(tool_name)
    out = _run(_PRE_TOOL, {
        "hook_event": "PreToolUse",
        "tool_name": mapped,
        "tool_input": _tool_input(tool_name, args),
        "session_id": session_id,
        "tool_use_id": tool_call_id,
        "cwd": os.getcwd(),
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
    _run(_POST_TOOL, {
        "hook_event": "PostToolUse",
        "tool_name": _hook_name(tool_name),
        "tool_input": _tool_input(tool_name, args or {}),
        "tool_output": result,
        "session_id": session_id,
        "tool_use_id": tool_call_id,
        "cwd": os.getcwd(),
    })


def _pre_llm(session_id: str = "", user_message: object = None, **_: object) -> dict | None:
    out = _run(_USER_PROMPT, {
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


def register(ctx) -> None:
    ctx.register_hook("pre_tool_call", _pre_tool)
    ctx.register_hook("post_tool_call", _post_tool)
    ctx.register_hook("pre_llm_call", _pre_llm)
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
        scripts = [...src.matchAll(/^_(?:PRE_TOOL|POST_TOOL|USER_PROMPT) = "([^"]+)"$/gm)].map((m) => JSON.parse(`"${m[1]}"`));
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
