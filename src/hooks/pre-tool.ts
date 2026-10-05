#!/usr/bin/env node
/**
 * PreToolUse hook: runs before every tool call, evaluates the rules
 * (deny / backup / pass), runs the tiered backup when needed, and emits the
 * hook response. Exit code 0 allows the call; 2 denies it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { configWarnings, getConfigPath, loadConfig } from "../config/load.js";
import { evaluateFailOpen } from "../engine/rules.js";
import { runBackup } from "../backup/strategies.js";
import { timingFilePath } from "./timing-path.js";
import { pendingRecoveryNotice } from "./recovery-notice.js";
import type { PreToolHookOutput } from "../types.js";
import { type HookContext, normalizeHookContext } from "../types.js";
import { adoptHostAgent } from "./host.js";
import { settleDeferredCopies } from "./deferred.js";
import { storeRoot } from "../store/layout.js";

/** Append one line to .backupper/hook-errors.log (next to the backups directory). Best-effort. */
function logHookError(config: { backupDir: string }, ctx: HookContext, message: string): void {
  try {
    const rootDir = storeRoot(config);
    fs.mkdirSync(rootDir, { recursive: true });
    fs.appendFileSync(
      path.join(rootDir, "hook-errors.log"),
      JSON.stringify({ at: new Date().toISOString(), hook: "PreToolUse", tool: ctx.tool_name, message }) + "\n",
    );
  } catch { /* logging must never block the call */ }
}

/**
 * Report config.json problems (a file that does not parse, wrong value types, invalid regexes)
 * on stderr and in hook-errors.log, once per problem for a given version of the file: a
 * problem already logged against the same file mtime is not repeated on every tool call.
 */
function warnConfigOnce(config: { backupDir: string }, ctx: HookContext): void {
  let warnings: string[];
  let mtime = 0;
  try {
    warnings = configWarnings();
    if (warnings.length === 0) return;
    mtime = Math.round(fs.statSync(getConfigPath()).mtimeMs);
  } catch {
    return;
  }
  let logged = "";
  const logFile = path.join(storeRoot(config), "hook-errors.log");
  try {
    const st = fs.statSync(logFile);
    const fd = fs.openSync(logFile, "r");
    const len = Math.min(st.size, 64 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    logged = buf.toString("utf-8");
  } catch { /* no log yet */ }
  for (const w of warnings) {
    const message = `config warning: ${w}`;
    const key = JSON.stringify({ message, configMtime: mtime }).slice(1, -1);
    if (logged.includes(key)) continue;
    process.stderr.write(`[BackUpper] ${message}\n`);
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, JSON.stringify({
        at: new Date().toISOString(), hook: "PreToolUse", tool: ctx.tool_name, message, configMtime: mtime,
      }) + "\n");
    } catch { /* logging must never block the call */ }
  }
}

async function main(): Promise<void> {
  adoptHostAgent();
  // Recursion guard: skip tool calls made by a subagent this plugin spawned.
  if (process.env.BACKUPPER_NO_HOOK === "1") {
    process.exit(0);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");

  let ctx: HookContext;
  try {
    const parsed = JSON.parse(raw);
    ctx = normalizeHookContext(parsed);
  } catch (e) {
    // Unparseable input: allow, and report it on stderr.
    process.stderr.write(`[BackUpper] could not parse hook input, allowing: ${e}\n`);
    process.exit(0);
  }

  let config;
  try {
    config = loadConfig();
  } catch (e) {
    process.stderr.write(`[BackUpper] config load failed, allowing: ${e}\n`);
    process.exit(0);
  }

  warnConfigOnce(config, ctx);

  if (!config.enabled) {
    process.exit(0);
  }

  // Record what this call is about to touch, for personalization provenance.
  try {
    if (config.personalization) {
      const payload = JSON.parse(raw);
      (ctx as any).provenance_action_id = payload.tool_use_id ?? payload.tool_call_id ?? payload.call_id;
      require("../backup/provenance.js").provenancePre(ctx, config);
    }
  } catch (e) { process.stderr.write("[provenance] " + String(e) + "\n"); }

  // Evaluate rules. An engine error fails open (the call is allowed and the error is
  // logged); the deny list is still checked on that path.
  const result = evaluateFailOpen(ctx, config);
  if (result.error) {
    const outcome = result.decision === "deny" ? "deny list still applied" : "allowing the call";
    process.stderr.write(`[BackUpper] rule evaluation failed, ${outcome}: ${result.error}\n`);
    logHookError(config, ctx, `rule evaluation failed (${outcome}): ${result.error}`);
  }

  if (config.verbose) {
    process.stderr.write(
      `[BackUpper] ${ctx.tool_name}: ${result.decision} (${result.reason})\n`
    );
  }

  // ── DENY ─────────────────────────────────────────────────────────
  if (result.decision === "deny") {
    const output: PreToolHookOutput = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `[BackUpper] ${result.reason}`,
      },
    };
    process.stdout.write(JSON.stringify(output));
    process.exit(2);
  }

  // ── BACKUP ───────────────────────────────────────────────────────
  if (result.decision === "backup") {
    // A timing file no post-tool hook consumed belongs to a call that never ran (e.g. the user
    // denied it); drop any chain-mode copies it claimed before this call replaces the file.
    try {
      const stale = JSON.parse(fs.readFileSync(timingFilePath(ctx), "utf-8")) as { actionDir?: string | null };
      settleDeferredCopies(stale.actionDir);
    } catch { /* no leftover */ }

    const backupResult = runBackup(ctx, config);

    // A backup-only tier-1 rule found the backup store in the victim set of a command it
    // cannot rewrite: block the call.
    if (backupResult.deny) {
      const output: PreToolHookOutput = {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `[BackUpper] ${backupResult.deny}`,
        },
      };
      process.stdout.write(JSON.stringify(output));
      process.exit(2);
    }

    const contextParts: string[] = [];

    // Tell the agent once if a restore rewound the workspace since its last action.
    const recovery = pendingRecoveryNotice(config);
    if (recovery) contextParts.push(recovery);

    // Successful backups are silent unless config.notifyOnSuccess is set;
    // the action folder, metadata, effect log and timings are still written.
    if (config.notifyOnSuccess) {
      for (const artifact of backupResult.artifacts) {
        if (artifact.strategy === "policy_rewrite" && !artifact.backupOnly) continue;  // reported below
        contextParts.push(
          `Backup: ${artifact.description} (${artifact.strategy})`
        );
      }
      // Tell the agent that a tier-4 reversal was recorded and it can proceed.
      if (backupResult.artifacts.some((a) => a.strategy === "subagent")) {
        contextParts.push(
          "BackUpper backed up this action (reversal recorded); continue."
        );
      }
    }

    // A tier-1 rewrite is always reported, since the command that runs
    // differs from the one the agent wrote. A backup-only capture changes nothing the agent
    // sees, so it follows notifyOnSuccess like the other tiers.
    for (const artifact of backupResult.artifacts) {
      if (artifact.strategy === "policy_rewrite" && !artifact.backupOnly) {
        contextParts.push(`Backup: ${artifact.description} (${artifact.strategy})`);
      }
    }

    // A subagent backup whose pre-state could not be confirmed is always reported.
    for (const artifact of backupResult.artifacts) {
      if (artifact.unverified) {
        contextParts.push(
          `BACKUP UNVERIFIED: pre-state for ${artifact.toolName} was not confirmed ` +
          `(${artifact.description.slice(0, 120)}). Treat this action as possibly irreversible.`
        );
      }
    }

    // Subagent instructions (the whole message is prefixed once below).
    if (backupResult.needsSubagent) {
      contextParts.push(
        `SUBAGENT BACKUP NEEDED: ${backupResult.subagentReason}`
      );
    }

    // No parts means no message.
    const contextMsg = contextParts.length > 0
      ? `[BackUpper] ${contextParts.join("; ")}`
      : "";

    if (config.verbose) {
      process.stderr.write(
        (contextMsg || `[BackUpper] ${ctx.tool_name}: backed up silently (notifyOnSuccess=false)`) + "\n"
      );
    }

    // Append this hook's latency to .backupper/backup-timings.jsonl,
    // located from config.backupDir so it is not counted as backup storage.
    if (backupResult.actionDir) {
      try {
        const sandboxRoot = storeRoot(config);
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

    // Write timing info for the post-tool hook, at a path scoped by a hash
    // of cwd and session.
    try {
      fs.writeFileSync(timingFilePath(ctx), JSON.stringify({
        startTime: Date.now(),
        backupId: backupResult.artifacts[0]?.id ?? null,
        backupIds: backupResult.artifacts.map((a) => a.id),
        needsSubagent: backupResult.needsSubagent,
        // Lets post-tool mark this backup as noise if the action fails.
        actionDir: backupResult.actionDir ?? null,
      }));
    } catch {
      // non-fatal
    }

    // Allow the call with backup context, propagating any tier-1 updatedInput.
    // Nothing to report and no rewrite: exit without a hook response.
    if (!contextMsg && !backupResult.updatedInput) {
      process.exit(0);
    }
    // Codex applies `updatedInput` only together with permissionDecision "allow" (otherwise it
    // discards the output and runs the original command, executing the effect twice). In Codex,
    // "allow" does not bypass its approval policy or sandbox, which run on the rewritten
    // command. Claude Code is not given "allow": there it would skip the permission check.
    const codexAllow = backupResult.updatedInput && process.env.BACKUPPER_HOST_AGENT === "codex";
    const output: PreToolHookOutput = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        ...(codexAllow ? { permissionDecision: "allow" as const } : {}),
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
  process.stderr.write(`[BackUpper] PreToolUse error: ${err}\n`);
  process.exit(0); // Never block on internal errors
});
