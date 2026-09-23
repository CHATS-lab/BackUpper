/**
 * OpenClaw adapter.
 *
 * Unlike Hermes (which needed a ToolRegistry source patch), OpenClaw
 * ships a first-class plugin API with `before_tool_call` /
 * `after_tool_call` hooks. We install a small ESM plugin into
 * `<project>/.openclaw/extensions/chats-sandbox/` that OpenClaw
 * discovers at startup; the plugin shells out to the same Node hooks
 * Claude Code and Hermes use, so the tier-0..3 backup logic is fully
 * reused across all three agents.
 *
 * Plugin contract (see openclaw docs/plugins/): an extension directory
 * with an `openclaw.plugin.json` manifest, a `package.json` whose
 * `openclaw.extensions` array names the code entry, and that entry
 * exporting `definePluginEntry({ id, name, register(api) })`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentAdapter, AgentInstallResult } from "./index.js";
import { appendGitignore } from "./index.js";
import { saveConfig, getConfigDir } from "../config/load.js";
import { DEFAULT_CONFIG } from "../types.js";

const EXTENSIONS_DIR = ".openclaw/extensions";
const PLUGIN_DIRNAME = "chats-sandbox";
const PLUGIN_ID = "chats-sandbox";

/** index.mjs — the plugin entry. Plain ESM JS so OpenClaw can load it
 *  with no build step (index.{ts,js,mjs,cjs} are all valid entries). */
function pluginIndexSource(pkgRoot: string): string {
  const preToolJs  = JSON.stringify(path.join(pkgRoot, "hooks", "pre-tool.js"));
  const postToolJs = JSON.stringify(path.join(pkgRoot, "hooks", "post-tool.js"));
  return `/**
 * CHATS-Sandbox plugin for OpenClaw.
 *
 * Installed by \`chats-sandbox install openclaw\`. Do not edit by hand —
 * regenerated on every \`install\`.
 *
 * Registers before_tool_call / after_tool_call hooks that pipe a JSON
 * payload to the same Node hooks Claude Code and Hermes use:
 *
 *   { "hook_event": "PreToolUse" | "PostToolUse",
 *     "tool_name": <str>, "tool_input": <obj>, "tool_output"?: <any> }
 *
 * so tier-0 / tier-1 / tier-2 / tier-3 backup is shared across agents.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { spawn } from "node:child_process";

const PRE_TOOL_HOOK  = ${preToolJs};
const POST_TOOL_HOOK = ${postToolJs};

// Recursion guard. CHATS_SANDBOX_NO_HOOK=1 means "this process is a
// chats-sandbox-spawned subagent — do not fire hooks." We honor it on
// the way in, and strip it from the hook's own child env (the flag is
// for subagents the hook itself spawns, not the hook).
const NO_HOOK_ENV = "CHATS_SANDBOX_NO_HOOK";

// OpenClaw tool names → the Claude-Code names the Node hooks key their
// logic on (tier-0 rules match "Bash"/"Write", read-only short-circuit
// matches "Read", etc.). Unmapped names pass through unchanged.
const TOOL_NAME_MAP = {
  exec: "Bash",
  write: "Write",
  edit: "Edit",
  apply_patch: "Edit",
  read: "Read",
};

function mapToolName(name) {
  if (TOOL_NAME_MAP[name]) return TOOL_NAME_MAP[name];
  // OpenClaw names bundle-MCP tools "<server>__<tool>" (its
  // TOOL_NAME_SEPARATOR is "__"), but every MCP rule in the gate keys on
  // the Claude-Code-style "mcp__<server>__<tool>". Without this prefix
  // every MCP action bypasses the gate SILENTLY - zero backup coverage
  // that still looks like a passing run.
  if (name && name.includes("__") && !name.startsWith("mcp__")) {
    return "mcp__" + name;
  }
  return name || "";
}

// Mirror OpenClaw's "path" param as "file_path" in the hook payload so
// path-keyed logic (outside-workspace Write rule, file labels) sees the
// key it expects. Copies only — never mutates the live params.
function hookInput(name, params) {
  const input = { ...(params || {}) };
  if ((name === "write" || name === "edit" || name === "apply_patch") &&
      input.path && !input.file_path) {
    input.file_path = input.path;
  }
  return input;
}

function runHook(hookPath, payload) {
  return new Promise((resolve) => {
    if (process.env[NO_HOOK_ENV] === "1") { resolve(undefined); return; }
    let done = false;
    let stdout = "";
    const finish = () => {
      if (done) return;
      done = true;
      try { resolve(stdout.trim() ? JSON.parse(stdout) : undefined); }
      catch { resolve(undefined); }
    };
    try {
      const env = { ...process.env };
      delete env[NO_HOOK_ENV];
      const child = spawn("node", [hookPath], {
        stdio: ["pipe", "pipe", "ignore"],
        env,
      });
      child.stdout.on("data", (d) => { stdout += String(d); });
      // Generous cap — a tier-3 subagent can run minutes. Past this we
      // give up rather than block the agent forever.
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        finish();
      }, 600000);
      child.on("close", () => { clearTimeout(timer); finish(); });
      child.on("error", () => { clearTimeout(timer); finish(); });
      child.stdin.on("error", () => {});
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    } catch {
      finish();
    }
  });
}

export default definePluginEntry({
  id: "${PLUGIN_ID}",
  name: "CHATS-Sandbox",
  description: "Tiered action backup & recovery for OpenClaw tool calls.",
  register(api) {
    // before_tool_call is a MODIFYING hook: returning { params } swaps
    // the tool's params. Tier-0 policy rules execute the destructive
    // command reversibly inside the hook (e.g. rm -> mv to trash) and
    // hand back updatedInput with the command rewritten to a no-op —
    // returning it here is what stops the original command from
    // running a second time. Backup itself is best-effort: every
    // error is swallowed so a backup failure never blocks the agent.
    api.on("before_tool_call", async (event) => {
      try {
        const name = (event && event.toolName) || "";
        const params = (event && event.params) || {};
        const out = await runHook(PRE_TOOL_HOOK, {
          hook_event: "PreToolUse",
          tool_name: mapToolName(name),
          tool_input: hookInput(name, params),
        });
        const hso = (out && out.hookSpecificOutput) || {};
        // SURFACE backup feedback: the Node hook reports a failed / UNVERIFIED
        // / needed tier-3 backup via additionalContext (no injection channel
        // in before_tool_call — stderr is the best available signal), and a
        // deny via permissionDecision — which the SDK DOES honor: returning
        // { block: true, blockReason } stops the tool call and surfaces the
        // reason to the agent as the tool result.
        if (typeof hso.additionalContext === "string" && hso.additionalContext.trim()) {
          try { process.stderr.write("[CHATS-Sandbox] " + hso.additionalContext.trim() + "\\n"); } catch { /* */ }
        }
        if (hso.permissionDecision === "deny") {
          let reason = (typeof hso.permissionDecisionReason === "string" &&
            hso.permissionDecisionReason.trim()) ||
            "blocked by backup policy.";
          // some hook paths already carry the prefix — never double it
          if (!reason.startsWith("[CHATS-Sandbox]")) reason = "[CHATS-Sandbox] " + reason;
          return { block: true, blockReason: reason };
        }
        const upd = hso.updatedInput;
        // Apply ALL updatedInput keys (today's tier-0 rules only rewrite
        // "command", but the hook contract allows any key — mirror the
        // Claude Code adapter instead of silently dropping the rest). Only
        // keys already present in params are touched: the hook rewrites
        // existing inputs, it does not invent new tool parameters.
        if (upd && typeof upd === "object") {
          let changed = false;
          const next = Object.assign({}, params);
          for (const k of Object.keys(upd)) {
            // Own keys only ("k in next" would match prototype-chain names
            // like toString and create a NEW own property).
            if (Object.prototype.hasOwnProperty.call(next, k) && next[k] !== upd[k]) {
              next[k] = upd[k]; changed = true;
            }
          }
          if (changed) return { params: next };
        }
      } catch { /* never block the tool */ }
      return undefined;
    });

    // after_tool_call is fire-and-forget (OpenClaw times it out).
    api.on("after_tool_call", async (event) => {
      try {
        const name = (event && event.toolName) || "";
        await runHook(POST_TOOL_HOOK, {
          hook_event: "PostToolUse",
          tool_name: mapToolName(name),
          tool_input: hookInput(name, (event && event.params) || {}),
          tool_output: event ? event.result : undefined,
        });
      } catch { /* observation only */ }
    });
  },
});
`;
}

/** openclaw.plugin.json — the manifest OpenClaw reads without executing
 *  any plugin code (identity + config). */
function manifestSource(): string {
  return JSON.stringify({
    id: PLUGIN_ID,
    name: "CHATS-Sandbox",
    version: "0.1.0",
    description:
      "Tiered action backup & recovery — snapshots every tool call, " +
      "restorable via the chats-sandbox CLI and dashboard.",
    activation: { onStartup: true },
    enabledByDefault: true,
    // Required by OpenClaw >= 2026.5 config validation, even when the
    // plugin takes no config.
    configSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  }, null, 2) + "\n";
}

/** package.json — declares the code entry under the `openclaw` field. */
function packageJsonSource(): string {
  return JSON.stringify({
    name: "chats-sandbox-openclaw",
    version: "0.1.0",
    private: true,
    type: "module",
    description: "CHATS-Sandbox backup plugin for OpenClaw.",
    openclaw: {
      extensions: ["./index.mjs"],
    },
  }, null, 2) + "\n";
}

export const openclawAdapter: AgentAdapter = {
  name: "openclaw",
  description: "OpenClaw agent (via .openclaw/extensions/chats-sandbox/)",

  detectInstalled(projectRoot: string): boolean {
    // An .openclaw/ dir is the strongest signal OpenClaw is wired here.
    return fs.existsSync(path.join(projectRoot, ".openclaw"));
  },

  install(projectRoot: string, pkgRoot: string): AgentInstallResult {
    const log: string[] = [];

    // Write the plugin into the workspace-scoped extensions dir, which
    // OpenClaw scans at startup (alongside ~/.openclaw/extensions).
    const pluginDir = path.join(projectRoot, EXTENSIONS_DIR, PLUGIN_DIRNAME);
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "openclaw.plugin.json"), manifestSource(), "utf-8");
    fs.writeFileSync(path.join(pluginDir, "package.json"), packageJsonSource(), "utf-8");
    fs.writeFileSync(path.join(pluginDir, "index.mjs"), pluginIndexSource(pkgRoot), "utf-8");

    // Sandbox config + backup dir. The tier-3 subagent runs as a
    // headless `openclaw agent --local` one-shot turn — an OpenClaw
    // deployment with no Claude CLI still gets working
    // out-of-workspace / remote-state backup. Provider API keys are
    // read from the environment at run time, never stored in config.
    const configDir = getConfigDir(projectRoot);
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    saveConfig({ ...DEFAULT_CONFIG, subagentRunner: "openclaw" as const }, projectRoot);

    appendGitignore(projectRoot, ".chats-sandbox/");

    log.push("CHATS-Sandbox installed successfully for OpenClaw!");
    log.push(`  Plugin written to ${EXTENSIONS_DIR}/${PLUGIN_DIRNAME}/`);
    log.push(`  Config at ${configDir}/config.json`);
    log.push(`  Backups will be stored in ${DEFAULT_CONFIG.backupDir}/`);
    log.push("");

    // OpenClaw (>= 2026.5) only scans its stock extensions dir — a
    // workspace plugin must be registered via `openclaw plugins
    // install`. Its security scan flags our child_process use (the
    // hook subprocess), so the bypass flag is required. Try to
    // register automatically; fall back to printing the command.
    const registerCmd =
      `openclaw plugins install --link --dangerously-force-unsafe-install ${pluginDir}`;
    let registered = false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { execSync } = require("node:child_process");
      execSync(registerCmd, { stdio: "pipe", timeout: 60_000 });
      registered = true;
      log.push("Plugin registered with OpenClaw (plugins install --link).");
    } catch {
      log.push("Could not auto-register the plugin (openclaw CLI not on");
      log.push("PATH or registration failed). Register it manually:");
      log.push(`  ${registerCmd}`);
      log.push("(--dangerously-force-unsafe-install is needed because the");
      log.push(" plugin spawns the chats-sandbox hook subprocess, which");
      log.push(" OpenClaw's security scan flags as child_process use.)");
    }
    log.push("");
    log.push(registered
      ? "On the next OpenClaw session the plugin fires its"
      : "Once registered, the plugin fires its");
    log.push("before_tool_call / after_tool_call hooks — every tool call");
    log.push("is wrapped with tier-0..3 backup, no source patch needed.");
    log.push("");
    log.push("To check backup state: chats-sandbox status");
    log.push("To view timeline:      chats-sandbox dashboard");
    log.push("To disable:            chats-sandbox uninstall openclaw");
    return { log };
  },

  uninstall(projectRoot: string): AgentInstallResult {
    const log: string[] = [];
    const pluginDir = path.join(projectRoot, EXTENSIONS_DIR, PLUGIN_DIRNAME);
    if (fs.existsSync(pluginDir)) {
      fs.rmSync(pluginDir, { recursive: true, force: true });
      log.push(`  Removed ${EXTENSIONS_DIR}/${PLUGIN_DIRNAME}/`);
    }
    log.push("CHATS-Sandbox uninstalled from OpenClaw.");
    log.push("  Config and backups left in .chats-sandbox/ (delete manually if desired)");
    return { log };
  },
};
