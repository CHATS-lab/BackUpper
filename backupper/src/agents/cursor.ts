/**
 * Cursor adapter (Cursor IDE Agent + cursor-agent CLI).
 *
 * Cursor ships a hooks system configured via `.cursor/hooks.json`
 * (project level) or `~/.cursor/hooks.json` (user level): JSON scripts
 * receive the lifecycle event on stdin and reply on stdout with
 * `{ permission: "allow"|"deny"|"ask", updated_input?, … }`.
 *
 * We register `preToolUse` / `postToolUse` (the generic tool events,
 * which support `updated_input` — so tier-0 run-and-rewrite works) and
 * the hook emits Cursor's output shape when it detects a Cursor payload
 * (see detectHookDialect in types.ts + pre-tool.ts).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentAdapter, AgentInstallResult } from "./index.js";
import { appendGitignore } from "./index.js";
import { saveConfig, getConfigDir } from "../config/load.js";
import { DEFAULT_CONFIG } from "../types.js";
import { isCommandAvailable } from "../backup/subagent.js";

const HOOKS_DIR = ".cursor";
const HOOKS_FILE = "hooks.json";
const HOOK_TIMEOUT_SEC = 600;

interface HookEntry { command: string; timeout?: number; failClosed?: boolean }
interface HooksJson { version?: number; hooks?: Record<string, HookEntry[]> }

function preCmd(pkgRoot: string): string {
  return `node "${path.join(pkgRoot, "hooks", "pre-tool.js")}"`;
}
function postCmd(pkgRoot: string): string {
  return `node "${path.join(pkgRoot, "hooks", "post-tool.js")}"`;
}

function hasOurHook(entries: HookEntry[] | undefined): boolean {
  return !!entries?.some((h) => /chats-sandbox|pre-tool\.js|post-tool\.js/.test(h.command));
}

function stripOurHooks(entries: HookEntry[] | undefined): HookEntry[] {
  return (entries ?? []).filter(
    (h) => !/chats-sandbox|pre-tool\.js|post-tool\.js/.test(h.command));
}

export const cursorAdapter: AgentAdapter = {
  name: "cursor",
  description: "Cursor agent (via .cursor/hooks.json)",

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
    doc.version = doc.version ?? 1;
    doc.hooks = doc.hooks ?? {};

    if (!hasOurHook(doc.hooks.preToolUse)) {
      doc.hooks.preToolUse = [
        ...(doc.hooks.preToolUse ?? []),
        // failClosed stays false: a backup failure must never block the
        // agent (backup is best-effort by design).
        { command: preCmd(pkgRoot), timeout: HOOK_TIMEOUT_SEC },
      ];
    }
    if (!hasOurHook(doc.hooks.postToolUse)) {
      doc.hooks.postToolUse = [
        ...(doc.hooks.postToolUse ?? []),
        { command: postCmd(pkgRoot), timeout: HOOK_TIMEOUT_SEC },
      ];
    }
    fs.writeFileSync(hooksPath, JSON.stringify(doc, null, 2) + "\n", "utf-8");

    const configDir = getConfigDir(projectRoot);
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    saveConfig(DEFAULT_CONFIG, projectRoot);

    appendGitignore(projectRoot, ".chats-sandbox/");

    // Cursor has no tier-3 runner branch of its own: the backup subagent runs
    // on DEFAULT_CONFIG.subagentRunner (claude). If that CLI is missing, every
    // out-of-workspace backup silently degrades to a log-only skip — say so
    // NOW, at install time, instead of letting the user discover it after a
    // destructive action went unprotected.
    if (!isCommandAvailable(DEFAULT_CONFIG.subagentRunner ?? "claude")) {
      log.push("");
      log.push(`WARNING: the tier-3 backup subagent runs on the "${DEFAULT_CONFIG.subagentRunner ?? "claude"}" CLI,`);
      log.push("which is NOT installed — out-of-workspace/MCP backups will be");
      log.push("SKIPPED. Install it, or set a runner you have:");
      log.push("  chats-sandbox config set subagentRunner <claude|hermes|codex|openclaw>");
    }

    log.push("CHATS-Sandbox installed successfully for Cursor!");
    log.push(`  Hooks wired into ${HOOKS_DIR}/${HOOKS_FILE}`);
    log.push(`  Config at ${configDir}/config.json`);
    log.push(`  Backups will be stored in ${DEFAULT_CONFIG.backupDir}/`);
    log.push("");
    log.push("Cursor (IDE agent and cursor-agent CLI) loads project hooks");
    log.push("from .cursor/hooks.json on the next session. preToolUse");
    log.push("supports updated_input, so tier-0 command rewriting works.");
    log.push("");
    log.push("To check backup state: chats-sandbox status");
    log.push("To view timeline:      chats-sandbox dashboard");
    log.push("To disable:            chats-sandbox uninstall cursor");
    return { log };
  },

  uninstall(projectRoot: string): AgentInstallResult {
    const log: string[] = [];
    const hooksPath = path.join(projectRoot, HOOKS_DIR, HOOKS_FILE);
    if (fs.existsSync(hooksPath)) {
      try {
        const doc = JSON.parse(fs.readFileSync(hooksPath, "utf-8")) as HooksJson;
        if (doc.hooks) {
          for (const k of ["preToolUse", "postToolUse"]) {
            doc.hooks[k] = stripOurHooks(doc.hooks[k]);
            if (doc.hooks[k].length === 0) delete doc.hooks[k];
          }
        }
        const empty = !doc.hooks || Object.keys(doc.hooks).length === 0;
        if (empty) {
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
    log.push("CHATS-Sandbox uninstalled from Cursor.");
    log.push("  Config and backups left in .chats-sandbox/ (delete manually if desired)");
    return { log };
  },
};
