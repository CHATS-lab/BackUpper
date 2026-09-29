#!/usr/bin/env node
/**
 * PostToolUse / PostToolUseFailure hook: runs after every tool call and
 * records what the call changed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../config/load.js";
import { captureEffect, logEffect } from "../engine/effects.js";
import { type HookContext, normalizeHookContext } from "../types.js";
import { timingFilePath } from "./timing-path.js";
import { adoptHostAgent } from "./host.js";

async function main(): Promise<void> {
  adoptHostAgent();
  // Recursion guard: exit early if running inside a sandbox-spawned subagent
  if (process.env.BACKUPPER_NO_HOOK === "1") {
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

  // Close the provenance record the pre-tool hook opened, with the outcome.
  try {
    if (config.enabled && config.personalization) {
      const payload = JSON.parse(raw);
      (ctx as any).provenance_action_id = payload.tool_use_id ?? payload.tool_call_id ?? payload.call_id;
      require("../backup/provenance.js").provenancePost(ctx, config);
    }
  } catch (e) { process.stderr.write("[provenance] " + String(e) + "\n"); }

  // Cache the last browser page view as pre-state for the backup subagent,
  // which needs the original content to reverse an edit or delete.
  if (config.enabled) {
    try {
      const { recordBrowserSnapshot } = require("../backup/strategies.js");
      recordBrowserSnapshot(ctx, config);
    } catch { /* best-effort — never block */ }

    // A failed action changed nothing, so delete its backup folder and its
    // timing-ledger entry. Runs even when effect logging is off; never throws.
    try {
      const actionDir = loadTimingFile(ctx)?.actionDir;
      const success = ctx.hook_event === "PostToolUse";
      if (actionDir && actionFailed(ctx, success) && fs.existsSync(actionDir)) {
        const actionName = path.basename(actionDir);
        // 1) Disk: remove the whole failed-action backup folder.
        try { fs.rmSync(actionDir, { recursive: true, force: true }); } catch { /* ignore */ }
        // 2) Time: drop the ledger record whose `action` equals the folder name.
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
          `[BackUpper] removed failed-action backup folder ${actionName} for ${ctx.tool_name} (excluded from cost/restore)\n`,
        );
      }
    } catch { /* non-fatal */ }
  }

  if (!config.enabled || !config.effectManifest) {
    process.exit(0);
  }

  // Recover timing and backup ID from the temp file written by the pre-tool hook.
  const startTime = readTiming(ctx) ?? Date.now();
  const backupId = readBackupId(ctx);

  // Capture and log the effect
  const effect = captureEffect(ctx, backupId, startTime);
  logEffect(effect, config);

  if (config.verbose) {
    process.stderr.write(
      `[BackUpper] Effect logged: ${ctx.tool_name} ` +
      `(${effect.success ? "ok" : "fail"}, ${effect.durationMs}ms)\n`
    );
  }

  if (config.verbose) {
    const summary = buildEffectSummary(effect);
    if (summary) {
      process.stderr.write(summary + "\n");
    }
  }

  // Write nothing to stdout: PostToolUse output is schema-validated.
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
  return `[BackUpper] Effects: ${parts.join("; ")}`;
}

/** Read (and consume) the timing file written by the pre-tool hook. */
interface TimingData {
  startTime: number;
  backupId: string | null;
  actionDir?: string | null;
}

/** True if the call failed: PostToolUseFailure, a non-zero exit_code, or an
 *  MCP {"error":…} wrapper. */
function actionFailed(ctx: HookContext, success: boolean): boolean {
  if (!success) return true;
  // Hermes sends tool_output as a JSON string; parse it before the checks.
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
  process.stderr.write(`[BackUpper] PostToolUse error: ${err}\n`);
  process.exit(0);
});
