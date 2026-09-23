/**
 * CHATS-Sandbox type definitions.
 *
 * These mirror the JSON schema that Claude Code hooks send/receive.
 */

import * as _nodePath from "node:path";

/**
 * RELOCATE THE WHOLE STORE — `CHATS_SANDBOX_STORE_DIR`.
 *
 * Unset (the default, and the only shape the plugin had before): the store is
 * `<projectRoot>/.chats-sandbox`, i.e. INSIDE the agent's workspace.
 *
 * MEASURED PROBLEM. A task whose goal is "empty this directory" makes the agent
 * delete our record while doing its job. Across the corpus: 8 runs, 12 deletions
 * — `find -delete` x4, `mv` x5, `rm` x3 — and 3 action dirs are simply gone from
 * the collected runs. STORE_RM_PATTERN below only pins `rm`, so the other two
 * verbs walked straight through it; and a text regex cannot be made to cover
 * every verb (see the denylist note there). Moving the store off the workspace
 * removes it from the victim set instead of trying to enumerate the attackers.
 *
 * Set to an ABSOLUTE path: that path IS the store root — the exact replacement
 * for `<projectRoot>/.chats-sandbox`. config.json, backups/, effects.jsonl,
 * shadow-repo/, experiences/, subagent.log, checker.jsonl, declarations.jsonl,
 * current-instruction.txt and the tmp ledger all live under it, because every
 * one of them is derived from `dirname(resolve(config.backupDir))` and that is
 * what this moves.
 *
 * A relative value is IGNORED (falls back to the default). Resolving it would
 * make the store follow whatever cwd the hook process happened to start in,
 * which is the failure this exists to prevent; and a caller who meant a path
 * can always pass an absolute one.
 */
export function storeDirOverride(): string | undefined {
  const raw = String(process.env.CHATS_SANDBOX_STORE_DIR ?? "").trim();
  if (!raw || !_nodePath.isAbsolute(raw)) return undefined;
  return _nodePath.resolve(raw);
}

/** The store root the config defaults are built against. */
const _STORE_OVERRIDE = storeDirOverride();

// ── Hook input (what Claude Code sends on stdin) ─────────────────────

export interface HookContext {
  /** Which hook event fired */
  hook_event: "PreToolUse" | "PostToolUse" | "PostToolUseFailure";
  /** Tool name: "Bash", "FileEdit", "Write", etc. */
  tool_name: string;
  /** Tool arguments the LLM produced */
  tool_input: Record<string, unknown>;
  /** Tool output (only present in PostToolUse / PostToolUseFailure) */
  tool_output?: unknown;
  /** Session ID */
  session_id?: string;
  /** The directory the tool call runs in. Carried because the checker resolves\n   *  RELATIVE paths in the arguments against it, and agents write relative\n   *  paths almost exclusively. Every hook dialect sends it; this used to be\n   *  dropped in normalizeHookContext, so ctx.cwd was undefined at every call\n   *  site and resolution silently fell back to the hook process own cwd --\n   *  right where the hook runs in the container, wrong where it does not. */
  cwd?: string;
}

/**
 * Normalize a parsed hook-input object into the HookContext shape.
 *
 * Agents differ slightly in field names: Claude Code and the Hermes
 * plugin send `{hook_event, tool_output}`; the OpenHands SDK sends
 * `{event_type, tool_response}`. This accepts both so every agent
 * shares one downstream contract, and hardens against null/missing
 * tool_input (OpenHands types it `dict | null`).
 */
/**
 * Build a compact, human-readable label for a tool call —
 * "Bash(rm x)", "Write(/abs/file.txt)", etc. Picks the most relevant
 * arg per tool: command for shell tools, file path for editors, and a
 * trimmed JSON fallback so non-shell tools (Write/Edit/MCP) never
 * render empty parens.
 */
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

/** OpenHands SDK tool names → the Claude-Code names the backup logic
 *  keys on. Applied only to payloads in the SDK's shape (event_type),
 *  so other agents' identically-named tools are unaffected — Hermes
 *  and OpenClaw do this mapping in their plugins instead. */
const OPENHANDS_TOOL_MAP: Record<string, string> = {
  terminal: "Bash",
  file_editor: "Edit",
  planning_file_editor: "Edit",
  apply_patch: "Edit",
  glob: "Glob",
  grep: "Grep",
};

/** Codex CLI payload tool names → canonical. Codex already serializes
 *  shell as "Bash"; file edits arrive as "apply_patch". */
const CODEX_TOOL_MAP: Record<string, string> = {
  apply_patch: "Edit",
};

/** Cursor payload tool names → canonical. Cursor's shell tool has gone
 *  by several names across versions; map the known candidates. */
const CURSOR_TOOL_MAP: Record<string, string> = {
  Shell: "Bash",
  shell: "Bash",
  run_terminal_cmd: "Bash",
  read_file: "Read",
  edit_file: "Edit",
  write_file: "Write",
};

/**
 * Which hook dialect produced this payload — decides both tool-name
 * normalization and (in pre-tool.ts) the OUTPUT shape we must emit.
 *   claude    — Claude Code / Codex (hookSpecificOutput contract)
 *   openhands — OpenHands SDK (allow/deny only; event_type key)
 *   cursor    — Cursor (top-level {permission, updated_input} contract)
 */
export type HookDialect = "claude" | "openhands" | "cursor";

export function detectHookDialect(parsed: unknown): HookDialect {
  const p = (parsed && typeof parsed === "object"
    ? parsed : {}) as Record<string, unknown>;
  if (p.hook_event === undefined && typeof p.event_type === "string") {
    return "openhands";
  }
  // Cursor payloads carry conversation/generation ids and workspace
  // roots; Claude Code and Codex carry session_id/turn_id instead.
  if (p.conversation_id !== undefined || p.generation_id !== undefined ||
      p.workspace_roots !== undefined) {
    return "cursor";
  }
  return "claude";
}

/** Map dialect-specific event names ("preToolUse", "PreToolUse") onto
 *  the canonical PascalCase set. */
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
  const dialect = detectHookDialect(parsed);
  const hookEvent = canonicalEvent(p.hook_event ?? p.hook_event_name ?? p.event_type);
  let toolName = typeof p.tool_name === "string" ? p.tool_name : "";
  let toolInput = (p.tool_input && typeof p.tool_input === "object")
    ? p.tool_input as Record<string, unknown> : {};

  if (dialect === "openhands") {
    toolName = OPENHANDS_TOOL_MAP[toolName] ?? toolName;
    // MCP tool calls arrive as MCPToolAction.model_dump(): the real
    // arguments are NESTED under `data` ({data: {sql: ...}, kind:
    // "MCPToolAction"}). The gate's payload inspection reads top-level
    // keys (input.sql / input.command / input.query / input.path) — a
    // destructive UPDATE hidden under data.sql would be classified
    // not-backup-worthy and run unprotected. Flatten data up.
    if (
      toolInput.kind === "MCPToolAction" &&
      toolInput.data && typeof toolInput.data === "object" &&
      !Array.isArray(toolInput.data)
    ) {
      toolInput = { ...(toolInput.data as Record<string, unknown>) };
    }
  } else if (dialect === "cursor") {
    toolName = CURSOR_TOOL_MAP[toolName] ?? toolName;
    // Cursor's beforeShellExecution-style payloads put the command at
    // the top level; surface it as tool_input.command for the rules.
    if (toolInput.command === undefined && typeof p.command === "string") {
      toolInput = { ...toolInput, command: p.command };
      if (!toolName) toolName = "Bash";
    }
  } else {
    toolName = CODEX_TOOL_MAP[toolName] ?? toolName;
  }
  // Editor tools on several agents use "path" where Claude Code uses
  // "file_path" — mirror it so path-keyed logic sees the usual key.
  if (typeof toolInput.path === "string" && toolInput.file_path === undefined) {
    toolInput = { ...toolInput, file_path: toolInput.path };
  }

  return {
    hook_event: (hookEvent ?? "PreToolUse") as HookContext["hook_event"],
    tool_name: toolName,
    tool_input: toolInput,
    tool_output: p.tool_output ?? p.tool_response,
    session_id: typeof p.session_id === "string" ? p.session_id : undefined,
    // Dropped here, ctx.cwd is undefined everywhere and the checker
    // resolves relative paths against the hook process cwd instead.
    cwd: typeof p.cwd === "string" ? p.cwd : undefined,
  };
}

// ── Hook output (what we write to stdout) ────────────────────────────

export interface PreToolHookOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    /** "allow" | "deny" | "ask" */
    permissionDecision?: "allow" | "deny" | "ask";
    permissionDecisionReason?: string;
    /** Replace tool input before execution — Claude Code honors this to
     *  swap in our tier-0 rewrite (rm → mv-to-trash, etc.). */
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

/** THE MODE.
 *
 *  "checker" (default) — tiers 0-2 run on every call because they are
 *    mechanical and cost milliseconds; the tier-3 subagent — a model call at a
 *    median 21.7 s — fires when the READ-ONLY CHECKER says the call is not
 *    read-only, or when the agent wrote a `[Backup needed]` declaration.
 *    See backup/readonly_checker.ts.
 *
 *  "off" — nothing runs. The rule engine short-circuits to "pass" before the
 *    deny gate, so even denyPatterns are not consulted. Off means off.
 */
export type SandboxMode = "checker" | "off";

/** IS THE CHECKER ON? The mode, or the env override.
 *
 *  THIS LIVES IN types AND NOT IN backup/readonly_checker BECAUSE THE CALLER MUST
 *  BE ABLE TO ASK WITHOUT LOADING THE MODULE. It was in readonly_checker first,
 *  and strategies had to `require()` that module to reach it -- so a corrupt or
 *  half-deployed readonly_checker.js threw at load, hit the caller's fail-open
 *  catch, and turned every gated call into a spawn with the checker switched
 *  off. Measured 2026-08-27: corrupted module,
 *  CHATS_SANDBOX_READONLY_CHECKER=0 -> tier-3 subagent ran anyway
 *  (20.0s, real capture). Fail-open is right for a checker that ANSWERS badly;
 *  it is wrong for a checker nobody asked for. Asking here costs no module load.
 */
export function isReadOnlyCheckerEnabled(config?: { mode?: SandboxMode }): boolean {
  const env = String(process.env.CHATS_SANDBOX_READONLY_CHECKER ?? "").trim();
  if (env === "0" || env.toLowerCase() === "false") return false;
  if (env === "1" || env.toLowerCase() === "true") return true;
  return config?.mode === "checker";
}

export interface SandboxConfig {
  /** Master switch */
  enabled: boolean;
  /** THE MODE (default "checker") — see SandboxMode above. */
  mode: SandboxMode;
  /** Directory for backup artifacts */
  backupDir: string;
  /** Max action folders to keep before pruning oldest. 0 = disabled. */
  maxActions: number;
  /** Max total size of action folders in MB. 0 = disabled. Oldest pruned
   *  first until the total is under the cap. Does NOT include the shared
   *  shadow git repo (that has its own lifecycle). */
  maxTotalSizeMB: number;
  /** Max age of action folders in hours. 0 = disabled. Folders older
   *  than this are pruned, regardless of count. */
  maxAgeHours: number;
  /** Enable effect manifest logging */
  effectManifest: boolean;
  /** Path to effect log */
  effectLogPath: string;
  /** Deny rules (regex patterns, matched case-insensitively against the
   *  command / path of a tool call). Seeded from DEFAULT_DENY_PATTERNS;
   *  users may add their own or clear the list entirely. */
  denyPatterns: string[];
  /** Patterns that always require backup once the rule engine is reached
   *  (i.e. in any mode other than "off") */
  alwaysBackupPatterns: string[];
  /** Verbose logging */
  verbose: boolean;
  /** Enable tier-3 subagent backup for out-of-workspace actions */
  subagentEnabled: boolean;
  /** Live, in-session learned read-only store. When the tier-3 subagent
   *  returns a read-only verdict it may also record patterns; a later
   *  single simple command matching one of them skips the spawn.
   *  Session-scoped and invalidated by any change to the program's bytes.
   *  Positive only: it can remove a spawn, never add or suppress a backup
   *  that another tier would have made. Set false to spawn every time. */
  learnedReadOnlyEnabled: boolean;
  /** Model to use for the subagent ("haiku", "sonnet", "opus", "inherit") */
  subagentModel: "haiku" | "sonnet" | "opus" | "inherit";
  /** Max seconds to wait for the subagent before giving up */
  subagentTimeoutSeconds: number;
  /** Permission mode passed to claude -p for the subagent.
   *  "bypassPermissions" (default) — full freedom, needed for git push,
   *    curl, ssh, aws, gcloud, etc. Wide blast radius — only safe to
   *    use if you trust the parent prompt and your sandbox config.
   *  "acceptEdits" — auto-approve filesystem ops only (mkdir, cp, mv,
   *    sed, git). Blocks network calls and arbitrary shell. Smaller
   *    blast radius but may fail for backups that need network access.
   */
  subagentPermissionMode: "bypassPermissions" | "acceptEdits";
  /** Which runner spawns the tier-3 subagent.
   *  "claude"   — `claude -p` CLI (default; for Claude Code deployments).
   *  "hermes"   — headless `hermes chat` subagent (for Hermes
   *    deployments). The OpenRouter/provider API key is read from the
   *    environment of the parent process, never stored in config.
   *  "openclaw" — headless `openclaw agent --local` one-shot turn (for
   *    OpenClaw deployments). Provider keys come from the environment.
   *  "codex"    — headless `codex exec` one-shot turn (for Codex
   *    deployments). Uses the user's existing codex login. */
  subagentRunner: "claude" | "hermes" | "openclaw" | "codex" | "openhands";
  /** For subagentRunner="hermes": model id passed to `hermes chat -m`
   *  (e.g. "anthropic/claude-haiku-4.5"). Ignored for the claude runner. */
  subagentHermesModel: string;
  /** For subagentRunner="hermes": provider passed to `hermes chat
   *  --provider` (e.g. "openrouter"). Ignored for the claude runner. */
  subagentHermesProvider: string;
  /** For subagentRunner="openclaw": model id passed to `openclaw agent
   *  --model` (e.g. "openrouter/anthropic/claude-haiku-4.5"). Empty =
   *  the OpenClaw agent's own default model. */
  subagentOpenclawModel: string;
  /** For subagentRunner="openclaw": named agent id passed as `--agent`
   *  (e.g. "backup" — a lean agents.list entry with a minimal
   *  systemPromptOverride and a tool-group deny list; measured 17.4k ->
   *  5.8k fixed prefix per call). Empty = the default agent. The agent
   *  entry itself must exist in the OpenClaw config (the bench provisions
   *  it per run; real installs define their own). */
  subagentOpenclawAgent: string;
  /** For subagentRunner="codex": model id passed to `codex exec -m`
   *  (e.g. "gpt-5.5-codex"). Empty = codex's own default model. */
  subagentCodexModel: string;
  /** For subagentRunner="openhands": litellm model id for the SDK spawn
   *  (e.g. "openrouter/qwen/qwen3.6-35b-a3b"). Empty = falls back to
   *  subagentHermesModel prefixed for openrouter. */
  subagentOpenhandsModel: string;
  /** For subagentRunner="openhands": python interpreter with the
   *  openhands.sdk package importable (the SDK has no headless CLI).
   *  Empty = $CHATS_SANDBOX_OH_PY, else "python3". */
  subagentOpenhandsPython: string;
  /** Path to an MCP config JSON (claude `--mcp-config`) handed to the
   *  LIVE-RESTORE subagent only, so it can reverse remote/UI state through
   *  the same tools the agent used (e.g. a playwright browser). Not given
   *  to backup-time subagents — they would collide with the agent's still
   *  active browser. Empty/unset = no MCP servers for the subagent. */
  subagentMcpConfig?: string;
  /** Maps an MCP SERVER to the EXPERIENCE that covers it, for cases where
   *  the experience name differs from the tool's server — e.g. a website
   *  driven through the browser: `{ "playwright": "reddit" }`. At backup
   *  time the subagent looks up the action's server here to inject the right
   *  learned reversal patterns. Without an entry, the server name is used
   *  as the experience name (dedicated MCPs like postgres → postgres). */
  experienceForServer?: Record<string, string>;
  /** Optional STRONGER model for the live-restore subagent only (backup stays
   *  on subagentModel). Restore must perform precise multi-step UI actions a
   *  cheap model can't. For the claude runner: haiku|sonnet|opus; for hermes a
   *  full model id. Unset = use subagentModel for restore too. */
  subagentRestoreModel?: string;
  /** Narrate every SUCCESSFUL backup into the agent's context.
   *
   *  Default FALSE. Measured 2026-08-18: with this on, the PreToolUse hook
   *  emitted a backup line on all 23 tool calls of a run, most of them
   *  byte-identical, and 22 of the 23 were pure reads. The agent under test
   *  concluded the stream was a prompt injection ("a real hook wouldn't loop
   *  identical text regardless of command") and disregarded EVERY subsequent
   *  hook message — including the warning attached to the one genuinely
   *  destructive call. Over-reporting cost the tool its credibility with the
   *  agent it was protecting.
   *
   *  Turning it off changes ONLY the agent-facing message. Action folders,
   *  metadata.json, the effect log and the timing ledger are written exactly
   *  as before. Messages the agent can ACT on — subagent-needed, backup
   *  failed, BACKUP UNVERIFIED, deny decisions, recovery notices — are never
   *  suppressed by this flag. */
  notifyOnSuccess: boolean;
  /** Emit the one-time "you are armed with a backupper" briefing on the
   *  first UserPromptSubmit of a session (and only the first). Default TRUE.
   *  This is what replaces the per-call narration: the agent learns once
   *  that backups happen automatically and where the log is, instead of
   *  being told again on every tool call. */
  announceOnce: boolean;
}

// ── Default deny rules ───────────────────────────────────────────────
//
// The sandbox's whole premise is "make it reversible, don't refuse it":
// tiers 0-3 exist so a destructive command can be undone rather than
// blocked. That premise has a floor. A handful of operations have NO
// inverse — they overwrite raw device blocks, destroy volume metadata,
// or delete the filesystem root (including the trash, the shadow repo and
// the restore tooling itself). For those there is nothing to back up
// because there is nothing that could be restored, so blocking is the
// only honest answer. Tier 0 already refuses to rewrite them
// (`isDangerousPath` in backup/policy_rules.ts bails on `/`, `~`, and the
// system roots), which without this list left the LEAST recoverable
// operations with the LEAST protection.
//
// Kept deliberately small and tightly anchored: every pattern requires the
// dangerous word to be the command actually being RUN (start of input or
// straight after a shell separator, optionally through sudo/doas), and
// every pattern pins the specific destructive form. A false positive here
// blocks legitimate work, so near-misses like `rm -rf ./build`,
// `dd if=x of=./disk.img`, `dd of=/dev/null`, `rm -rf ~/project` and
// `wipefs /dev/sdb` (the read-only listing form) must all pass.
//
// Users can drop or extend the list: `chats-sandbox config set
// denyPatterns '[]'`.

/** Command-boundary prefix: start of input, or right after a shell
 *  separator/newline, optionally through a `sudo`/`doas` prefix and its
 *  flags. Anchors every default deny pattern so the word only fires when
 *  it is the command being invoked, not when it appears in a filename, a
 *  comment or a grep argument. */
const CMD_BOUNDARY =
  "(?:^|[;&|(]\\s*|\\n\\s*)(?:(?:sudo|doas)\\s+(?:-\\S+\\s+)*)?";

/** The default backup-store directory name. A deny pattern is a regex over
 *  command TEXT, so it can only pin the default layout; a store moved via
 *  `backupDir` is covered instead by the tier-0 store guard
 *  (excludeSandboxStore in backup/policy_rules_extra.ts), which reads the
 *  configured path. */
const STORE_DIR = "\\.chats-sandbox";

/** Appended to DEFAULT_DENY_RULES below — kept separate only because its
 *  regex is long. Matches `rm <flags> [other paths] .chats-sandbox[/…]`
 *  in any position within one command segment, absolute or relative,
 *  quoted or bare. Deliberately does NOT match a neighbouring path that
 *  merely starts with the same characters (`.chats-sandbox-old`). */
const STORE_RM_PATTERN =
  CMD_BOUNDARY +
  "rm\\s+(?:[^\\s;&|]+\\s+)*?[\"']?(?:[^\\s;&|]*/)?" +
  STORE_DIR +
  "(?:/[^\\s;&|]*)?/?[\"']?(?=\\s|;|&|\\||$)";

/** A default deny rule: the regex plus the neutral one-line explanation
 *  the hook shows when it blocks. */
export interface DenyRule {
  pattern: string;
  /** One neutral line: what was blocked and why it cannot be made
   *  reversible. Surfaced verbatim in the PreToolUse deny reason. */
  why: string;
}

export const DEFAULT_DENY_RULES: readonly DenyRule[] = [
  {
    // mkfs, mkfs.ext4, mkfs.xfs, … — needs at least one argument (bare
    // `mkfs` only prints usage).
    pattern: CMD_BOUNDARY + "mkfs(?:\\.[a-z0-9]+)?\\s+\\S",
    why:
      "mkfs was blocked: it writes a new filesystem over the target device, " +
      "so the previous contents are gone the moment it runs and no snapshot taken beforehand could be replayed onto it.",
  },
  {
    // wipefs only erases with -a/--all or -o/--offset; the bare
    // `wipefs /dev/sdb` form just LISTS signatures and stays allowed.
    // A --no-act dry run is likewise allowed.
    pattern:
      CMD_BOUNDARY +
      "wipefs\\s+(?![^;&|]*(?:-n\\b|--no-act\\b))[^;&|]*(?:-a\\b|--all\\b|-o\\b|--offset\\b)",
    why:
      "wipefs --all was blocked: it erases the partition table and filesystem signatures on the device, " +
      "and those superblocks are the only record of where the data begins — there is nothing left to restore from.",
  },
  {
    // dd writing to a real block device. The character devices that are
    // legitimate sinks (/dev/null, /dev/zero, the std streams, ttys, pty
    // slaves) are excluded, as is any ordinary file (`of=./disk.img`).
    pattern:
      CMD_BOUNDARY +
      "dd\\s+(?:[^;&|]*\\s)?of=[\"']?/dev/(?!null\\b|zero\\b|stdout\\b|stderr\\b|stdin\\b|tty\\b|full\\b|random\\b|urandom\\b|fd/|pts/)",
    why:
      "dd writing to a block device was blocked: it overwrites raw sectors underneath the filesystem, " +
      "which no file-level backup can capture and no recorded inverse can undo.",
  },
  {
    // shred's entire purpose is unrecoverable overwrite-then-unlink.
    pattern: CMD_BOUNDARY + "shred\\s+(?!-{1,2}(?:h|help|version)\\b)\\S",
    why:
      "shred was blocked: it overwrites the file's blocks in place with random data before unlinking it, " +
      "so the original bytes are destroyed at write time and cannot be recovered from the disk afterwards.",
  },
  {
    // LVM teardown. `--test` dry runs stay allowed.
    pattern:
      CMD_BOUNDARY +
      "(?:lv|vg|pv)remove\\s+(?![^;&|]*--test\\b)(?:-\\S+\\s+)*\\S",
    why:
      "an LVM remove (lvremove/vgremove/pvremove) was blocked: it destroys the volume metadata that maps logical extents to physical ones, " +
      "and without that mapping the extents on disk cannot be reassembled into the original volume.",
  },
  {
    // `rm -rf /`, `rm -fr /*`, `rm -rf --no-preserve-root /`. Requires at
    // least one flag AND a target that is exactly the filesystem root, so
    // `rm -rf /tmp/junk` and `rm -rf ./build` are untouched.
    pattern:
      CMD_BOUNDARY +
      "rm\\s+(?:-\\S+\\s+)+[\"']?/\\*?[\"']?(?:\\s|;|&|\\||$)",
    why:
      "a recursive delete of the filesystem root was blocked: it would destroy the per-action trash, the shadow repo and the restore tooling along with the system, " +
      "so there would be no surviving copy of anything to restore from.",
  },
  {
    // `rm -rf ~`, `rm -rf ~/`, `rm -rf ~/*`, `rm -rf $HOME`,
    // `rm -rf "${HOME}"`. A path INSIDE the home dir (`rm -rf ~/project`)
    // is a normal tier-0 rm-to-trash and is untouched.
    pattern:
      CMD_BOUNDARY +
      "rm\\s+(?:-\\S+\\s+)+[\"']?(?:~|\\$HOME|\\$\\{HOME\\})/?\\*?[\"']?(?:\\s|;|&|\\||$)",
    why:
      "a recursive delete of the entire home directory was blocked: it takes every project, credential and agent state directory at once, " +
      "including the sandbox's own backups, so nothing outside it holds a copy of what was deleted.",
  },
  {
    // Deleting the backup store itself. Every other destructive command
    // is reversible BECAUSE this directory exists; deleting it is the one
    // action whose inverse it would have been. Tier 0 cannot rewrite it
    // either — the store is the mv target, so `mv <store> <store>/…/trash`
    // is a move into a subdirectory of itself.
    pattern: STORE_RM_PATTERN,
    why:
      "a delete of the sandbox's own backup store (.chats-sandbox) was blocked: it holds the per-action trash, the shadow repo and the recovery commands " +
      "for everything already soft-deleted, so removing it is the one deletion that makes every earlier one permanent. " +
      "To drop backups deliberately use `chats-sandbox clear`, or `chats-sandbox uninstall` to remove the plugin.",
  },
];


/** Just the regexes, in the order they are evaluated. */
export const DEFAULT_DENY_PATTERNS: string[] = DEFAULT_DENY_RULES.map(
  (r) => r.pattern,
);

/** Pattern → neutral explanation, for the deny reason the hook emits.
 *  User-added patterns are absent here and fall back to showing the
 *  regex itself. */
export const DEFAULT_DENY_REASONS: Readonly<Record<string, string>> =
  Object.freeze(
    Object.fromEntries(DEFAULT_DENY_RULES.map((r) => [r.pattern, r.why])),
  );

export const DEFAULT_CONFIG: SandboxConfig = {
  enabled: true,
  mode: "checker",
  // The store root, and everything derived from it, moves as one when
  // CHATS_SANDBOX_STORE_DIR names an absolute path (see storeDirOverride).
  // Unset -> the byte-identical literal this always was.
  backupDir: _STORE_OVERRIDE ? _nodePath.join(_STORE_OVERRIDE, "backups") : ".chats-sandbox/backups",
  maxActions: 50,
  // Size and age retention default OFF — keep maxActions as the only
  // enabled limit unless the user opts in.
  maxTotalSizeMB: 0,
  maxAgeHours: 0,
  effectManifest: true,
  effectLogPath: _STORE_OVERRIDE ? _nodePath.join(_STORE_OVERRIDE, "effects.jsonl") : ".chats-sandbox/effects.jsonl",
  // A small, conservative default deny list covering the operations that
  // have no possible inverse (see DEFAULT_DENY_RULES above). Everything
  // else stays reversible-not-blocked. Users can extend or clear it via
  // `chats-sandbox config`.
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
  // Tier-3 subagent is enabled by default. It shells out to `claude -p
  // --model haiku` when an out-of-workspace action is detected that
  // no targeted manifest can cover. Users who want zero subagent
  // overhead can disable it via `chats-sandbox config set subagentEnabled false`.
  subagentEnabled: true,
  // Live read-only learning. Implemented and tested, but DEFAULT OFF on
  // the measurement, not on principle. Measured over the real corpora
  // (35 runs / 420 Bash calls with backup ground truth; 1,162 runs /
  // 23,383 Bash calls without):
  //   - only 5.9% (large corpus) / 13.7% (ground-truth corpus) of tier-3
  //     spawns are single simple commands at all, so that is the hard
  //     ceiling on any saving, whatever the patterns say;
  //   - a maximally generous `<program> **` model realises 2.7% / 9.4%;
  //   - of the commands that saving covers, 100% carried a backupId, and
  //     the dominant shape is a read-only `--dry-run` or `status` call
  //     teaching a pattern that then swallows the `--apply` beside it —
  //     present in 18+ distinct runs.
  // A ~3% spawn saving does not buy that. Set true to enable; the
  // acceptance test (`allot --state released --json` skips,
  // `allot release --apply` does not) holds when the subagent writes an
  // option-set pattern, and fails when it writes `<program> **`.
  learnedReadOnlyEnabled: false,
  subagentModel: "haiku",
  // Measured: warm `claude -p` backups take 20-35s, but a cold start can
  // exceed 90s — 60s timed out in stress testing, losing the backup.
  subagentTimeoutSeconds: 120,
  // Default to bypassPermissions so the subagent has full freedom to
  // run any backup commands it needs (git push, curl, ssh, etc.).
  // Users who want a smaller blast radius can switch to "acceptEdits"
  // via `chats-sandbox config set subagentPermissionMode acceptEdits`.
  subagentPermissionMode: "bypassPermissions",
  // Default runner is the claude CLI. `chats-sandbox install hermes`
  // overwrites this with "hermes" so non-Claude agents get a working
  // tier-3 subagent.
  subagentRunner: "claude",
  subagentHermesModel: "anthropic/claude-haiku-4.5",
  subagentHermesProvider: "openrouter",
  // Empty = use the OpenClaw agent's default model for the subagent.
  subagentOpenclawModel: "",
  subagentOpenclawAgent: "",
  subagentOpenhandsModel: "",
  subagentOpenhandsPython: "",
  // Empty = use codex's default model for the subagent.
  subagentCodexModel: "",
  // Silent on success; announce once at session start. See the field docs
  // on SandboxConfig for the measurement that set these defaults.
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
  strategy: "file_copy" | "git_tag" | "pip_freeze" | "npm_list" | "env_snapshot" | "git_snapshot" | "subagent" | "policy_rewrite" | "learned_rule";
  /** Where the backup artifact lives */
  artifactPath: string;
  /** Size in bytes (if applicable) */
  sizeBytes?: number;
  /** Commands the subagent ran to create this backup (tier 3 only) */
  subagentCommands?: string[];
  /** The original action that was about to execute (for restore context) */
  originalAction?: string;
  /** Full git commit hash (for git_snapshot strategy — references shared shadow repo) */
  commitHash?: string;
  /** Subagent-only: if true, the recorded subagentCommands are NOT a
   *  reliable inverse (e.g. remote state that drifts). On restore, the
   *  plugin will spawn a fresh subagent to reason about current state
   *  rather than executing the canned commands. */
  liveRestore?: boolean;
  /** Subagent-only (live_restore=false): the EXACT MCP tool call(s) that
   *  deterministically reverse a remote action, recorded by the backup
   *  agent as structured data. On restore they are replayed verbatim via
   *  the MCP (tools/call) — never via psql/curl or any direct binary.
   *  Each entry names the `tool` and its `args`; `server` is optional
   *  (defaults to the action's own server). */
  recoveryMcpCalls?: Array<{ server?: string; tool: string; args: Record<string, unknown> }>;
  /** policy_rewrite-only: commands that reverse the rewrite. Runs via
   *  execSync on restore — same contract as subagent's recovery_commands. */
  recoveryCommands?: string[];
  /** policy_rewrite-only: the rule id that fired (for debugging, UI). */
  policyRuleId?: string;
  /** Subagent-only: the backup was recorded but its pre-state could not be
   *  confirmed (the subagent said UNVERIFIED, or produced no recovery
   *  commands and no recovery MCP calls). Surfaced to the agent inline —
   *  successful backups are silent, uncertain ones are not. */
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
