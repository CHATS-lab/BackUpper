#!/usr/bin/env node
/**
 * The hook entry point, one subcommand per hook:
 *
 *   node hook.js pre      PreToolUse: evaluate the rules, run the tiered backup, emit the
 *                         hook response (exit 0 allows the call, 2 denies it)
 *   node hook.js post     PostToolUse / PostToolUseFailure: record what the call changed
 *   node hook.js prompt   UserPromptSubmit: the session briefing and the panel toggle
 *   node hook.js capture <src> <dest> [...]   chain-mode copy helper
 *
 * Every installed hook command also carries `--agent <name>` (see adoptHostAgent).
 */

import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { normalizeHookContext, storeDirOverride, type HookContext, type BackupArtifact, type SandboxConfig, type PreToolHookOutput } from "./types.js";
import * as fs from "node:fs";
import { readJson, storeRoot } from "./util.js";
import { readRestoreHistory } from "./restore/restore.js";
import { execFileSync, spawn } from "node:child_process";
import { configWarnings, getConfigPath, loadConfig } from "./config/load.js";
import { evaluateFailOpen, captureEffect, logEffect } from "./engine.js";
import { runBackup } from "./backup/strategies.js";
import { BRIEFING_CHECKER, render } from "./prompts.generated.js";
import { panelCommand, parsePanelPrompt } from "./cli.js";

// =============================================================================
// ── host ──
// =============================================================================

/**
 * Host-agent tag: each installed hook command carries `--agent <name>`, which is exported as
 * BACKUPPER_HOST_AGENT so the tier-4 subagent can default to the same CLI and login.
 */

export function adoptHostAgent(argv: string[] = process.argv): void {
  const i = argv.indexOf("--agent");
  const name = i >= 0 ? argv[i + 1] : undefined;
  if (name && /^[a-z-]+$/.test(name)) process.env.BACKUPPER_HOST_AGENT = name;
}

// =============================================================================
// ── timing path ──
// =============================================================================

/**
 * Path of the pre-tool → post-tool timing file, keyed by a hash of
 * (cwd, session_id) so both hooks agree and separate projects never collide.
 */

export function timingFilePath(ctx: HookContext): string {
  const key = `${process.cwd()}|${ctx.session_id ?? ""}`;
  const h = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), `backupper-timing-${h}.json`);
}

// =============================================================================
// ── deferred ──
// =============================================================================

/**
 * Chain-mode bookkeeping: a tier-1 artifact whose copies were prepended to the command
 * (`deferredCopies`) is only real if the host ran the command. When any copy is missing (the
 * call was denied, or never ran), the artifact is dropped from the action's metadata; an
 * action left with no artifacts is removed together with its timing-ledger line.
 */

export function settleDeferredCopies(actionDir: string | null | undefined): void {
  if (!actionDir) return;
  const metaPath = path.join(actionDir, "metadata.json");
  const artifacts = readJson<BackupArtifact[] | null>(metaPath, null);
  if (!Array.isArray(artifacts)) return;
  const kept = artifacts.filter((a) => !a.deferredCopies?.length || a.deferredCopies.every((p) => fs.existsSync(p)));
  if (kept.length === artifacts.length) return;
  if (kept.length > 0) {
    fs.writeFileSync(metaPath, JSON.stringify(kept, null, 2) + "\n", "utf-8");
    return;
  }
  const actionName = path.basename(actionDir);
  try { fs.rmSync(actionDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try {
    const ledger = path.join(path.dirname(path.dirname(actionDir)), "backup-timings.jsonl");
    if (fs.existsSync(ledger)) {
      const lines = fs.readFileSync(ledger, "utf-8").split("\n").filter((line) => {
        if (!line.trim()) return false;
        try { return (JSON.parse(line) as { action?: string }).action !== actionName; }
        catch { return true; }
      });
      fs.writeFileSync(ledger, lines.length ? lines.join("\n") + "\n" : "");
    }
  } catch { /* ignore */ }
}

// =============================================================================
// ── recovery notice ──
// =============================================================================

/**
 * One-line notice telling the main agent that a restore rewound the
 * workspace since its last action; a marker file shows it once per restore.
 */

function markerPath(config: SandboxConfig): string {
  return path.join(storeRoot(config), ".restore-seen");
}

/**
 * Return a notice for a restore not yet announced (updating the marker),
 * else null. Never throws.
 */
export function pendingRecoveryNotice(config: SandboxConfig): string | null {
  try {
    const history = readRestoreHistory(config, 5); // newest first
    if (history.length === 0) return null;
    const latest = history[0];

    const marker = markerPath(config);
    let lastSeen = "";
    try { lastSeen = fs.readFileSync(marker, "utf-8").trim(); } catch { /* none */ }
    if (latest.ts === lastSeen) return null; // already announced

    fs.writeFileSync(marker, latest.ts, "utf-8");

    const where = latest.seq !== null ? `action ${String(latest.seq).padStart(3, "0")}` : latest.action;
    const what = latest.fileOnly
      ? `\`${latest.fileOnly}\` restored`
      : `${latest.ok} file(s) restored`;
    const failed = latest.failed > 0 ? `, ${latest.failed} failed` : "";
    // No "[BackUpper]" prefix — the hook's contextMsg wrapper adds it.
    return `↩ Recovery: workspace rewound to ${where} (${what}${failed}). ` +
      `Re-read open files before editing — their contents may have changed.`;
  } catch {
    return null;
  }
}

// =============================================================================
// ── capture ──
// =============================================================================

/**
 * Chain-mode copy helper: `node hook.js capture <src> <dest> [<src> <dest> ...]`.
 *
 * In a non-bypass permission mode the pre-tool hook executes nothing and hands the host
 * `node hook.js capture ... && <original command>`. Claude Code checks each `&&` segment on its own
 * and path-checks `cp`/`mkdir` against its deny rules (BackUpper denies file tools under
 * .backupper/), so the copies run through this subcommand, which `backupper install claude-code`
 * allows. It copies only into a trash folder the hook has just recorded: every <dest> must be
 * listed in the `deferredCopies` of that action's metadata.json and must not exist yet.
 * Exit 1 on any refusal or failure, so `&&` keeps the original command from running.
 */

function fail(msg: string): never {
  process.stderr.write(`[BackUpper] capture: ${msg}\n`);
  process.exit(1);
}

/** `hook.js capture <src> <dest> [...]`. */
function captureMain(): void {
  const args = process.argv.slice(3);
  if (args.length === 0 || args.length % 2 !== 0) fail("expected <src> <dest> pairs");
  for (let i = 0; i < args.length; i += 2) {
    const src = args[i];
    const dest = args[i + 1];
    if (!path.isAbsolute(dest) || path.resolve(dest) !== dest) fail(`not a normalized absolute path: ${dest}`);
    const trash = path.dirname(dest);
    if (path.basename(trash) !== "trash") fail(`not a trash folder: ${trash}`);
    let listed = false;
    const meta = readJson<unknown>(path.join(path.dirname(trash), "metadata.json"), null);
    listed = Array.isArray(meta) && meta.some((a) => Array.isArray(a?.deferredCopies) && a.deferredCopies.includes(dest));
    if (!listed) fail(`${dest} is not a copy the hook recorded`);
    if (fs.existsSync(dest)) fail(`${dest} already exists`);
    try {
      fs.mkdirSync(trash, { recursive: true });
      execFileSync("cp", ["-a", "--", src, dest], { stdio: ["ignore", "ignore", "inherit"] });
    } catch (e) {
      fail(`copy of ${src} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// =============================================================================
// ── pre tool ──
// =============================================================================

/**
 * PreToolUse hook: runs before every tool call, evaluates the rules
 * (deny / backup / pass), runs the tiered backup when needed, and emits the
 * hook response. Exit code 0 allows the call; 2 denies it.
 */

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

async function preToolMain(): Promise<void> {
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
      require("./backup/provenance.js").provenancePre(ctx, config);
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

// =============================================================================
// ── post tool ──
// =============================================================================

/**
 * PostToolUse / PostToolUseFailure hook: runs after every tool call and
 * records what the call changed.
 */

async function postToolMain(): Promise<void> {
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
      require("./backup/provenance.js").provenancePost(ctx, config);
    }
  } catch (e) { process.stderr.write("[provenance] " + String(e) + "\n"); }

  // Cache the last browser page view as pre-state for the backup subagent,
  // which needs the original content to reverse an edit or delete.
  if (config.enabled) {
    try {
      const { recordBrowserSnapshot } = require("./backup/strategies.js");
      recordBrowserSnapshot(ctx, config);
    } catch { /* best-effort — never block */ }

    // A failed action that provably changed nothing: delete its backup folder and its
    // timing-ledger entry. A failed command may still have changed files (`printf x > f;
    // false`, `rm a missing`), so the backup is kept unless every capture still matches the
    // live state. Runs even when effect logging is off; never throws.
    // Chain mode: drop the claim of copies the host never ran (the call was denied).
    try { settleDeferredCopies(loadTimingFile(ctx)?.actionDir); } catch { /* non-fatal */ }

    try {
      const actionDir = loadTimingFile(ctx)?.actionDir;
      const success = ctx.hook_event === "PostToolUse";
      if (actionDir && actionFailed(ctx, success) && fs.existsSync(actionDir) &&
          provablyUnchanged(actionDir)) {
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

/** Byte-and-mode equality of two paths (recursively for directories); false on any doubt. */
function sameTree(a: string, b: string, budget = { n: 20_000 }): boolean {
  let sa: fs.Stats, sb: fs.Stats;
  try { sa = fs.lstatSync(a); sb = fs.lstatSync(b); } catch { return false; }
  if (--budget.n < 0) return false;
  if ((sa.mode & 0o170000) !== (sb.mode & 0o170000)) return false;
  if (sa.isSymbolicLink()) return fs.readlinkSync(a) === fs.readlinkSync(b);
  if ((sa.mode & 0o7777) !== (sb.mode & 0o7777)) return false;
  if (sa.isDirectory()) {
    const ea = fs.readdirSync(a).sort();
    const eb = fs.readdirSync(b).sort();
    if (ea.length !== eb.length || ea.some((x, i) => x !== eb[i])) return false;
    return ea.every((x) => sameTree(path.join(a, x), path.join(b, x), budget));
  }
  if (!sa.isFile() || sa.size !== sb.size) return false;
  return fs.readFileSync(a).equals(fs.readFileSync(b));
}

/** True when the workspace (and modes recorded with the snapshot) still match a snapshot commit. */
function workspaceMatchesSnapshot(a: BackupArtifact): boolean {
  const commit = a.commitHash ?? a.id;
  const shadow = a.artifactPath;
  if (!commit || !shadow || !fs.existsSync(shadow)) return false;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "backupper-chk-"));
  try {
    const opts = {
      cwd: process.cwd(), stdio: "pipe" as const, timeout: 30_000,
      env: { ...process.env, GIT_DIR: shadow, GIT_WORK_TREE: process.cwd(), GIT_INDEX_FILE: path.join(tmp, "index") },
    };
    execFileSync("git", ["read-tree", commit], opts);
    execFileSync("git", ["add", "-A"], opts);
    try { execFileSync("git", ["diff", "--cached", "--quiet", commit], opts); } catch { return false; }
  } catch {
    return false;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // Modes and owners git does not see.
  try {
    const meta = a.metaPath ? JSON.parse(fs.readFileSync(a.metaPath, "utf-8")) : null;
    for (const e of meta?.entries ?? []) {
      if (e.t === "l") continue;
      const st = fs.lstatSync(path.resolve(meta.root, e.p));
      if ((st.mode & 0o7777) !== e.mode || st.uid !== e.uid || st.gid !== e.gid) return false;
    }
  } catch { return false; }
  return true;
}

/**
 * True only when nothing the action's captures cover has changed since they were taken, so
 * dropping the backup of a failed call loses nothing. Anything that cannot be checked counts
 * as changed.
 */
function provablyUnchanged(actionDir: string): boolean {
  const artifacts = readJson<BackupArtifact[] | null>(path.join(actionDir, "metadata.json"), null);
  if (!Array.isArray(artifacts) || artifacts.length === 0) return false;
  if (fs.existsSync(path.join(actionDir, "incomplete.json"))) return false;
  for (const a of artifacts) {
    switch (a.strategy) {
      case "git_snapshot":
        if (!workspaceMatchesSnapshot(a)) return false;
        break;
      case "file_copy": {
        const target = typeof a.targetPath === "string" ? a.targetPath : null;
        if (!target || a.containerId || !sameTree(a.artifactPath, target)) return false;
        break;
      }
      case "policy_rewrite":
        // A rewrite already moved things itself; a copy-only capture is unchanged only when
        // every target still matches its copy.
        if (!a.backupOnly || !a.captures?.length) return false;
        if (!a.captures.every((c) => sameTree(c.copy, c.target))) return false;
        break;
      default:
        return false;
    }
  }
  return true;
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

// =============================================================================
// ── user prompt ──
// =============================================================================

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

interface PromptContext {
  hook_event?: string;
  prompt?: string;
  user_prompt?: string;
  message?: string;
  session_id?: string;
}

const MAX_LEN = 200;

async function userPromptMain(): Promise<void> {
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

/** argv that starts `backupper watch` from this install (hook.js lives in dist/, beside cli.js). */
function watchArgv(): string[] {
  return [process.execPath, path.join(__dirname, "cli.js"), "watch"];
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
    const child = spawn(process.execPath, [path.join(__dirname, "cli.js"), "panel", "on"], {
      cwd: process.cwd(), detached: true, stdio: "ignore",
    });
    child.on("error", () => { /* best effort */ });
    child.unref();
  } catch { /* never fail the hook */ }
}

/** The briefing text comes from prompts.md (briefing-checker) via prompts.generated.ts. */

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

// =============================================================================
// dispatch
// =============================================================================

switch (process.argv[2]) {
  case "pre":
    preToolMain().catch((err) => {
      process.stderr.write(`[BackUpper] PreToolUse error: ${err}\n`);
      process.exit(0); // Never block on internal errors
    });
    break;
  case "post":
    postToolMain().catch((err) => {
      process.stderr.write(`[BackUpper] PostToolUse error: ${err}\n`);
      process.exit(0);
    });
    break;
  case "prompt":
    userPromptMain().catch(() => {
      process.exit(0); // never block on internal errors
    });
    break;
  case "capture":
    captureMain();
    break;
  default:
    // Exit 1, not 2: a host reads 2 from a PreToolUse hook as "deny the call".
    process.stderr.write(`[BackUpper] usage: hook.js pre|post|prompt|capture [--agent <name>]\n`);
    process.exit(1);
}
