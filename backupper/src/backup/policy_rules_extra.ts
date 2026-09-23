import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs";
import { join } from "node:path";
import * as path from "node:path";
import type { HookContext } from "../types.js";
import type { PolicyRule, PolicyRuleResult } from "./policy_rules.js";

/* -----------------------------------------------------------------------
 * EXTRA_RULES — tier-0 policy rules beyond the core `rm` rule in
 * policy_rules.ts. Each rule either:
 *   (a) run-and-rewrite — executes the destructive op inside apply(),
 *       then returns updatedInput={command:"true"} so Claude runs a
 *       noop. Used for git / docker / kubectl where we want to guarantee
 *       the destruction has happened (no race with hook return).
 *   (b) record-and-pass — captures pre-state, returns the original
 *       command unchanged. Used for chmod / chown (cheap stat capture)
 *       and outside-workspace-write-new (no state to capture, just
 *       record inverse).
 *
 * recoveryCommands are exact inverses executed verbatim by
 * `chats-sandbox restore` via execSync.
 *
 *   id                             category      confidence  description
 *   ------------------------------ ------------- ----------- --------------------------------------------------
 *   git-reset-hard                 git           high        Save HEAD sha before `git reset --hard`.
 *   git-branch-delete-force        git           high        Save branch sha before `git branch -D`.
 *   git-stash-drop                 git           high        Preserve stash commit under backup ref.
 *   git-push-force                 git           medium      Record remote sha before force-push.
 *   git-clean                      git           high        Move what `git clean -f…` would delete into trash.
 *   git-worktree-remove-force      git           high        Snapshot worktree + admin dir before force-remove.
 *   docker-rm                      container     medium      Commit container fs before `docker rm`.
 *   docker-volume-rm               container     high        Tar volume contents before `docker volume rm`.
 *   docker-image-rm                container     high        `docker save` image before `rmi`.
 *   kubectl-delete                 k8s           medium      Dump resource yaml before `kubectl delete`.
 *   helm-uninstall                 k8s           medium      `helm get all` + --keep-history; restore rolls back.
 *   mv-overwrite                   fs-overwrite  high        Record inverse mv; snapshot a clobbered dest.
 *   sed-in-place                   fs-overwrite  high        Snapshot bytes before `sed -i`; cp back.
 *   truncate                       fs-overwrite  high        Snapshot bytes before `truncate`; cp back.
 *   shell-truncate                 fs-overwrite  high        Snapshot bytes before a bare `> file` redirect.
 *   rsync-delete                   fs-delete     high        Snapshot dest tree before `rsync --delete`.
 *   find-delete                    fs-delete     high        `find … -delete`/`-exec rm` victims to trash.
 *   git-discard-worktree           git           high        Snapshot bytes before `git restore`/checkout discard.
 *   chmod                          fs-overwrite  high        Save old mode (whole subtree for -R); chmod back.
 *   chown                          fs-overwrite  high        Save old owner (whole subtree for -R); chown back.
 *   outside-workspace-write-new    fs-delete     high        New file outside cwd: record rm as recovery.
 * ----------------------------------------------------------------------- */

// ---------- helpers --------------------------------------------------------

function shq(s: string): string {
  if (s === "") return "''";
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function trashName(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180);
  return cleaned.length > 0 ? cleaned : "item";
}

/**
 * Conservative compound-command detector. Single-quoted substrings are
 * stripped first so args like 'a;b' don't trip the check.
 */
function hasCompound(command: string): boolean {
  const stripped = command.replace(/'[^']*'/g, "");
  if (/[|&;`]/.test(stripped)) return true;
  if (/\$\(/.test(stripped)) return true;
  if (/<\(|>\(/.test(stripped)) return true;
  return false;
}

function runCaptured(cmd: string): string | null {
  try {
    return execSync(cmd, {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

function runSilent(cmd: string): boolean {
  try {
    execSync(cmd, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function which(cmd: string): boolean {
  try {
    execSync(`command -v ${shq(cmd)}`, { stdio: "pipe", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Tokenize a shell command honoring single/double quotes and backslash
 * escapes. Returns null on unterminated quote or dangling backslash.
 */
function tokenize(command: string): string[] | null {
  const tokens: string[] = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let pushed = false;

  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (escaped) {
      cur += c;
      escaped = false;
      pushed = true;
      continue;
    }
    if (!inSingle && c === "\\") {
      escaped = true;
      continue;
    }
    if (!inDouble && c === "'") {
      inSingle = !inSingle;
      pushed = true;
      continue;
    }
    if (!inSingle && c === '"') {
      inDouble = !inDouble;
      pushed = true;
      continue;
    }
    if (!inSingle && !inDouble && /\s/.test(c)) {
      if (pushed) {
        tokens.push(cur);
        cur = "";
        pushed = false;
      }
      continue;
    }
    cur += c;
    pushed = true;
  }
  if (inSingle || inDouble || escaped) return null;
  if (pushed) tokens.push(cur);
  return tokens;
}

function rawCommand(ctx: HookContext): string {
  const input = ctx.tool_input as { command?: unknown };
  return typeof input.command === "string" ? input.command : "";
}

function noopInput(ctx: HookContext): Record<string, unknown> {
  return { ...(ctx.tool_input as Record<string, unknown>), command: "true" };
}

function isHelpInvocation(tokens: string[]): boolean {
  return tokens.includes("--help");
}

/** Resolve a path arg to an absolute path IFF it is a safe, existing
 *  regular file. Returns null otherwise (so callers bail conservatively
 *  on globs, directories, missing files, or sensitive system paths). */
function resolveExistingFile(p: string): string | null {
  if (!isSafePath(p)) return null;
  const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  try {
    if (!fs.existsSync(abs)) return null;
    if (!fs.statSync(abs).isFile()) return null;
  } catch {
    return null;
  }
  return abs;
}

/**
 * Shared run-and-rewrite helper for in-place file edits (sed -i,
 * truncate, git restore/checkout -- <path>): snapshot each target's
 * bytes to the action trash, execute the original command, and record a
 * `cp` back as the recovery. The original command is replaced with a
 * no-op for Claude (it already ran here). Returns null if any snapshot
 * or the command itself fails, leaving the engine to escalate.
 */
function snapshotAndRun(
  ctx: HookContext,
  command: string,
  absPaths: string[],
  trashDir: string,
  ruleId: string,
  describe: (n: number) => string,
): PolicyRuleResult | null {
  try {
    fs.mkdirSync(trashDir, { recursive: true });
  } catch {
    return null;
  }
  const nonce = Date.now();
  const preCommands: string[] = [];
  const recoveryCommands: string[] = [];
  for (const abs of absPaths) {
    const trashFile = join(trashDir, `${ruleId}-${trashName(abs)}-${nonce}.bak`);
    const cpCmd = `cp -a ${shq(abs)} ${shq(trashFile)}`;
    if (!runSilent(cpCmd)) return null;
    if (!existsSync(trashFile)) return null;
    preCommands.push(cpCmd);
    recoveryCommands.push(`cp -a ${shq(trashFile)} ${shq(abs)}`);
  }
  if (!runSilent(command)) return null;
  preCommands.push(command);
  return {
    updatedInput: noopInput(ctx),
    preCommands,
    recoveryCommands,
    description: describe(absPaths.length),
    ruleId,
  };
}

/**
 * Ceiling on how many filesystem entries a rule will record or copy
 * inside the PreToolUse hook.
 *
 * The hook is synchronous and sits between the agent emitting a tool call
 * and the tool running, so every entry we walk is latency the agent pays.
 * benchmarks/results/T3_OVERFIRE_REPORT.md is the cautionary tale (774 s
 * of backup latency on one instance). A rule that would exceed this bails
 * — an honest "no tier-0 inverse" is better than a partial one, and the
 * lower tiers still cover the action.
 */
const MAX_TREE_ENTRIES = 20_000;

/**
 * Count entries under a directory, stopping just past the cap (the `head`
 * closes the pipe, so `find` is killed instead of walking a huge tree).
 * Returns null when the count can't be taken. Paths containing newlines
 * inflate the count, which biases toward bailing — the safe direction.
 */
function countTreeEntries(absDir: string): number | null {
  const out = runCaptured(
    `find ${shq(absDir)} | head -n ${MAX_TREE_ENTRIES + 1} | wc -l`,
  );
  if (out === null) return null;
  const n = Number(out.trim());
  return Number.isInteger(n) ? n : null;
}

/**
 * Drop any path that lives inside another path in the list. Callers move
 * whole subtrees, so moving a parent already carries its children — a
 * second move of the child would just fail. Input need not be sorted.
 */
function dropNested(paths: string[]): string[] {
  const sorted = [...paths].sort();
  const roots: string[] = [];
  for (const p of sorted) {
    if (roots.some((r) => p === r || p.startsWith(r + path.sep))) continue;
    roots.push(p);
  }
  return roots;
}

/* ---------- the sandbox's own store is never a victim -------------------
 *
 * The backup store (`.chats-sandbox/` by default) lives INSIDE the
 * workspace, so any broad sweep — `git clean -fdx`, `find … -delete`,
 * `rm -rf .chats-sandbox` — enumerates the store itself as a victim.
 * Moving it into its own action trash is a move into a subdirectory of
 * itself: `mv` fails, the rule returns null, the command is therefore
 * NOT rewritten, and the ORIGINAL destructive command then takes the
 * workspace AND the store that would have restored it. The store is the
 * protection mechanism, not protected content — so it is filtered out of
 * every victim set BEFORE any rule moves anything, and a rule left with
 * nothing but store paths still rewrites the command instead of falling
 * through to a tier that cannot save the store.
 */

/** True when `child` is `parent`, or lives underneath it. */
function isAtOrUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * The store root for this action's trash.
 *
 * `storeRoot` is threaded down from applyPolicyRules(), which derives it
 * from `config.backupDir` — the configured source of truth, and the SAME
 * derivation pre-tool.ts uses for the timing ledger. The path arithmetic
 * (`<store>/backups/action_NNN/trash` → `<store>`) is only the fallback
 * for callers that do not pass it, and it is sanity-checked: a derived
 * root that does not contain the action trash (or that is the filesystem
 * root) is discarded in favour of the trash dir itself, so a future
 * layout change degrades the guard to its layout-independent half rather
 * than silently swallowing the whole workspace.
 */
function storeRootOf(trashDir: string, storeRoot?: string): string {
  const trash = path.resolve(trashDir);
  const derived =
    storeRoot !== undefined && storeRoot !== ""
      ? path.resolve(storeRoot)
      : path.dirname(path.dirname(path.dirname(trash)));
  if (!isAtOrUnder(trash, derived)) return trash;
  if (derived === path.parse(derived).root) return trash;
  return derived;
}

/**
 * True when moving/deleting `abs` would damage the sandbox's own store.
 *
 * Two independent tests, both required:
 *   (a) `abs` is, or contains, THIS action's trash. Layout-independent —
 *       it is exactly the "move into a subdirectory of itself" condition,
 *       and it still holds if (b)'s derivation ever goes stale.
 *   (b) `abs` overlaps the store root in either direction: the store and
 *       everything under it (other actions' trash, `shadow-repo/`, the
 *       ledgers restore reads), plus any ancestor that would take the
 *       store with it.
 */
export function isSandboxStorePath(
  abs: string,
  trashDir: string,
  storeRoot?: string,
): boolean {
  const p = path.resolve(abs);
  if (isAtOrUnder(path.resolve(trashDir), p)) return true;
  const root = storeRootOf(trashDir, storeRoot);
  return isAtOrUnder(p, root) || isAtOrUnder(root, p);
}

/**
 * Split a victim set into the paths a rule may act on and the store paths
 * it must leave alone. Every rule that moves or deletes a caller-supplied
 * path set routes its list through this before touching anything.
 */
export function excludeSandboxStore(
  paths: string[],
  trashDir: string,
  storeRoot?: string,
): { kept: string[]; skipped: string[] } {
  const kept: string[] = [];
  const skipped: string[] = [];
  for (const p of paths) {
    if (isSandboxStorePath(p, trashDir, storeRoot)) skipped.push(p);
    else kept.push(p);
  }
  return { kept, skipped };
}

/**
 * Durable record of a tier-0 stand-down or partial application.
 *
 * A rule that returns null is indistinguishable from "no rule matched",
 * and every failure inside these helpers used to be swallowed by
 * runSilent()'s `stdio: "ignore"`. Same destination as the
 * foreign-exec-target refusal in policy_rules.ts: stderr (which some
 * bridges discard) plus `<store root>/tier0-skipped.log`.
 */
export function logTier0Note(
  trashDir: string,
  ruleId: string,
  detail: string,
  storeRoot?: string,
): void {
  const line = `[CHATS-Sandbox] TIER-0 '${ruleId}': ${detail}`;
  try {
    process.stderr.write(line + "\n");
  } catch { /* best-effort */ }
  try {
    const root = storeRootOf(trashDir, storeRoot);
    fs.mkdirSync(root, { recursive: true });
    fs.appendFileSync(
      path.join(root, "tier0-skipped.log"),
      `[${new Date().toISOString()}] ${line}\n`,
    );
  } catch { /* best-effort */ }
}

/**
 * Shared rm-to-trash machinery for the rules whose victims are a resolved
 * set of paths (`git clean`, `find … -delete`): move each path into the
 * action trash and record the exact `mv` back.
 *
 * Same contract as the core rm rule in policy_rules.ts — a cross-device
 * move would silently become a full copy and defeat tier 0, and any
 * failure unwinds the moves already made and bails so the caller can fall
 * through to a lower tier with the workspace untouched.
 */
function moveVictimsToTrash(
  absPaths: string[],
  trashDir: string,
  ruleId: string,
  storeRoot?: string,
): { preCommands: string[]; recoveryCommands: string[] } | null {
  // Backstop for the shared guard: callers filter their own victim set
  // (so they can still rewrite the command when the store was the only
  // victim), but a future caller that forgets must not get as far as
  // `mv <store> <store>/…/trash`.
  const store = absPaths.filter((p) => isSandboxStorePath(p, trashDir, storeRoot));
  if (store.length > 0) {
    logTier0Note(
      trashDir,
      ruleId,
      `stood down: victim set reached moveVictimsToTrash still holding ` +
        `sandbox store path(s) ${store.join(", ")} — caller did not apply ` +
        `excludeSandboxStore(). No paths were moved.`,
      storeRoot,
    );
    return null;
  }
  try {
    fs.mkdirSync(trashDir, { recursive: true });
  } catch {
    logTier0Note(trashDir, ruleId, `stood down: cannot create trash dir ${trashDir}.`, storeRoot);
    return null;
  }
  let trashDev: number;
  try {
    trashDev = fs.statSync(trashDir).dev;
  } catch {
    logTier0Note(trashDir, ruleId, `stood down: cannot stat trash dir ${trashDir}.`, storeRoot);
    return null;
  }

  const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const preCommands: string[] = [];
  const undo: string[] = [];
  const recoveryPairs: string[][] = [];

  const unwind = (): void => {
    for (const c of undo) runSilent(c);
  };

  let idx = 0;
  for (const abs of absPaths) {
    try {
      if (fs.lstatSync(abs).dev !== trashDev) {
        unwind();
        logTier0Note(
          trashDir,
          ruleId,
          `stood down: ${abs} is on a different filesystem than the trash — ` +
            `a cross-device mv would be a full copy. Moves unwound.`,
          storeRoot,
        );
        return null;
      }
    } catch {
      unwind();
      logTier0Note(trashDir, ruleId, `stood down: cannot stat victim ${abs}. Moves unwound.`, storeRoot);
      return null;
    }
    const dest = join(trashDir, `${ruleId}-${nonce}-${idx++}-${trashName(abs)}`);
    const mv = `mv ${shq(abs)} ${shq(dest)}`;
    if (!runSilent(mv)) {
      unwind();
      logTier0Note(trashDir, ruleId, `stood down: \`${mv}\` failed. Moves unwound.`, storeRoot);
      return null;
    }
    preCommands.push(mv);
    undo.unshift(`mv ${shq(dest)} ${shq(abs)}`);
    // `git clean -fd` removes the containing directory too, so the parent
    // may not exist at restore time.
    recoveryPairs.push([
      `mkdir -p ${shq(path.dirname(abs))}`,
      `mv ${shq(dest)} ${shq(abs)}`,
    ]);
  }
  if (preCommands.length === 0) {
    logTier0Note(trashDir, ruleId, "stood down: empty victim set.", storeRoot);
    return null;
  }
  // LIFO, matching the core rm rule.
  return { preCommands, recoveryCommands: recoveryPairs.reverse().flat() };
}

function isSafePath(p: string): boolean {
  const t = p.trim();
  if (!t) return false;
  if (/[*?]/.test(t)) return false;
  if (/^(?:\/|~|\.|\.\.|\*)$/.test(t)) return false;
  if (/^\/(home|usr|var|etc|bin|sbin|lib|boot|dev|proc|sys|root|opt)\/?$/.test(t)) return false;
  return true;
}

// ---------- git reset --hard ----------------------------------------------

const gitResetHard: PolicyRule = {
  id: "git-reset-hard",
  category: "git",
  toolName: "Bash",
  pattern: /^\s*git\s+reset\s+(?:\S+\s+)*--hard\b/,
  confidence: "high",
  description:
    "Record HEAD sha before `git reset --hard` so the branch can be moved back on restore.",
  apply(_match, ctx, _trashDir) {
    const command = rawCommand(ctx);
    if (hasCompound(command)) return null;

    const tokens = tokenize(command);
    if (tokens === null) return null;
    if (isHelpInvocation(tokens)) return null;

    const head = runCaptured("git rev-parse --verify HEAD");
    if (head === null || !/^[0-9a-f]{7,64}$/.test(head)) return null;

    const shaFile = join(_trashDir, "git-reset-hard.sha");
    try {
      fs.mkdirSync(_trashDir, { recursive: true });
    } catch {
      return null;
    }
    const saveCmd = `printf %s ${shq(head)} > ${shq(shaFile)}`;
    if (!runSilent(saveCmd)) return null;

    if (!runSilent(command)) {
      return null;
    }

    return {
      updatedInput: noopInput(ctx),
      preCommands: [saveCmd, command],
      recoveryCommands: [`git reset --hard ${head}`],
      description: `Saved HEAD ${head.slice(0, 12)} before git reset --hard (worktree captured by snapshot).`,
      ruleId: "git-reset-hard",
      // `git reset --hard` also destroys uncommitted worktree changes,
      // which the saved HEAD sha alone cannot restore. Keep tier-2 so
      // the shadow snapshot captures the dirty worktree before reset.
      preserveLowerTiers: true,
    };
  },
};

// ---------- git branch -D --------------------------------------------------

const gitBranchDeleteForce: PolicyRule = {
  id: "git-branch-delete-force",
  category: "git",
  toolName: "Bash",
  pattern: /^\s*git\s+branch\s+(?:\S+\s+)*(?:-D|--delete\s+--force)\b/,
  confidence: "high",
  description:
    "Capture branch sha before `git branch -D` so the ref can be recreated on restore.",
  apply(_match, ctx, _trashDir) {
    const command = rawCommand(ctx);
    if (hasCompound(command)) return null;

    const tokens = tokenize(command);
    if (tokens === null) return null;
    if (isHelpInvocation(tokens)) return null;

    const positional = tokens.slice(2).filter((t) => !t.startsWith("-"));
    if (positional.length !== 1) return null;
    const branch = positional[0];
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) return null;

    const sha = runCaptured(
      `git rev-parse --verify ${shq("refs/heads/" + branch)}`,
    );
    if (sha === null || !/^[0-9a-f]{7,64}$/.test(sha)) return null;

    if (!runSilent(command)) return null;

    return {
      updatedInput: noopInput(ctx),
      preCommands: [command],
      recoveryCommands: [`git branch -f ${shq(branch)} ${sha}`],
      description: `Captured sha ${sha.slice(0, 12)} of branch ${branch} before force-delete.`,
      ruleId: "git-branch-delete-force",
    };
  },
};

// ---------- git stash drop -------------------------------------------------

const gitStashDrop: PolicyRule = {
  id: "git-stash-drop",
  category: "git",
  toolName: "Bash",
  pattern: /^\s*git\s+stash\s+drop\b/,
  confidence: "high",
  description:
    "Preserve the stash commit under a backup ref before `git stash drop`; restore recreates stash@{0}.",
  apply(_match, ctx, _trashDir) {
    const command = rawCommand(ctx);
    if (hasCompound(command)) return null;

    const tokens = tokenize(command);
    if (tokens === null) return null;
    if (isHelpInvocation(tokens)) return null;

    const args = tokens
      .slice(3)
      .filter((t) => t !== "-q" && t !== "--quiet" && !t.startsWith("-"));
    if (args.length > 1) return null;
    const stashRef = args.length === 0 ? "stash@{0}" : args[0];
    if (!/^[A-Za-z0-9._@{}/-]+$/.test(stashRef)) return null;

    const sha = runCaptured(`git rev-parse --verify ${shq(stashRef)}`);
    if (sha === null || !/^[0-9a-f]{7,64}$/.test(sha)) return null;

    const backupRef = `refs/chats-sandbox/stash-${Date.now()}-${sha.slice(0, 8)}`;
    const backupCmd = `git update-ref ${shq(backupRef)} ${sha}`;
    if (!runSilent(backupCmd)) return null;

    if (!runSilent(command)) {
      runSilent(`git update-ref -d ${shq(backupRef)}`);
      return null;
    }

    return {
      updatedInput: noopInput(ctx),
      preCommands: [backupCmd, command],
      recoveryCommands: [
        `git stash store -m ${shq("chats-sandbox recovered stash")} ${sha}`,
        `git update-ref -d ${shq(backupRef)}`,
      ],
      description: `Backed up ${stashRef} (${sha.slice(0, 12)}) under ${backupRef} before drop.`,
      ruleId: "git-stash-drop",
    };
  },
};

// ---------- git push --force ----------------------------------------------

const gitPushForce: PolicyRule = {
  id: "git-push-force",
  category: "git",
  toolName: "Bash",
  pattern:
    /^\s*git\s+push\b(?=[^\n]*?\s(?:--force(?:-with-lease)?|-f)(?:=\S*|\b))/,
  confidence: "medium",
  description:
    "Record remote ref sha before `git push --force`. Remote may diverge before restore runs.",
  apply(_match, ctx, _trashDir) {
    const command = rawCommand(ctx);
    if (hasCompound(command)) return null;

    const tokens = tokenize(command);
    if (tokens === null) return null;
    if (isHelpInvocation(tokens)) return null;

    const positional: string[] = [];
    for (let i = 2; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.startsWith("-")) continue;
      positional.push(t);
    }
    if (positional.length !== 2) return null;
    const [remote, refspec] = positional;
    if (!/^[A-Za-z0-9._-]+$/.test(remote)) return null;

    const colonIdx = refspec.indexOf(":");
    const remoteRef = colonIdx >= 0 ? refspec.slice(colonIdx + 1) : refspec;
    const localRef = colonIdx >= 0 ? refspec.slice(0, colonIdx) : refspec;
    if (localRef.length === 0 || remoteRef.length === 0) return null;
    if (!/^[A-Za-z0-9._/-]+$/.test(remoteRef)) return null;

    const lsOut = runCaptured(`git ls-remote ${shq(remote)} ${shq(remoteRef)}`);
    if (lsOut === null) return null;

    let oldSha: string | null = null;
    if (lsOut !== "") {
      const firstLine = lsOut.split("\n")[0] ?? "";
      const candidate = firstLine.split(/\s+/)[0] ?? "";
      if (!/^[0-9a-f]{7,64}$/.test(candidate)) return null;
      oldSha = candidate;
    }

    if (!runSilent(command)) return null;

    const recoveryCommands: string[] =
      oldSha === null
        ? [`git push ${shq(remote)} --delete ${shq(remoteRef)}`]
        : [`git push --force ${shq(remote)} ${shq(oldSha + ":" + remoteRef)}`];

    return {
      updatedInput: noopInput(ctx),
      preCommands: [command],
      recoveryCommands,
      description:
        oldSha === null
          ? `Remote ${remote}/${remoteRef} did not exist before force-push; restore deletes it.`
          : `Recorded remote ${remote}/${remoteRef} at ${oldSha.slice(0, 12)} before force-push.`,
      ruleId: "git-push-force",
    };
  },
};

// ---------- docker rm ------------------------------------------------------

const dockerRm: PolicyRule = {
  id: "docker-rm",
  category: "container",
  toolName: "Bash",
  pattern: /^\s*docker\s+(?:container\s+)?rm\b/,
  confidence: "medium",
  description:
    "Commit container filesystem before `docker rm`. Restore via `docker create` from the recovery image; runtime state (ports, volumes, env) is NOT preserved — see inspect.json.",
  apply(_match, ctx, trashDir) {
    if (!which("docker")) return null;
    const command = rawCommand(ctx);
    if (hasCompound(command)) return null;

    const tokens = tokenize(command);
    if (tokens === null) return null;
    if (isHelpInvocation(tokens)) return null;

    let i = 1;
    if (tokens[i] === "container") i++;
    if (tokens[i] !== "rm") return null;
    i++;

    const containers: string[] = [];
    for (; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.startsWith("-")) continue;
      containers.push(t);
    }
    if (containers.length !== 1) return null;
    const container = containers[0];
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(container)) return null;

    const id = runCaptured(`docker inspect --format={{.Id}} ${shq(container)}`);
    if (id === null || !/^[0-9a-f]{12,}$/.test(id)) return null;

    try {
      fs.mkdirSync(trashDir, { recursive: true });
    } catch {
      return null;
    }

    const safeLabel = trashName(container).toLowerCase();
    const recoveryImage = `chats-sandbox/recovery-${safeLabel}:${Date.now()}`;
    const inspectFile = join(trashDir, `docker-${safeLabel}.inspect.json`);

    const inspectCmd = `docker inspect ${shq(container)} > ${shq(inspectFile)}`;
    if (!runSilent(inspectCmd)) return null;

    const commitCmd = `docker commit ${shq(id)} ${shq(recoveryImage)}`;
    if (!runSilent(commitCmd)) return null;

    if (!runSilent(command)) {
      runSilent(`docker image rm ${shq(recoveryImage)}`);
      return null;
    }

    return {
      updatedInput: noopInput(ctx),
      preCommands: [inspectCmd, commitCmd, command],
      recoveryCommands: [
        `docker create --name ${shq(container)} ${shq(recoveryImage)}`,
      ],
      description: `Committed container ${container} as ${recoveryImage}; inspect saved to ${inspectFile}.`,
      ruleId: "docker-rm",
    };
  },
};

// ---------- docker volume rm ----------------------------------------------

const dockerVolumeRm: PolicyRule = {
  id: "docker-volume-rm",
  category: "container",
  toolName: "Bash",
  pattern: /^\s*docker\s+volume\s+rm\b/,
  confidence: "high",
  description:
    "Tar the volume contents into the action trash before `docker volume rm`; restore creates a fresh volume and untars back.",
  apply(_match, ctx, trashDir) {
    if (!which("docker")) return null;
    const command = rawCommand(ctx);
    if (hasCompound(command)) return null;

    const tokens = tokenize(command);
    if (tokens === null) return null;
    if (isHelpInvocation(tokens)) return null;
    if (tokens[0] !== "docker" || tokens[1] !== "volume" || tokens[2] !== "rm")
      return null;

    const volumes: string[] = [];
    for (let i = 3; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.startsWith("-")) continue;
      volumes.push(t);
    }
    if (volumes.length !== 1) return null;
    const volume = volumes[0];
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(volume)) return null;

    if (!runSilent(`docker volume inspect ${shq(volume)}`)) return null;

    try {
      fs.mkdirSync(trashDir, { recursive: true });
    } catch {
      return null;
    }

    const safeLabel = trashName(volume);
    const tarName = `docker-volume-${safeLabel}.tar`;
    const tarFile = join(trashDir, tarName);
    const backupCmd =
      `docker run --rm ` +
      `-v ${shq(volume + ":/v:ro")} ` +
      `-v ${shq(trashDir + ":/out")} ` +
      `busybox sh -c ${shq(`tar cf /out/${tarName} -C /v .`)}`;
    if (!runSilent(backupCmd)) return null;
    if (!existsSync(tarFile)) return null;

    if (!runSilent(command)) return null;

    return {
      updatedInput: noopInput(ctx),
      preCommands: [backupCmd, command],
      recoveryCommands: [
        `docker volume create ${shq(volume)}`,
        `docker run --rm ` +
          `-v ${shq(volume + ":/v")} ` +
          `-v ${shq(trashDir + ":/backup:ro")} ` +
          `busybox sh -c ${shq(`tar xf /backup/${tarName} -C /v`)}`,
      ],
      description: `Archived docker volume ${volume} to ${tarFile} before removal.`,
      ruleId: "docker-volume-rm",
    };
  },
};

// ---------- docker image rm / rmi -----------------------------------------

const dockerImageRm: PolicyRule = {
  id: "docker-image-rm",
  category: "container",
  toolName: "Bash",
  pattern: /^\s*docker\s+(?:image\s+rm|rmi)\b/,
  confidence: "high",
  description:
    "`docker save` the image tarball before `rmi`; restore via `docker load`.",
  apply(_match, ctx, trashDir) {
    if (!which("docker")) return null;
    const command = rawCommand(ctx);
    if (hasCompound(command)) return null;

    const tokens = tokenize(command);
    if (tokens === null) return null;
    if (isHelpInvocation(tokens)) return null;

    let i = 1;
    if (tokens[i] === "image") {
      i++;
      if (tokens[i] !== "rm") return null;
      i++;
    } else if (tokens[i] === "rmi") {
      i++;
    } else {
      return null;
    }

    const images: string[] = [];
    for (; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.startsWith("-")) continue;
      images.push(t);
    }
    if (images.length !== 1) return null;
    const image = images[0];
    if (!/^[A-Za-z0-9][A-Za-z0-9_./:@-]*$/.test(image)) return null;

    const resolved = runCaptured(
      `docker inspect --format={{.Id}} ${shq(image)}`,
    );
    if (resolved === null) return null;

    try {
      fs.mkdirSync(trashDir, { recursive: true });
    } catch {
      return null;
    }

    const safeLabel = trashName(image);
    const tarFile = join(trashDir, `docker-image-${safeLabel}.tar`);
    const saveCmd = `docker save ${shq(image)} -o ${shq(tarFile)}`;
    if (!runSilent(saveCmd)) return null;
    if (!existsSync(tarFile)) return null;

    if (!runSilent(command)) return null;

    return {
      updatedInput: noopInput(ctx),
      preCommands: [saveCmd, command],
      recoveryCommands: [`docker load -i ${shq(tarFile)}`],
      description: `Saved docker image ${image} to ${tarFile} before removal.`,
      ruleId: "docker-image-rm",
    };
  },
};

// ---------- kubectl delete -------------------------------------------------

const kubectlDelete: PolicyRule = {
  id: "kubectl-delete",
  category: "k8s",
  toolName: "Bash",
  pattern: /^\s*kubectl\s+delete\s+/,
  exclude:
    /\bkubectl\s+delete\s+(?:[^\n]*?\s)?(?:namespace|ns|crd|customresourcedefinition|clusterrole|clusterrolebinding|node|persistentvolume|pv|storageclass|-f|--filename|-l|--selector|--all|--all-namespaces|-A)\b/,
  confidence: "medium",
  description:
    "Snapshot a single namespaced resource via `kubectl get -o yaml` before `kubectl delete`; restore via `kubectl apply -f`.",
  apply(_match, ctx, trashDir) {
    if (!which("kubectl")) return null;
    const command = rawCommand(ctx);
    if (hasCompound(command)) return null;

    const tokens = tokenize(command);
    if (tokens === null) return null;
    if (isHelpInvocation(tokens)) return null;
    if (tokens[0] !== "kubectl" || tokens[1] !== "delete") return null;

    const positional: string[] = [];
    let namespace: string | null = null;
    for (let i = 2; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === "-n" || t === "--namespace") {
        namespace = tokens[i + 1] ?? null;
        i++;
        continue;
      }
      if (t.startsWith("--namespace=")) {
        namespace = t.slice("--namespace=".length);
        continue;
      }
      if (t.startsWith("-")) continue;
      positional.push(t);
    }

    let kind: string;
    let name: string;
    if (positional.length === 2) {
      kind = positional[0];
      name = positional[1];
    } else if (positional.length === 1 && positional[0].includes("/")) {
      const parts = positional[0].split("/");
      if (parts.length !== 2) return null;
      kind = parts[0];
      name = parts[1];
    } else {
      return null;
    }
    if (!/^[A-Za-z][A-Za-z0-9.-]*$/.test(kind)) return null;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return null;
    if (namespace !== null && !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(namespace))
      return null;

    try {
      fs.mkdirSync(trashDir, { recursive: true });
    } catch {
      return null;
    }

    const selector = `${kind}/${name}`;
    const nsFlag = namespace === null ? "" : ` -n ${shq(namespace)}`;
    const safeLabel = trashName(
      `${kind}-${name}${namespace === null ? "" : `-${namespace}`}`,
    );
    const yamlFile = join(trashDir, `kubectl-${safeLabel}.yaml`);

    const dumpCmd = `kubectl get ${shq(selector)}${nsFlag} -o yaml > ${shq(yamlFile)}`;
    if (!runSilent(dumpCmd)) return null;
    if (!existsSync(yamlFile)) return null;

    if (!runSilent(command)) return null;

    return {
      updatedInput: noopInput(ctx),
      preCommands: [dumpCmd, command],
      recoveryCommands: [`kubectl apply -f ${shq(yamlFile)}${nsFlag}`],
      description:
        `Snapshotted ${selector}` +
        (namespace === null ? "" : ` (namespace=${namespace})`) +
        ` to ${yamlFile} before delete.`,
      ruleId: "kubectl-delete",
    };
  },
};

// ---------- chmod / chown (record-and-pass) ------------------------------

/** True when the arg list carries chmod/chown's recursive flag (`-R`,
 *  `--recursive`, or `R` inside a short cluster like `-vR`). Note `-r` is
 *  NOT recursion for either tool. */
function hasRecursiveFlag(tokens: string[]): boolean {
  return tokens.some(
    (t) =>
      t === "--recursive" ||
      (/^-[A-Za-z]+$/.test(t) && t.includes("R")),
  );
}

/**
 * Record the modes/owners of a whole subtree so a `chmod -R` / `chown -R`
 * can be undone exactly.
 *
 * The inverse is one command per entry, which for a real tree is far too
 * many to inline into metadata.json — so we generate a shell script into
 * the action trash and record a single `sh <script>` as the recovery.
 * Everything is derived from one `find -printf` pass; if that can't be
 * parsed (BSD find has no -printf, a filename contains a newline) or the
 * tree exceeds MAX_TREE_ENTRIES, we bail rather than record a partial
 * inverse. Symlinks are excluded because chmod/chown -R do not alter them
 * either, and re-applying a mode to a symlink would hit its TARGET.
 */
function recordSubtreeAttrs(
  absPaths: string[],
  trashDir: string,
  ruleId: "chmod" | "chown",
): { recoveryCommands: string[]; preCommands: string[]; entries: number } | null {
  const listing = runCaptured(
    `find ${absPaths.map(shq).join(" ")} ! -type l -printf '%m %U %G %p\\n'`,
  );
  if (listing === null || listing === "") return null;
  const lines = listing.split("\n").filter((l) => l !== "");
  if (lines.length === 0 || lines.length > MAX_TREE_ENTRIES) return null;

  const script: string[] = [];
  for (const line of lines) {
    const m = /^([0-7]{3,4}) (\d+) (\d+) (\/.+)$/.exec(line);
    if (m === null) return null; // unparseable entry — no partial inverses
    script.push(
      ruleId === "chmod"
        ? `chmod ${m[1]} ${shq(m[4])}`
        : `chown ${m[2]}:${m[3]} ${shq(m[4])}`,
    );
  }

  try {
    fs.mkdirSync(trashDir, { recursive: true });
  } catch {
    return null;
  }
  const scriptFile = join(
    trashDir,
    `${ruleId}-recursive-${trashName(path.basename(absPaths[0]))}-${Date.now()}.sh`,
  );
  try {
    fs.writeFileSync(
      scriptFile,
      `#!/bin/sh\n# chats-sandbox: re-apply the ${ruleId === "chmod" ? "modes" : "owners"} recorded before \`${ruleId} -R\`.\n` +
        script.join("\n") +
        "\n",
      "utf-8",
    );
  } catch {
    return null;
  }

  return {
    entries: lines.length,
    preCommands: [
      `# recorded ${lines.length} ${ruleId === "chmod" ? "modes" : "owners"} under ${absPaths.join(", ")} to ${scriptFile}`,
    ],
    recoveryCommands: [`sh ${shq(scriptFile)}`],
  };
}

/** Split `chmod|chown [flags] SPEC path…` into its operands. Flags may be
 *  interleaved; the first non-flag operand is the mode / owner spec. */
function attrOperands(tokens: string[]): string[] | null {
  const operands = tokens.slice(1).filter((t) => !t.startsWith("-") || t === "-");
  if (operands.length < 2) return null;
  return operands.slice(1); // drop the mode / owner spec
}

const chmodRule: PolicyRule = {
  id: "chmod",
  category: "fs-overwrite",
  toolName: "Bash",
  pattern: /^\s*chmod\s+\S+\s+\S+/,
  exclude: /[|;&`]|\$\(/,
  confidence: "high",
  description:
    "Save old file mode before chmod; for `chmod -R`, record every mode in the subtree. Recover via chmod <old>.",
  apply(_match, ctx, trashDir): PolicyRuleResult | null {
    const command = rawCommand(ctx);
    const tokens = tokenize(command);
    if (tokens === null) return null;
    const paths = attrOperands(tokens);
    if (paths === null || paths.length === 0) return null;

    const abs: string[] = [];
    for (const p of paths) {
      if (!isSafePath(p)) return null;
      const a = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
      if (!fs.existsSync(a)) return null;
      abs.push(a);
    }

    if (hasRecursiveFlag(tokens)) {
      const rec = recordSubtreeAttrs(abs, trashDir, "chmod");
      if (rec === null) return null;
      return {
        updatedInput: { ...ctx.tool_input },
        preCommands: rec.preCommands,
        recoveryCommands: rec.recoveryCommands,
        description: `chmod -R (${rec.entries} entries, original modes recorded)`,
        ruleId: "chmod",
      };
    }

    const preCommands: string[] = [];
    const recoveryCommands: string[] = [];
    for (const a of abs) {
      let mode = runCaptured(`stat -c %a ${shq(a)}`);
      if (!mode) mode = runCaptured(`stat -f %Lp ${shq(a)}`);
      if (!mode || !/^[0-7]{3,4}$/.test(mode)) return null;
      preCommands.push(`# recorded mode ${mode} for ${a}`);
      recoveryCommands.push(`chmod ${mode} ${shq(a)}`);
    }
    return {
      updatedInput: { ...ctx.tool_input },
      preCommands,
      recoveryCommands,
      description: `chmod (${abs.length} path${abs.length === 1 ? "" : "s"}, original modes recorded)`,
      ruleId: "chmod",
    };
  },
};

const chownRule: PolicyRule = {
  id: "chown",
  category: "fs-overwrite",
  toolName: "Bash",
  pattern: /^\s*chown\s+\S+\s+\S+/,
  exclude: /[|;&`]|\$\(/,
  confidence: "high",
  description:
    "Save old owner:group before chown; for `chown -R`, record every owner in the subtree. Recover via chown <old>.",
  apply(_match, ctx, trashDir): PolicyRuleResult | null {
    const command = rawCommand(ctx);
    const tokens = tokenize(command);
    if (tokens === null) return null;
    const paths = attrOperands(tokens);
    if (paths === null || paths.length === 0) return null;

    const abs: string[] = [];
    for (const p of paths) {
      if (!isSafePath(p)) return null;
      const a = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
      if (!fs.existsSync(a)) return null;
      abs.push(a);
    }

    if (hasRecursiveFlag(tokens)) {
      const rec = recordSubtreeAttrs(abs, trashDir, "chown");
      if (rec === null) return null;
      return {
        updatedInput: { ...ctx.tool_input },
        preCommands: rec.preCommands,
        recoveryCommands: rec.recoveryCommands,
        description: `chown -R (${rec.entries} entries, original owners recorded)`,
        ruleId: "chown",
      };
    }

    const preCommands: string[] = [];
    const recoveryCommands: string[] = [];
    for (const a of abs) {
      let spec = runCaptured(`stat -c %u:%g ${shq(a)}`);
      if (!spec) spec = runCaptured(`stat -f %u:%g ${shq(a)}`);
      if (!spec || !/^\d+:\d+$/.test(spec)) return null;
      preCommands.push(`# recorded owner ${spec} for ${a}`);
      recoveryCommands.push(`chown ${spec} ${shq(a)}`);
    }
    return {
      updatedInput: { ...ctx.tool_input },
      preCommands,
      recoveryCommands,
      description: `chown (${abs.length} path${abs.length === 1 ? "" : "s"}, original owners recorded)`,
      ruleId: "chown",
    };
  },
};

// ---------- outside-workspace Write to NEW path -------------------------

const outsideWorkspaceWriteNew: PolicyRule = {
  id: "outside-workspace-write-new",
  category: "fs-delete",
  toolName: "Write",
  pattern: /.*/,
  confidence: "high",
  description:
    "Write to a NEW path outside cwd: no data to preserve, record rm as recovery (cheaper than escalating to tier-3 subagent).",
  apply(_match, ctx, _trashDir): PolicyRuleResult | null {
    const target = ctx.tool_input.file_path as string | undefined;
    if (!target || typeof target !== "string") return null;
    if (!path.isAbsolute(target)) return null;
    const cwd = process.cwd();
    if (!path.relative(cwd, target).startsWith("..")) return null;
    if (fs.existsSync(target)) return null;
    if (!isSafePath(target)) return null;

    return {
      updatedInput: { ...ctx.tool_input },
      preCommands: [`# outside-workspace create, no data captured`],
      recoveryCommands: [`rm ${shq(target)}`],
      description: `Write new file outside workspace (recovery: rm ${path.basename(target)})`,
      ruleId: "outside-workspace-write-new",
    };
  },
};

// ---------- mv (record inverse, snapshot a clobbered dest) ---------------

const mvRule: PolicyRule = {
  id: "mv-overwrite",
  category: "fs-overwrite",
  toolName: "Bash",
  pattern: /^\s*mv\s+/,
  confidence: "high",
  description:
    "Run `mv src dst`, record the inverse `mv dst src`; if dst already existed, snapshot it first so the clobbered file can be restored too.",
  apply(_match, ctx, trashDir) {
    const command = rawCommand(ctx);
    if (hasCompound(command)) return null;
    const tokens = tokenize(command);
    if (tokens === null) return null;
    if (isHelpInvocation(tokens)) return null;
    if (tokens[0] !== "mv") return null;

    const positional: string[] = [];
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i];
      // Flags that change move semantics or would prompt: bail.
      if (t === "-t" || t === "--target-directory" || t.startsWith("--target-directory="))
        return null;
      if (t === "-i" || t === "--interactive") return null;
      if (t === "-S" || t === "--suffix") {
        i++;
        continue;
      }
      if (t.startsWith("--suffix=")) continue;
      if (t.startsWith("-") && t !== "-") continue;
      positional.push(t);
    }
    // Only the simple two-operand form (single src → single dst).
    if (positional.length !== 2) return null;
    const [src, dst] = positional;
    if (!isSafePath(src) || !isSafePath(dst)) return null;

    const cwd = process.cwd();
    const absSrc = path.isAbsolute(src) ? src : path.resolve(cwd, src);
    const absDst = path.isAbsolute(dst) ? dst : path.resolve(cwd, dst);
    try {
      if (!fs.existsSync(absSrc)) return null;
    } catch {
      return null;
    }

    // If dst is an existing directory the file lands inside it.
    let landed = absDst;
    try {
      if (fs.existsSync(absDst) && fs.statSync(absDst).isDirectory()) {
        landed = join(absDst, path.basename(absSrc));
      }
    } catch {
      return null;
    }
    if (landed === absSrc) return null; // no-op / self move

    try {
      fs.mkdirSync(trashDir, { recursive: true });
    } catch {
      return null;
    }

    const preCommands: string[] = [];
    let backupFile: string | null = null;
    let clobbered = false;
    try {
      clobbered = fs.existsSync(landed);
    } catch {
      return null;
    }
    if (clobbered) {
      backupFile = join(trashDir, `mv-clobbered-${trashName(landed)}-${Date.now()}.bak`);
      const cpCmd = `cp -a ${shq(landed)} ${shq(backupFile)}`;
      if (!runSilent(cpCmd)) return null;
      if (!existsSync(backupFile)) return null;
      preCommands.push(cpCmd);
    }

    if (!runSilent(command)) return null;
    preCommands.push(command);

    const recoveryCommands: string[] = [`mv ${shq(landed)} ${shq(absSrc)}`];
    if (clobbered && backupFile) {
      recoveryCommands.push(`cp -a ${shq(backupFile)} ${shq(landed)}`);
    }

    return {
      updatedInput: noopInput(ctx),
      preCommands,
      recoveryCommands,
      description: clobbered
        ? `mv with clobber: snapshotted ${path.basename(landed)}; inverse mv recorded.`
        : `mv: recorded inverse mv ${path.basename(landed)} → ${path.basename(absSrc)}.`,
      ruleId: "mv-overwrite",
    };
  },
};


// ---------- cp (snapshot a clobbered dest, else record the delete) --------

const cpRule: PolicyRule = {
  id: "cp-overwrite",
  category: "fs-overwrite",
  toolName: "Bash",
  pattern: /^\s*cp\s+/,
  confidence: "high",
  description:
    "Run `cp src dst`; if dst already existed, snapshot it first so the clobbered file can be restored, otherwise record the `rm` that undoes the new file.",
  apply(_match, ctx, trashDir) {
    const command = rawCommand(ctx);
    if (hasCompound(command)) return null;
    const tokens = tokenize(command);
    if (tokens === null) return null;
    if (isHelpInvocation(tokens)) return null;
    if (tokens[0] !== "cp") return null;

    const positional: string[] = [];
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i];
      // A tree destination is not an O(1) rename; leave it to tier 3.
      if (t === "-r" || t === "-R" || t === "--recursive") return null;
      if (t === "-a" || t === "--archive") return null;
      if (t === "-t" || t === "--target-directory" || t.startsWith("--target-directory="))
        return null;
      if (t === "-i" || t === "--interactive") return null;
      if (t === "-S" || t === "--suffix") { i++; continue; }
      if (t.startsWith("--suffix=")) continue;
      if (t.startsWith("-") && t !== "-") continue;
      positional.push(t);
    }
    if (positional.length !== 2) return null;
    const [src, dst] = positional;
    if (!isSafePath(src) || !isSafePath(dst)) return null;

    const cwd = process.cwd();
    const absSrc = path.isAbsolute(src) ? src : path.resolve(cwd, src);
    const absDst = path.isAbsolute(dst) ? dst : path.resolve(cwd, dst);
    try {
      if (!fs.existsSync(absSrc)) return null;
      if (fs.statSync(absSrc).isDirectory()) return null;
    } catch {
      return null;
    }

    let landed = absDst;
    try {
      if (fs.existsSync(absDst) && fs.statSync(absDst).isDirectory()) {
        landed = join(absDst, path.basename(absSrc));
      }
    } catch {
      return null;
    }
    if (landed === absSrc) return null;

    try {
      fs.mkdirSync(trashDir, { recursive: true });
    } catch {
      return null;
    }

    const preCommands: string[] = [];
    let backupFile: string | null = null;
    let clobbered = false;
    try {
      clobbered = fs.existsSync(landed);
    } catch {
      return null;
    }
    if (clobbered) {
      backupFile = join(trashDir, `cp-clobbered-${trashName(landed)}-${Date.now()}.bak`);
      const cpCmd = `cp -a ${shq(landed)} ${shq(backupFile)}`;
      if (!runSilent(cpCmd)) return null;
      if (!existsSync(backupFile)) return null;
      preCommands.push(cpCmd);
    }

    if (!runSilent(command)) return null;
    preCommands.push(command);

    const recoveryCommands: string[] = clobbered && backupFile
      ? [`cp -a ${shq(backupFile)} ${shq(landed)}`]
      : [`rm -f ${shq(landed)}`];

    return {
      updatedInput: noopInput(ctx),
      preCommands,
      recoveryCommands,
      description: clobbered
        ? `cp with clobber: snapshotted ${path.basename(landed)} before overwriting it.`
        : `cp to a new path: recorded the rm that removes ${path.basename(landed)}.`,
      ruleId: "cp-overwrite",
    };
  },
};

// ---------- sed -i (in-place stream edit) --------------------------------

const sedInPlace: PolicyRule = {
  id: "sed-in-place",
  category: "fs-overwrite",
  toolName: "Bash",
  pattern: /^\s*sed\s+/,
  confidence: "high",
  description:
    "Snapshot file bytes before a `sed -i` in-place edit; restore via cp back.",
  apply(_match, ctx, trashDir) {
    const command = rawCommand(ctx);
    if (hasCompound(command)) return null;
    const tokens = tokenize(command);
    if (tokens === null) return null;
    if (isHelpInvocation(tokens)) return null;
    if (tokens[0] !== "sed") return null;

    let inPlace = false;
    const positional: string[] = [];
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i];
      if (
        t === "-i" ||
        t === "--in-place" ||
        /^-i\.[A-Za-z0-9_]+$/.test(t) ||
        t.startsWith("--in-place=")
      ) {
        inPlace = true;
        continue;
      }
      // Script-supplying flags make file identification ambiguous: bail.
      if (t === "-e" || t === "--expression" || t === "-f" || t === "--file")
        return null;
      if (t.startsWith("-") && t !== "-") {
        // A clustered short flag that includes `i` (e.g. -ni) is ambiguous.
        if (/^-[A-Za-z]*i[A-Za-z]*$/.test(t)) return null;
        continue;
      }
      positional.push(t);
    }
    if (!inPlace) return null;
    // positionals = [script, file1, file2, ...]
    if (positional.length < 2) return null;
    const abs: string[] = [];
    for (const f of positional.slice(1)) {
      const a = resolveExistingFile(f);
      if (a === null) return null;
      abs.push(a);
    }
    return snapshotAndRun(
      ctx,
      command,
      abs,
      trashDir,
      "sed-in-place",
      (n) => `Snapshotted ${n} file${n === 1 ? "" : "s"} before sed -i.`,
    );
  },
};

// ---------- truncate (in-place size change / wipe) -----------------------

const truncateRule: PolicyRule = {
  id: "truncate",
  category: "fs-overwrite",
  toolName: "Bash",
  pattern: /^\s*truncate\s+/,
  confidence: "high",
  description:
    "Snapshot file bytes before `truncate` shrinks/wipes them in place; restore via cp back.",
  apply(_match, ctx, trashDir) {
    const command = rawCommand(ctx);
    if (hasCompound(command)) return null;
    const tokens = tokenize(command);
    if (tokens === null) return null;
    if (isHelpInvocation(tokens)) return null;
    if (tokens[0] !== "truncate") return null;

    const positional: string[] = [];
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i];
      // -r/--reference points at another file, not a target: too ambiguous.
      if (t === "-r" || t === "--reference" || t.startsWith("--reference="))
        return null;
      if (t === "-s" || t === "--size") {
        i++;
        continue;
      }
      if (t.startsWith("-") && t !== "-") continue; // -s0, --size=0, -c, -o ...
      positional.push(t);
    }
    if (positional.length === 0) return null;
    const abs: string[] = [];
    for (const f of positional) {
      const a = resolveExistingFile(f);
      if (a === null) return null;
      abs.push(a);
    }
    return snapshotAndRun(
      ctx,
      command,
      abs,
      trashDir,
      "truncate",
      (n) => `Snapshotted ${n} file${n === 1 ? "" : "s"} before truncate.`,
    );
  },
};

// ---------- git restore / checkout -- <path> (discard worktree edits) ----

const gitDiscardWorktree: PolicyRule = {
  id: "git-discard-worktree",
  category: "git",
  toolName: "Bash",
  pattern: /^\s*git\s+(?:checkout|restore)\b/,
  confidence: "high",
  description:
    "Snapshot working-tree bytes before `git restore <path>` / `git checkout -- <path>` discards uncommitted edits; restore via cp back.",
  apply(_match, ctx, trashDir) {
    if (!which("git")) return null;
    const command = rawCommand(ctx);
    if (hasCompound(command)) return null;
    const tokens = tokenize(command);
    if (tokens === null) return null;
    if (isHelpInvocation(tokens)) return null;
    if (tokens[0] !== "git") return null;
    const sub = tokens[1];
    if (sub !== "checkout" && sub !== "restore") return null;

    let sawSep = false;
    const positional: string[] = [];
    for (let i = 2; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === "--") {
        sawSep = true;
        continue;
      }
      if (sawSep) {
        positional.push(t);
        continue;
      }
      if (sub === "checkout") {
        // Branch-affecting forms are not a pure path discard: bail.
        if (t === "-b" || t === "-B" || t === "--orphan" || t === "--detach")
          return null;
        if (t.startsWith("-")) continue;
        // A bare operand before `--` on checkout is ambiguous (branch vs
        // path), so we only handle the explicit `git checkout -- <path>` form.
        return null;
      }
      // git restore: always overwrites the worktree unless --staged-only.
      if (t === "--staged" || t === "-S") return null; // index only, nothing to snapshot
      if (t === "-s" || t === "--source") {
        i++;
        continue;
      }
      if (t.startsWith("-")) continue;
      positional.push(t);
    }
    if (positional.length === 0) return null;
    const abs: string[] = [];
    for (const p of positional) {
      const a = resolveExistingFile(p);
      if (a === null) return null; // only snapshot existing regular files
      abs.push(a);
    }
    return snapshotAndRun(
      ctx,
      command,
      abs,
      trashDir,
      "git-discard-worktree",
      (n) =>
        `Snapshotted ${n} working file${n === 1 ? "" : "s"} before git ${sub} discard.`,
    );
  },
};

// ---------- git clean (delete untracked files) ---------------------------

const gitClean: PolicyRule = {
  id: "git-clean",
  category: "git",
  toolName: "Bash",
  pattern: /^\s*git\s+clean\b/,
  confidence: "high",
  description:
    "Enumerate what `git clean` would delete (`git clean -n…`), move those paths into the per-action trash, and record the exact `mv` back.",
  apply(_match, ctx, trashDir, storeRoot) {
    if (!which("git")) return null;
    const command = rawCommand(ctx);
    if (hasCompound(command)) return null;
    const tokens = tokenize(command);
    if (tokens === null) return null;
    if (isHelpInvocation(tokens)) return null;
    if (tokens[0] !== "git" || tokens[1] !== "clean") return null;

    let force = false;
    let dirs = false;
    let ignoredToo = false;
    let onlyIgnored = false;
    let dryRun = false;
    const excludes: string[] = [];
    const pathspecs: string[] = [];
    let sawSep = false;

    for (let i = 2; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === "--") {
        sawSep = true;
        continue;
      }
      if (!sawSep && t.startsWith("--")) {
        if (t === "--force") { force = true; continue; }
        if (t === "--dry-run") { dryRun = true; continue; }
        if (t === "--quiet") continue;
        if (t === "--interactive") return null;
        if (t === "--exclude") {
          const v = tokens[++i];
          if (v === undefined) return null;
          excludes.push(v);
          continue;
        }
        if (t.startsWith("--exclude=")) {
          excludes.push(t.slice("--exclude=".length));
          continue;
        }
        return null; // unknown long option — don't guess at the victim set
      }
      if (!sawSep && t.startsWith("-") && t !== "-") {
        // Short cluster: -f -d -x -X -n -q -e<pat> (and -ff).
        let consumedRest = false;
        for (let k = 1; k < t.length && !consumedRest; k++) {
          switch (t[k]) {
            case "f": force = true; break;
            case "d": dirs = true; break;
            case "x": ignoredToo = true; break;
            case "X": onlyIgnored = true; break;
            case "n": dryRun = true; break;
            case "q": break;
            case "e": {
              const glued = t.slice(k + 1);
              if (glued) excludes.push(glued);
              else {
                const v = tokens[++i];
                if (v === undefined) return null;
                excludes.push(v);
              }
              consumedRest = true;
              break;
            }
            default: return null; // -i and anything unrecognized
          }
        }
        continue;
      }
      pathspecs.push(t);
    }

    if (dryRun) return null; // nothing is destroyed
    if (!force) {
      // git refuses to clean without -f unless clean.requireForce=false.
      const rf = runCaptured("git config --bool --get clean.requireForce");
      if (rf !== "false") return null;
    }

    // Enumerate the EXACT victim set: same selection flags, dry-run mode.
    // LC_ALL=C pins the "Would remove" wording we parse.
    const listCmd =
      `LC_ALL=C git clean -n${dirs ? "d" : ""}${ignoredToo ? "x" : ""}${onlyIgnored ? "X" : ""}` +
      excludes.map((e) => ` -e ${shq(e)}`).join("") +
      (pathspecs.length > 0 ? ` -- ${pathspecs.map(shq).join(" ")}` : "");
    const listed = runCaptured(listCmd);
    if (listed === null || listed === "") return null;

    const victims: string[] = [];
    for (const line of listed.split("\n")) {
      if (line.trim() === "") continue;
      // Nested repos are skipped by git clean too (without -ff).
      if (/^Would skip repository /.test(line)) continue;
      const m = /^Would remove (.+)$/.exec(line);
      if (m === null) return null; // unrecognized output — can't trust the set
      let rel = m[1];
      if (rel.endsWith("/")) rel = rel.slice(0, -1);
      if (!isSafePath(rel)) return null;
      const abs = path.isAbsolute(rel) ? rel : path.resolve(process.cwd(), rel);
      try {
        if (!fs.existsSync(abs)) return null;
      } catch {
        return null;
      }
      victims.push(abs);
    }
    if (victims.length === 0) return null;

    // `git clean -fdx` lists the sandbox store as an untracked victim.
    // Filter it out before anything moves; if it was the ONLY victim we
    // still rewrite, because falling through leaves the real `git clean`
    // to delete the store.
    const { kept: roots, skipped } = excludeSandboxStore(
      dropNested(victims),
      trashDir,
      storeRoot,
    );
    if (skipped.length > 0) {
      logTier0Note(
        trashDir,
        "git-clean",
        `kept the sandbox store out of the victim set: ${skipped.join(", ")}. ` +
          `${roots.length} other path(s) moved to trash; the command is ` +
          `rewritten either way so the real \`git clean\` never runs.`,
        storeRoot,
      );
    }
    if (roots.length === 0) {
      // Nothing left but the store. Rewrite to a noop so the original
      // never runs, and let the lower tiers still cover the action.
      return {
        updatedInput: {
          ...(ctx.tool_input as Record<string, unknown>),
          command: `true  # chats-sandbox: git clean had nothing to remove but the backup store`,
        },
        preCommands: [],
        recoveryCommands: [],
        description:
          `git clean → nothing removed: the only match was the sandbox's own ` +
          `backup store (${skipped.join(", ")}), which is preserved.`,
        ruleId: "git-clean",
        preserveLowerTiers: true,
      };
    }
    const moved = moveVictimsToTrash(roots, trashDir, "git-clean", storeRoot);
    if (moved === null) return null;

    // The paths are already out of the working tree, so the original
    // `git clean` has nothing left to do — same shape as rm-to-trash.
    return {
      updatedInput: {
        ...(ctx.tool_input as Record<string, unknown>),
        command: `true  # chats-sandbox: git clean rewritten to trash, ${roots.length} path(s)`,
      },
      preCommands: moved.preCommands,
      recoveryCommands: moved.recoveryCommands,
      description: `git clean → soft-deleted ${roots.length} untracked path(s) to trash (reversible).`,
      ruleId: "git-clean",
    };
  },
};

// ---------- git worktree remove --force ----------------------------------

const gitWorktreeRemove: PolicyRule = {
  id: "git-worktree-remove-force",
  category: "git",
  toolName: "Bash",
  pattern: /^\s*git\s+worktree\s+remove\b/,
  confidence: "high",
  description:
    "Snapshot a linked worktree's full content (untracked files included) and its git admin dir before `git worktree remove --force`; restore copies both back.",
  apply(_match, ctx, trashDir) {
    if (!which("git")) return null;
    const command = rawCommand(ctx);
    if (hasCompound(command)) return null;
    const tokens = tokenize(command);
    if (tokens === null) return null;
    if (isHelpInvocation(tokens)) return null;
    if (
      tokens[0] !== "git" ||
      tokens[1] !== "worktree" ||
      tokens[2] !== "remove"
    ) {
      return null;
    }

    let force = false;
    const positional: string[] = [];
    for (let i = 3; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === "--") continue;
      if (t === "-f" || t === "--force") { force = true; continue; }
      if (t === "--dry-run") return null;
      if (t.startsWith("-")) return null; // unknown option — bail
      positional.push(t);
    }
    // Without --force git refuses to remove a worktree that has untracked
    // or modified content, so the only thing at risk is the checkout of
    // already-committed state. --force is the destructive form.
    if (!force) return null;
    if (positional.length !== 1) return null;

    const wt = positional[0];
    if (!isSafePath(wt)) return null;
    const absWt = path.isAbsolute(wt) ? wt : path.resolve(process.cwd(), wt);
    try {
      if (!fs.statSync(absWt).isDirectory()) return null;
    } catch {
      return null;
    }

    // `git worktree remove` deletes the admin dir under the MAIN repo
    // (<main>/.git/worktrees/<name>) as well. Without it the restored
    // directory is a loose checkout, not a registered worktree — so the
    // inverse has to carry both halves or it isn't exact.
    const adminDir = runCaptured(
      `git -C ${shq(absWt)} rev-parse --absolute-git-dir`,
    );
    if (adminDir === null || !path.isAbsolute(adminDir)) return null;
    if (path.basename(path.dirname(adminDir)) !== "worktrees") return null;
    try {
      if (!fs.statSync(adminDir).isDirectory()) return null;
    } catch {
      return null;
    }

    const entries = countTreeEntries(absWt);
    if (entries === null || entries > MAX_TREE_ENTRIES) return null;

    const base = join(
      trashDir,
      `git-worktree-${trashName(path.basename(absWt))}-${Date.now()}`,
    );
    try {
      fs.mkdirSync(base, { recursive: true });
    } catch {
      return null;
    }
    const treeSnap = join(base, "tree");
    const adminSnap = join(base, "admin");

    const cpTree = `cp -a ${shq(absWt)} ${shq(treeSnap)}`;
    if (!runSilent(cpTree)) return null;
    if (!existsSync(treeSnap)) return null;
    const cpAdmin = `cp -a ${shq(adminDir)} ${shq(adminSnap)}`;
    if (!runSilent(cpAdmin)) return null;
    if (!existsSync(adminSnap)) return null;

    if (!runSilent(command)) return null;

    return {
      updatedInput: noopInput(ctx),
      preCommands: [cpTree, cpAdmin, command],
      recoveryCommands: [
        `mkdir -p ${shq(path.dirname(adminDir))}`,
        `cp -a ${shq(adminSnap)} ${shq(adminDir)}`,
        `mkdir -p ${shq(path.dirname(absWt))}`,
        `cp -a ${shq(treeSnap)} ${shq(absWt)}`,
      ],
      description: `Snapshotted worktree ${absWt} (${entries} entries, untracked content included) and its admin dir before force-remove.`,
      ruleId: "git-worktree-remove-force",
    };
  },
};

// ---------- rsync --delete (destination tree is overwritten) -------------

/** rsync's delete family, all of which prune extraneous files from the
 *  destination. `--delete-excluded` implies deletion too. */
const RSYNC_DELETE_FLAG =
  /^--del(?:ete(?:-before|-during|-delay|-after|-excluded)?)?$/;

const rsyncDelete: PolicyRule = {
  id: "rsync-delete",
  category: "fs-delete",
  toolName: "Bash",
  pattern: /^\s*rsync\b/,
  confidence: "high",
  description:
    "Snapshot the destination tree before an `rsync --delete` prunes it; restore syncs the snapshot back.",
  apply(_match, ctx, trashDir) {
    if (!which("rsync")) return null;
    const command = rawCommand(ctx);
    if (hasCompound(command)) return null;
    const tokens = tokenize(command);
    if (tokens === null) return null;
    if (isHelpInvocation(tokens)) return null;
    if (tokens[0] !== "rsync") return null;
    if (tokens.length < 3) return null;

    let del = false;
    for (const t of tokens.slice(1)) {
      if (RSYNC_DELETE_FLAG.test(t)) { del = true; continue; }
      if (t === "--dry-run") return null;
      // A short cluster containing `n` is a dry run (`-avn`); one
      // containing `b` writes backups elsewhere and changes the inverse.
      if (/^-[A-Za-z0-9]+$/.test(t) && /[nb]/.test(t.slice(1))) return null;
      if (t === "--backup" || t.startsWith("--backup-dir")) return null;
    }
    if (!del) return null;

    // The destination is rsync's LAST operand. Requiring it to be the
    // final token means we can never mistake a flag's value for it.
    const dest = tokens[tokens.length - 1];
    if (dest.startsWith("-")) return null;
    // Remote destinations (`host:/path`, `rsync://…`) can't be snapshotted
    // from here — that is exactly the case tier 3 exists for.
    if (dest.includes(":")) return null;
    if (!isSafePath(dest)) return null;

    const absDest = path.resolve(process.cwd(), dest);
    try {
      if (!fs.statSync(absDest).isDirectory()) return null; // nothing to prune
    } catch {
      return null;
    }

    const entries = countTreeEntries(absDest);
    if (entries === null || entries > MAX_TREE_ENTRIES) return null;

    try {
      fs.mkdirSync(trashDir, { recursive: true });
    } catch {
      return null;
    }
    const snap = join(
      trashDir,
      `rsync-dest-${trashName(path.basename(absDest))}-${Date.now()}`,
    );
    const cpCmd = `cp -a ${shq(absDest)} ${shq(snap)}`;
    if (!runSilent(cpCmd)) return null;
    if (!existsSync(snap)) return null;

    if (!runSilent(command)) return null;

    return {
      updatedInput: noopInput(ctx),
      preCommands: [cpCmd, command],
      // The trailing slashes are load-bearing: contents-of-snapshot into
      // destination, with --delete removing anything the sync added.
      recoveryCommands: [
        `rsync -a --delete ${shq(snap + "/")} ${shq(absDest + "/")}`,
      ],
      description: `Snapshotted rsync destination ${absDest} (${entries} entries) before --delete.`,
      ruleId: "rsync-delete",
    };
  },
};

// ---------- find … -delete / -exec rm ------------------------------------

const findDelete: PolicyRule = {
  id: "find-delete",
  category: "fs-delete",
  toolName: "Bash",
  pattern: /^\s*find\s+/,
  confidence: "high",
  description:
    "Resolve what `find … -delete` / `find … -exec rm` would remove and move it into the per-action trash instead; restore moves it back.",
  apply(_match, ctx, trashDir, storeRoot) {
    const command = rawCommand(ctx);
    // `-exec … \;` (and its quoted spellings) legitimately contains a
    // semicolon that is NOT a command separator — neutralize those before
    // the compound check so the whole rule isn't disabled by its own
    // terminator.
    if (hasCompound(command.replace(/\\;|"\s*;\s*"/g, " "))) return null;
    const tokens = tokenize(command);
    if (tokens === null) return null;
    if (isHelpInvocation(tokens)) return null;
    if (tokens[0] !== "find") return null;

    // Build a LISTING variant of the same expression by swapping the
    // destructive action for `-print` IN PLACE. Position matters: find's
    // `-o` binds looser than the implicit `-a`, so appending `-print` at
    // the end would silently change which files are selected.
    const listTokens: string[] = [];
    let action: "delete" | "exec" | null = null;
    let recursiveRm = false;

    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === "-delete") {
        if (action !== null) return null;
        action = "delete";
        listTokens.push("-print");
        continue;
      }
      if (t === "-exec" || t === "-execdir") {
        if (action !== null) return null;
        const argv: string[] = [];
        let j = i + 1;
        for (; j < tokens.length; j++) {
          if (tokens[j] === ";" || tokens[j] === "+") break;
          argv.push(tokens[j]);
        }
        if (j >= tokens.length) return null; // unterminated -exec
        if (argv.length === 0) return null;
        const verb = argv[0].split("/").pop() ?? "";
        if (verb !== "rm" && verb !== "unlink") return null;
        for (const a of argv.slice(1)) {
          if (a.startsWith("-")) {
            if (/^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(a) || a === "--recursive") {
              recursiveRm = true;
            }
            continue;
          }
          // Anything other than the {} placeholder means the command
          // touches paths we did not resolve.
          if (a !== "{}") return null;
        }
        action = "exec";
        listTokens.push("-print");
        i = j; // skip the terminator too
        continue;
      }
      // Interactive and file-writing actions: not our shape.
      if (t === "-ok" || t === "-okdir") return null;
      if (t === "-fls" || t === "-fprint" || t === "-fprint0" || t === "-fprintf") {
        return null;
      }
      listTokens.push(t);
    }
    if (action === null) return null;

    const listed = runCaptured(
      `LC_ALL=C find ${listTokens.map(shq).join(" ")}`,
    );
    if (listed === null || listed === "") return null;

    const victims: string[] = [];
    for (const line of listed.split("\n")) {
      if (line === "") continue;
      if (!isSafePath(line)) return null; // rejects ".", "/", glob-ish names
      const abs = path.isAbsolute(line)
        ? line
        : path.resolve(process.cwd(), line);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(abs);
      } catch {
        return null; // listed but gone — the set is not stable
      }
      // `find -delete` only unlinks EMPTY directories, and a non-recursive
      // `rm` fails on any directory. Moving the whole subtree would delete
      // more than the command would have, so bail instead.
      if (st.isDirectory()) {
        if (action === "exec" && !recursiveRm) return null;
        if (action === "delete") {
          try {
            if (fs.readdirSync(abs).length > 0) return null;
          } catch {
            return null;
          }
        }
      }
      victims.push(abs);
    }
    if (victims.length === 0) return null;

    // Same store collision as `git clean`: a sweep rooted at the
    // workspace enumerates the sandbox store as a victim.
    const { kept: roots, skipped } = excludeSandboxStore(
      dropNested(victims),
      trashDir,
      storeRoot,
    );
    if (skipped.length > 0) {
      logTier0Note(
        trashDir,
        "find-delete",
        `kept the sandbox store out of the victim set: ${skipped.join(", ")}. ` +
          `${roots.length} other path(s) moved to trash.`,
        storeRoot,
      );
    }
    if (roots.length === 0) {
      return {
        updatedInput: {
          ...(ctx.tool_input as Record<string, unknown>),
          command: `true  # chats-sandbox: find matched only the backup store`,
        },
        preCommands: [],
        recoveryCommands: [],
        description:
          `find → nothing removed: the only match was the sandbox's own ` +
          `backup store (${skipped.join(", ")}), which is preserved.`,
        ruleId: "find-delete",
        preserveLowerTiers: true,
      };
    }
    // Trash prefix is "find-victim", NOT the rule id: the restore-time
    // guard (isDangerousRecoveryCommand) refuses anything shaped like
    // `find … -delete`, and a trash filename containing that literal
    // would make our own recovery `mv` look like the attack it screens
    // for.
    const moved = moveVictimsToTrash(roots, trashDir, "find-victim", storeRoot);
    if (moved === null) return null;

    return {
      updatedInput: {
        ...(ctx.tool_input as Record<string, unknown>),
        command: `true  # chats-sandbox: find delete rewritten to trash, ${roots.length} path(s)`,
      },
      preCommands: moved.preCommands,
      recoveryCommands: moved.recoveryCommands,
      description: `find → soft-deleted ${roots.length} matched path(s) to trash (reversible).`,
      ruleId: "find-delete",
    };
  },
};

// ---------- `> file` / `: > file` shell truncation -----------------------

/** A bare output redirect with no command producing data — the shell's
 *  own truncate-to-zero idiom. Anchored end-to-end so a compound like
 *  `> a; rm b` cannot match. */
const SHELL_TRUNCATE_RE = /^\s*(?::|true)?\s*>\|?\s*(\S+)\s*$/;

const shellTruncate: PolicyRule = {
  id: "shell-truncate",
  category: "fs-overwrite",
  toolName: "Bash",
  pattern: SHELL_TRUNCATE_RE,
  confidence: "high",
  description:
    "Snapshot file bytes before a bare `> file` / `: > file` redirect truncates them to zero; restore via cp back.",
  apply(_match, ctx, trashDir) {
    const command = rawCommand(ctx);
    const m = SHELL_TRUNCATE_RE.exec(command);
    if (m === null) return null;
    let target = m[1];
    if (
      (target.startsWith("'") && target.endsWith("'")) ||
      (target.startsWith('"') && target.endsWith('"'))
    ) {
      target = target.slice(1, -1);
    }
    // No expansion, glob or operator may remain: we have to know exactly
    // which file loses its contents.
    if (target === "" || /[;&|`$()<>*?'"\\]/.test(target)) return null;
    // A path that does not exist yet is a plain create — nothing is lost.
    const abs = resolveExistingFile(target);
    if (abs === null) return null;
    return snapshotAndRun(
      ctx,
      command,
      [abs],
      trashDir,
      "shell-truncate",
      () => `Snapshotted ${path.basename(abs)} before a > redirect truncated it.`,
    );
  },
};

// ---------- helm uninstall ------------------------------------------------

const helmUninstall: PolicyRule = {
  id: "helm-uninstall",
  category: "k8s",
  toolName: "Bash",
  pattern: /^\s*helm\s+(?:uninstall|delete|del)\s+/,
  confidence: "medium",
  description:
    "Dump `helm get all <release>` into the action trash and uninstall with --keep-history so the release can be rolled back exactly.",
  apply(_match, ctx, trashDir) {
    if (!which("helm")) return null;
    const command = rawCommand(ctx);
    if (hasCompound(command)) return null;
    const tokens = tokenize(command);
    if (tokens === null) return null;
    if (isHelpInvocation(tokens)) return null;
    if (tokens[0] !== "helm") return null;
    const sub = tokens[1];
    if (sub !== "uninstall" && sub !== "delete" && sub !== "del") return null;

    let namespace: string | null = null;
    let keepHistory = false;
    const positional: string[] = [];
    for (let i = 2; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === "-n" || t === "--namespace") {
        namespace = tokens[++i] ?? null;
        continue;
      }
      if (t.startsWith("--namespace=")) {
        namespace = t.slice("--namespace=".length);
        continue;
      }
      if (t === "--keep-history") { keepHistory = true; continue; }
      if (t === "--dry-run" || t.startsWith("--dry-run=")) return null;
      if (t.startsWith("-")) continue;
      positional.push(t);
    }
    // One release only — `helm uninstall a b c` would need a per-release
    // inverse and a partial rollback is worse than none.
    if (positional.length !== 1) return null;
    const release = positional[0];
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(release)) return null;
    if (namespace !== null && !/^[a-z0-9][a-z0-9-]*$/i.test(namespace)) {
      return null;
    }
    const nsFlag = namespace === null ? "" : ` -n ${shq(namespace)}`;

    // The revision we roll back to. No revision → no exact inverse → bail.
    const hist = runCaptured(
      `helm history ${shq(release)}${nsFlag} -o json`,
    );
    if (hist === null) return null;
    let revision: number | null = null;
    try {
      const rows = JSON.parse(hist) as Array<{ revision?: unknown }>;
      if (!Array.isArray(rows) || rows.length === 0) return null;
      for (const r of rows) {
        const v = Number(r.revision);
        if (Number.isInteger(v) && v > 0) {
          revision = revision === null ? v : Math.max(revision, v);
        }
      }
    } catch {
      return null;
    }
    if (revision === null) return null;

    try {
      fs.mkdirSync(trashDir, { recursive: true });
    } catch {
      return null;
    }
    const label = trashName(
      `${release}${namespace === null ? "" : `-${namespace}`}`,
    );
    const dumpFile = join(trashDir, `helm-${label}.all.txt`);
    const dumpCmd = `helm get all ${shq(release)}${nsFlag} > ${shq(dumpFile)}`;
    if (!runSilent(dumpCmd)) return null;
    if (!existsSync(dumpFile)) return null;

    // The rewrite that makes this reversible: --keep-history leaves the
    // release record behind in an "uninstalled" state, which is what lets
    // `helm rollback` restore the chart, values and rendered manifest from
    // helm's OWN stored revision instead of from something we reconstruct.
    const runCommand = keepHistory ? command : `${command} --keep-history`;
    if (!runSilent(runCommand)) return null;

    return {
      updatedInput: noopInput(ctx),
      preCommands: [dumpCmd, runCommand],
      recoveryCommands: [
        `helm rollback ${shq(release)} ${revision}${nsFlag}`,
      ],
      description: `Saved \`helm get all ${release}\` to ${dumpFile}; uninstalled with --keep-history so restore rolls back to revision ${revision}.`,
      ruleId: "helm-uninstall",
    };
  },
};

// ---------- registry -------------------------------------------------------

export const EXTRA_RULES: PolicyRule[] = [
  // Run-and-rewrite cluster (execute inside apply, noop back to Claude)
  gitResetHard,
  gitBranchDeleteForce,
  gitStashDrop,
  gitPushForce,
  gitClean,
  gitWorktreeRemove,
  dockerRm,
  dockerVolumeRm,
  dockerImageRm,
  kubectlDelete,
  helmUninstall,
  mvRule,
  sedInPlace,
  truncateRule,
  shellTruncate,
  rsyncDelete,
  findDelete,
  gitDiscardWorktree,
  // Record-and-pass cluster (capture state, original command runs as-is)
  chmodRule,
  chownRule,
  outsideWorkspaceWriteNew,
];
