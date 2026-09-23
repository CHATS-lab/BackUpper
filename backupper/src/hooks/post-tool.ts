#!/usr/bin/env node
/**
 * PostToolUse / PostToolUseFailure hook — fires after every Claude Code tool call.
 *
 * Captures effect manifest: what did this tool call actually change?
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../config/load.js";
import { captureEffect, logEffect } from "../engine/effects.js";
import { type HookContext, normalizeHookContext } from "../types.js";
import { timingFilePath } from "./timing-path.js";

async function main(): Promise<void> {
  // Recursion guard: exit early if running inside a sandbox-spawned subagent
  if (process.env.CHATS_SANDBOX_NO_HOOK === "1") {
    process.exit(0);
  }

  // Read context from stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");

  let ctx: HookContext;
  try {
    ctx = normalizeHookContext(JSON.parse(raw));
  } catch {
    process.exit(0);
  }

  const config = loadConfig();

  // Cache the last browser page view (snapshot/navigate) as PRE-state for the
  // backup subagent — it holds the original field value / entity content the
  // subagent needs to reverse an edit/delete. Independent of effect-manifest
  // logging below, so it runs whenever the plugin is enabled.
  if (config.enabled) {
    try {
      const { recordBrowserSnapshot } = require("../backup/strategies.js");
      recordBrowserSnapshot(ctx, config);
    } catch { /* best-effort — never block */ }

    // Post-tool cleanup: if the action FAILED, the backup the pre-tool hook
    // made is for a no-op (a fumbled/retried call mutated nothing). It's an
    // artifact of the agent fumbling, NOT a real cost of the backup method, so
    // we REMOVE the whole backup folder (disk → 0) AND drop its matching
    // backup-timings.jsonl entry (time → 0). MUST be before the effect-manifest
    // gate below so it runs even when effect logging is off. No-op when the
    // agent succeeds (the common case). Best-effort: never throw from the hook.
    try {
      const actionDir = loadTimingFile(ctx)?.actionDir;
      const success = ctx.hook_event === "PostToolUse";
      if (actionDir && actionFailed(ctx, success) && fs.existsSync(actionDir)) {
        const actionName = path.basename(actionDir);
        // 1) Disk: remove the whole failed-action backup folder.
        try { fs.rmSync(actionDir, { recursive: true, force: true }); } catch { /* ignore */ }
        // 2) Time: drop this action's entry from the central timing ledger.
        //    The ledger lives one level up from the backups dir (sandbox root)
        //    and each record carries `action` === the action folder basename
        //    (written by pre-tool.ts), so it is joinable by name.
        try {
          const ledger = path.join(path.dirname(path.dirname(actionDir)), "backup-timings.jsonl");
          if (fs.existsSync(ledger)) {
            const kept = fs.readFileSync(ledger, "utf-8")
              .split("\n")
              .filter((line) => {
                if (!line.trim()) return false;
                try { return (JSON.parse(line) as { action?: string }).action !== actionName; }
                catch { return true; } // keep unparseable lines untouched
              });
            fs.writeFileSync(ledger, kept.length ? kept.join("\n") + "\n" : "");
          }
        } catch { /* ignore */ }
        process.stderr.write(
          `[CHATS-Sandbox] removed failed-action backup folder ${actionName} for ${ctx.tool_name} (excluded from cost/restore)\n`,
        );
      }
    } catch { /* non-fatal */ }
  }

  if (!config.enabled || !config.effectManifest) {
    process.exit(0);
  }

  // Recover timing + backup ID from env (set by pre-tool hook in same session)
  // Note: in Claude Code, pre/post hooks are separate processes, so env vars
  // don't persist. We use a temp file instead.
  const startTime = readTiming(ctx) ?? Date.now();
  const backupId = readBackupId(ctx);

  // Capture and log the effect
  const effect = captureEffect(ctx, backupId, startTime);
  logEffect(effect, config);

  if (config.verbose) {
    process.stderr.write(
      `[CHATS-Sandbox] Effect logged: ${ctx.tool_name} ` +
      `(${effect.success ? "ok" : "fail"}, ${effect.durationMs}ms)\n`
    );
  }

  if (config.verbose) {
    const summary = buildEffectSummary(effect);
    if (summary) {
      process.stderr.write(summary + "\n");
    }
  }

  // Don't write to stdout — Claude Code's PostToolUse hook validation
  // is strict and rejects output that doesn't match its expected schema.
  // Effect logging is internal; no need to inject into the conversation.
  process.exit(0);
}

// ── Helpers ──────────────────────────────────────────────────────────

function buildEffectSummary(effect: {
  toolName: string;
  filesCreated?: string[];
  filesModified?: string[];
  filesDeleted?: string[];
  backupId?: string;
  success: boolean;
}): string | undefined {
  const parts: string[] = [];

  if (effect.filesCreated?.length) {
    parts.push(`created: ${effect.filesCreated.join(", ")}`);
  }
  if (effect.filesModified?.length) {
    parts.push(`modified: ${effect.filesModified.join(", ")}`);
  }
  if (effect.filesDeleted?.length) {
    parts.push(`deleted: ${effect.filesDeleted.join(", ")}`);
  }
  if (effect.backupId) {
    parts.push(`backup: ${effect.backupId}`);
  }

  if (parts.length === 0) return undefined;
  return `[CHATS-Sandbox] Effects: ${parts.join("; ")}`;
}

/**
 * Read timing info from a temp file (written by pre-tool hook).
 * Pre-tool and post-tool are separate processes, so we use the filesystem.
 */
interface TimingData {
  startTime: number;
  backupId: string | null;
  actionDir?: string | null;
}

/** Did the just-finished tool call FAIL / change nothing? PostToolUseFailure,
 *  a non-zero exit_code, or an MCP {"error":…} wrapper (NOT page "console
 *  errors", which live inside a `result`). A failed action mutated nothing, so
 *  its pre-tool backup is noise → flag it (excluded from cost/restore). */
function actionFailed(ctx: HookContext, success: boolean): boolean {
  if (!success) return true;
  // hermes sends tool_output as a JSON STRING (its bridge json.dumps the result
  // and never sets PostToolUseFailure); Claude sends an object. Parse a string
  // first so the error/exit_code checks below see the actual shape.
  let out: unknown = ctx.tool_output;
  if (typeof out === "string") {
    try { out = JSON.parse(out); } catch { return false; }
  }
  if (out && typeof out === "object") {
    const o = out as Record<string, unknown>;
    if (typeof o.exit_code === "number" && o.exit_code !== 0) return true;
    if (o.error != null && o.error !== "" && o.result == null) return true;
  }
  return false;
}

let _cachedTiming: TimingData | null = null;

function loadTimingFile(ctx: HookContext): TimingData | null {
  if (_cachedTiming !== null) return _cachedTiming;
  try {
    const tmpFile = timingFilePath(ctx);
    if (fs.existsSync(tmpFile)) {
      const data = JSON.parse(fs.readFileSync(tmpFile, "utf-8")) as TimingData;
      fs.unlinkSync(tmpFile); // consume it
      _cachedTiming = data;
      return data;
    }
  } catch {
    // ignore
  }
  return null;
}

function readTiming(ctx: HookContext): number | undefined {
  return loadTimingFile(ctx)?.startTime;
}

function readBackupId(ctx: HookContext): string | undefined {
  return loadTimingFile(ctx)?.backupId ?? undefined;
}

main().catch((err) => {
  process.stderr.write(`[CHATS-Sandbox] PostToolUse error: ${err}\n`);
  process.exit(0);
});
