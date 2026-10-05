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

export function normalizeHookContext(parsed: unknown): HookContext {
  const p = (parsed && typeof parsed === "object"
    ? parsed : {}) as Record<string, unknown>;
  const hookEvent = canonicalEvent(p.hook_event ?? p.hook_event_name);
  let toolName = typeof p.tool_name === "string" ? p.tool_name : "";
  let toolInput = (p.tool_input && typeof p.tool_input === "object")
    ? p.tool_input as Record<string, unknown> : {};

  toolName = CODEX_TOOL_MAP[toolName] ?? toolName;
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
    cwd: typeof p.cwd === "string" ? p.cwd : undefined,
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
  /** Deny rules: regexes matched case-insensitively against a call's command or path. */
  denyPatterns: string[];
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
  personalization?: "high-impact" | "beyond-request" | "human-work";
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
   * (Claude Code runs claude, Codex runs codex, Hermes runs hermes).
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
}

// ── Default deny rules ───────────────────────────────────────────────
//
// Operations with no possible inverse (raw device writes, volume teardown, deleting the
// filesystem root, home or backup store) are blocked instead of backed up. Each pattern
// only fires when the destructive word is the command actually run.

/** Command-boundary prefix: start of input or after a shell separator, optionally via sudo/doas. */
const CMD_BOUNDARY =
  "(?:^|[;&|(]\\s*|\\n\\s*)(?:(?:sudo|doas)\\s+(?:-\\S+\\s+)*)?";

/** Default backup-store directory name; a relocated store is guarded by tier 1 instead. */
const STORE_DIR = "\\.backupper";

/**
 * Matches `rm` of `.backupper[/...]` anywhere in a command segment, but not similarly
 * named neighbours such as `.backupper-old`.
 */
const STORE_RM_PATTERN =
  CMD_BOUNDARY +
  "rm\\s+(?:[^\\s;&|]+\\s+)*?[\"']?(?:[^\\s;&|]*/)?" +
  STORE_DIR +
  "(?:/[^\\s;&|]*)?/?[\"']?(?=\\s|;|&|\\||$)";

/** A default deny rule: regex plus the explanation shown when it blocks. */
export interface DenyRule {
  pattern: string;
  /** What was blocked and why it cannot be made reversible. */
  why: string;
}

export const DEFAULT_DENY_RULES: readonly DenyRule[] = [
  {
    // mkfs with at least one argument.
    pattern: CMD_BOUNDARY + "mkfs(?:\\.[a-z0-9]+)?\\s+\\S",
    why:
      "mkfs was blocked: it writes a new filesystem over the target device, " +
      "so the previous contents are gone the moment it runs and no snapshot taken beforehand could be replayed onto it.",
  },
  {
    // wipefs erasing with -a/-o; listing and --no-act dry runs stay allowed.
    pattern:
      CMD_BOUNDARY +
      "wipefs\\s+(?![^;&|]*(?:-n\\b|--no-act\\b))[^;&|]*(?:-a\\b|--all\\b|-o\\b|--offset\\b)",
    why:
      "wipefs --all was blocked: it erases the partition table and filesystem signatures on the device, " +
      "and those superblocks are the only record of where the data begins — there is nothing left to restore from.",
  },
  {
    // dd writing to a block device; null/zero/std streams, ttys and ordinary files are excluded.
    pattern:
      CMD_BOUNDARY +
      "dd\\s+(?:[^;&|]*\\s)?of=[\"']?/dev/(?!null\\b|zero\\b|stdout\\b|stderr\\b|stdin\\b|tty\\b|full\\b|random\\b|urandom\\b|fd/|pts/)",
    why:
      "dd writing to a block device was blocked: it overwrites raw sectors underneath the filesystem, " +
      "which no file-level backup can capture and no recorded inverse can undo.",
  },
  {
    // shred overwrites then unlinks.
    pattern: CMD_BOUNDARY + "shred\\s+(?!-{1,2}(?:h|help|version)\\b)\\S",
    why:
      "shred was blocked: it overwrites the file's blocks in place with random data before unlinking it, " +
      "so the original bytes are destroyed at write time and cannot be recovered from the disk afterwards.",
  },
  {
    // LVM teardown; `--test` dry runs stay allowed.
    pattern:
      CMD_BOUNDARY +
      "(?:lv|vg|pv)remove\\s+(?![^;&|]*--test\\b)(?:-\\S+\\s+)*\\S",
    why:
      "an LVM remove (lvremove/vgremove/pvremove) was blocked: it destroys the volume metadata that maps logical extents to physical ones, " +
      "and without that mapping the extents on disk cannot be reassembled into the original volume.",
  },
  {
    // rm with flags whose target is exactly the filesystem root.
    pattern:
      CMD_BOUNDARY +
      "rm\\s+(?:-\\S+\\s+)+[\"']?/\\*?[\"']?(?:\\s|;|&|\\||$)",
    why:
      "a recursive delete of the filesystem root was blocked: it would destroy the per-action trash, the shadow repo and the restore tooling along with the system, " +
      "so there would be no surviving copy of anything to restore from.",
  },
  {
    // rm with flags whose target is the home directory itself.
    pattern:
      CMD_BOUNDARY +
      "rm\\s+(?:-\\S+\\s+)+[\"']?(?:~|\\$HOME|\\$\\{HOME\\})/?\\*?[\"']?(?:\\s|;|&|\\||$)",
    why:
      "a recursive delete of the entire home directory was blocked: it takes every project, credential and agent state directory at once, " +
      "including the sandbox's own backups, so nothing outside it holds a copy of what was deleted.",
  },
  {
    // Deleting the backup store, which every other restore depends on.
    pattern: STORE_RM_PATTERN,
    why:
      "a delete of the sandbox's own backup store (.backupper) was blocked: it holds the per-action trash, the shadow repo and the recovery commands " +
      "for everything already soft-deleted, so removing it is the one deletion that makes every earlier one permanent. " +
      "To drop backups deliberately use `backupper clear`, or `backupper uninstall` to remove the plugin.",
  },
];


/** Just the regexes, in the order they are evaluated. */
export const DEFAULT_DENY_PATTERNS: string[] = DEFAULT_DENY_RULES.map(
  (r) => r.pattern,
);

/** Pattern to explanation; user-added patterns fall back to showing the regex. */
export const DEFAULT_DENY_REASONS: Readonly<Record<string, string>> =
  Object.freeze(
    Object.fromEntries(DEFAULT_DENY_RULES.map((r) => [r.pattern, r.why])),
  );

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
  // Default deny list: only operations with no possible inverse.
  denyPatterns: [...DEFAULT_DENY_PATTERNS],
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
  /** file_copy only: the absolute path the copy was taken from, i.e. where restore writes it. */
  targetPath?: string;
  /** file_copy only: the container the file lives in, when it was copied out of one. */
  containerId?: string;
  /** Subagent only: the pre-state could not be confirmed; reported to the agent. */
  unverified?: boolean;
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
