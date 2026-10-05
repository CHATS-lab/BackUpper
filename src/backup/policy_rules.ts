/**
 * Tier-1 command-rewriting rules.
 *
 * Rewrite mode (hosts that apply a rewritten tool input: Claude Code, Hermes, Codex): a matching
 * call is rewritten into a recoverable form, e.g. `rm -rf path` becomes a move into the
 * action folder's trash, and the agent runs a no-op in its place.
 *
 * Backup-only mode (BACKUPPER_NO_REWRITE=1, an unknown host, or a compound command segment):
 * a rule captures the pre-state (a copy, a saved sha, a dump) without executing or moving
 * anything, and the host runs the original command unchanged.
 *
 * Either way the recorded recovery commands reverse the effect on restore. Trash lives in
 * the action folder, so retention pruning also expires it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { HookContext } from "../types.js";
import {
  EXTRA_RULES,
  copyVictimsToTrash,
  excludeSandboxStore,
  logTier1Note,
  storeDenyReason,
  stripShellComment,
} from "./policy_rules_extra.js";
import { foreignExecTarget, type ForeignExecTarget } from "./exec_target.js";
import { uniqueCaptureName } from "./fsmeta.js";

export interface PolicyRuleResult {
  /**
   * Rewritten tool input, returned to the hook as `updatedInput`. Absent in backup-only
   * mode, where the host runs the original command.
   */
  updatedInput?: Record<string, unknown>;
  /** True when the rule only captured pre-state and executed nothing (backup-only mode). */
  backupOnly?: boolean;
  /**
   * Backup-only mode: the call must be blocked (the only way left to keep the backup store
   * out of a victim set when the command cannot be rewritten). The reason is shown to the agent.
   */
  deny?: string;
  /** Commands run before returning updatedInput (e.g. the move to trash). */
  preCommands: string[];
  /**
   * Copy-only captures: each target path and the copy taken of it. Lets the post-tool hook
   * check whether a failed command changed anything before discarding the backup.
   */
  captures?: Array<{ target: string; copy: string }>;
  /** Commands that reverse the whole effect, run on restore. */
  recoveryCommands: string[];
  /** Human-readable summary for the action card. */
  description: string;
  /** Stable rule id (for debugging + UI). */
  ruleId: string;
  /**
   * If true, the tier-1 artifact is recorded but tier 3 still snapshots the workspace;
   * used by rules whose own recovery is partial (e.g. `git reset --hard`).
   */
  preserveLowerTiers?: boolean;
}

export interface PolicyRule {
  id: string;
  category: "fs-delete" | "fs-overwrite" | "git" | "container" | "k8s" | "db";
  /** Tool this rule applies to. Most rules target Bash. */
  toolName: "Bash" | "Write" | "Edit";
  /** Regex over the raw command (for Bash) or over JSON.stringify(tool_input). */
  pattern: RegExp;
  /** Safety exclusion: if this matches, the rule does not fire and later tiers handle the call. */
  exclude?: RegExp;
  confidence: "high" | "medium" | "low";
  /** Short human summary, displayed in action cards and logs. */
  description: string;
  /**
   * Performs the rewrite (or, with `opts.rewrite === false`, only the capture); returns null
   * when the rule matched but does not apply.
   */
  apply(
    match: RegExpMatchArray,
    ctx: HookContext,
    trashDir: string,
    /**
     * Absolute store root; rules that move or delete caller-supplied paths filter them
     * through excludeSandboxStore() with it.
     */
    storeRoot?: string,
    opts?: PolicyApplyOptions,
  ): PolicyRuleResult | null;
}

export interface PolicyApplyOptions {
  /**
   * false: backup-only mode. The rule must not execute, move or delete anything the command
   * targets; it captures a restorable copy and the host runs the original command.
   * Defaults to true.
   */
  rewrite?: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────

/** Escape a path for shell — wraps in single quotes, escapes embedded '. */
function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Paths we never rewrite. `rm -rf /`, `rm -rf ~`, `rm -rf .`, etc. */
const DANGEROUS_PATHS = new Set([
  "/", "/*", "~", "~/", "~/.", ".", "./", "..", "../", "*", "~/*",
]);
function isDangerousPath(p: string): boolean {
  const trimmed = p.trim();
  if (DANGEROUS_PATHS.has(trimmed)) return true;
  // /home, /usr, /var, /etc, /bin, /sbin, /lib, /boot, /dev, /proc, /sys, /root
  if (/^\/(home|usr|var|etc|bin|sbin|lib|boot|dev|proc|sys|root|opt)\/?$/.test(trimmed)) return true;
  return false;
}

/**
 * Parse the path arguments of `rm <flags> path...`, handling simple quoting and escapes.
 * Returns null for pipes, command substitution or globs.
 */
function parseRmArgs(command: string): { paths: string[]; flags: string } | null {
  // Reject compound / piped commands outright — too risky to rewrite a part.
  if (/[|;&]/.test(command) && !/\\\s*$/.test(command)) {
    // ^ any of | ; & NOT at end-of-line (line continuation is fine)
    return null;
  }
  // Reject command substitution — we can't know what it'll expand to.
  if (/\$\(|`/.test(command)) return null;
  // Reject unexpanded glob patterns.
  if (/[*?]/.test(command.replace(/^rm\s+/, ""))) return null;

  const tokens: string[] = [];
  let cur = "";
  let i = 0;
  const src = command.trim();
  // Skip the leading `rm`
  if (!src.startsWith("rm")) return null;
  i = 2;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t") {
      if (cur) {
        tokens.push(cur);
        cur = "";
      }
      i++;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) return null;
      cur += src.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      const end = src.indexOf('"', i + 1);
      if (end === -1) return null;
      cur += src.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (c === "\\" && i + 1 < src.length) {
      cur += src[i + 1];
      i += 2;
      continue;
    }
    cur += c;
    i++;
  }
  if (cur) tokens.push(cur);

  const flags: string[] = [];
  const paths: string[] = [];
  for (const t of tokens) {
    if (t.startsWith("-")) flags.push(t);
    else paths.push(t);
  }
  return { paths, flags: flags.join(" ") };
}

/** Encode a path for safe use as a filesystem name within trash/, unique per path. */
function trashName(absPath: string, nonce: string): string {
  return `${nonce}_${uniqueCaptureName("rm", absPath)}`;
}

// ── The rules ──────────────────────────────────────────────────────

export const POLICY_RULES: PolicyRule[] = [
  {
    id: "rm-to-trash",
    category: "fs-delete",
    toolName: "Bash",
    // Match `rm` at the start, allow any flag soup.
    pattern: /^\s*rm\s+/,
    // Never rewrite rm targeting a single-token catastrophic path.
    exclude: /\brm\s+(?:-[a-zA-Z]+\s+)*(?:\/|~|\.|\.\.|\*)\s*(?:$|[|;&])/,
    confidence: "high",
    description: "Rewrite `rm` into `mv` to a per-action trash, reversible on restore.",
    apply(_match, ctx, trashDir, storeRoot, opts) {
      const rewrite = opts?.rewrite !== false;
      const command = stripShellComment(String(ctx.tool_input.command ?? ""));
      const parsed = parseRmArgs(command);
      if (!parsed) return null;                     // too complex — fall through
      if (parsed.paths.length === 0) return null;   // no-op rm

      // Check for dangerous paths. If any, bail entirely.
      for (const p of parsed.paths) {
        if (isDangerousPath(p)) return null;
      }

      // Resolve paths against cwd. Skip paths that don't exist (rm would
      // fail anyway; no backup needed).
      const cwd = process.cwd();
      const candidates: string[] = [];
      for (const p of parsed.paths) {
        const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
        if (!fs.existsSync(abs)) continue;
        candidates.push(abs);
      }
      if (candidates.length === 0) return null;

      // Never move the store into its own trash; filter it out of the target set.
      const { kept: resolved, skipped } =
        excludeSandboxStore(candidates, trashDir, storeRoot);
      if (!rewrite) {
        // The host will run the original rm, so the store cannot be filtered out of it.
        if (skipped.length > 0) return storeDenyReason("rm-to-trash", skipped);
        const copied = copyVictimsToTrash(resolved, trashDir, "rm-to-trash", storeRoot);
        if (copied === null) return null;
        return {
          backupOnly: true,
          preCommands: copied.preCommands,
          captures: copied.captures,
          recoveryCommands: copied.recoveryCommands,
          description: resolved.length === 1
            ? `rm → copied ${path.basename(resolved[0])} to trash before the rm ran (reversible)`
            : `rm → copied ${resolved.length} paths to trash before the rm ran (reversible)`,
          ruleId: "rm-to-trash",
        };
      }
      if (skipped.length > 0) {
        logTier1Note(
          trashDir,
          "rm-to-trash",
          `refused: ${skipped.join(", ")} is, or contains, the sandbox ` +
            `backup store. ` +
            `It is the mechanism that makes every other deletion reversible ` +
            `and has no inverse of its own — remove it deliberately with ` +
            `\`backupper clear\` or \`backupper uninstall\`. ` +
            `${resolved.length} other path(s) still soft-deleted.`,
          storeRoot,
        );
      }
      if (resolved.length === 0) {
        // Every target was the store: rewrite to a no-op and report it.
        return {
          updatedInput: {
            ...ctx.tool_input,
            command:
              `true  # backupper: refused to delete the backup store`,
          },
          preCommands: [],
          recoveryCommands: [],
          description:
            `rm → REFUSED: ${skipped.join(", ")} is, or contains, the ` +
            `sandbox's own backup store, which holds the only copy of ` +
            `everything already soft-deleted. Nothing was removed. Use ` +
            `\`backupper clear\` to drop backups deliberately, or delete ` +
            `the contents around the store instead.`,
          ruleId: "rm-to-trash",
          preserveLowerTiers: true,
        };
      }

      // Build pre-commands (the actual mv-to-trash) and recovery commands.
      try {
        fs.mkdirSync(trashDir, { recursive: true });
      } catch {
        return null; // can't make trash — bail
      }

      const nonce = Math.random().toString(36).slice(2, 8);
      const preCommands: string[] = [];
      const recoveryCommands: string[] = [];

      for (const abs of resolved) {
        const name = trashName(abs, nonce);
        const trashPath = path.join(trashDir, name);
        // Fall through on a cross-filesystem move, which would be a full copy.
        try {
          const srcDev = fs.statSync(abs).dev;
          const dstDev = fs.statSync(trashDir).dev;
          if (srcDev !== dstDev) return null;
        } catch {
          return null;
        }
        const cmd = `mv ${shq(abs)} ${shq(trashPath)}`;
        try {
          execSync(cmd, { stdio: "pipe", timeout: 10_000 });
        } catch {
          // mv failed — unwind any successful earlier moves and bail.
          for (const done of recoveryCommands) {
            try { execSync(done, { stdio: "pipe", timeout: 10_000 }); } catch { /* best-effort */ }
          }
          return null;
        }
        preCommands.push(cmd);
        // Recovery moves things back; prepend so we reverse in LIFO order. The parent is
        // re-created first: a later snapshot restore drops directories this rm left empty.
        recoveryCommands.unshift(`mkdir -p ${shq(path.dirname(abs))} && mv ${shq(trashPath)} ${shq(abs)}`);
      }

      // The deletion already happened via preCommands; the agent runs a no-op in its place.
      const desc = resolved.length === 1
        ? `rm → soft-delete ${path.basename(resolved[0])} to trash (reversible)`
        : `rm → soft-delete ${resolved.length} paths to trash (reversible)`;

      return {
        updatedInput: { ...ctx.tool_input, command: `true  # backupper: rm rewritten to trash, ${resolved.length} item(s)` },
        preCommands,
        recoveryCommands,
        description: desc,
        ruleId: "rm-to-trash",
      };
    },
  },
  // Additional rules (git, chmod, chown, docker, kubectl, outside-workspace Write) from
  // policy_rules_extra.ts. First match wins.
  ...EXTRA_RULES,
];

/** Record a tier-1 refusal on stderr and in `<sandbox root>/tier1-skipped.log`. */
function logTier1Refusal(
  trashDir: string,
  ruleId: string,
  foreign: ForeignExecTarget,
  commandOrJson: string,
): void {
  const line =
    `[BackUpper] TIER-1 DISABLED: the agent executes through a ` +
    `'${foreign.backend}' backend (${foreign.source}), not this filesystem. ` +
    `Rule '${ruleId}' matched but was NOT applied — a tier-1 rewrite runs its ` +
    `own mv/cp/rm HERE, which would mutate the wrong machine and still leave ` +
    `the real target unprotected. Command passed through unmodified; tiers 2-4 ` +
    `still apply. Action: ${commandOrJson.slice(0, 300)}`;
  try {
    process.stderr.write(line + "\n");
  } catch { /* best-effort */ }
  try {
    const root = path.dirname(path.dirname(path.dirname(path.resolve(trashDir))));
    fs.mkdirSync(root, { recursive: true });
    fs.appendFileSync(
      path.join(root, "tier1-skipped.log"),
      `[${new Date().toISOString()}] ${line}\n`,
    );
  } catch { /* best-effort */ }
}

/**
 * Return the first rule that fires for this tool call and apply it, or null.
 * Rules act on this process's filesystem, so they are refused when the agent's calls run
 * on a different machine (see backup/exec_target.ts).
 */
export function applyPolicyRules(
  ctx: HookContext,
  trashDir: string,
  /** Absolute store root, `dirname(resolve(config.backupDir))`; optional. */
  storeRoot?: string,
  /** `{ rewrite: false }` selects backup-only mode (see the file header). */
  opts: PolicyApplyOptions = {},
): PolicyRuleResult | null {
  const rewrite = opts.rewrite !== false;
  const commandOrJson = ctx.tool_name === "Bash"
    ? stripShellComment(String(ctx.tool_input.command ?? ""))
    : JSON.stringify(ctx.tool_input);

  for (const rule of POLICY_RULES) {
    if (rule.toolName !== ctx.tool_name) continue;
    if (rule.exclude && rule.exclude.test(commandOrJson)) continue;
    const m = commandOrJson.match(rule.pattern);
    if (!m) continue;
    // Checked after the match, so the log names the rule, and before apply().
    const foreign = foreignExecTarget();
    if (foreign) {
      logTier1Refusal(trashDir, rule.id, foreign, commandOrJson);
      return null;
    }
    const result = rule.apply(m, ctx, trashDir, storeRoot, { rewrite });
    if (result) {
      // A result whose input is absent or unchanged is capture-only: the host runs the
      // original command. In backup-only mode that is enforced for every rule.
      const unchanged = result.updatedInput === undefined ||
        JSON.stringify(result.updatedInput) === JSON.stringify(ctx.tool_input);
      if (!rewrite || unchanged) {
        delete result.updatedInput;
        result.backupOnly = true;
      }
      return result;
    }
  }
  return null;
}
