/**
 * Tier-1 command-rewriting rules: the foreign-execution-target guard,
 * the extra rules (git, docker, kubectl, chmod/chown, sed -i, truncate, ...) and their helpers,
 * then the core rm rule, POLICY_RULES and applyPolicyRules.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs";
import { join } from "node:path";
import * as path from "node:path";
import type { HookContext } from "../types.js";
import { uniqueCaptureName } from "./fsmeta.js";
import { quote } from "../util.js";

// =============================================================================
// ── exec target ──
// =============================================================================

/**
 * Detects whether the agent's tool calls execute on this process's own
 * filesystem. Tier 1 executes its rewrites in the hook process, so under a
 * remote execution backend (e.g. hermes TERMINAL_ENV=docker|ssh) it must
 * stand down and pass the command through unmodified. Unknown signals are
 * treated as local.
 */

export interface ForeignExecTarget {
  /** The backend the agent executes through: "docker", "ssh", "modal", … */
  backend: string;
  /** Environment signal that identified the backend. */
  source: string;
}

/** hermes terminal backends that run on the hook's own filesystem. */
const HERMES_LOCAL_BACKENDS = new Set(["", "local", "host"]);

/**
 * Describe the agent's execution target when it is not this filesystem, or
 * return null. Signals, in precedence order: BACKUPPER_EXEC_TARGET
 * ("local"/"self" or a backend name), hermes TERMINAL_ENV, and
 * BACKUPPER_REMOTE_EXEC=1.
 */
export function foreignExecTarget(): ForeignExecTarget | null {
  const explicit = (process.env.BACKUPPER_EXEC_TARGET ?? "").trim().toLowerCase();
  if (explicit) {
    if (explicit === "local" || explicit === "self" || explicit === "same") return null;
    return { backend: explicit, source: "BACKUPPER_EXEC_TARGET" };
  }

  const terminalEnv = (process.env.TERMINAL_ENV ?? "").trim().toLowerCase();
  if (!HERMES_LOCAL_BACKENDS.has(terminalEnv)) {
    return { backend: terminalEnv, source: "TERMINAL_ENV" };
  }

  if (process.env.BACKUPPER_REMOTE_EXEC === "1") {
    return { backend: "unspecified-remote", source: "BACKUPPER_REMOTE_EXEC" };
  }

  return null;
}

/** True when the agent runs on this filesystem. */
export function execTargetIsSelf(): boolean {
  return foreignExecTarget() === null;
}

// =============================================================================
// ── policy rules ──
// =============================================================================

/**
 * Tier-1 command-rewriting rules: the extra rules (git, docker, kubectl, chmod/chown,
 * sed -i, truncate, ...) and their helpers first, then the core rm rule, POLICY_RULES and
 * applyPolicyRules.
 */

// =============================================================================
// ── policy rules extra ──
// =============================================================================

/*
 * EXTRA_RULES: tier-1 command-rewriting rules beyond the core `rm` rule in policy_rules.ts.
 * Run-and-rewrite rules execute the destructive operation inside apply() and return a no-op;
 * record-and-pass rules capture pre-state and let the original command run. Recovery commands
 * are exact inverses run by `backupper restore`.
 *
 * Backup-only mode (`opts.rewrite === false`, for hosts that ignore a rewritten input): every
 * rule captures its pre-state exactly as in rewrite mode but executes nothing the command
 * targets; rules that would move victims into the trash copy them there instead. The host then
 * runs the original command once, and the same recovery commands reverse it.
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
 */

// ---------- helpers --------------------------------------------------------

const shq = (s: string): string => quote(s);

/**
 * Common start of a single-command Bash rule: the raw command and its tokens, or null when
 * the command is compound (unless `allowCompound`), cannot be tokenized, or is a --help call.
 */
function bashRuleInput(
  ctx: HookContext,
  opts: { allowCompound?: boolean } = {},
): { command: string; tokens: string[] } | null {
  const command = rawCommand(ctx);
  if (!opts.allowCompound && hasCompound(command)) return null;
  const tokens = tokenize(command);
  if (tokens === null) return null;
  if (isHelpInvocation(tokens)) return null;
  return { command, tokens };
}

/** Create the trash directory; false when it cannot be created. */
function ensureTrash(trashDir: string): boolean {
  try {
    fs.mkdirSync(trashDir, { recursive: true });
    return true;
  } catch {
    return false;
  }
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

/**
 * While set, the copy-only captures below record their copy commands here instead of running
 * them, so the caller can run only the copies the tier-3 snapshot does not already hold.
 */
let deferredCopies: DeferredCopy[] | null = null;

/** One deferred copy: the command and the path it creates. */
export interface DeferredCopy { command: string; src: string; dest: string }

/** Run `fn` with copy commands deferred; returns its result and the copies it deferred. */
export function withDeferredCopies<T>(fn: () => T): { result: T; commands: DeferredCopy[] } {
  const prev = deferredCopies;
  const commands: DeferredCopy[] = [];
  deferredCopies = commands;
  try {
    return { result: fn(), commands };
  } finally {
    deferredCopies = prev;
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

/**
 * Drop a trailing shell comment (an unquoted `#` that starts a word), such as the
 * `# [BACKUP NEEDED]` marker an agent appends to a step. Without this, the marker's words
 * parse as extra operands and every rule stands down on a marked command.
 */
export function stripShellComment(command: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "\\" && !inSingle) { i++; continue; }
    if (c === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (c === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (c === "#" && !inSingle && !inDouble && (i === 0 || /\s/.test(command[i - 1]))) {
      return command.slice(0, i).trimEnd();
    }
  }
  return command;
}

function rawCommand(ctx: HookContext): string {
  const input = ctx.tool_input as { command?: unknown };
  return typeof input.command === "string" ? stripShellComment(input.command) : "";
}

function noopInput(ctx: HookContext): Record<string, unknown> {
  return { ...(ctx.tool_input as Record<string, unknown>), command: "true" };
}

/** Rewrite mode unless the caller asked for backup-only. */
function rewriting(opts?: PolicyApplyOptions): boolean {
  return opts?.rewrite !== false;
}

/**
 * Finish a run-and-rewrite rule. Rewrite mode: run `command` here and hand the agent a no-op.
 * Backup-only mode: run nothing; the host runs `command` itself. Returns null when the command
 * fails in rewrite mode (the engine then escalates).
 */
function finishRule(
  ctx: HookContext,
  command: string,
  opts: PolicyApplyOptions | undefined,
  result: Omit<PolicyRuleResult, "updatedInput" | "backupOnly">,
  onFailure?: () => void,
): PolicyRuleResult | null {
  if (!rewriting(opts)) {
    return { ...result, backupOnly: true };
  }
  if (!runSilent(command)) {
    onFailure?.();
    return null;
  }
  return {
    ...result,
    preCommands: [...result.preCommands, command],
    updatedInput: noopInput(ctx),
  };
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
 * no-op for the agent (it already ran here). Returns null if any snapshot
 * or the command itself fails, leaving the engine to escalate.
 */
function snapshotAndRun(
  ctx: HookContext,
  command: string,
  absPaths: string[],
  trashDir: string,
  ruleId: string,
  describe: (n: number) => string,
  opts?: PolicyApplyOptions,
): PolicyRuleResult | null {
  if (!deferredCopies) {
    if (!ensureTrash(trashDir)) return null;
  }
  const preCommands: string[] = [];
  const recoveryCommands: string[] = [];
  const captures: Array<{ target: string; copy: string }> = [];
  for (const abs of absPaths) {
    // Unique per target: sanitising or truncating two different paths can not collide.
    const trashFile = join(trashDir, `${uniqueCaptureName(ruleId, abs)}.bak`);
    const cpCmd = `cp -a ${shq(abs)} ${shq(trashFile)}`;
    if (deferredCopies) deferredCopies.push({ command: cpCmd, src: abs, dest: trashFile });
    else if (!runSilent(cpCmd) || !existsSync(trashFile)) return null;
    preCommands.push(cpCmd);
    captures.push({ target: abs, copy: trashFile });
    recoveryCommands.push(`mkdir -p ${shq(path.dirname(abs))} && cp -a ${shq(trashFile)} ${shq(abs)}`);
  }
  return finishRule(ctx, command, opts, {
    preCommands,
    recoveryCommands,
    description: describe(absPaths.length),
    ruleId,
    captures,
  });
}

/**
 * Maximum number of filesystem entries a rule records or copies inside the synchronous hook;
 * larger targets bail to the lower tiers.
 */
const MAX_TREE_ENTRIES = 20_000;

/** Count entries under a directory, stopping just past the cap; null if the count fails. */
function countTreeEntries(absDir: string): number | null {
  const out = runCaptured(
    `find ${shq(absDir)} | head -n ${MAX_TREE_ENTRIES + 1} | wc -l`,
  );
  if (out === null) return null;
  const n = Number(out.trim());
  return Number.isInteger(n) ? n : null;
}

/** Drop paths nested inside another path in the list, since moving the parent carries them. */
function dropNested(paths: string[]): string[] {
  const sorted = [...paths].sort();
  const roots: string[] = [];
  for (const p of sorted) {
    if (roots.some((r) => p === r || p.startsWith(r + path.sep))) continue;
    roots.push(p);
  }
  return roots;
}

/*
 * ---------- the sandbox's own store is never a victim -------------------
 *
 * Broad sweeps inside the workspace enumerate the backup store as a victim. Store paths are
 * filtered out of every victim set before any rule moves anything.
 */

/** True when `child` is `parent`, or lives underneath it. */
function isAtOrUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Store root for this action's trash: `storeRoot` when given, else derived from the trash
 * path (`<store>/backups/action_NNN/trash`) and sanity-checked.
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
 * True when moving or deleting `abs` would damage the store: it is or contains this action's
 * trash, or it overlaps the store root in either direction.
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

/** Split a victim set into paths a rule may act on and store paths it must leave alone. */
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
 * Record a tier-1 stand-down or partial application on stderr and in
 * `<store root>/tier1-skipped.log`.
 */
export function logTier1Note(
  trashDir: string,
  ruleId: string,
  detail: string,
  storeRoot?: string,
): void {
  writeTier1Log(trashDir, `[BackUpper] TIER-1 '${ruleId}': ${detail}`, storeRoot);
}

/** Print a tier-1 message to stderr and append it to the store's tier1-skipped.log (best-effort). */
export function writeTier1Log(trashDir: string, line: string, storeRoot?: string): void {
  try {
    process.stderr.write(line + "\n");
  } catch { /* best-effort */ }
  try {
    const root = storeRootOf(trashDir, storeRoot);
    fs.mkdirSync(root, { recursive: true });
    fs.appendFileSync(
      path.join(root, "tier1-skipped.log"),
      `[${new Date().toISOString()}] ${line}\n`,
    );
  } catch { /* best-effort */ }
}

/**
 * Move each resolved victim path into the action trash and record the `mv` back.
 * Cross-device moves bail; any failure unwinds earlier moves.
 */
function moveVictimsToTrash(
  absPaths: string[],
  trashDir: string,
  ruleId: string,
  storeRoot?: string,
): { preCommands: string[]; recoveryCommands: string[] } | null {
  // Backstop: refuse store paths even if a caller did not filter them.
  const store = absPaths.filter((p) => isSandboxStorePath(p, trashDir, storeRoot));
  if (store.length > 0) {
    logTier1Note(
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
    logTier1Note(trashDir, ruleId, `stood down: cannot create trash dir ${trashDir}.`, storeRoot);
    return null;
  }
  let trashDev: number;
  try {
    trashDev = fs.statSync(trashDir).dev;
  } catch {
    logTier1Note(trashDir, ruleId, `stood down: cannot stat trash dir ${trashDir}.`, storeRoot);
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
        logTier1Note(
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
      logTier1Note(trashDir, ruleId, `stood down: cannot stat victim ${abs}. Moves unwound.`, storeRoot);
      return null;
    }
    const dest = join(trashDir, `${uniqueCaptureName(ruleId, abs)}-${nonce}-${idx++}`);
    const mv = `mv ${shq(abs)} ${shq(dest)}`;
    if (!runSilent(mv)) {
      unwind();
      logTier1Note(trashDir, ruleId, `stood down: \`${mv}\` failed. Moves unwound.`, storeRoot);
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
    logTier1Note(trashDir, ruleId, "stood down: empty victim set.", storeRoot);
    return null;
  }
  // LIFO, matching the core rm rule.
  return { preCommands, recoveryCommands: recoveryPairs.reverse().flat() };
}

/** Byte cap on what a backup-only rule copies inside the synchronous hook. */
const MAX_COPY_BYTES = 256 * 1024 * 1024;

/** Entry count and byte size under `abs` (not following symlinks), or null past the caps. */
function measureTree(abs: string): { entries: number; bytes: number } | null {
  let entries = 0;
  let bytes = 0;
  const stack = [abs];
  while (stack.length > 0) {
    const p = stack.pop() as string;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      return null;
    }
    entries++;
    if (st.isFile()) bytes += st.size;
    if (entries > MAX_TREE_ENTRIES || bytes > MAX_COPY_BYTES) return null;
    if (st.isDirectory()) {
      try {
        for (const e of fs.readdirSync(p)) stack.push(join(p, e));
      } catch {
        return null;
      }
    }
  }
  return { entries, bytes };
}

/**
 * Backup-only counterpart of moveVictimsToTrash: copy each victim into the action trash
 * (nothing is moved or deleted) and record a copy back. The host's own command then removes
 * the originals. Victim sets over the size caps bail to the lower tiers.
 */
export function copyVictimsToTrash(
  absPaths: string[],
  trashDir: string,
  ruleId: string,
  storeRoot?: string,
): { preCommands: string[]; recoveryCommands: string[]; captures: Array<{ target: string; copy: string }> } | null {
  const store = absPaths.filter((p) => isSandboxStorePath(p, trashDir, storeRoot));
  if (store.length > 0 || absPaths.length === 0) return null;
  let entries = 0;
  let bytes = 0;
  for (const abs of absPaths) {
    const m = measureTree(abs);
    if (m === null) {
      logTier1Note(trashDir, ruleId, `stood down: ${abs} is too large to copy in the hook (or unreadable).`, storeRoot);
      return null;
    }
    entries += m.entries;
    bytes += m.bytes;
    if (entries > MAX_TREE_ENTRIES || bytes > MAX_COPY_BYTES) {
      logTier1Note(trashDir, ruleId, `stood down: the victim set is too large to copy in the hook.`, storeRoot);
      return null;
    }
  }
  if (!deferredCopies) {
    if (!ensureTrash(trashDir)) return null;
  }
  const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const preCommands: string[] = [];
  const copied: string[] = [];
  const recoveryPairs: string[][] = [];
  const captures: Array<{ target: string; copy: string }> = [];
  let idx = 0;
  for (const abs of absPaths) {
    const dest = join(trashDir, `${uniqueCaptureName(ruleId, abs)}-${nonce}-${idx++}`);
    const cp = `cp -a ${shq(abs)} ${shq(dest)}`;
    if (deferredCopies) {
      deferredCopies.push({ command: cp, src: abs, dest });
    } else if (!runSilent(cp) || !existsSync(dest)) {
      // Remove the partial copies; the originals were never touched.
      for (const d of [...copied, dest]) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
      logTier1Note(trashDir, ruleId, `stood down: \`${cp}\` failed.`, storeRoot);
      return null;
    }
    preCommands.push(cp);
    copied.push(dest);
    captures.push({ target: abs, copy: dest });
    let isDir = false;
    try { isDir = fs.lstatSync(deferredCopies ? abs : dest).isDirectory(); } catch { /* treat as file */ }
    // A directory is copied back into place (merging if the path was re-created);
    // a file or symlink is copied over whatever now holds its path.
    recoveryPairs.push(isDir
      ? [`mkdir -p ${shq(abs)}`, `cp -a ${shq(dest + "/.")} ${shq(abs + "/")}`]
      : [`mkdir -p ${shq(path.dirname(abs))}`, `cp -a ${shq(dest)} ${shq(abs)}`]);
  }
  return { preCommands, recoveryCommands: recoveryPairs.reverse().flat(), captures };
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
    const input = bashRuleInput(ctx);
    if (!input) return null;
    const { command, tokens } = input;

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

    // Record-and-pass in both modes: the saved sha cannot restore uncommitted changes, so
    // tier 3 must snapshot the worktree BEFORE the reset runs. Running the reset here would
    // let tier 3 snapshot the already-reset tree.
    return {
      preCommands: [saveCmd],
      recoveryCommands: [`git reset --hard ${head}`],
      description: `Saved HEAD ${head.slice(0, 12)} before git reset --hard (worktree captured by snapshot).`,
      ruleId: "git-reset-hard",
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
  apply(_match, ctx, _trashDir, _storeRoot, opts) {
    const input = bashRuleInput(ctx);
    if (!input) return null;
    const { command, tokens } = input;

    const positional = tokens.slice(2).filter((t) => !t.startsWith("-"));
    if (positional.length !== 1) return null;
    const branch = positional[0];
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) return null;

    const sha = runCaptured(
      `git rev-parse --verify ${shq("refs/heads/" + branch)}`,
    );
    if (sha === null || !/^[0-9a-f]{7,64}$/.test(sha)) return null;

    return finishRule(ctx, command, opts, {
      preCommands: [`# recorded refs/heads/${branch} at ${sha}`],
      recoveryCommands: [`git branch -f ${shq(branch)} ${sha}`],
      description: `Captured sha ${sha.slice(0, 12)} of branch ${branch} before force-delete.`,
      ruleId: "git-branch-delete-force",
    });
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
  apply(_match, ctx, _trashDir, _storeRoot, opts) {
    const input = bashRuleInput(ctx);
    if (!input) return null;
    const { command, tokens } = input;

    const args = tokens
      .slice(3)
      .filter((t) => t !== "-q" && t !== "--quiet" && !t.startsWith("-"));
    if (args.length > 1) return null;
    const stashRef = args.length === 0 ? "stash@{0}" : args[0];
    if (!/^[A-Za-z0-9._@{}/-]+$/.test(stashRef)) return null;

    const sha = runCaptured(`git rev-parse --verify ${shq(stashRef)}`);
    if (sha === null || !/^[0-9a-f]{7,64}$/.test(sha)) return null;

    // The stash's own message (its commit subject), so a restore recreates the same entry.
    const message = runCaptured(`git log -1 --format=%s ${shq(sha)}`) || "backupper recovered stash";
    const backupRef = `refs/backupper/stash-${Date.now()}-${sha.slice(0, 8)}`;
    const backupCmd = `git update-ref ${shq(backupRef)} ${sha}`;
    if (!runSilent(backupCmd)) return null;

    return finishRule(ctx, command, opts, {
      preCommands: [backupCmd],
      recoveryCommands: [
        `git stash store -m ${shq(message)} ${sha}`,
        `git update-ref -d ${shq(backupRef)}`,
      ],
      description: `Backed up ${stashRef} (${sha.slice(0, 12)}) under ${backupRef} before drop.`,
      ruleId: "git-stash-drop",
    }, () => runSilent(`git update-ref -d ${shq(backupRef)}`));
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
  apply(_match, ctx, _trashDir, _storeRoot, opts) {
    const input = bashRuleInput(ctx);
    if (!input) return null;
    const { command, tokens } = input;

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

    const recoveryCommands: string[] =
      oldSha === null
        ? [`git push ${shq(remote)} --delete ${shq(remoteRef)}`]
        : [`git push --force ${shq(remote)} ${shq(oldSha + ":" + remoteRef)}`];

    return finishRule(ctx, command, opts, {
      preCommands: [`# recorded ${remote}/${remoteRef} at ${oldSha ?? "(absent)"}`],
      recoveryCommands,
      description:
        oldSha === null
          ? `Remote ${remote}/${remoteRef} did not exist before force-push; restore deletes it.`
          : `Recorded remote ${remote}/${remoteRef} at ${oldSha.slice(0, 12)} before force-push.`,
      ruleId: "git-push-force",
    });
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
  apply(_match, ctx, trashDir, _storeRoot, opts) {
    if (!which("docker")) return null;
    const input = bashRuleInput(ctx);
    if (!input) return null;
    const { command, tokens } = input;

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

    if (!ensureTrash(trashDir)) return null;

    const safeLabel = trashName(container).toLowerCase();
    const recoveryImage = `backupper/recovery-${safeLabel}:${Date.now()}`;
    const inspectFile = join(trashDir, `docker-${safeLabel}.inspect.json`);

    const inspectCmd = `docker inspect ${shq(container)} > ${shq(inspectFile)}`;
    if (!runSilent(inspectCmd)) return null;

    const commitCmd = `docker commit ${shq(id)} ${shq(recoveryImage)}`;
    if (!runSilent(commitCmd)) return null;

    return finishRule(ctx, command, opts, {
      preCommands: [inspectCmd, commitCmd],
      recoveryCommands: [
        `docker create --name ${shq(container)} ${shq(recoveryImage)}`,
      ],
      description: `Committed container ${container} as ${recoveryImage}; inspect saved to ${inspectFile}.`,
      ruleId: "docker-rm",
    }, () => runSilent(`docker image rm ${shq(recoveryImage)}`));
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
  apply(_match, ctx, trashDir, _storeRoot, opts) {
    if (!which("docker")) return null;
    const input = bashRuleInput(ctx);
    if (!input) return null;
    const { command, tokens } = input;
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

    if (!ensureTrash(trashDir)) return null;

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

    return finishRule(ctx, command, opts, {
      preCommands: [backupCmd],
      recoveryCommands: [
        `docker volume create ${shq(volume)}`,
        `docker run --rm ` +
          `-v ${shq(volume + ":/v")} ` +
          `-v ${shq(trashDir + ":/backup:ro")} ` +
          `busybox sh -c ${shq(`tar xf /backup/${tarName} -C /v`)}`,
      ],
      description: `Archived docker volume ${volume} to ${tarFile} before removal.`,
      ruleId: "docker-volume-rm",
    });
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
  apply(_match, ctx, trashDir, _storeRoot, opts) {
    if (!which("docker")) return null;
    const input = bashRuleInput(ctx);
    if (!input) return null;
    const { command, tokens } = input;

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

    if (!ensureTrash(trashDir)) return null;

    const safeLabel = trashName(image);
    const tarFile = join(trashDir, `docker-image-${safeLabel}.tar`);
    const saveCmd = `docker save ${shq(image)} -o ${shq(tarFile)}`;
    if (!runSilent(saveCmd)) return null;
    if (!existsSync(tarFile)) return null;

    return finishRule(ctx, command, opts, {
      preCommands: [saveCmd],
      recoveryCommands: [`docker load -i ${shq(tarFile)}`],
      description: `Saved docker image ${image} to ${tarFile} before removal.`,
      ruleId: "docker-image-rm",
    });
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
  apply(_match, ctx, trashDir, _storeRoot, opts) {
    if (!which("kubectl")) return null;
    const input = bashRuleInput(ctx);
    if (!input) return null;
    const { command, tokens } = input;
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

    if (!ensureTrash(trashDir)) return null;

    const selector = `${kind}/${name}`;
    const nsFlag = namespace === null ? "" : ` -n ${shq(namespace)}`;
    const safeLabel = trashName(
      `${kind}-${name}${namespace === null ? "" : `-${namespace}`}`,
    );
    const yamlFile = join(trashDir, `kubectl-${safeLabel}.yaml`);

    const dumpCmd = `kubectl get ${shq(selector)}${nsFlag} -o yaml > ${shq(yamlFile)}`;
    if (!runSilent(dumpCmd)) return null;
    if (!existsSync(yamlFile)) return null;

    return finishRule(ctx, command, opts, {
      preCommands: [dumpCmd],
      recoveryCommands: [`kubectl apply -f ${shq(yamlFile)}${nsFlag}`],
      description:
        `Snapshotted ${selector}` +
        (namespace === null ? "" : ` (namespace=${namespace})`) +
        ` to ${yamlFile} before delete.`,
      ruleId: "kubectl-delete",
    });
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
 * Record the modes or owners of a whole subtree into a generated script in the action trash,
 * so `chmod -R`/`chown -R` can be undone with one `sh <script>`. Symlinks are excluded;
 * unparseable or oversized trees bail.
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

  if (!ensureTrash(trashDir)) return null;
  const scriptFile = join(
    trashDir,
    `${uniqueCaptureName(`${ruleId}-recursive`, absPaths.join("\0"))}.sh`,
  );
  try {
    fs.writeFileSync(
      scriptFile,
      `#!/bin/sh\n# backupper: re-apply the ${ruleId === "chmod" ? "modes" : "owners"} recorded before \`${ruleId} -R\`.\n` +
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
      // chmod follows symlinks, so the mode to record is the target's (stat -L), not the
      // link's own 0777; recording the link's mode would chmod the target to 777 on restore.
      let mode = runCaptured(`stat -L -c %a ${shq(a)}`);
      if (!mode) mode = runCaptured(`stat -L -f %Lp ${shq(a)}`);
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
    "Write to a NEW path outside cwd: no data to preserve, record rm as recovery (cheaper than escalating to tier-4 subagent).",
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
  apply(_match, ctx, trashDir, _storeRoot, opts) {
    const input = bashRuleInput(ctx);
    if (!input) return null;
    const { command, tokens } = input;
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

    if (!deferredCopies) {
      if (!ensureTrash(trashDir)) return null;
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
      backupFile = join(trashDir, `${uniqueCaptureName("mv-clobbered", landed)}.bak`);
      const cpCmd = `cp -a ${shq(landed)} ${shq(backupFile)}`;
      if (deferredCopies) deferredCopies.push({ command: cpCmd, src: landed, dest: backupFile });
      else if (!runSilent(cpCmd) || !existsSync(backupFile)) return null;
      preCommands.push(cpCmd);
    }

    // Parents are re-created first: a later snapshot restore drops directories left empty.
    const recoveryCommands: string[] = [`mkdir -p ${shq(path.dirname(absSrc))} && mv ${shq(landed)} ${shq(absSrc)}`];
    if (clobbered && backupFile) {
      recoveryCommands.push(`mkdir -p ${shq(path.dirname(landed))} && cp -a ${shq(backupFile)} ${shq(landed)}`);
    }

    return finishRule(ctx, command, opts, {
      preCommands,
      recoveryCommands,
      description: clobbered
        ? `mv with clobber: snapshotted ${path.basename(landed)}; inverse mv recorded.`
        : `mv: recorded inverse mv ${path.basename(landed)} → ${path.basename(absSrc)}.`,
      ruleId: "mv-overwrite",
      touched: [absSrc, landed],
    });
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
  apply(_match, ctx, trashDir, _storeRoot, opts) {
    const input = bashRuleInput(ctx);
    if (!input) return null;
    const { command, tokens } = input;
    if (tokens[0] !== "sed") return null;

    let inPlace = false;
    let suffix = "";
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
        if (t.startsWith("-i.")) suffix = t.slice(2);
        else if (t.startsWith("--in-place=")) suffix = t.slice("--in-place=".length);
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
    // `sed -i.bak` also creates FILE.bak; a restore removes the ones that did not exist before.
    const createdBackups = suffix && /^[A-Za-z0-9._~-]+$/.test(suffix)
      ? abs.map((a) => a + suffix).filter((c) => !existsSync(c))
      : [];
    const r = snapshotAndRun(
      ctx,
      command,
      abs,
      trashDir,
      "sed-in-place",
      (n) => `Snapshotted ${n} file${n === 1 ? "" : "s"} before sed -i.`,
      opts,
    );
    if (r) for (const c of createdBackups) r.recoveryCommands.push(`rm -f ${shq(c)}`);
    return r;
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
  apply(_match, ctx, trashDir, _storeRoot, opts) {
    const input = bashRuleInput(ctx);
    if (!input) return null;
    const { command, tokens } = input;
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
      opts,
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
  apply(_match, ctx, trashDir, _storeRoot, opts) {
    if (!which("git")) return null;
    const input = bashRuleInput(ctx);
    if (!input) return null;
    const { command, tokens } = input;
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
        // path), so only the explicit `git checkout -- <path>` form is handled.
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
      opts,
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
  apply(_match, ctx, trashDir, storeRoot, opts) {
    if (!which("git")) return null;
    const input = bashRuleInput(ctx);
    if (!input) return null;
    const { command, tokens } = input;
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
    // LC_ALL=C pins the "Would remove" wording parsed below.
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

    // Filter the store out of the victim set; still rewrite if it was the only victim.
    const { kept: roots, skipped } = excludeSandboxStore(
      dropNested(victims),
      trashDir,
      storeRoot,
    );
    if (!rewriting(opts)) {
      // The host runs the real `git clean`: copy the victims, never touch them. The store
      // cannot be filtered out of a command we do not rewrite, so git is told to ignore it
      // (the repository's local .git/info/exclude, never committed) and the set re-listed.
      if (skipped.length > 0 && !ignoredToo && !onlyIgnored && ignoreStoreInRepo(skipped)) {
        return gitClean.apply(_match, ctx, trashDir, storeRoot, opts);
      }
      const copied = copyVictimsToTrash(roots, trashDir, "git-clean", storeRoot);
      if (copied === null) return null;
      return {
        backupOnly: true,
        preCommands: copied.preCommands,
        captures: copied.captures,
        recoveryCommands: copied.recoveryCommands,
        description: `git clean → copied ${roots.length} untracked path(s) to trash before the clean ran (reversible).`,
        ruleId: "git-clean",
      };
    }
    if (skipped.length > 0) {
      logTier1Note(
        trashDir,
        "git-clean",
        `kept the sandbox store out of the victim set: ${skipped.join(", ")}. ` +
          `${roots.length} other path(s) moved to trash; the command is ` +
          `rewritten either way so the real \`git clean\` never runs.`,
        storeRoot,
      );
    }
    if (roots.length === 0) {
      // Only the store remained: rewrite to a no-op so the original never runs.
      return {
        updatedInput: {
          ...(ctx.tool_input as Record<string, unknown>),
          command: `true  # backupper: git clean had nothing to remove but the backup store`,
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
        command: `true  # backupper: git clean rewritten to trash, ${roots.length} path(s)`,
      },
      preCommands: moved.preCommands,
      recoveryCommands: moved.recoveryCommands,
      description: `git clean → soft-deleted ${roots.length} untracked path(s) to trash (reversible).`,
      ruleId: "git-clean",
    };
  },
};

/**
 * Add each store path to the repository's local exclude file (.git/info/exclude) so a plain
 * `git clean` leaves it alone. Returns true when at least one line was added (so re-listing
 * can make progress), false when nothing could be or needed to be added.
 */
function ignoreStoreInRepo(storePaths: string[]): boolean {
  const top = runCaptured("git rev-parse --show-toplevel");
  const excludeFile = runCaptured("git rev-parse --git-path info/exclude");
  if (!top || !excludeFile) return false;
  const file = path.resolve(process.cwd(), excludeFile);
  let cur = "";
  try { cur = fs.readFileSync(file, "utf-8"); } catch { /* absent */ }
  const have = new Set(cur.split("\n").map((l) => l.trim()));
  const add: string[] = [];
  for (const p of storePaths) {
    const rel = path.relative(top, p);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    const line = `/${rel.split(path.sep).join("/")}/`;
    if (!have.has(line)) add.push(line);
  }
  if (add.length === 0) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, (cur && !cur.endsWith("\n") ? "\n" : "") +
      "# added by BackUpper: keep its backup store out of git clean\n" + add.join("\n") + "\n");
    return true;
  } catch {
    return false;
  }
}

// ---------- git worktree remove --force ----------------------------------

const gitWorktreeRemove: PolicyRule = {
  id: "git-worktree-remove-force",
  category: "git",
  toolName: "Bash",
  pattern: /^\s*git\s+worktree\s+remove\b/,
  confidence: "high",
  description:
    "Snapshot a linked worktree's full content (untracked files included) and its git admin dir before `git worktree remove --force`; restore copies both back.",
  apply(_match, ctx, trashDir, _storeRoot, opts) {
    if (!which("git")) return null;
    const input = bashRuleInput(ctx);
    if (!input) return null;
    const { command, tokens } = input;
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
    // Only the --force form can remove uncommitted content.
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

    // Also snapshot the worktree admin dir under the main repo so the restore re-registers it.
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
      uniqueCaptureName("git-worktree", absWt),
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

    return finishRule(ctx, command, opts, {
      preCommands: [cpTree, cpAdmin],
      recoveryCommands: [
        `mkdir -p ${shq(path.dirname(adminDir))}`,
        `cp -a ${shq(adminSnap)} ${shq(adminDir)}`,
        `mkdir -p ${shq(path.dirname(absWt))}`,
        `cp -a ${shq(treeSnap)} ${shq(absWt)}`,
      ],
      description: `Snapshotted worktree ${absWt} (${entries} entries, untracked content included) and its admin dir before force-remove.`,
      ruleId: "git-worktree-remove-force",
    });
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
  apply(_match, ctx, trashDir, _storeRoot, opts) {
    if (!which("rsync")) return null;
    const input = bashRuleInput(ctx);
    if (!input) return null;
    const { command, tokens } = input;
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
    // final token means a flag's value is never mistaken for it.
    const dest = tokens[tokens.length - 1];
    if (dest.startsWith("-")) return null;
    // Remote destinations cannot be snapshotted here and are left to tier 4.
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

    if (!deferredCopies) {
      if (!ensureTrash(trashDir)) return null;
    }
    const snap = join(
      trashDir,
      uniqueCaptureName("rsync-dest", absDest),
    );
    const cpCmd = `cp -a ${shq(absDest)} ${shq(snap)}`;
    if (deferredCopies) deferredCopies.push({ command: cpCmd, src: absDest, dest: snap });
    else if (!runSilent(cpCmd) || !existsSync(snap)) return null;

    return finishRule(ctx, command, opts, {
      preCommands: [cpCmd],
      // Trailing slashes restore the snapshot's contents into the destination.
      recoveryCommands: [
        `rsync -a --delete ${shq(snap + "/")} ${shq(absDest + "/")}`,
      ],
      description: `Snapshotted rsync destination ${absDest} (${entries} entries) before --delete.`,
      ruleId: "rsync-delete",
    });
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
  apply(_match, ctx, trashDir, storeRoot, opts) {
    const command = rawCommand(ctx);
    // Neutralise the `-exec ... \;` terminator before the compound-command check.
    if (hasCompound(command.replace(/\\;|"\s*;\s*"/g, " "))) return null;
    const tokens = tokenize(command);
    if (tokens === null) return null;
    if (isHelpInvocation(tokens)) return null;
    if (tokens[0] !== "find") return null;

    // Build a listing variant by replacing the destructive action with `-print` in place,
    // preserving operator precedence.
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
          // touches paths that were not resolved.
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
      // Directories are not handled: moving a subtree could remove more than the command would.
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

    // Filter the store out of the victim set, as for `git clean`.
    const { kept: roots, skipped } = excludeSandboxStore(
      dropNested(victims),
      trashDir,
      storeRoot,
    );
    if (!rewriting(opts)) {
      // The host runs the real `find`: copy the victims, never touch them.
      const copied = copyVictimsToTrash(roots, trashDir, "find-victim", storeRoot);
      if (copied === null) return null;
      return {
        backupOnly: true,
        preCommands: copied.preCommands,
        captures: copied.captures,
        recoveryCommands: copied.recoveryCommands,
        description: `find → copied ${roots.length} matched path(s) to trash before the delete ran (reversible).`,
        ruleId: "find-delete",
      };
    }
    if (skipped.length > 0) {
      logTier1Note(
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
          command: `true  # backupper: find matched only the backup store`,
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
    // Trash prefix avoids the literal rule id so the recovery `mv` does not match the
    // restore-time `find ... -delete` guard.
    const moved = moveVictimsToTrash(roots, trashDir, "find-victim", storeRoot);
    if (moved === null) return null;

    return {
      updatedInput: {
        ...(ctx.tool_input as Record<string, unknown>),
        command: `true  # backupper: find delete rewritten to trash, ${roots.length} path(s)`,
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
  apply(_match, ctx, trashDir, _storeRoot, opts) {
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
    // No expansion, glob or operator may remain: the file that loses its
    // contents must be known exactly.
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
      opts,
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
  apply(_match, ctx, trashDir, _storeRoot, opts) {
    if (!which("helm")) return null;
    const input = bashRuleInput(ctx);
    if (!input) return null;
    const { command, tokens } = input;
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
    // Backup-only mode cannot add --keep-history, and without it `helm rollback` has nothing
    // to roll back to: leave the call to the lower tiers.
    if (!rewriting(opts) && !keepHistory) return null;
    // One release only — `helm uninstall a b c` would need a per-release
    // inverse and a partial rollback is worse than none.
    if (positional.length !== 1) return null;
    const release = positional[0];
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(release)) return null;
    if (namespace !== null && !/^[a-z0-9][a-z0-9-]*$/i.test(namespace)) {
      return null;
    }
    const nsFlag = namespace === null ? "" : ` -n ${shq(namespace)}`;

    // The revision to roll back to. No revision → no exact inverse → bail.
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

    if (!ensureTrash(trashDir)) return null;
    const label = trashName(
      `${release}${namespace === null ? "" : `-${namespace}`}`,
    );
    const dumpFile = join(trashDir, `helm-${label}.all.txt`);
    const dumpCmd = `helm get all ${shq(release)}${nsFlag} > ${shq(dumpFile)}`;
    if (!runSilent(dumpCmd)) return null;
    if (!existsSync(dumpFile)) return null;

    // --keep-history keeps the release record so `helm rollback` can restore it.
    const runCommand = keepHistory ? command : `${command} --keep-history`;
    return finishRule(ctx, runCommand, opts, {
      preCommands: [dumpCmd],
      recoveryCommands: [
        `helm rollback ${shq(release)} ${revision}${nsFlag}`,
      ],
      description: `Saved \`helm get all ${release}\` to ${dumpFile}; uninstalled with --keep-history so restore rolls back to revision ${revision}.`,
      ruleId: "helm-uninstall",
    });
  },
};

// ---------- registry -------------------------------------------------------

export const EXTRA_RULES: PolicyRule[] = [
  // Run-and-rewrite cluster (executed inside apply; the agent receives a no-op)
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

// =============================================================================
// ── policy rules ──
// =============================================================================

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

export interface PolicyRuleResult {
  /**
   * Rewritten tool input, returned to the hook as `updatedInput`. Absent in backup-only
   * mode, where the host runs the original command.
   */
  updatedInput?: Record<string, unknown>;
  /** True when the rule only captured pre-state and executed nothing (backup-only mode). */
  backupOnly?: boolean;
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
  /** Paths the command changes besides the ones it copies (e.g. the source of a `mv`). */
  touched?: string[];
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
  /** Rule ids that are not tried. */
  skip?: readonly string[];
}

// ── Helpers ────────────────────────────────────────────────────────

/** Escape a path for shell — always wraps in single quotes (recorded recovery commands keep this form). */
function shqAlways(s: string): string {
  return quote(s, { always: true });
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
function rmTrashName(absPath: string, nonce: string): string {
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
        const name = rmTrashName(abs, nonce);
        const trashPath = path.join(trashDir, name);
        // Fall through on a cross-filesystem move, which would be a full copy.
        try {
          const srcDev = fs.statSync(abs).dev;
          const dstDev = fs.statSync(trashDir).dev;
          if (srcDev !== dstDev) return null;
        } catch {
          return null;
        }
        const cmd = `mv ${shqAlways(abs)} ${shqAlways(trashPath)}`;
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
        recoveryCommands.unshift(`mkdir -p ${shqAlways(path.dirname(abs))} && mv ${shqAlways(trashPath)} ${shqAlways(abs)}`);
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
  // the extra-rules section above. First match wins.
  ...EXTRA_RULES,
];

/** Record a tier-1 refusal on stderr and in `<sandbox root>/tier1-skipped.log`. */
function logTier1Refusal(
  trashDir: string,
  ruleId: string,
  foreign: ForeignExecTarget,
  commandOrJson: string,
): void {
  writeTier1Log(
    trashDir,
    `[BackUpper] TIER-1 DISABLED: the agent executes through a ` +
    `'${foreign.backend}' backend (${foreign.source}), not this filesystem. ` +
    `Rule '${ruleId}' matched but was NOT applied — a tier-1 rewrite runs its ` +
    `own mv/cp/rm HERE, which would mutate the wrong machine and still leave ` +
    `the real target unprotected. Command passed through unmodified; tiers 2-4 ` +
    `still apply. Action: ${commandOrJson.slice(0, 300)}`,
  );
}

/**
 * Return the first rule that fires for this tool call and apply it, or null.
 * Rules act on this process's filesystem, so they are refused when the agent's calls run
 * on a different machine (see foreignExecTarget above).
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
    if (opts.skip?.includes(rule.id)) continue;
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
