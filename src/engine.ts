/**
 * The rule engine (deny / backup / pass for one tool call) and the effect log.
 */

import { DEFAULT_DENY_PATTERNS, DEFAULT_DENY_REASONS, type HookContext, type SandboxConfig, type EffectEntry } from "./types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { appendJsonl } from "./util.js";

// =============================================================================
// ── rules ──
// =============================================================================

/**
 * Rule engine — decides whether a tool call needs backup, denial, or pass-through.
 *
 * Order: deny rules, precaution flag, read-only skip, destructive-pattern list,
 * then default backup. Unrecognized actions are backed up unless mode="off".
 */

export type Decision = "deny" | "backup" | "pass";

export interface RuleResult {
  decision: Decision;
  reason: string;
  trigger: "deny_rule" | "backup_rule" | "precaution_field" | "default_backup" | "none";
}

/** Tools that are read-only — never need backup */
const READ_ONLY_TOOLS = new Set([
  "Read",
  "read_file",
  "search_files",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "TodoRead",
  "process",   // process list/poll — read-only
]);

/**
 * True when `backupper` is the invoked program (by basename) of some
 * shell segment, ignoring leading NAME=value assignments.
 */
export function invokesBackUpper(command: string): boolean {
  for (const seg of command.split(/(?:&&|\|\||[|;&\n])/)) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_]\w*=/.test(tokens[i])) i++;
    const argv0 = tokens[i];
    if (!argv0) continue;
    const base = argv0.split("/").pop() ?? argv0;
    if (base === "backupper") return true;
  }
  return false;
}

export function evaluate(ctx: HookContext, config: SandboxConfig): RuleResult {
  const toolName = ctx.tool_name;
  const toolInput = ctx.tool_input;

  // mode="off" passes every call, before deny patterns are consulted.
  if (config.mode === "off") {
    return { decision: "pass", reason: "mode=off", trigger: "none" };
  }

  const commandStr = extractCommandString(toolName, toolInput);

  // ── 1. Deny rules ──────────────────────────────────────────────
  const denied = matchDeny(commandStr, config.denyPatterns);
  if (denied) return denied;

  // ── 2. Precaution field (LLM self-declared) ────────────────────
  if (toolInput.precaution === true || toolInput.precaution === "true") {
    return {
      decision: "backup",
      reason: `LLM set precaution=true for ${toolName}`,
      trigger: "precaution_field",
    };
  }

  // ── 3. Skip read-only tools ────────────────────────────────────
  if (READ_ONLY_TOOLS.has(toolName)) {
    return {
      decision: "pass",
      reason: `${toolName} is read-only`,
      trigger: "none",
    };
  }

  // ── 3b. Skip our own CLI commands (they manage backups, not create risk) ──
  if (toolName === "Bash" && invokesBackUpper(commandStr)) {
    return {
      decision: "pass",
      reason: "backupper CLI command (internal)",
      trigger: "none",
    };
  }

  // ── 4. Rule-based checklist ────────────────────────────────────
  if (isFileMutatingTool(toolName)) {
    return {
      decision: "backup",
      reason: `${toolName} is a file-mutating tool`,
      trigger: "backup_rule",
    };
  }

  for (const pattern of config.alwaysBackupPatterns) {
    try {
      if (new RegExp(pattern, "i").test(commandStr)) {
        return {
          decision: "backup",
          reason: `Matched backup rule: /${pattern}/`,
          trigger: "backup_rule",
        };
      }
    } catch {
      // Invalid regex — skip
    }
  }

  // ── 5. Default: backup everything not explicitly read-only ─────
  // Unknown actions are backed up; strategies choose the cheapest approach.
  return {
    decision: "backup",
    reason: `Default backup for unrecognized action: ${toolName}`,
    trigger: "default_backup",
  };
}

/** The deny verdict for `commandStr`, or null when no pattern matches. Invalid regexes are skipped. */
function matchDeny(commandStr: string, patterns: readonly string[]): RuleResult | null {
  for (const pattern of patterns) {
    try {
      if (new RegExp(pattern, "i").test(commandStr)) {
        // Use the shipped explanation if any, else name the matching regex.
        const why = DEFAULT_DENY_REASONS[pattern];
        return {
          decision: "deny",
          reason: why ?? `Blocked by deny rule: /${pattern}/`,
          trigger: "deny_rule",
        };
      }
    } catch {
      // Invalid regex — skip
    }
  }
  return null;
}

/**
 * `evaluate`, but an internal error fails open: the call is allowed and the error is
 * returned for logging. The deny list is still checked on that path (the configured
 * patterns when they are a list of strings, else the shipped ones), so an operation
 * with no inverse stays blocked even when the rest of the engine breaks.
 */
export function evaluateFailOpen(
  ctx: HookContext,
  config: SandboxConfig,
  evaluator: (ctx: HookContext, config: SandboxConfig) => RuleResult = evaluate,
): RuleResult & { error?: string } {
  try {
    return evaluator(ctx, config);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    if (config?.mode !== "off") {
      try {
        const patterns = Array.isArray(config?.denyPatterns) &&
          config.denyPatterns.every((p) => typeof p === "string")
          ? config.denyPatterns : DEFAULT_DENY_PATTERNS;
        const input = ctx?.tool_input && typeof ctx.tool_input === "object" ? ctx.tool_input : {};
        const denied = matchDeny(extractCommandString(String(ctx?.tool_name ?? ""), input), patterns);
        if (denied) return { ...denied, error };
      } catch { /* fall through to allow */ }
    }
    return { decision: "pass", reason: `rule evaluation failed, allowed: ${error}`, trigger: "none", error };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function extractCommandString(
  toolName: string,
  toolInput: Record<string, unknown>
): string {
  switch (toolName) {
    case "Bash":
      return String(toolInput.command ?? "");
    case "FileEdit":
    case "Write":
    case "write_file":
    case "patch":
      return String(toolInput.path ?? toolInput.file_path ?? "");
    default:
      return JSON.stringify(toolInput);
  }
}

function isFileMutatingTool(toolName: string): boolean {
  const mutators = new Set([
    "FileEdit",
    "Write",
    "write_file",
    "patch",
    "NotebookEdit",
  ]);
  return mutators.has(toolName);
}

// =============================================================================
// ── effects ──
// =============================================================================

/**
 * Effect manifest logger: records, heuristically from tool name and input,
 * what each tool call changed.
 */

/**
 * Build an effect entry from a PostToolUse context.
 */
export function captureEffect(
  ctx: HookContext,
  backupId: string | undefined,
  startTime: number
): EffectEntry {
  const entry: EffectEntry = {
    timestamp: new Date().toISOString(),
    sessionId: ctx.session_id,
    toolName: ctx.tool_name,
    toolInput: ctx.tool_input,
    success: ctx.hook_event === "PostToolUse",
    backupId,
    durationMs: Date.now() - startTime,
  };

  // Extract effect details from tool output
  const output = ctx.tool_output;
  if (typeof output === "object" && output !== null) {
    const out = output as Record<string, unknown>;
    if (typeof out.exit_code === "number") {
      entry.exitCode = out.exit_code;
    }
  }

  // Infer file effects from tool name + input
  const filePath = String(
    ctx.tool_input.path ?? ctx.tool_input.file_path ?? ""
  );

  switch (ctx.tool_name) {
    case "Write":
    case "write_file":
      if (filePath) {
        entry.filesCreated = [filePath];
      }
      break;
    case "FileEdit":
    case "patch":
      if (filePath) {
        entry.filesModified = [filePath];
      }
      break;
    case "Bash": {
      const cmd = String(ctx.tool_input.command ?? "");
      // Simple heuristic: detect rm commands
      const rmMatch = cmd.match(/\brm\s+(?:-\w+\s+)*(.+)/);
      if (rmMatch) {
        entry.filesDeleted = [rmMatch[1].trim()];
      }
      break;
    }
  }

  return entry;
}

/**
 * Append an effect entry to the JSONL log file.
 */
export function logEffect(entry: EffectEntry, config: SandboxConfig): void {
  if (!config.effectManifest) return;

  appendJsonl(path.resolve(config.effectLogPath), entry);
}
