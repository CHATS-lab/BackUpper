/**
 * OpenHands adapter.
 *
 * The OpenHands Agent SDK ships a Claude-Code-style hook system: a
 * `.openhands/hooks.json` with `PreToolUse` / `PostToolUse` entries,
 * each a `command` that receives the lifecycle event as JSON on stdin.
 * We write that file pointing at the same Node hooks every other agent
 * uses — no source patch needed.
 *
 * The SDK's event JSON uses `event_type` / `tool_response` where Claude
 * Code uses `hook_event` / `tool_output`; `normalizeHookContext` in the
 * Node hooks accepts both, so one hook binary serves every agent. It
 * also owns the OpenHands tool-name mapping (OPENHANDS_TOOL_MAP:
 * terminal→Bash, file_editor→Edit, …) and the path→file_path mirror —
 * unlike Hermes/OpenClaw, whose plugins map names before calling the
 * hooks, the raw SDK payload is normalized centrally, keyed on its
 * `event_type` dialect. Browser tools arrive under BARE names
 * (browser_click, no mcp__ prefix) and the gate accepts those directly
 * (strategies.ts isBareBrowserTool / isReadOnlyMcpTool). Non-browser
 * MCP tools ALSO arrive bare (the SDK's MCPToolDefinition.name is the
 * raw mcp_tool.name — no server prefix, and the payload carries no
 * server field), which the gate would NOT match — the shim rewrites
 * them to mcp__<server>__<tool> using the CHATS_SANDBOX_MCP_TOOLMAP
 * env (JSON tool→server map) supplied by whoever wires the MCP config.
 *
 * The hooks.json commands point at a generated shim
 * (.openhands/chats-sandbox-hook.cjs) rather than the Node hooks
 * directly: the SDK honors allow/deny (exit 2 = deny) but has no
 * channel for hookSpecificOutput.additionalContext and cannot apply
 * updatedInput, so the shim mirrors backup feedback to stderr and
 * disables tier-0 rewriting — see hookShimSource for the contract.
 *
 * Note: the SDK's `Conversation` does not auto-load hooks.json — the
 * caller passes `hook_config=HookConfig.load(working_dir=...)`. The
 * install output explains this.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentAdapter, AgentInstallResult } from "./index.js";
import { appendGitignore } from "./index.js";
import { saveConfig, getConfigDir } from "../config/load.js";
import { DEFAULT_CONFIG } from "../types.js";
import { isCommandAvailable } from "../backup/subagent.js";

const HOOKS_DIR = ".openhands";
const HOOKS_FILE = "hooks.json";
const SHIM_FILENAME = "chats-sandbox-hook.cjs";
const HOOK_TIMEOUT = 600;

interface HookEntry { command: string; timeout?: number }
interface HookMatcher { matcher: string; hooks: HookEntry[] }
interface HooksJson { hooks?: Record<string, HookMatcher[]> }

function preCmd(shimPath: string): string {
  return `node "${shimPath}" pre`;
}
function postCmd(shimPath: string): string {
  return `node "${shimPath}" post`;
}

/** chats-sandbox-hook.cjs — the hooks.json command target. Plain CJS so
 *  a bare `node` runs it regardless of any package.json "type" nearby. */
function hookShimSource(pkgRoot: string): string {
  const preToolJs  = JSON.stringify(path.join(pkgRoot, "hooks", "pre-tool.js"));
  const postToolJs = JSON.stringify(path.join(pkgRoot, "hooks", "post-tool.js"));
  return `#!/usr/bin/env node
/**
 * CHATS-Sandbox hook shim for OpenHands.
 *
 * Installed by 'chats-sandbox install openhands'. Do not edit by hand —
 * regenerated on every 'install'.
 *
 * The OpenHands SDK runs each hooks.json command with the lifecycle
 * event JSON on stdin and honors allow/deny via the exit code, but it
 * has no channel for hookSpecificOutput.additionalContext (failed /
 * UNVERIFIED / tier-3 backup notices) and cannot apply updatedInput.
 * This shim wraps the shared Node hooks (the same ones Claude Code,
 * Hermes and OpenClaw use) so nothing is silently dropped:
 *
 *   - stdout is passed through VERBATIM and the exit code preserved,
 *     so the SDK keeps everything it does honor (exit 2 = deny), and
 *     a future SDK that reads more of the contract gets the full
 *     object — including EVERY updatedInput key, never a subset.
 *   - additionalContext and a deny's reason are mirrored to stderr —
 *     the only signal channel the SDK leaves us (same honest
 *     degradation as the OpenClaw plugin; Claude Code / Cursor get
 *     these natively via additionalContext / permission:deny).
 *   - CHATS_SANDBOX_NO_REWRITE=1 is set for the pre hook: the SDK
 *     cannot apply updatedInput, so tier-0 run-and-rewrite would
 *     double-execute the destructive command. The gate skips tier-0
 *     and tiers 1-3 cover the action instead.
 */
"use strict";
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");

const HOOKS = { pre: ${preToolJs}, post: ${postToolJs} };

// Recursion guard. CHATS_SANDBOX_NO_HOOK=1 means "this process is a
// chats-sandbox-spawned subagent — do not fire hooks." We honor it on
// the way in (the Node hooks check it too — belt and braces), and
// strip it from the hook's own child env (the flag is for subagents
// the hook itself spawns, not the hook).
const NO_HOOK_ENV = "CHATS_SANDBOX_NO_HOOK";

function main() {
  const hookPath = HOOKS[process.argv[2]];
  if (!hookPath) process.exit(0);
  if (process.env[NO_HOOK_ENV] === "1") process.exit(0);

  const env = { ...process.env };
  delete env[NO_HOOK_ENV];
  if (process.argv[2] === "pre") env.CHATS_SANDBOX_NO_REWRITE = "1";

  let input = "";
  try { input = fs.readFileSync(0, "utf-8"); } catch { /* no stdin */ }

  // MCP tool-name mapping. The SDK registers MCP tools under their BARE
  // names (MCPToolDefinition.name is mcp_tool.name — no server prefix)
  // and the hook payload carries no server identifier at all, so the
  // gate's mcp__<server>__<tool> rules would never match and every MCP
  // mutation would silently bypass backup. The caller that KNOWS the MCP
  // topology (the benchmark harness / the user's runner script) exports
  //   CHATS_SANDBOX_MCP_TOOLMAP='{"query":"postgres","write_file":"filesystem",...}'
  // and we rewrite tool_name before the shared hooks see it — the same
  // agent-side mapping Hermes and OpenClaw do in their plugins. Bare
  // names not in the map pass through (browser_* is accepted bare by
  // the gate); already-prefixed names are never double-prefixed.
  try {
    const map = JSON.parse(process.env.CHATS_SANDBOX_MCP_TOOLMAP || "null");
    if (map && typeof map === "object") {
      const payload = JSON.parse(input);
      const t = payload && payload.tool_name;
      if (typeof t === "string" && t.indexOf("mcp__") !== 0 &&
          typeof map[t] === "string" && map[t]) {
        payload.tool_name = "mcp__" + map[t] + "__" + t;
        input = JSON.stringify(payload);
      }
    }
  } catch { /* invalid map or non-JSON stdin — pass through unchanged */ }

  // Generous cap — a tier-3 subagent can legitimately run minutes.
  // Past it we give up rather than block the agent forever. (The
  // hooks.json entry carries the same 600 s timeout; this keeps the
  // shim safe if that field is ever edited away.)
  const proc = spawnSync("node", [hookPath], {
    input,
    env,
    timeout: 600000,
    stdio: ["pipe", "pipe", "inherit"], // hook stderr flows straight through
  });

  // Pass the hook's stdout through untouched — the SDK sees the exact
  // hookSpecificOutput object the other agents' frameworks see.
  const stdout = proc.stdout ? String(proc.stdout) : "";
  if (stdout) { try { process.stdout.write(stdout); } catch { /* */ } }

  // SURFACE backup feedback on stderr. Never double the "[CHATS-Sandbox]"
  // prefix — the pre hook already prefixes its own messages.
  try {
    const hso = (JSON.parse(stdout) || {}).hookSpecificOutput || {};
    const say = (msg) => {
      const m = String(msg).trim();
      if (!m) return;
      process.stderr.write(
        (m.startsWith("[CHATS-Sandbox]") ? m : "[CHATS-Sandbox] " + m) + "\\n");
    };
    if (typeof hso.additionalContext === "string") say(hso.additionalContext);
    if (hso.permissionDecision === "deny") {
      // The block itself rides on the exit code below; this is the reason.
      say(hso.permissionDecisionReason || "tool call denied by backup policy.");
    }
  } catch { /* no JSON on stdout — nothing to surface */ }

  // Preserve the hook's exit code — the SDK's deny channel (exit 2 =
  // block). A timeout / spawn failure exits 0: never block the tool on
  // an internal shim error (a missed backup is recoverable-by-omission;
  // a wrongly-blocked agent turn is not ours to decide here).
  process.exit(typeof proc.status === "number" ? proc.status : 0);
}

main();
`;
}

/** Drop every matcher whose hooks reference our shim / Node hook scripts. */
function stripOurHooks(matchers: HookMatcher[] | undefined): HookMatcher[] {
  if (!matchers) return [];
  return matchers
    .map((m) => ({
      ...m,
      hooks: (m.hooks ?? []).filter(
        (h) => !/chats-sandbox|pre-tool\.js|post-tool\.js/.test(h.command)),
    }))
    .filter((m) => m.hooks.length > 0);
}

export const openhandsAdapter: AgentAdapter = {
  name: "openhands",
  description: "OpenHands Agent SDK (via .openhands/hooks.json)",

  detectInstalled(projectRoot: string): boolean {
    return fs.existsSync(path.join(projectRoot, HOOKS_DIR));
  },

  install(projectRoot: string, pkgRoot: string): AgentInstallResult {
    const log: string[] = [];

    const hooksDir = path.join(projectRoot, HOOKS_DIR);
    fs.mkdirSync(hooksDir, { recursive: true });
    const hooksPath = path.join(hooksDir, HOOKS_FILE);

    // The shim (regenerated on every install, like the Hermes/OpenClaw
    // plugin files) is what hooks.json invokes — see hookShimSource.
    const shimPath = path.join(hooksDir, SHIM_FILENAME);
    fs.writeFileSync(shimPath, hookShimSource(pkgRoot), "utf-8");

    // Merge into an existing hooks.json rather than clobbering it —
    // the user may already have their own OpenHands hooks here.
    let doc: HooksJson = {};
    if (fs.existsSync(hooksPath)) {
      try {
        doc = JSON.parse(fs.readFileSync(hooksPath, "utf-8")) as HooksJson;
      } catch {
        log.push(`  Warning: ${HOOKS_DIR}/${HOOKS_FILE} was unparseable — replaced.`);
        doc = {};
      }
    }
    doc.hooks = doc.hooks ?? {};

    // Idempotent + self-upgrading: strip any stale chats-sandbox entry
    // (older installs pointed hooks.json straight at pre-tool.js, with
    // no shim — leaving that in place would keep backup feedback
    // silently dropped), then append the current command.
    doc.hooks.PreToolUse = [
      ...stripOurHooks(doc.hooks.PreToolUse),
      { matcher: "*", hooks: [{ command: preCmd(shimPath), timeout: HOOK_TIMEOUT }] },
    ];
    doc.hooks.PostToolUse = [
      ...stripOurHooks(doc.hooks.PostToolUse),
      { matcher: "*", hooks: [{ command: postCmd(shimPath), timeout: HOOK_TIMEOUT }] },
    ];
    fs.writeFileSync(hooksPath, JSON.stringify(doc, null, 2) + "\n", "utf-8");

    // Sandbox config + backup dir.
    const configDir = getConfigDir(projectRoot);
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    saveConfig(DEFAULT_CONFIG, projectRoot);

    appendGitignore(projectRoot, ".chats-sandbox/");

    // OpenHands has no tier-3 runner branch of its own: the backup subagent
    // runs on DEFAULT_CONFIG.subagentRunner (claude). If that CLI is missing,
    // every out-of-workspace backup silently degrades to a log-only skip —
    // say so at install time, not after a destructive action went unprotected.
    if (!isCommandAvailable(DEFAULT_CONFIG.subagentRunner ?? "claude")) {
      log.push("");
      log.push(`WARNING: the tier-3 backup subagent runs on the "${DEFAULT_CONFIG.subagentRunner ?? "claude"}" CLI,`);
      log.push("which is NOT installed — out-of-workspace/MCP backups will be");
      log.push("SKIPPED. Install it, or set a runner you have:");
      log.push("  chats-sandbox config set subagentRunner <claude|hermes|codex|openclaw>");
    }

    log.push("CHATS-Sandbox installed successfully for OpenHands!");
    log.push(`  Hooks wired into ${HOOKS_DIR}/${HOOKS_FILE} (via ${HOOKS_DIR}/${SHIM_FILENAME})`);
    log.push(`  Config at ${configDir}/config.json`);
    log.push(`  Backups will be stored in ${DEFAULT_CONFIG.backupDir}/`);
    log.push("");
    log.push("The OpenHands SDK does not auto-load hooks.json — pass it");
    log.push("to your Conversation explicitly:");
    log.push("");
    log.push("  from openhands.sdk.hooks import HookConfig");
    log.push("  hook_config = HookConfig.load(working_dir=os.getcwd())");
    log.push("  Conversation(agent=agent, workspace=cwd, hook_config=hook_config)");
    log.push("");
    log.push("Every PreToolUse / PostToolUse then fires the tiered backup.");
    log.push("(Tier-0 command rewriting is disabled on OpenHands — its hook");
    log.push(" API is allow/deny only — so actions are covered by tiers 1-3.");
    log.push(" Backup warnings and deny reasons are mirrored to stderr, the");
    log.push(" SDK's only feedback channel; denies block via exit code 2.)");
    log.push("To check backup state: chats-sandbox status");
    log.push("To view timeline:      chats-sandbox dashboard");
    log.push("To disable:            chats-sandbox uninstall openhands");
    return { log };
  },

  uninstall(projectRoot: string): AgentInstallResult {
    const log: string[] = [];
    const shimPath = path.join(projectRoot, HOOKS_DIR, SHIM_FILENAME);
    if (fs.existsSync(shimPath)) {
      fs.unlinkSync(shimPath);
      log.push(`  Removed ${HOOKS_DIR}/${SHIM_FILENAME}`);
    }
    const hooksPath = path.join(projectRoot, HOOKS_DIR, HOOKS_FILE);
    if (fs.existsSync(hooksPath)) {
      try {
        const doc = JSON.parse(fs.readFileSync(hooksPath, "utf-8")) as HooksJson;
        if (doc.hooks) {
          doc.hooks.PreToolUse = stripOurHooks(doc.hooks.PreToolUse);
          doc.hooks.PostToolUse = stripOurHooks(doc.hooks.PostToolUse);
          // Drop now-empty event arrays.
          for (const k of ["PreToolUse", "PostToolUse"] as const) {
            if (doc.hooks[k]?.length === 0) delete doc.hooks[k];
          }
        }
        const empty = !doc.hooks || Object.keys(doc.hooks).length === 0;
        if (empty && Object.keys(doc).length <= 1) {
          // The file was ours alone — remove it entirely.
          fs.rmSync(hooksPath, { force: true });
          log.push(`  Removed ${HOOKS_DIR}/${HOOKS_FILE}`);
        } else {
          fs.writeFileSync(hooksPath, JSON.stringify(doc, null, 2) + "\n", "utf-8");
          log.push(`  Removed CHATS-Sandbox hooks from ${HOOKS_DIR}/${HOOKS_FILE}`);
        }
      } catch {
        log.push(`  Could not parse ${HOOKS_DIR}/${HOOKS_FILE} — left untouched.`);
      }
    }
    log.push("CHATS-Sandbox uninstalled from OpenHands.");
    log.push("  Config and backups left in .chats-sandbox/ (delete manually if desired)");
    return { log };
  },
};
