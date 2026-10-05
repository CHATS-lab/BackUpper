/**
 * Session-scoped store of read-only command patterns learned by the tier-4
 * subagent; a later command matching a stored pattern skips the spawn.
 *
 * Matching is positive-only (it can only remove a spawn), applies to a single
 * simple command's argv, requires the program's current sha256 to equal the
 * hash recorded at learn time, and is discarded when the session id changes.
 * Every pattern and every hit is logged with its provenance.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

/** One learned read-only form, plus the provenance to audit it later. */
export interface LearnedPattern {
  /** Token pattern matched against a single simple command's argv. Tokens:
   *  literal, `*` (one token), `**` (zero or more), `{a,b}` (alternation),
   *  `pre*` (prefix), `[--a --b= -c]` (zero or more listed options in any
   *  order; a trailing `=` means the option consumes a value). */
  pattern: string;
  /** Absolute path of the program this was derived from. */
  program: string;
  /** sha256 of that program's bytes at learn time. */
  programHash: string;
  /** Command whose subagent spawn produced this pattern. */
  learnedFrom: string;
  /** Subagent's stated reason for the read-only verdict. */
  reason: string;
  learnedAt: string;
  /** Action directory of the producing spawn. */
  actionDir?: string;
}

/** A pattern match that skipped a spawn. */
export interface LearnedHit {
  at: string;
  command: string;
  pattern: string;
  learnedFrom: string;
}

export interface LearnedStore {
  /** Owning session; a store with a different id is discarded. */
  sessionId: string;
  patterns: LearnedPattern[];
  hits: LearnedHit[];
}

export const LEARNED_STORE_FILE = "learned-readonly.json";

/** Size caps on the store file, which is read on every hook call. */
const MAX_PATTERNS = 256;
const MAX_HITS = 512;
const MAX_PATTERN_LEN = 512;
const MAX_HASHED_BYTES = 64 * 1024 * 1024;

export function learnedStorePath(sandboxDir: string): string {
  return path.join(sandboxDir, LEARNED_STORE_FILE);
}

/** Load the store for `sessionId`; a store from any other session yields an empty store. */
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
  } catch { /* best-effort */ }
}

/** Resolve argv[0] to a regular file (relative to `cwd` or via PATH);
 *  null when unresolvable, which means no match. */
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

/** True when `tok` resolves to an executable file. Such an argument means
 *  argv[0] is a wrapper (e.g. `sudo halt`), so learned patterns do not apply. */
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
    // Brackets and braces nest, so option sets and alternations keep their spaces.
    if (c === "[" || c === "{") depth++;
    if (c === "]" || c === "}") depth = Math.max(0, depth - 1);
    if (/\s/.test(c) && depth === 0) {
      if (buf) {
        out.push(buf);
        buf = "";
      }
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

/** Consume option tokens from `argv` starting at `ai`; returns the index past them. */
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
    if (eq > 0 && table.get(tok.slice(0, eq)) === true) {
      i += 1;                          // `--k=v`: the value is glued
      continue;
    }
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
      // Consumes zero or more options, never a positional.
      return walk(pi + 1, consumeOptionSet(optSet, argv, ai));
    }
    if (ai >= argv.length) return false;
    if (!tokenMatches(pats[pi], argv[ai])) return false;
    return walk(pi + 1, ai + 1);
  };
  return walk(0, 0);
}

/**
 * Return the stored pattern that matches `argv`, provided argv[0] resolves to
 * the same file with the same sha256 recorded at learn time; otherwise null.
 */
export function matchLearnedReadOnly(
  store: LearnedStore,
  argv: string[],
  cwd: string,
): LearnedPattern | null {
  if (!store.patterns.length || !argv.length) return null;

  // An argument that is itself a program disqualifies every pattern.
  for (let i = 1; i < argv.length; i++) {
    if (argumentIsAProgram(argv[i], cwd)) return null;
  }

  const candidates = store.patterns.filter((p) => patternMatchesArgv(p.pattern, argv));
  if (!candidates.length) return null;

  // Resolve and hash only when some pattern matched.
  const resolved = resolveProgram(argv[0], cwd);
  if (!resolved) return null;
  const hash = hashProgram(resolved);
  if (!hash) return null;

  for (const p of candidates) {
    // Program path and content must equal those seen at learn time.
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
 * Store patterns from a read-only subagent verdict, stamped with the
 * program's path, hash and provenance. Returns the number of patterns added.
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

  // Program identity is taken from the command just judged.
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
