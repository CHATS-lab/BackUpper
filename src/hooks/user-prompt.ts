#!/usr/bin/env node
/**
 * UserPromptSubmit hook: emits the one-time session briefing and writes the
 * user's prompt, truncated to one line, to .backupper/current-instruction.txt
 * so action folders can record what was asked.
 *
 * For Codex and Hermes, a prompt that is only `/backupper-panel [on|off|toggle|status]` is
 * answered here and blocked, so toggling the side panel never reaches the model. With
 * `panel: true` the panel is opened once per session, in a detached process the hook does not
 * wait for. Claude Code gets both from the plugin in claude-plugin/, which draws the pane itself.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { loadConfig } from "../config/load.js";
import { storeDirOverride } from "../types.js";
import { BRIEFING_CHECKER, render } from "../prompts.generated.js";
import { adoptHostAgent } from "./host.js";
import { panelCommand, parsePanelPrompt } from "../cli/panel.js";
import { storeRoot } from "../store/layout.js";

interface PromptContext {
  hook_event?: string;
  prompt?: string;
  user_prompt?: string;
  message?: string;
  session_id?: string;
}

const MAX_LEN = 200;

async function main(): Promise<void> {
  adoptHostAgent();
  // Recursion guard: exit inside a sandbox-spawned subagent.
  if (process.env.BACKUPPER_NO_HOOK === "1") {
    process.exit(0);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");

  let ctx: PromptContext;
  try {
    ctx = JSON.parse(raw) as PromptContext;
  } catch {
    process.exit(0);
  }

  // ── Side panel toggle: handled here, never sent to the model ───────
  const ownPanel = process.env.BACKUPPER_HOST_AGENT === "claude-code";
  const panelAction = ownPanel ? null : parsePanelPrompt(String(ctx.prompt ?? ctx.user_prompt ?? ctx.message ?? ""));
  if (panelAction) {
    let lines: string[];
    try {
      lines = panelCommand(panelAction, { projectRoot: process.cwd(), watch: watchArgv() }).lines;
    } catch (e) {
      lines = [`BackUpper panel: ${(e as Error).message}`];
    }
    process.stdout.write(JSON.stringify({ decision: "block", reason: lines.join("\n") }));
    process.exit(0);
  }

  const config = loadConfig();
  if (!config.enabled) {
    process.exit(0);
  }

  const sandboxDir = storeRoot(config);

  if (config.panel && !ownPanel) openPanelOnce(sandboxDir, String(ctx.session_id ?? "default"));

  // ── One-time session briefing ──────────────────────────────────────
  // Emitted on the first prompt of each session, tracked by a session-id
  // marker in the sandbox dir.
  let announcement = "";
  if (config.announceOnce) {
    try {
      const sessionKey = String(ctx.session_id ?? "default");
      const markerFile = path.join(sandboxDir, "announced-sessions.json");
      let seen: string[] = [];
      try {
        const parsed = JSON.parse(fs.readFileSync(markerFile, "utf-8"));
        if (Array.isArray(parsed)) seen = parsed.map(String);
      } catch { /* fresh */ }
      if (!seen.includes(sessionKey)) {
        announcement = buildAnnouncement(config);
        seen.push(sessionKey);
        // Bound the marker file's size.
        seen = seen.slice(-200);
        if (!fs.existsSync(sandboxDir)) fs.mkdirSync(sandboxDir, { recursive: true });
        fs.writeFileSync(markerFile, JSON.stringify(seen), "utf-8");
      }
    } catch {
      // If the marker cannot be read or written, stay silent rather than repeat.
      announcement = "";
    }
  }

  if (announcement) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: announcement,
      },
    }));
  }

  // Accept several field names for the prompt text.
  const promptText =
    String(ctx.prompt ?? ctx.user_prompt ?? ctx.message ?? "").trim();

  if (!promptText) {
    process.exit(0);
  }

  // Collapse to one line and truncate to MAX_LEN with an ellipsis.
  const singleLine = promptText.replace(/\s+/g, " ");
  const truncated =
    singleLine.length > MAX_LEN
      ? singleLine.slice(0, MAX_LEN) + "..."
      : singleLine;

  // Overwrite .backupper/current-instruction.txt with the current prompt.
  try {
    if (!fs.existsSync(sandboxDir)) {
      fs.mkdirSync(sandboxDir, { recursive: true });
    }
    const instructionFile = path.join(sandboxDir, "current-instruction.txt");
    fs.writeFileSync(instructionFile, truncated, "utf-8");
  } catch {
    // best-effort; never block on this
  }

  process.exit(0);
}

/** argv that starts `backupper watch` from this install (hooks live in dist/hooks/). */
function watchArgv(): string[] {
  return [process.execPath, path.join(__dirname, "..", "cli.js"), "watch"];
}

/**
 * `panel: true`: open the side panel on the first prompt of a session. Runs `panel on` in a
 * detached child the hook never waits for; any failure stays inside that child.
 */
function openPanelOnce(sandboxDir: string, sessionKey: string): void {
  try {
    const marker = path.join(sandboxDir, "panel-sessions.json");
    let seen: string[] = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(marker, "utf-8"));
      if (Array.isArray(parsed)) seen = parsed.map(String);
    } catch { /* fresh */ }
    if (seen.includes(sessionKey)) return;
    fs.mkdirSync(sandboxDir, { recursive: true });
    fs.writeFileSync(marker, JSON.stringify([...seen, sessionKey].slice(-200)), "utf-8");
    const child = spawn(process.execPath, [path.join(__dirname, "..", "cli.js"), "panel", "on"], {
      cwd: process.cwd(), detached: true, stdio: "ignore",
    });
    child.on("error", () => { /* best effort */ });
    child.unref();
  } catch { /* never fail the hook */ }
}

/** The briefing text comes from prompts/briefing-checker.md via prompts.generated.ts. */

/**
 * Workspace path substituted for {{WORKSPACE}} in the briefing: process.cwd()
 * when BACKUPPER_STORE_DIR relocates the store, else backupDir two levels up.
 */
function briefingWorkspace(config: { backupDir: string }): string {
  if (storeDirOverride()) return path.resolve(process.cwd());
  return path.dirname(storeRoot(config));
}

function buildAnnouncement(config: { backupDir: string }): string {
  // workspace = backupDir two levels up, or process.cwd() for a relocated store.
  return render(BRIEFING_CHECKER.body, { WORKSPACE: briefingWorkspace(config) });
}

main().catch(() => {
  process.exit(0); // never block on internal errors
});
