/** Type definitions for the BackUpper hook contract and its configuration. */

import * as path from "node:path";

/**
 * Absolute store directory from BACKUPPER_STORE_DIR, used instead of `<projectRoot>/.backupper`.
 * Relative values are ignored so the store cannot follow the hook's cwd.
 */
export function storeDirOverride(): string | undefined {
  const raw = String(process.env.BACKUPPER_STORE_DIR ?? "").trim();
  if (!raw || !path.isAbsolute(raw)) return undefined;
  return path.resolve(raw);
}

/** The store root the config defaults are built against. */
const STORE_OVERRIDE = storeDirOverride();

// ── Hook input (what Claude Code sends on stdin) ─────────────────────

export interface HookContext {
  /** Which hook event fired */
  hook_event: "PreToolUse" | "PostToolUse" | "PostToolUseFailure";
  /** Tool name: "Bash", "FileEdit", "Write", etc. */
  tool_name: string;
  /** Tool arguments produced by the agent */
  tool_input: Record<string, unknown>;
  /** Tool output (only present in PostToolUse / PostToolUseFailure) */
  tool_output?: unknown;
  /** Session ID */
  session_id?: string;
  /** Working directory of the tool call; relative paths in the arguments resolve against it. */
  cwd?: string;
  /**
   * The host's permission mode for this call (`bypassPermissions`, `default`, `acceptEdits`,
   * ...), when the host reports one. Selects how tier 1 hands its rewrite back (see
   * agents.ts tier1Mode).
   */
  permission_mode?: string;
}

/** Compact label for a tool call, e.g. "Bash(rm x)"; picks the most relevant argument per tool. */
export function describeToolAction(
  toolName: string,
  toolInput: Record<string, unknown>,
): string {
  const ti = toolInput ?? {};
  const pick = (k: string): string | undefined =>
    typeof ti[k] === "string" && (ti[k] as string).length > 0 ? (ti[k] as string) : undefined;
  const arg =
    pick("command") ??
    pick("file_path") ?? pick("path") ?? pick("target") ?? pick("destination") ??
    pick("url") ?? pick("element") ??
    (Object.keys(ti).length ? JSON.stringify(ti) : "");
  return `${toolName}(${String(arg).slice(0, 200)})`;
}

/** Tool-name map for Codex payloads; file edits arrive as "apply_patch". */
const CODEX_TOOL_MAP: Record<string, string> = {
  apply_patch: "Edit",
};

/** Tool-name map for DeepSeek Harness payloads (its bridge passes dsh's own tool names). */
const DSH_TOOL_MAP: Record<string, string> = {
  bash: "Bash",
  write: "Write",
  edit: "Edit",
  read: "Read",
  glob: "Glob",
  grep: "Grep",
};

/** Maps dialect-specific event names onto the canonical PascalCase set. */
function canonicalEvent(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  const k = raw.toLowerCase().replace(/[^a-z]/g, "");
  if (k === "pretooluse") return "PreToolUse";
  if (k === "posttooluse") return "PostToolUse";
  if (k === "posttoolusefailure") return "PostToolUseFailure";
  if (k === "userpromptsubmit") return "UserPromptSubmit";
  return raw;
}

/**
 * OpenHands payloads carry `event_type` and `working_dir`, and its file tools take a `command`
 * that names the operation; map them onto the Claude Code tools and fields.
 */
function openHandsTool(name: string, input: Record<string, unknown>): [string, Record<string, unknown>] {
  if (name === "terminal") return ["Bash", input];
  if (name === "apply_patch") return ["Edit", { ...input, command: input.patch }];
  if (name === "write_file") return ["Write", input];
  if (name === "read_file") return ["Read", input];
  if (name === "edit") return ["Edit", input];
  if (name !== "file_editor" && name !== "planning_file_editor") return [name, input];
  const { command, file_text, old_str, new_str, ...rest } = input;
  if (command === "view") return ["Read", rest];
  if (command === "create") return ["Write", { ...rest, content: file_text }];
  return ["Edit", { ...rest, old_string: old_str, new_string: new_str }];
}

export function normalizeHookContext(parsed: unknown): HookContext {
  const p = (parsed && typeof parsed === "object"
    ? parsed : {}) as Record<string, unknown>;
  const openHands = typeof p.event_type === "string";
  const hookEvent = canonicalEvent(p.hook_event ?? p.hook_event_name ?? p.event_type);
  let toolName = typeof p.tool_name === "string" ? p.tool_name : "";
  let toolInput = (p.tool_input && typeof p.tool_input === "object")
    ? p.tool_input as Record<string, unknown> : {};

  if (openHands) [toolName, toolInput] = openHandsTool(toolName, toolInput);
  toolName = CODEX_TOOL_MAP[toolName] ?? toolName;
  if (process.env.BACKUPPER_HOST_AGENT === "deepseek-harness") {
    // str_replace_editor views, creates and edits under one name; only `view` is a read.
    if (toolName === "str_replace_editor") toolName = toolInput.command === "view" ? "Read" : "Edit";
    toolName = DSH_TOOL_MAP[toolName] ?? toolName;
  }
  // Mirror `path` to `file_path` so path-keyed logic sees the usual key.
  if (typeof toolInput.path === "string" && toolInput.file_path === undefined) {
    toolInput = { ...toolInput, file_path: toolInput.path };
  }

  return {
    hook_event: (hookEvent ?? "PreToolUse") as HookContext["hook_event"],
    tool_name: toolName,
    tool_input: toolInput,
    tool_output: p.tool_output ?? p.tool_response,
    session_id: typeof p.session_id === "string" ? p.session_id : undefined,
    cwd: typeof p.cwd === "string" ? p.cwd : typeof p.working_dir === "string" ? p.working_dir : undefined,
    ...(typeof p.permission_mode === "string" ? { permission_mode: p.permission_mode } : {}),
  };
}

// ── Hook output (written to stdout) ──────────────────────────────────

export interface PreToolHookOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    /** "allow" | "deny" | "ask" */
    permissionDecision?: "allow" | "deny" | "ask";
    permissionDecisionReason?: string;
    /** Replacement tool input, used for the tier-1 rewrite (e.g. rm to mv-to-trash). */
    updatedInput?: Record<string, unknown>;
    /** Extra context injected into the conversation */
    additionalContext?: string;
  };
}

export interface PostToolHookOutput {
  hookSpecificOutput: {
    hookEventName: "PostToolUse" | "PostToolUseFailure";
    additionalContext?: string;
  };
}

// ── Sandbox config ───────────────────────────────────────────────────

/**
 * Operating mode.
 * "checker": tiers 1-3 run on every call; the tier-4 subagent runs when the read-only checker
 * says the call is not read-only or the agent declared `[BACKUP NEEDED]`. "off": nothing runs.
 */
export type SandboxMode = "checker" | "off";

/**
 * Whether the read-only checker is enabled, from the environment override or the mode.
 * Defined here so callers need not load backup/readonly_checker.
 */
export function isReadOnlyCheckerEnabled(config?: { mode?: SandboxMode }): boolean {
  const env = String(process.env.BACKUPPER_READONLY_CHECKER ?? "").trim();
  if (env === "0" || env.toLowerCase() === "false") return false;
  if (env === "1" || env.toLowerCase() === "true") return true;
  return config?.mode === "checker";
}

/** A CLI that can run the tier-4 subagent. */
export type SubagentRunnerName = "claude" | "codex" | "hermes";

export interface SandboxConfig {
  /** Master switch */
  enabled: boolean;
  /** Operating mode (default "checker"). */
  mode: SandboxMode;
  /** Directory for backup artifacts */
  backupDir: string;
  /** Max action folders to keep before pruning oldest. 0 = disabled. */
  maxActions: number;
  /** Max total size of action folders in MB (0 = disabled); excludes the shadow git repo. */
  maxTotalSizeMB: number;
  /** Max age of action folders in hours (0 = disabled). */
  maxAgeHours: number;
  /** Enable effect manifest logging */
  effectManifest: boolean;
  /** Path to effect log */
  effectLogPath: string;
  /** Patterns that always require a backup unless the mode is "off". */
  alwaysBackupPatterns: string[];
  /** Verbose logging */
  verbose: boolean;
  /** Enable tier-4 subagent backup for out-of-workspace actions */
  subagentEnabled: boolean;
  /**
   * Session-scoped store of read-only patterns learned from tier-4 verdicts; a matching
   * simple command skips the spawn. Invalidated when the program's bytes change.
   */
  learnedReadOnlyEnabled: boolean;
  /** Run one reflection turn after a successful tier-4 backup. */
  selfImproving: boolean;
  /** After reflection writes a rule, run one more turn that generalises it to sibling operations. */
  selfImprovingGeneralize: boolean;
  /** Path of the versioned learned-rule table; relative paths resolve from cwd. */
  learnedBackupRulesPath: string;
  /** Reflection-only runner and model overrides; empty reuses the backup subagent's. */
  reflectionSubagentRunner: "" | SubagentRunnerName;
  reflectionSubagentModel: string;
  /**
   * Model for the tier-4 subagent, passed to the runner's model flag. Empty uses the runner's
   * own default (the model the user configured for that CLI).
   */
  subagentModel: string;
  /**
   * Per-runner model used when `subagentModel` is empty, e.g. `{ "claude": "haiku" }`. A runner
   * with no entry uses its own default model.
   */
  subagentModels: Partial<Record<SubagentRunnerName, string>>;
  /** Max seconds to wait for the subagent before giving up */
  subagentTimeoutSeconds: number;
  /**
   * Personalization preference: a preference-scoped checker decides whether the action touches
   * protected state, and the preference becomes the tier-4 capture scope.
   */
  personalization?: "high-impact" | "beyond-request" | "human-work" | "custom";
  /** The user's own preference text, used when personalization is "custom". */
  personalizationPolicy?: string;
  /** Every user turn delivered so far, oldest first (evidence for the checker). */
  personalizationUserRequests?: string[];
  /** The current turn's instruction (evidence for the checker). */
  personalizationCurrentInstruction?: string;
  /** Set per spawn by the tiers: the scope text the subagent receives. */
  personalizationCaptureScope?: string;
  /**
   * Permission mode for the claude subagent: "bypassPermissions" (full access) or "acceptEdits"
   * (filesystem edits only).
   */
  subagentPermissionMode: "bypassPermissions" | "acceptEdits";
  /**
   * CLI that runs the tier-4 subagent. "auto" follows the agent whose hook fired
   * (Claude Code runs claude, Codex runs codex, Hermes runs hermes, OpenClaw runs claude).
   */
  subagentRunner: "auto" | SubagentRunnerName;
  /** Provider for the hermes runner (`hermes chat --provider`); empty uses hermes's configured one. */
  subagentProvider: string;
  /**
   * MCP config JSON given only to the live-restore subagent so it can reverse remote state
   * through the agent's tools.
   */
  subagentMcpConfig?: string;
  /**
   * Maps an MCP server name to the experience that covers it, e.g. `{ "playwright": "shop" }`;
   * unmapped servers use their own name.
   */
  experienceForServer?: Record<string, string>;
  /** Optional stronger model for the live-restore subagent; unset reuses subagentModel. */
  subagentRestoreModel?: string;
  /**
   * Report each successful backup to the agent (default false). Failures, unverified backups,
   * denials and recovery notices are always reported.
   */
  notifyOnSuccess: boolean;
  /** Show the one-time backup briefing on the first UserPromptSubmit of a session (default true). */
  announceOnce: boolean;
  /** Open the `backupper watch` side panel once at the start of each agent session. */
  panel: boolean;
}

/** Default tier-4/checker model per runner: the CLI's cheapest current tier. */
export const DEFAULT_SUBAGENT_MODELS: Readonly<Partial<Record<SubagentRunnerName, string>>> =
  Object.freeze({ claude: "haiku", codex: "gpt-6-luna" });

export const DEFAULT_CONFIG: SandboxConfig = {
  enabled: true,
  mode: "checker",
  // The store root follows BACKUPPER_STORE_DIR when it names an absolute path.
  backupDir: STORE_OVERRIDE ? path.join(STORE_OVERRIDE, "backups") : ".backupper/backups",
  maxActions: 50,
  // Size and age retention are off by default.
  maxTotalSizeMB: 0,
  maxAgeHours: 0,
  effectManifest: true,
  effectLogPath: STORE_OVERRIDE ? path.join(STORE_OVERRIDE, "effects.jsonl") : ".backupper/effects.jsonl",
  alwaysBackupPatterns: [
    "rm\\s",
    "git\\s+push",
    "git\\s+rebase",
    "git\\s+reset",
    "git\\s+commit\\s+--amend",
    "pip\\s+install",
    "pip\\s+uninstall",
    "npm\\s+install",
    "npm\\s+uninstall",
    "apt\\s+install",
    "apt\\s+remove",
    "docker\\s+rm",
    "DROP\\s+TABLE",
    "TRUNCATE",
    "DELETE\\s+FROM",
  ],
  verbose: false,
  // Tier-4 subagent enabled by default.
  subagentEnabled: true,
  // Live read-only learning, off by default.
  learnedReadOnlyEnabled: false,
  selfImproving: false,
  selfImprovingGeneralize: false,
  learnedBackupRulesPath: ".backupper/learned-backup-rules.json",
  reflectionSubagentRunner: "",
  reflectionSubagentModel: "",
  subagentModel: "",
  // Cheap per-runner defaults for tier 4 and the checker; hermes keeps its provider's default.
  subagentModels: { ...DEFAULT_SUBAGENT_MODELS },
  // Allows for cold starts of the subagent CLI.
  subagentTimeoutSeconds: 120,
  // Full permissions so the subagent can run any backup command.
  subagentPermissionMode: "bypassPermissions",
  // Follow the host agent's own CLI and login.
  subagentRunner: "auto",
  subagentProvider: "",
  // Silent on success; announce once at session start.
  notifyOnSuccess: false,
  announceOnce: true,
  panel: false,
};

// ── Backup artifact ──────────────────────────────────────────────────

export interface BackupArtifact {
  /** Unique ID */
  id: string;
  /** ISO timestamp */
  timestamp: string;
  /** What triggered the backup */
  trigger: "rule" | "precaution" | "always";
  /** Tool that was about to run */
  toolName: string;
  /** Human-readable description of what was backed up */
  description: string;
  /** Strategy used */
  strategy:
    | "file_copy"
    | "git_tag"
    | "pip_freeze"
    | "npm_list"
    | "env_snapshot"
    | "git_snapshot"
    | "subagent"
    | "policy_rewrite"
    | "learned_rule";
  /** Where the backup artifact lives */
  artifactPath: string;
  /** Size in bytes (if applicable) */
  sizeBytes?: number;
  /** Commands the subagent ran to create this backup (tier 4 only) */
  subagentCommands?: string[];
  /** The original action that was about to execute (for restore context) */
  originalAction?: string;
  /** Full git commit hash (for git_snapshot strategy — references shared shadow repo) */
  commitHash?: string;
  /**
   * Subagent only: recorded commands are not a reliable inverse, so restore spawns a fresh
   * subagent to reason about current state.
   */
  liveRestore?: boolean;
  /**
   * Subagent only: exact MCP tool calls that reverse a remote action, replayed via tools/call
   * on restore. `server` defaults to the action's own server.
   */
  recoveryMcpCalls?: Array<{ server?: string; tool: string; args: Record<string, unknown> }>;
  /** policy_rewrite only: commands that reverse the rewrite, run on restore. */
  recoveryCommands?: string[];
  /** policy_rewrite only: id of the rule that fired. */
  policyRuleId?: string;
  /**
   * policy_rewrite only: the rule captured pre-state and executed nothing; the host ran the
   * original command (backup-only mode, or a record-and-pass rule).
   */
  backupOnly?: boolean;
  /**
   * policy_rewrite only (chain mode): the copies the hook prepended to the original command
   * with `&&` instead of taking them itself. They exist only if the host ran the command; the
   * hooks drop the artifact when any is missing (the call was denied or never ran).
   */
  deferredCopies?: string[];
  /** file_copy only: the absolute path the copy was taken from, i.e. where restore writes it. */
  targetPath?: string;
  /** file_copy only: the container the file lives in, when it was copied out of one. */
  containerId?: string;
  /** Subagent only: the pre-state could not be confirmed; reported to the agent. */
  unverified?: boolean;
  /** policy_rewrite (copy-only) only: each target and the copy taken of it before the call. */
  captures?: Array<{ target: string; copy: string }>;
  /**
   * git_snapshot: file holding the modes, owners, empty directories and stash list recorded
   * with this snapshot (git keeps none of them). subagent: the modes/owners of the files its
   * external-shadow commit holds.
   */
  metaPath?: string;
  /** policy_rewrite only: captured from one segment of a compound command (copy-only). */
  segment?: string;
}

/**
 * Written as `incomplete.json` in an action folder when part of the call's effect was not
 * captured by any tier: `list`/`show` flag the action and `restore` names what it cannot bring back.
 */
export interface IncompleteCapture {
  /** Why the capture is incomplete. */
  reason: string;
  /** The command segments (or tool call) whose effect was not captured. */
  segments: string[];
  /** Paths those segments name, resolved where possible; may be empty when unknown. */
  paths: string[];
}

// ── Effect manifest entry ────────────────────────────────────────────

export interface EffectEntry {
  /** ISO timestamp */
  timestamp: string;
  /** Session ID */
  sessionId?: string;
  /** Tool name */
  toolName: string;
  /** Tool input summary */
  toolInput: Record<string, unknown>;
  /** Exit code (for Bash) */
  exitCode?: number;
  /** Files created/modified/deleted */
  filesCreated?: string[];
  filesModified?: string[];
  filesDeleted?: string[];
  /** Backup artifact ID (if backup was taken) */
  backupId?: string;
  /** Duration in ms */
  durationMs?: number;
  /** Whether the tool succeeded */
  success: boolean;
}
