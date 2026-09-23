#!/usr/bin/env node
/**
 * UserPromptSubmit hook — fires once per user message in Claude Code.
 *
 * Also emits the ONE-TIME session briefing (config.announceOnce). The
 * PreToolUse hook used to narrate every successful backup; measured
 * 2026-08-18 that produced 23 near-identical messages in one run, 22 of
 * them on pure reads, and the agent under test dismissed the stream as a
 * prompt injection — then ignored the warning on the genuinely destructive
 * call as well. The agent is now told once, here, what the backupper does
 * and where the log is; per-call messages are reserved for things it can
 * act on (failure, unverified, subagent-needed, deny).
 *
 * Captures the user's prompt text and writes it to a sidecar file
 * (.chats-sandbox/current-instruction.txt). The pre-tool hook reads
 * this file when materializing an action folder and copies the
 * instruction into the folder's metadata, so `chats-sandbox history`
 * can show the user what they were asking for.
 *
 * Truncated to ~200 chars to keep the file small. The full prompt is
 * never stored (we don't want a transcript log).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../config/load.js";
import { storeDirOverride } from "../types.js";
import { BRIEFING_CHECKER, render } from "../prompts.generated.js";

interface PromptContext {
  hook_event?: string;
  prompt?: string;
  user_prompt?: string;
  message?: string;
  session_id?: string;
}

const MAX_LEN = 200;

async function main(): Promise<void> {
  // Recursion guard: if we're inside a sandbox-spawned subagent, exit.
  if (process.env.CHATS_SANDBOX_NO_HOOK === "1") {
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

  const config = loadConfig();
  if (!config.enabled) {
    process.exit(0);
  }

  const sandboxDir = path.dirname(path.resolve(config.backupDir));

  // ── One-time session briefing ──────────────────────────────────────
  // Emitted on the FIRST UserPromptSubmit of a session and never again.
  // The marker is keyed by session id and stored in the sandbox dir, so a
  // new session re-announces but every later prompt in this one is silent.
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
        // Bounded: the marker file must not grow without limit across
        // months of sessions on one project.
        seen = seen.slice(-200);
        if (!fs.existsSync(sandboxDir)) fs.mkdirSync(sandboxDir, { recursive: true });
        fs.writeFileSync(markerFile, JSON.stringify(seen), "utf-8");
      }
    } catch {
      // If the marker can't be read or written we say NOTHING rather than
      // risk repeating the announcement on every prompt — repetition is the
      // exact failure this change exists to remove.
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

  // Try multiple field names — Claude Code's UserPromptSubmit context
  // shape may vary across versions.
  const promptText =
    String(ctx.prompt ?? ctx.user_prompt ?? ctx.message ?? "").trim();

  if (!promptText) {
    process.exit(0);
  }

  // Truncate to MAX_LEN chars, single line, with ellipsis if shortened
  const singleLine = promptText.replace(/\s+/g, " ");
  const truncated =
    singleLine.length > MAX_LEN
      ? singleLine.slice(0, MAX_LEN) + "..."
      : singleLine;

  // Write to .chats-sandbox/current-instruction.txt — overwrites the
  // previous prompt (one current instruction at a time).
  try {
    if (!fs.existsSync(sandboxDir)) {
      fs.mkdirSync(sandboxDir, { recursive: true });
    }
    const instructionFile = path.join(sandboxDir, "current-instruction.txt");
    fs.writeFileSync(instructionFile, truncated, "utf-8");

    // Session sidecar — read by the dashboard so each instance can show
    // which conversation it is watching ("multiple dashboards" case).
    const sessionFile = path.join(sandboxDir, "session.json");
    let prev: Record<string, unknown> = {};
    try { prev = JSON.parse(fs.readFileSync(sessionFile, "utf-8")); } catch { /* fresh */ }
    fs.writeFileSync(sessionFile, JSON.stringify({
      ...prev,
      session_id: ctx.session_id ?? prev.session_id ?? null,
      prompt: truncated,
      ts: new Date().toISOString(),
    }, null, 2) + "\n", "utf-8");
  } catch {
    // best-effort; never block on this
  }

  process.exit(0);
}

/**
 * The briefing text lives in prompts/briefing-checker.md (compiled into
 * ../prompts.generated.ts by scripts/gen_prompts.mjs). Exact wording is
 * deliberate and should not drift: it tells the agent (a) backups are
 * automatic and pre-action, (b) it must not duplicate them by hand, (c) where
 * the record lives and that reading it is not part of normal work, and (d)
 * that silence means success — which is what makes the absence of per-call
 * messages informative rather than ambiguous.
 */

/**
 * The path the briefing substitutes for {{WORKSPACE}}.
 *
 * IT IS THE AGENT'S WORKSPACE, NOT THE STORE'S PARENT. Those coincided only
 * because the store sat inside the workspace: `<cwd>/.chats-sandbox/backups`
 * two levels up IS `<cwd>`. With CHATS_SANDBOX_STORE_DIR set, two levels up is
 * the parent of the relocated store — so the briefing would name a directory
 * the agent never touches, every "is this call inside {{WORKSPACE}}?" judgement
 * would be made against the wrong path, and NOTHING would report an error.
 *
 * process.cwd() is the right source and matches what the rest of the plugin
 * already uses for this question: strategies.js snapshots process.cwd() as
 * GIT_WORK_TREE, readonly_checker.js prints process.cwd() as its own ## WORKSPACE
 * section, and outsideWorkspaceResolved() resolves against it.
 *
 * When the variable is unset the OLD expression is kept verbatim rather than
 * swapped for process.cwd(): they agree for the default layout, but a config
 * that sets `backupDir` by hand can make them differ, and "unset changes
 * nothing" is the hard requirement here.
 */
function briefingWorkspace(config: { backupDir: string }): string {
  if (storeDirOverride()) return path.resolve(process.cwd());
  return path.dirname(path.dirname(path.resolve(config.backupDir)));
}

function buildAnnouncement(config: { backupDir: string }): string {
  // workspace = backupDir two levels up (<cwd>/.chats-sandbox/backups -> <cwd>),
  // or process.cwd() when the store has been relocated — see briefingWorkspace().
  return render(BRIEFING_CHECKER.body, { WORKSPACE: briefingWorkspace(config) });
}

main().catch(() => {
  process.exit(0); // never block on internal errors
});
