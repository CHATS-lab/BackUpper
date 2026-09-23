/**
 * Codex CLI adapter (OpenAI Codex).
 *
 * Codex ships a Claude-Code-compatible hook engine (internally named
 * ClaudeHooksEngine): `.codex/hooks.json` next to a config layer, with
 * PascalCase events, nested matcher groups, and the same stdin/stdout
 * contract Claude Code uses — including `hookSpecificOutput.updatedInput`,
 * so tier-0 run-and-rewrite works unmodified.
 *
 * Payload differences handled in normalizeHookContext:
 *   - the event key is `hook_event_name` (vs `hook_event`)
 *   - file edits arrive as tool_name "apply_patch" (mapped to Edit)
 *
 * Two Codex-specific gates the user must know about (verified against
 * the codex-rs source at rust-v0.139.0):
 *   1. Hook TRUST: hooks only run once trusted (Codex TUI prompts to
 *      review them on startup, persisting a trusted_hash), or with
 *      `--dangerously-bypass-hook-trust` for vetted automation.
 *   2. As of codex-cli 0.139.0, hooks dispatch in interactive (TUI)
 *      sessions; `codex exec` did not dispatch them in our testing.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentAdapter, AgentInstallResult } from "./index.js";
import { appendGitignore } from "./index.js";
import { saveConfig, getConfigDir } from "../config/load.js";
import { DEFAULT_CONFIG } from "../types.js";

const HOOKS_DIR = ".codex";
const HOOKS_FILE = "hooks.json";
const HOOK_TIMEOUT_SEC = 600;

interface HookEntry { type: "command"; command: string; timeout?: number }
interface MatcherGroup { matcher?: string; hooks: HookEntry[] }
interface HooksJson { hooks?: Record<string, MatcherGroup[]> }

function preCmd(pkgRoot: string): string {
  return `node "${path.join(pkgRoot, "hooks", "pre-tool.js")}"`;
}
function postCmd(pkgRoot: string): string {
  return `node "${path.join(pkgRoot, "hooks", "post-tool.js")}"`;
}

function hasOurHook(groups: MatcherGroup[] | undefined): boolean {
  return !!groups?.some((g) =>
    g.hooks?.some((h) => /chats-sandbox|pre-tool\.js|post-tool\.js/.test(h.command)));
}

function stripOurHooks(groups: MatcherGroup[] | undefined): MatcherGroup[] {
  if (!groups) return [];
  return groups
    .map((g) => ({
      ...g,
      hooks: (g.hooks ?? []).filter(
        (h) => !/chats-sandbox|pre-tool\.js|post-tool\.js/.test(h.command)),
    }))
    .filter((g) => g.hooks.length > 0);
}

export const codexAdapter: AgentAdapter = {
  name: "codex",
  description: "OpenAI Codex CLI (via .codex/hooks.json)",

  detectInstalled(projectRoot: string): boolean {
    return fs.existsSync(path.join(projectRoot, HOOKS_DIR));
  },

  install(projectRoot: string, pkgRoot: string): AgentInstallResult {
    const log: string[] = [];

    const hooksDir = path.join(projectRoot, HOOKS_DIR);
    fs.mkdirSync(hooksDir, { recursive: true });
    const hooksPath = path.join(hooksDir, HOOKS_FILE);

    // Merge into an existing hooks.json rather than clobbering it.
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

    if (!hasOurHook(doc.hooks.PreToolUse)) {
      doc.hooks.PreToolUse = [
        ...(doc.hooks.PreToolUse ?? []),
        // No matcher = match every tool (Codex treats matcher as an
        // optional regex; omitted means all tools).
        { hooks: [{ type: "command", command: preCmd(pkgRoot), timeout: HOOK_TIMEOUT_SEC }] },
      ];
    }
    if (!hasOurHook(doc.hooks.PostToolUse)) {
      doc.hooks.PostToolUse = [
        ...(doc.hooks.PostToolUse ?? []),
        { hooks: [{ type: "command", command: postCmd(pkgRoot), timeout: HOOK_TIMEOUT_SEC }] },
      ];
    }
    fs.writeFileSync(hooksPath, JSON.stringify(doc, null, 2) + "\n", "utf-8");

    // Sandbox config + backup dir. Tier-3 uses the native codex runner
    // (`codex exec`) so a Codex deployment needs no other agent CLI.
    const configDir = getConfigDir(projectRoot);
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    saveConfig({ ...DEFAULT_CONFIG, subagentRunner: "codex" as const }, projectRoot);

    appendGitignore(projectRoot, ".chats-sandbox/");

    log.push("CHATS-Sandbox installed successfully for Codex!");
    log.push(`  Hooks wired into ${HOOKS_DIR}/${HOOKS_FILE}`);
    log.push(`  Config at ${configDir}/config.json`);
    log.push(`  Backups will be stored in ${DEFAULT_CONFIG.backupDir}/`);
    log.push("");
    log.push("Codex gates hooks behind a TRUST review: on your next");
    log.push("interactive `codex` session it will ask you to review and");
    log.push("trust these hooks (persisted in config). For vetted");
    log.push("automation you can instead pass:");
    log.push("  codex --dangerously-bypass-hook-trust …");
    log.push("");
    log.push("Note: as of codex-cli 0.139.0 hooks fire in interactive");
    log.push("sessions; `codex exec` did not dispatch them in testing.");
    log.push("Tier-0 command rewriting is fully supported — Codex honors");
    log.push("hookSpecificOutput.updatedInput like Claude Code.");
    log.push("");
    log.push("To check backup state: chats-sandbox status");
    log.push("To view timeline:      chats-sandbox dashboard");
    log.push("To disable:            chats-sandbox uninstall codex");
    return { log };
  },

  uninstall(projectRoot: string): AgentInstallResult {
    const log: string[] = [];
    const hooksPath = path.join(projectRoot, HOOKS_DIR, HOOKS_FILE);
    if (fs.existsSync(hooksPath)) {
      try {
        const doc = JSON.parse(fs.readFileSync(hooksPath, "utf-8")) as HooksJson;
        if (doc.hooks) {
          doc.hooks.PreToolUse = stripOurHooks(doc.hooks.PreToolUse);
          doc.hooks.PostToolUse = stripOurHooks(doc.hooks.PostToolUse);
          for (const k of ["PreToolUse", "PostToolUse"]) {
            if (doc.hooks[k]?.length === 0) delete doc.hooks[k];
          }
        }
        const empty = !doc.hooks || Object.keys(doc.hooks).length === 0;
        if (empty && Object.keys(doc).length <= 1) {
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
    log.push("CHATS-Sandbox uninstalled from Codex.");
    log.push("  Config and backups left in .chats-sandbox/ (delete manually if desired)");
    return { log };
  },
};
