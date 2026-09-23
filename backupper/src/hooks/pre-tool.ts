#!/usr/bin/env node
/**
 * PreToolUse hook — fires before every Claude Code tool call.
 *
 * Flow:
 *   1. Read hook context from stdin
 *   2. Evaluate rules → deny / backup / pass
 *   3. If backup needed, run tiered strategy:
 *      1st: Targeted manifest (pip freeze, git tag, etc.)
 *      2nd: git add -A
 *      3rd: Signal that a subagent is needed (hook layer handles it)
 *   4. Output hook response
 *
 * Exit codes:
 *   0 = allow (with optional modifications/context)
 *   2 = deny (block the tool call)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../config/load.js";
import { evaluate } from "../engine/rules.js";
import { runBackup } from "../backup/strategies.js";
import { timingFilePath } from "./timing-path.js";
import { pendingRecoveryNotice } from "./recovery-notice.js";
import type { PreToolHookOutput } from "../types.js";
import {
  type HookContext,
  type HookDialect,
  detectHookDialect,
  normalizeHookContext,
} from "../types.js";

async function main(): Promise<void> {
  // Recursion guard: if we're running inside a subagent that we spawned,
  // exit immediately to avoid infinite recursion (subagent tool calls
  // would otherwise fire this hook again).
  if (process.env.CHATS_SANDBOX_NO_HOOK === "1") {
    process.exit(0);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");

  let ctx: HookContext;
  let dialect: HookDialect = "claude";
  try {
    const parsed = JSON.parse(raw);
    dialect = detectHookDialect(parsed);
    ctx = normalizeHookContext(parsed);
  } catch (e) {
    // Unparseable input: we genuinely cannot act on it. Allow, but say
    // so on stderr — a silent allow is how a broken hook hides.
    process.stderr.write(`[CHATS-Sandbox] could not parse hook input, allowing: ${e}\n`);
    process.exit(0);
  }

  let config;
  try {
    config = loadConfig();
  } catch (e) {
    process.stderr.write(`[CHATS-Sandbox] config load failed, allowing: ${e}\n`);
    process.exit(0);
  }

  if (!config.enabled) {
    process.exit(0);
  }

  // Evaluate rules. A deny that cannot be evaluated must FAIL CLOSED:
  // letting an evaluation error silently downgrade a deny to allow is
  // the worst failure mode for a guard. Backup-tier errors below are
  // allowed to fail open (a missed backup is recoverable-by-omission,
  // a wrongly-allowed destructive command is not), but the deny gate
  // itself blocks on error.
  let result;
  try {
    result = evaluate(ctx, config);
  } catch (e) {
    process.stderr.write(`[CHATS-Sandbox] rule evaluation failed — blocking to fail closed: ${e}\n`);
    const reason = `[CHATS-Sandbox] rule evaluation error; blocked to fail safe`;
    if (dialect === "cursor") {
      process.stdout.write(JSON.stringify({
        continue: false, permission: "deny",
        user_message: reason, agent_message: reason,
      }));
    } else {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      }));
    }
    process.exit(2);
  }

  if (config.verbose) {
    process.stderr.write(
      `[CHATS-Sandbox] ${ctx.tool_name}: ${result.decision} (${result.reason})\n`
    );
  }

  // ── DENY ─────────────────────────────────────────────────────────
  if (result.decision === "deny") {
    if (dialect === "cursor") {
      // Cursor's hook contract: top-level permission + messages.
      process.stdout.write(JSON.stringify({
        continue: false,
        permission: "deny",
        user_message: `[CHATS-Sandbox] ${result.reason}`,
        agent_message: `[CHATS-Sandbox] ${result.reason}`,
      }));
      process.exit(2);
    }
    const output: PreToolHookOutput = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `[CHATS-Sandbox] ${result.reason}`,
      },
    };
    process.stdout.write(JSON.stringify(output));
    process.exit(2);
  }

  // ── BACKUP ───────────────────────────────────────────────────────
  if (result.decision === "backup") {
    const backupResult = runBackup(ctx, config);

    const contextParts: string[] = [];

    // Recovery awareness: if a restore rewound the workspace since the
    // agent's last action, tell it ONCE, up front — backups are routine
    // but a recovery silently changes files the agent already read.
    const recovery = pendingRecoveryNotice(config);
    if (recovery) contextParts.push(recovery);

    // SUCCESS IS SILENT (config.notifyOnSuccess, default false).
    //
    // Narrating every successful backup is what destroyed this hook's
    // credibility in a measured run: 23 tool calls, 23 backup lines, most
    // byte-identical, 22 of them on pure reads. The agent concluded the
    // stream was a prompt injection and ignored the hook from then on —
    // including the warning on the one destructive call. The agent is told
    // ONCE, at session start (UserPromptSubmit), that backups happen
    // automatically; per-call confirmation adds nothing it can act on.
    //
    // Everything else is unchanged: the action folder, metadata.json, the
    // effect log and the timing ledger below are still written. Only the
    // agent-facing message goes away.
    if (config.notifyOnSuccess) {
      for (const artifact of backupResult.artifacts) {
        if (artifact.strategy === "policy_rewrite") continue;  // always reported below
        contextParts.push(
          `Backup: ${artifact.description} (${artifact.strategy})`
        );
      }
      // Continue-note: a tier-3 subagent recorded a reversal for this action
      // without touching the agent's session (the backup is written from the
      // cached pre-state). Reassure the main agent it can proceed normally.
      if (backupResult.artifacts.some((a) => a.strategy === "subagent")) {
        contextParts.push(
          "CHATS-Sandbox backed up this action (reversal recorded); continue."
        );
      }
    }

    // A TIER-0 REWRITE IS NEVER SILENT, whatever notifyOnSuccess says. This
    // is not "your backup succeeded" — it is "the command you are about to
    // run is not the command you wrote" (rm → mv to trash). The agent will
    // see the rewritten command execute and must know why, or the mismatch
    // between what it asked for and what ran is itself the thing that reads
    // as tampering. Always paired with updatedInput.
    for (const artifact of backupResult.artifacts) {
      if (artifact.strategy === "policy_rewrite") {
        contextParts.push(`Backup: ${artifact.description} (${artifact.strategy})`);
      }
    }

    // UNCERTAINTY IS NEVER SILENT. A subagent backup whose pre-state could
    // not be confirmed is recorded, but the agent must know the reversal
    // may not hold — this is the one case worth interrupting for, and it
    // previously went only to /dev/tty, where the agent never sees it.
    for (const artifact of backupResult.artifacts) {
      if (artifact.unverified) {
        contextParts.push(
          `BACKUP UNVERIFIED: pre-state for ${artifact.toolName} was not confirmed ` +
          `(${artifact.description.slice(0, 120)}). Treat this action as possibly irreversible.`
        );
      }
    }

    // If subagent is needed, add instructions for Claude to see. No
    // "[CHATS-Sandbox]" prefix here — the whole string is prefixed ONCE below
    // (the double prefix "[CHATS-Sandbox] [CHATS-Sandbox] SUBAGENT…" was a bug).
    if (backupResult.needsSubagent) {
      contextParts.push(
        `SUBAGENT BACKUP NEEDED: ${backupResult.subagentReason}`
      );
    }

    // No parts => nothing the agent can act on => NO message at all. The
    // old fallback ("No backup needed for X …") fired on every read and was
    // the single largest source of the identical-text loop.
    const contextMsg = contextParts.length > 0
      ? `[CHATS-Sandbox] ${contextParts.join("; ")}`
      : "";

    if (config.verbose) {
      process.stderr.write(
        (contextMsg || `[CHATS-Sandbox] ${ctx.tool_name}: backed up silently (notifyOnSuccess=false)`) + "\n"
      );
    }

    // Backup latency: the time this hook held up the agent between
    // emitting the tool call and its execution — process birth (node
    // boot included) to now. The user-facing "cost of safety" number.
    // All actions append to ONE ledger at the sandbox root
    // (.chats-sandbox/backup-timings.jsonl) so the record never counts
    // toward backup storage (storage accounting sums action_* dirs and
    // the shadow repo, both under backupDir; the ledger lives one level
    // up). Derive that root from config.backupDir — the SAME derivation
    // the dashboard uses (server.ts loadBackupTimings) — rather than
    // dirname(dirname(actionDir)), which silently lands in the
    // workspace if backupDir is set to a flat path. Append-only JSONL
    // keeps parallel-hook WRITES safe; the action-name key can still
    // collide under the known parallel seq-race (single session
    // serializes, so unaffected in practice).
    if (backupResult.actionDir) {
      try {
        const sandboxRoot = path.dirname(path.resolve(config.backupDir));
        fs.appendFileSync(
          path.join(sandboxRoot, "backup-timings.jsonl"),
          JSON.stringify({
            action: path.basename(backupResult.actionDir),
            addedLatencyMs: Math.round(Date.now() - performance.timeOrigin),
            recordedAt: new Date().toISOString(),
          }) + "\n",
        );
      } catch { /* non-fatal */ }
    }

    // Write timing info for post-tool hook. Field name is `backupId`
    // (singular) — post-tool reads `.backupId`; the old code wrote
    // `backupIds` (array) so the read was always undefined and no effect
    // was ever correlated to its backup. Path is scoped by a hash of
    // cwd+session, not a predictable `…-${session ?? "default"}.json`
    // in /tmp, so agents that send no session_id (hermes/openclaw/
    // openhands) on different projects no longer share one
    // world-writable file (cross-attribution / local-user pre-creation).
    try {
      fs.writeFileSync(timingFilePath(ctx), JSON.stringify({
        startTime: Date.now(),
        backupId: backupResult.artifacts[0]?.id ?? null,
        backupIds: backupResult.artifacts.map((a) => a.id),
        needsSubagent: backupResult.needsSubagent,
        // so post-tool can flag this backup if the action then FAILS (a failed
        // action mutated nothing — its backup is noise, excluded from cost).
        actionDir: backupResult.actionDir ?? null,
      }));
    } catch {
      // non-fatal
    }

    // Session sidecar for the dashboard. UserPromptSubmit also writes
    // this (with the prompt text), but not every agent wires that hook
    // — updating it here too means session identity works everywhere.
    try {
      const pathMod = require("node:path") as typeof import("node:path");
      const sandboxDir = pathMod.dirname(pathMod.resolve(config.backupDir));
      const sessionFile = pathMod.join(sandboxDir, "session.json");
      let prev: Record<string, unknown> = {};
      try { prev = JSON.parse(fs.readFileSync(sessionFile, "utf-8")); } catch { /* fresh */ }
      fs.writeFileSync(sessionFile, JSON.stringify({
        ...prev,
        session_id: ctx.session_id ?? prev.session_id ?? null,
        dialect,
        ts: new Date().toISOString(),
      }, null, 2) + "\n", "utf-8");
    } catch {
      // non-fatal
    }

    // Allow the tool call, inject backup info as context.
    // If a tier-0 policy rule rewrote the command (e.g. rm → mv to trash),
    // propagate the updatedInput so the agent runs the rewritten form.
    if (dialect === "cursor") {
      // Cursor's preToolUse contract: top-level permission, snake_case
      // updated_input, agent_message for context.
      process.stdout.write(JSON.stringify({
        continue: true,
        permission: "allow",
        ...(contextMsg ? { agent_message: contextMsg } : {}),
        ...(backupResult.updatedInput ? { updated_input: backupResult.updatedInput } : {}),
      }));
      process.exit(0);
    }
    // A silent success with no command rewrite has nothing to say — exit
    // without writing a hook response at all, so no empty additionalContext
    // reaches the transcript.
    if (!contextMsg && !backupResult.updatedInput) {
      process.exit(0);
    }
    const output: PreToolHookOutput = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        ...(contextMsg ? { additionalContext: contextMsg } : {}),
        ...(backupResult.updatedInput ? { updatedInput: backupResult.updatedInput } : {}),
      },
    };
    process.stdout.write(JSON.stringify(output));
    process.exit(0);
  }

  // ── PASS ─────────────────────────────────────────────────────────
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[CHATS-Sandbox] PreToolUse error: ${err}\n`);
  process.exit(0); // Never block on internal errors
});
