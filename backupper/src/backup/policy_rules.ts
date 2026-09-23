/**
 * Policy rewrite rules (tier-0).
 *
 * When a rule matches an incoming tool call, the plugin REWRITES the
 * command into a recoverable form instead of running the destructive
 * original. Example: `rm -rf path` is rewritten to `mv path
 * .chats-sandbox/backups/action_NNN/trash/path`. The file still "goes
 * away" from the user's perspective (not at its original path anymore),
 * but the data sits in the action folder's trash. On restore, the
 * recorded recovery commands (e.g. `mv back`) reverse the rewrite.
 *
 * Advantages over tier-2 (git_snapshot) for destructive ops:
 *   - O(1) inode rename vs O(N) data copy. Huge files stay cheap.
 *   - Works for paths outside the workspace (no git-repo assumption).
 *   - Explicit, deterministic recovery. No model reasoning at restore.
 *
 * Trash lives INSIDE the action folder, so the existing retention system
 * (maxActions / maxTotalSizeMB / maxAgeHours) deletes trash entries when
 * it prunes an action folder. Soft-delete becomes hard-delete at
 * retention time — no separate lifecycle logic needed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { HookContext } from "../types.js";
import {
  EXTRA_RULES,
  excludeSandboxStore,
  logTier0Note,
} from "./policy_rules_extra.js";
import { foreignExecTarget, type ForeignExecTarget } from "./exec_target.js";

export interface PolicyRuleResult {
  /** The rewritten tool input. Plugin returns this as `updatedInput` to
   *  the Claude Code hook, which re-invokes the tool with it. */
  updatedInput: Record<string, unknown>;
  /** Commands the plugin ran BEFORE returning updatedInput (e.g. the mv
   *  to trash). Recorded on the artifact for audit / debugging. */
  preCommands: string[];
  /** Commands that reverse the whole effect. Run via execSync on
   *  restore — no LLM needed. */
  recoveryCommands: string[];
  /** Human-readable summary for the action card. */
  description: string;
  /** Stable rule id (for debugging + UI). */
  ruleId: string;
  /** When true, the tier-0 artifact is recorded but the pipeline does
   *  NOT short-circuit — tier-2 still snapshots the workspace. Used by
   *  rules whose own recovery is partial (e.g. `git reset --hard` saves
   *  the HEAD sha but cannot reconstruct the dirty worktree it
   *  destroys; the tier-2 snapshot captures that). Default (undefined)
   *  keeps the normal terminating behavior. */
  preserveLowerTiers?: boolean;
}

export interface PolicyRule {
  id: string;
  category: "fs-delete" | "fs-overwrite" | "git" | "container" | "k8s" | "db";
  /** Tool this rule applies to. Most rules target Bash. */
  toolName: "Bash" | "Write" | "Edit";
  /** Regex over the raw command (for Bash) or over JSON.stringify(tool_input). */
  pattern: RegExp;
  /** Safety exclusion — if this matches, the rule does NOT fire (fall back
   *  to tier-1/2/3). Guards against catastrophic cases like `rm -rf /`. */
  exclude?: RegExp;
  confidence: "high" | "medium" | "low";
  /** Short human summary, displayed in action cards and logs. */
  description: string;
  /** The actual work. Returns null when the rule matched pattern but
   *  decided it doesn't apply (e.g. mv to a target that doesn't exist —
   *  benign, no backup needed). */
  apply(
    match: RegExpMatchArray,
    ctx: HookContext,
    trashDir: string,
    /** Absolute sandbox store root, derived from `config.backupDir` by
     *  applyPolicyRules(). Rules that move or delete a caller-supplied
     *  path set MUST pass their set through excludeSandboxStore() with
     *  it; rules that don't touch path sets can ignore it. */
    storeRoot?: string,
  ): PolicyRuleResult | null;
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
 * Parse the argument list of `rm <flags> path1 path2 …` into an array of
 * path strings. Handles simple quoting and backslash escapes. Returns
 * null if the command is too complex to parse safely (compound pipes,
 * command substitutions, glob expansions we can't resolve — fall back
 * to another tier rather than guess).
 */
function parseRmArgs(command: string): { paths: string[]; flags: string } | null {
  // Reject compound / piped commands outright — too risky to rewrite a part.
  if (/[|;&]/.test(command) && !/\\\s*$/.test(command)) {
    // ^ any of | ; & NOT at end-of-line (line continuation is fine)
    return null;
  }
  // Reject command substitution — we can't know what it'll expand to.
  if (/\$\(|`/.test(command)) return null;
  // Reject glob patterns — shell expansion would already have happened
  // by the time the command reaches us, but agents sometimes pass them
  // raw. Safer to skip.
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
      if (cur) { tokens.push(cur); cur = ""; }
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

/** Encode a path for safe use as a filesystem name within trash/. */
function trashName(absPath: string, nonce: string): string {
  // Replace / with __, strip leading underscores, cap length.
  const enc = absPath.replace(/^\/+/, "").replace(/\//g, "__").slice(0, 200);
  return `${nonce}_${enc}`;
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
    apply(_match, ctx, trashDir, storeRoot) {
      const command = String(ctx.tool_input.command ?? "");
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

      // The sandbox's own store is never a legitimate mv target — moving
      // it into its own action trash fails ("cannot move to a subdirectory
      // of itself"), which used to make this rule return null and let the
      // real `rm -rf .chats-sandbox` delete the store. Filter it out.
      // Normally a deletion aimed at the store is stopped earlier by the
      // sandbox-store deny rule (types.ts DEFAULT_DENY_RULES); this is the
      // backstop for configs written before that rule existed, or with
      // denyPatterns cleared.
      const { kept: resolved, skipped } =
        excludeSandboxStore(candidates, trashDir, storeRoot);
      if (skipped.length > 0) {
        logTier0Note(
          trashDir,
          "rm-to-trash",
          `refused: ${skipped.join(", ")} is, or contains, the sandbox ` +
            `backup store. ` +
            `It is the mechanism that makes every other deletion reversible ` +
            `and has no inverse of its own — remove it deliberately with ` +
            `\`chats-sandbox clear\` or \`chats-sandbox uninstall\`. ` +
            `${resolved.length} other path(s) still soft-deleted.`,
          storeRoot,
        );
      }
      if (resolved.length === 0) {
        // Everything named was the store. Rewrite to a noop and SAY SO —
        // falling through would hand the original `rm -rf` the store.
        return {
          updatedInput: {
            ...ctx.tool_input,
            command:
              `true  # chats-sandbox: refused to delete the backup store`,
          },
          preCommands: [],
          recoveryCommands: [],
          description:
            `rm → REFUSED: ${skipped.join(", ")} is, or contains, the ` +
            `sandbox's own backup store, which holds the only copy of ` +
            `everything already soft-deleted. Nothing was removed. Use ` +
            `\`chats-sandbox clear\` to drop backups deliberately, or delete ` +
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
        // Verify same filesystem — mv across FS becomes a full copy,
        // which defeats the whole point of tier-0. Fall through if cross-FS.
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
            try { execSync(done, { stdio: "pipe", timeout: 10_000 }); } catch { /* */ }
          }
          return null;
        }
        preCommands.push(cmd);
        // Recovery moves things back; prepend so we reverse in LIFO order.
        recoveryCommands.unshift(`mv ${shq(trashPath)} ${shq(abs)}`);
      }

      // Rewrite the command to a noop — the deletion already happened
      // (to trash) via preCommands. Claude will run the rewritten command
      // and see a successful "deletion," exactly as if rm had run.
      const desc = resolved.length === 1
        ? `rm → soft-delete ${path.basename(resolved[0])} to trash (reversible)`
        : `rm → soft-delete ${resolved.length} paths to trash (reversible)`;

      return {
        updatedInput: { ...ctx.tool_input, command: `true  # chats-sandbox: rm rewritten to trash, ${resolved.length} item(s)` },
        preCommands,
        recoveryCommands,
        description: desc,
        ruleId: "rm-to-trash",
      };
    },
  },
  // Extra rules (git, chmod, chown, docker, kubectl, outside-workspace Write).
  // Loaded from policy_rules_extra.ts to keep this file focused on the core
  // rm machinery. Ordering matters — first match wins in applyPolicyRules().
  ...EXTRA_RULES,
];

/**
 * Loud, durable record of a tier-0 refusal.
 *
 * A silent stand-down is indistinguishable from "no rule matched", and the
 * whole point of the guard is that an operator can SEE that tier 0 is off.
 * stderr alone is not enough — hermes' plugin bridge sends the Node hook's
 * stderr to DEVNULL — so also append to `<sandbox root>/tier0-skipped.log`,
 * derived from the action trash dir
 * (`<root>/backups/action_NNN/trash` → `<root>`).
 */
function logTier0Refusal(
  trashDir: string,
  ruleId: string,
  foreign: ForeignExecTarget,
  commandOrJson: string,
): void {
  const line =
    `[CHATS-Sandbox] TIER-0 DISABLED: the agent executes through a ` +
    `'${foreign.backend}' backend (${foreign.source}), not this filesystem. ` +
    `Rule '${ruleId}' matched but was NOT applied — a tier-0 rewrite runs its ` +
    `own mv/cp/rm HERE, which would mutate the wrong machine and still leave ` +
    `the real target unprotected. Command passed through unmodified; tiers 1-3 ` +
    `still apply. Action: ${commandOrJson.slice(0, 300)}`;
  try {
    process.stderr.write(line + "\n");
  } catch { /* best-effort */ }
  try {
    const root = path.dirname(path.dirname(path.dirname(path.resolve(trashDir))));
    fs.mkdirSync(root, { recursive: true });
    fs.appendFileSync(
      path.join(root, "tier0-skipped.log"),
      `[${new Date().toISOString()}] ${line}\n`,
    );
  } catch { /* best-effort */ }
}

/**
 * Find a matching rule for this tool call, if any. Runs through rules
 * in order; first match wins. Returns null when no rule fires.
 *
 * SAFETY GATE (see backup/exec_target.ts): every rule's `apply()` performs
 * the rewrite ITSELF, in this process, on this process's filesystem. That is
 * only legitimate when the agent's tool calls land on the same filesystem.
 * When the agent runs through a container/ssh/remote terminal backend the
 * rewrite would delete or move the HOST's files while the agent's real
 * target is untouched, so we refuse: log loudly and return null, which makes
 * the caller leave the command completely unmodified and fall through to
 * tiers 1-3. Refusing costs a backup; acting costs the wrong machine's data.
 */
export function applyPolicyRules(
  ctx: HookContext,
  trashDir: string,
  /** Absolute sandbox store root — `dirname(resolve(config.backupDir))`,
   *  the same derivation pre-tool.ts uses for the timing ledger. Passed
   *  down so the store guard reads the CONFIGURED layout instead of
   *  inferring it from trashDir. Optional: omitting it falls back to the
   *  path arithmetic inside the guard. */
  storeRoot?: string,
): PolicyRuleResult | null {
  const commandOrJson = ctx.tool_name === "Bash"
    ? String(ctx.tool_input.command ?? "")
    : JSON.stringify(ctx.tool_input);

  for (const rule of POLICY_RULES) {
    if (rule.toolName !== ctx.tool_name) continue;
    if (rule.exclude && rule.exclude.test(commandOrJson)) continue;
    const m = commandOrJson.match(rule.pattern);
    if (!m) continue;
    // The check sits AFTER the match so the log names the rule that would
    // have fired, and BEFORE apply() so nothing is ever executed.
    const foreign = foreignExecTarget();
    if (foreign) {
      logTier0Refusal(trashDir, rule.id, foreign, commandOrJson);
      return null;
    }
    const result = rule.apply(m, ctx, trashDir, storeRoot);
    if (result) return result;
  }
  return null;
}
