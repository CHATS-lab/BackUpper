/**
 * LIVE, IN-SESSION READ-ONLY LEARNING
 * ===================================
 *
 * When the tier-3 subagent is woken and concludes "this action is
 * read-only, no backup needed", it may also record one or more PATTERNS
 * into a session-scoped store. A later command that matches a stored
 * pattern skips the subagent spawn entirely.
 *
 * WHY: measured on results/claude/capline-allot-release-20260823_233449,
 * the subagent was woken 12 times and returned "read-only" 10 times.
 * Seven of the ten were `bin/capctl status|holders|flights|allot …` — a
 * task-specific program. No allowlist of standard commands can cover
 * those; whether `bin/capctl status` reads or writes is knowable only by
 * reading the program. The subagent HAS read the program by the time it
 * answers, so it is the component best placed to say what generalizes.
 *
 * HOW THIS DIFFERS FROM SELF-EXPLORATION, AND WHY THE BAR IS HIGHER:
 * self-exploration runs before the task, offline, and emits a static
 * artifact a human can review. This runs DURING the task and takes effect
 * on the very next command with no review step in between. A wrong entry
 * means a destructive command receives zero backup, silently, at the
 * moment it matters.
 *
 * THE FIVE PROPERTIES THAT HOLD REGARDLESS OF WHAT THE SUBAGENT WRITES
 * -------------------------------------------------------------------
 * The pattern text itself is trusted (a deliberate product decision — the
 * subagent read the source, we did not). These five are structural and do
 * not depend on that trust:
 *
 *  1. POSITIVE ONLY. The store can only ever REMOVE a spawn for a command
 *     that matches. A command matching nothing escalates exactly as
 *     before. Nothing here can mark an action as *not* needing a backup
 *     that would otherwise have got one by another route, and nothing
 *     here can suppress tiers 0-2.
 *
 *  2. SINGLE SIMPLE COMMANDS ONLY. A pattern is matched against the argv
 *     of ONE simple command. Pipes, `&&`, `;`, redirections, command
 *     substitution, heredocs, subshells and newlines all mean NO match —
 *     not because the subagent is distrusted, but because token-matching
 *     a pattern against `capctl allot --json > /etc/passwd` is
 *     meaningless: the pattern describes the program's own behaviour and
 *     says nothing about what the shell does around it. The caller does
 *     this gating with the audited `splitTopLevel` parser and hands us a
 *     plain argv.
 *
 *  3. PROGRAM CONTENT HASH. Every pattern records the resolved path and
 *     sha256 of the program it was derived from. That hash is recomputed
 *     at MATCH time, not just at learn time. The agent under test can
 *     edit `bin/capctl`; the moment it does, every pattern derived from
 *     it stops matching.
 *
 *  4. SESSION SCOPED. The store is stamped with the session id and is
 *     discarded wholesale when the session id changes, so nothing learned
 *     in one run can leak into another.
 *
 *  5. FULL PROVENANCE, BOTH SIDES. Every pattern carries the action it
 *     was derived from and the subagent's stated reason. Every HIT is
 *     logged with the command it let through and the pattern that did it.
 *     If a learned pattern ever admits something it should not have, both
 *     halves of "which pattern, and what did it wave through" are on
 *     disk. Cheap now, impossible to reconstruct later.
 *
 * RESIDUAL RISK, STATED PLAINLY: within those five properties, a pattern
 * such as `bin/capctl allot **` — a perfectly natural generalization from
 * the read-only `bin/capctl allot --state released --json` — also matches
 * `bin/capctl allot release --apply`, which destroys the store. Nothing
 * in this file prevents that; by design, the subagent's judgement is what
 * stands between the two. See the report accompanying this change for the
 * measured frequency of that shape in the corpus.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

/** One learned read-only form, plus the provenance to audit it later. */
export interface LearnedPattern {
  /** Token pattern matched against a single simple command's argv.
   *  Each whitespace-separated token is one of:
   *    literal            exact token match
   *    `*`                exactly one arbitrary token
   *    `**`               zero or more arbitrary tokens
   *    `{a,b,c}`          alternation of literals
   *    `pre*`             literal prefix match
   *    `[--a --b= -c]`    OPTION SET: zero or more of these options in any
   *                       order. A trailing `=` marks an option that takes
   *                       a value, so the value token is consumed too and
   *                       is NOT treated as a positional.
   *  The option set is the primitive that separates a read from a write on
   *  a subcommand-style CLI: `capctl allot [--state= --json]` matches
   *  `capctl allot --state released --json` but NOT
   *  `capctl allot release --apply`, because `release` is a bare positional
   *  that no option in the set can absorb. */
  pattern: string;
  /** Absolute path of the program this was derived from. */
  program: string;
  /** sha256 of that program's bytes at learn time. */
  programHash: string;
  /** PROVENANCE: the exact command whose spawn produced this pattern. */
  learnedFrom: string;
  /** PROVENANCE: the subagent's stated reason for the read-only verdict. */
  reason: string;
  learnedAt: string;
  /** The action dir of the spawn that produced it, for cross-referencing. */
  actionDir?: string;
}

/** A pattern match that skipped a spawn — the audit half of provenance. */
export interface LearnedHit {
  at: string;
  command: string;
  pattern: string;
  learnedFrom: string;
}

export interface LearnedStore {
  /** Session this store belongs to. A different id discards the lot. */
  sessionId: string;
  patterns: LearnedPattern[];
  hits: LearnedHit[];
}

export const LEARNED_STORE_FILE = "learned-readonly.json";

/** Bounds — not a judgement on the patterns, just a cap on how much a
 *  runaway subagent can write into a file we read on every hook call. */
const MAX_PATTERNS = 256;
const MAX_HITS = 512;
const MAX_PATTERN_LEN = 512;
const MAX_HASHED_BYTES = 64 * 1024 * 1024;

export function learnedStorePath(sandboxDir: string): string {
  return path.join(sandboxDir, LEARNED_STORE_FILE);
}

/**
 * Load the store for `sessionId`. A store stamped with any OTHER session
 * is discarded and an empty one returned — session scoping is enforced on
 * read, so a stale file left behind by a previous run can never match.
 */
export function loadLearnedStore(sandboxDir: string, sessionId: string): LearnedStore {
  const empty: LearnedStore = { sessionId, patterns: [], hits: [] };
  try {
    const raw = fs.readFileSync(learnedStorePath(sandboxDir), "utf-8");
    const parsed = JSON.parse(raw) as Partial<LearnedStore>;
    if (!parsed || typeof parsed !== "object") return empty;
    if (parsed.sessionId !== sessionId) return empty;
    return {
      sessionId,
      patterns: Array.isArray(parsed.patterns)
        ? (parsed.patterns as LearnedPattern[]).filter(
            (p) => p && typeof p.pattern === "string" && typeof p.programHash === "string",
          )
        : [],
      hits: Array.isArray(parsed.hits) ? (parsed.hits as LearnedHit[]) : [],
    };
  } catch {
    return empty;
  }
}

function saveLearnedStore(sandboxDir: string, store: LearnedStore): void {
  try {
    fs.mkdirSync(sandboxDir, { recursive: true });
    fs.writeFileSync(
      learnedStorePath(sandboxDir),
      JSON.stringify(store, null, 2),
      "utf-8",
    );
  } catch { /* best-effort; a store we cannot write just means no saving */ }
}

/** Resolve a command's argv[0] to a real file on disk.
 *  `bin/capctl` → <cwd>/bin/capctl; `python3` → the PATH entry.
 *  Returns null when it is not a plain file we can hash (builtins,
 *  functions, aliases, anything unresolvable) — which means NO match. */
export function resolveProgram(argv0: string, cwd: string): string | null {
  if (!argv0) return null;
  const candidates: string[] = [];
  if (argv0.includes("/")) {
    candidates.push(path.resolve(cwd, argv0));
  } else {
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
      if (dir) candidates.push(path.join(dir, argv0));
    }
  }
  for (const c of candidates) {
    try {
      const st = fs.statSync(c);
      if (st.isFile()) return c;
    } catch { /* keep looking */ }
  }
  return null;
}

/** True when `tok` names an EXECUTABLE program reachable from here.
 *
 *  Closes the residual left by the caller's shape gate: that gate rejects
 *  a payload argument carrying whitespace or shell syntax
 *  (`bash -lc 'rm -rf /'`), but not a bare one — `bash -lc poweroff`,
 *  `sudo halt`, `xargs rm`, `timeout 5 shred`. In every one of those the
 *  argument IS the program that runs, so the learned claim about argv[0]
 *  says nothing about the effect.
 *
 *  Again by shape, not by naming wrappers: an argument that resolves to an
 *  executable is treated as code. Data arguments do not (`--month 2026-07`,
 *  `--state released`, `--file ./data.csv` — a real file, but not +x). It
 *  costs a spawn on subcommands that share a name with a binary
 *  (`tool test`, `tool install`); that is the safe direction. */
function argumentIsAProgram(tok: string, cwd: string): boolean {
  if (!tok || tok.startsWith("-")) return false;
  const p = resolveProgram(tok, cwd);
  if (!p) return false;
  try {
    return (fs.statSync(p).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** sha256 of a program's bytes. null when unreadable or implausibly large. */
export function hashProgram(programPath: string): string | null {
  try {
    const st = fs.statSync(programPath);
    if (!st.isFile() || st.size > MAX_HASHED_BYTES) return null;
    return crypto.createHash("sha256").update(fs.readFileSync(programPath)).digest("hex");
  } catch {
    return null;
  }
}

/** Split a pattern into tokens, keeping a bracketed option set — which
 *  contains spaces — as a single token. */
export function splitPatternTokens(pattern: string): string[] {
  const out: string[] = [];
  let buf = "";
  let depth = 0;
  for (const c of pattern.trim()) {
    // Both bracket forms nest: `[--a --b=]` option sets and `{a, b}`
    // alternations may contain spaces without being split.
    if (c === "[" || c === "{") depth++;
    if (c === "]" || c === "}") depth = Math.max(0, depth - 1);
    if (/\s/.test(c) && depth === 0) {
      if (buf) { out.push(buf); buf = ""; }
      continue;
    }
    buf += c;
  }
  if (buf) out.push(buf);
  return out;
}

/** Parse `[--a --b= -c]` into its option table. */
function parseOptionSet(tok: string): Map<string, boolean> | null {
  if (!tok.startsWith("[") || !tok.endsWith("]")) return null;
  const table = new Map<string, boolean>(); // flag → takes a value
  for (const raw of tok.slice(1, -1).split(/\s+/).filter(Boolean)) {
    if (raw.endsWith("=")) table.set(raw.slice(0, -1), true);
    else table.set(raw, false);
  }
  return table;
}

/** Consume as many option tokens from `argv` at `ai` as the set allows.
 *  Returns the index just past them. Unambiguous and therefore greedy:
 *  a token either is a member of the set or it is not. */
function consumeOptionSet(table: Map<string, boolean>, argv: string[], ai: number): number {
  let i = ai;
  while (i < argv.length) {
    const tok = argv[i];
    if (table.has(tok)) {
      i += table.get(tok) ? 2 : 1;   // value-taking options eat their value
      if (i > argv.length) return argv.length; // trailing option missing its value
      continue;
    }
    const eq = tok.indexOf("=");
    if (eq > 0 && table.get(tok.slice(0, eq)) === true) { i += 1; continue; } // --k=v
    break;
  }
  return i;
}

/** Match ONE pattern token against ONE argv token. */
function tokenMatches(pat: string, tok: string): boolean {
  if (pat === "*") return true;
  if (pat.startsWith("{") && pat.endsWith("}")) {
    return pat.slice(1, -1).split(",").some((alt) => tokenMatches(alt.trim(), tok));
  }
  if (pat.endsWith("*")) return tok.startsWith(pat.slice(0, -1));
  return pat === tok;
}

/** Token-wise glob match of a pattern's tokens against an argv.
 *  `**` consumes zero or more tokens. */
export function patternMatchesArgv(pattern: string, argv: string[]): boolean {
  const pats = splitPatternTokens(pattern);
  if (!pats.length || !argv.length) return false;

  const walk = (pi: number, ai: number): boolean => {
    if (pi === pats.length) return ai === argv.length;
    if (pats[pi] === "**") {
      for (let k = ai; k <= argv.length; k++) {
        if (walk(pi + 1, k)) return true;
      }
      return false;
    }
    const optSet = parseOptionSet(pats[pi]);
    if (optSet) {
      // Zero or more options — never a positional, which is the whole point.
      return walk(pi + 1, consumeOptionSet(optSet, argv, ai));
    }
    if (ai >= argv.length) return false;
    if (!tokenMatches(pats[pi], argv[ai])) return false;
    return walk(pi + 1, ai + 1);
  };
  return walk(0, 0);
}

/**
 * Ask the store whether this argv has already been confirmed read-only.
 *
 * A hit requires ALL of:
 *   - a stored pattern whose tokens match the argv, AND
 *   - argv[0] resolving to a real file, AND
 *   - that file's CURRENT sha256 equalling the hash recorded when the
 *     pattern was learned.
 *
 * Anything else — no pattern, unresolvable program, edited program —
 * returns null, and the caller escalates exactly as it did before.
 */
export function matchLearnedReadOnly(
  store: LearnedStore,
  argv: string[],
  cwd: string,
): LearnedPattern | null {
  if (!store.patterns.length || !argv.length) return null;

  // An argument that is itself a program means argv[0] is a wrapper and
  // the pattern's claim does not describe what runs. Checked BEFORE the
  // pattern scan so no pattern, however broad, can reach it.
  for (let i = 1; i < argv.length; i++) {
    if (argumentIsAProgram(argv[i], cwd)) return null;
  }

  const candidates = store.patterns.filter((p) => patternMatchesArgv(p.pattern, argv));
  if (!candidates.length) return null;

  // Resolve + hash ONCE, and only when a pattern actually matched —
  // hashing on every hook call for nothing would be pure overhead.
  const resolved = resolveProgram(argv[0], cwd);
  if (!resolved) return null;
  const hash = hashProgram(resolved);
  if (!hash) return null;

  for (const p of candidates) {
    // The program must be the SAME file, with the SAME contents, as the
    // one the subagent read when it formed this conclusion.
    if (p.program !== resolved) continue;
    if (p.programHash !== hash) continue;
    return p;
  }
  return null;
}

/** Append a hit to the store's audit trail and persist. */
export function recordLearnedHit(
  sandboxDir: string,
  store: LearnedStore,
  command: string,
  pattern: LearnedPattern,
): void {
  store.hits.push({
    at: new Date().toISOString(),
    command: command.slice(0, 500),
    pattern: pattern.pattern,
    learnedFrom: pattern.learnedFrom,
  });
  if (store.hits.length > MAX_HITS) store.hits.splice(0, store.hits.length - MAX_HITS);
  saveLearnedStore(sandboxDir, store);
}

/**
 * Record what the subagent learned. Called ONLY on a read-only verdict
 * (`no_backup_needed: true`) — a spawn that actually made a backup
 * teaches nothing about what is safe to skip.
 *
 * The pattern TEXT is taken as written; there is no acceptance check
 * against the triggering command, no restriction on where a wildcard may
 * appear, and no cross-check against earlier commands. What IS attached
 * is the program identity + hash and the provenance needed to audit a
 * bad call after the fact.
 *
 * Returns the number of patterns stored.
 */
export function learnReadOnlyPatterns(
  sandboxDir: string,
  sessionId: string,
  opts: {
    patterns: Array<{ pattern: string; reason?: string }>;
    command: string;
    cwd: string;
    reason: string;
    actionDir?: string;
  },
): number {
  if (!opts.patterns.length) return 0;

  // The program identity comes from the command that was JUST judged, so
  // a changed program invalidates everything learned from it.
  const argv0 = opts.command.trim().split(/\s+/)[0] ?? "";
  const resolved = resolveProgram(argv0, opts.cwd);
  if (!resolved) return 0;
  const hash = hashProgram(resolved);
  if (!hash) return 0;

  const store = loadLearnedStore(sandboxDir, sessionId);
  const now = new Date().toISOString();
  let added = 0;

  for (const p of opts.patterns) {
    const text = String(p.pattern ?? "").trim();
    if (!text || text.length > MAX_PATTERN_LEN) continue;
    if (store.patterns.length >= MAX_PATTERNS) break;
    // Same pattern from the same program+hash twice is a no-op.
    if (store.patterns.some((e) => e.pattern === text && e.programHash === hash)) continue;
    store.patterns.push({
      pattern: text,
      program: resolved,
      programHash: hash,
      learnedFrom: opts.command.slice(0, 500),
      reason: String(p.reason ?? opts.reason ?? "").slice(0, 500),
      learnedAt: now,
      actionDir: opts.actionDir,
    });
    added++;
  }

  if (added) saveLearnedStore(sandboxDir, store);
  return added;
}
