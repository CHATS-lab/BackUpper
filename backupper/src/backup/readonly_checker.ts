/**
 * THE READ-ONLY CHECKER
 * =====================
 *
 * A second opinion on "does this tool call write anything", asked BEFORE the
 * tier-3 backup subagent is spawned, instead of waiting for the agent's own
 * `[Backup needed]` marker.
 *
 * WHY IT EXISTS. On the marker alone, a missing marker means no spawn, and a
 * missing marker is the dominant loss: the agent forgets, or argues itself into
 * an exemption, and the one component that could have captured the bytes is
 * never woken. The checker makes the marker sufficient but no longer necessary:
 *
 *     spawn  when  outsideWorkspace && !targetedSucceeded && !externalFileSnapshot
 *                  && ( declaration !== null || checker says NOT read-only )
 *
 * WHAT IT IS. The SAME spawn mechanism as the backup subagent — the same
 * `buildSubagentInvocation` path, so the runner, the model, the gateway routing
 * and the session persistence all stay exactly as configured — with two
 * differences: tools are banned, and the system prompt is the checker's.
 *
 * THE TOOL BAN IS A SAFETY PROPERTY, NOT A LIMITATION. The backup subagent's
 * most common failure is going off and capturing an adjacent object it
 * discovered itself. A checker that cannot run a command cannot do that. It sees
 * exactly the input this file assembles and nothing else.
 *
 * THE INPUT, in this order (see buildCheckerInput):
 *   1. tool name and full arguments;
 *   2. for every path named in the arguments, its current state — a file's
 *      CONTENTS pasted in, a directory's stat-style summary (type, entry count);
 *   3. when the first word of a shell command resolves on PATH to a readable
 *      text script, that script's source. Measured: 25% of at-risk shell calls
 *      invoke such a script, and their effect is decided inside it and is
 *      invisible in the arguments.
 * Truncation: 8 KB per file, 32 KB total, head+tail with an elision marker.
 *
 * THREE DECISIONS, SETTLED:
 *
 *   * NO PATHS IN THE ARGUMENTS -> SKIP THE CHECKER AND SPAWN. 37% of at-risk
 *     calls name no path at all (`sitefold`, `gem install foo.gem`,
 *     `terraform apply`); the destination is inside the program, so there is
 *     nothing for the checker to look at and its answer would be a guess. Those
 *     escalate without asking. They must not be silently skipped.
 *   * SERIAL, not parallel with the subagent. Latency is accepted for now.
 *   * FAIL OPEN. Timeout, malformed JSON, transport error, runner unavailable —
 *     every one of them spawns. A needless capture costs seconds; a missed one
 *     loses bytes that exist nowhere else.
 *
 * `targets` IS NOT DECORATION. When the checker has read a script and worked out
 * what the call actually writes, that list is handed to the backup subagent's
 * prompt (see runSubagentBackup's `checkerTargets`). The subagent's single
 * largest failure mode is capturing an ADJACENT OBJECT — a workspace snapshot of
 * /srv/qa/suite while `--clean` emptied /srv/qa/allure-report. The checker has
 * already done that work; throwing it away and letting the subagent re-derive it
 * from the same arguments reproduces the same mistake.
 *
 * EVERY VERDICT IS LOGGED to `.chats-sandbox/checker.jsonl` (a sibling of
 * effects.jsonl, in the same directory), with the decision, the reason, and the
 * inputs it was given. A gate whose mistakes are invisible cannot be tuned, and
 * the false-negative rate is the whole point of the measurement.
 */
import { READONLY_CHECKER, render } from "../prompts.generated.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import type { HookContext, SandboxConfig } from "../types.js";

/** What the checker answered, once parsed and shape-checked. */
export interface CheckerVerdict {
  readOnly: boolean;
  targets: string[];
  why: string;
}

/** What the gate needs back: whether to spawn, and why. */
export interface CheckerOutcome {
  spawn: boolean;
  verdict: CheckerVerdict | null;
  targets: string[];
  reason: string;
}

// ── THE CHECKER'S SYSTEM PROMPT ──────────────────────────────────────────────
// The ONLY place this text lives. Passed verbatim to the runner as the system
// prompt, so editing it needs no other change.
//
// THREE THINGS IN IT ARE LOAD-BEARING, and each is here because of a measured
// failure elsewhere in this project:
//
//  1. THERE IS NO THIRD ANSWER. The first sketch of this let the model say it
//     could not tell. Given that option a model takes it, and an abstention has
//     to be resolved by the caller anyway -- so the resolution is stated here
//     instead: no answer means read_only:false. The model is told the safe
//     direction explicitly rather than left to infer it.
//  2. SECOND-ORDER DESTRUCTION. Of the at-risk actions the agent marked and a
//     path/tool-shape rule did NOT flag, the dominant shape is a call that
//     removes nothing itself -- a retention window, an index with an expiry, a
//     config another process acts on. A checker that reasons from the verb
//     misses all of them, and they are the expensive ones.
//  3. TARGETS ARE THE THING AFFECTED, NOT THE THING NAMED. The recorded backup
//     failure is capturing an adjacent object: a snapshot of /srv/qa/suite while
//     `--clean` emptied /srv/qa/allure-report. The list is handed to the backup
//     subagent (see BackupGuidanceOpts.checkerTargets), so a target that names
//     the wrong object is worse than no target at all.
//
// The OUTPUT CONTRACT is deliberately restated at the tail of the assembled
// USER message as well (see buildCheckerInput). The plugin parses that JSON, so
// the contract must survive a system prompt edited by someone who did not know
// the parser existed.
export const READONLY_CHECKER_SYSTEM_PROMPT: string = READONLY_CHECKER.body;   // prompts/readonly-checker.md

/** 8 KB per pasted file. */
const PER_FILE_LIMIT = 8 * 1024;
/** 32 KB across everything pasted for one call (all files + the script). */
const TOTAL_LIMIT = 32 * 1024;
/** At most this many distinct paths are described, newest-found first. A call
 *  naming 300 paths is a batch job; describing all of them would blow the total
 *  budget on the first few and tell the checker nothing about the rest. */
const MAX_PATHS = 24;

/** Hard bound on how long the checker may block the agent's tool call. Derived
 *  from the subagent's own timeout so a lane that tunes one tunes both, but
 *  clipped: the checker is a single non-agentic answer, not a capture. */
function checkerTimeoutSeconds(config?: SandboxConfig): number {
  // NOT HALVED ANY MORE -- see the js twin. Halving gave 120s from the bench's 240
  // and 12 of the first 526 live consultations still came back empty. An empty
  // answer costs a spawn, so waiting longer is cheaper than giving up sooner.
  const base = Number(config?.subagentTimeoutSeconds ?? 120);
  if (!Number.isFinite(base) || base <= 0) return 180;
  return Math.max(60, Math.min(300, Math.round(base)));
}

/**
 * IS THE CHECKER ON? -- RE-EXPORTED, NOT DEFINED HERE.
 *
 * The definition lives in ../types.js so that the caller in backup/strategies can
 * ask WITHOUT loading this module: when it was defined here, strategies had to
 * `require()` this file to reach it, and a corrupt or half-deployed copy threw at
 * load and tripped the caller's fail-open catch -- turning every gated call into
 * a spawn with the checker switched off. Kept exported from here as well because
 * the selftest and any future caller of this module should not have to know
 * where it moved to.
 *
 * Two ways in:
 *
 *   mode="checker"                        the mode. This is the switch the bench
 *                                         uses, because RB_CS_MODE already
 *                                         reaches the plugin inside the task
 *                                         container and no harness change is
 *                                         needed to carry it.
 *   CHATS_SANDBOX_READONLY_CHECKER=1|0    env override, read at hook time. 0
 *                                         forces the checker off even under
 *                                         mode="checker", which is what an
 *                                         A/B arm needs.
 */
export { isReadOnlyCheckerEnabled } from "../types.js";

/** Head+tail truncation with an explicit elision marker. Never a silent cut: a
 *  checker that cannot see it was given half a file will reason as if it had the
 *  whole one, and the missing half is where the write usually is. */
export function truncateHeadTail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.6);
  const tail = Math.max(0, limit - head - 64);
  const dropped = text.length - head - tail;
  return (
    text.slice(0, head) +
    `\n… [ELIDED ${dropped} of ${text.length} bytes] …\n` +
    (tail > 0 ? text.slice(text.length - tail) : "")
  );
}

/** Every string anywhere in the tool arguments, depth-first, bounded. */
function collectStrings(value: unknown, out: string[], depth: number): void {
  if (out.length > 400 || depth > 8) return;
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, out, depth + 1);
  }
}

/**
 * THE PATHS NAMED IN THE ARGUMENTS.
 *
 * Two sources, in order of confidence:
 *   1. the path-bearing argument keys every agent surface uses (file_path, path,
 *      notebook_path, …) — the whole value, verbatim, no pattern matching;
 *   2. path-shaped tokens found in any string value, absolute or ~-rooted.
 *
 * The ">= 2 segments" rule is taken from touchesOutsideWorkspace and exists for
 * the same reason: single-segment tokens like "/retries" are overwhelmingly sed
 * or awk fragments, not paths, and describing them wastes the byte budget.
 *
 * An EMPTY result is meaningful and is not an error — it is the "no paths in the
 * arguments" case, which skips the checker and spawns.
 */
export function collectArgumentPaths(toolInput: Record<string, unknown>, cwd?: string): string[] {
  const PATH_KEYS = new Set([
    "file_path", "filePath", "path", "notebook_path", "notebookPath",
    "target_file", "targetFile", "source", "destination", "dest", "dir",
    "directory", "cwd", "output_path", "outputPath",
  ]);
  const seen = new Set<string>();
  const add = (raw: unknown): void => {
    if (typeof raw !== "string") return;
    const s = raw.trim().replace(/^['"]|['"]$/g, "");
    if (!s || s.length > 4096) return;
    if (!(s.startsWith("/") || s.startsWith("~/") || s.startsWith("./") || s.startsWith("../"))) return;
    if (s.split("/").filter(Boolean).length < 2 && !s.startsWith("~/")) return;
    seen.add(s);
  };

  if (toolInput && typeof toolInput === "object") {
    for (const [k, v] of Object.entries(toolInput)) {
      if (PATH_KEYS.has(k)) add(v);
    }
  }
  const strings: string[] = [];
  collectStrings(toolInput, strings, 0);
  // A candidate must START AT A TOKEN BOUNDARY. Without that anchor `sed
  // s/a/b/` yields "/a/b": touchesOutsideWorkspace has the same false
  // positive and tolerates it because over-firing there is merely slow, but
  // here it converts a "no paths -> spawn" call into a checker call about a
  // path that does not exist and never did.
  const CANDIDATE = /(^|[\s"'`=(,;:<>|&{[])(~?\/[\w.@+~-]+(?:\/[\w.@+~-]+)*)/g;
  for (const s of strings) {
    CANDIDATE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CANDIDATE.exec(s)) !== null) add(m[2]);
  }
    // ── RELATIVE CANDIDATES, KEPT ONLY IF THEY EXIST ─────────────────────
  const relAdd = (raw: unknown): void => {
    if (typeof raw !== "string") return;
    const s = raw.trim().replace(/^['"]|['"]$/g, "");
    if (!s || s.length > 4096 || s.startsWith("/") || s.startsWith("~")) return;
    if (!/^[\w.@+-][\w.@/+-]*$/.test(s)) return;
    // A bare word is only a path if it has a separator or a file extension;
    // otherwise every subcommand ("install", "prune") becomes a candidate.
    if (!s.includes("/") && !/\.[A-Za-z0-9]{1,8}$/.test(s)) return;
    try {
      const abs = path.resolve(cwd || process.cwd(), s);
      if (fs.existsSync(abs)) seen.add(abs);
    } catch { /* unresolvable */ }
  };
  // strings hold whole argument values; split on shell separators so each token
  // is tested on its own -- `pytest tests/x.py` is one string, two tokens.
  for (const s2 of strings)
    for (const tok of String(s2).split(/[\s"'`=(),;:<>|&{}\[\]]+/))
      relAdd(tok);
  return Array.from(seen).slice(0, MAX_PATHS);
}

/** Absolute, ~-expanded resolution of a path as named in the arguments. */
function resolveNamed(p: string): string {
  const expanded = p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
  return path.resolve(expanded);
}

/** True when the first bytes look like something no model should be shown. */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * THE CURRENT STATE OF ONE NAMED PATH.
 *
 * File      -> a stat line plus the CONTENTS, truncated head+tail.
 * Directory -> a stat-style summary: type and entry count. Not a listing: the
 *              checker is deciding whether the call writes, and 400 file names
 *              would eat the whole budget without moving that decision.
 * Missing   -> said plainly. "Does not exist yet" is often the single most
 *              decision-relevant fact about a create.
 *
 * `budget` is the bytes still available from the 32 KB total; the function
 * returns what it used so the caller can debit.
 */
export function describePathState(named: string, budget: number): { text: string; used: number } {
  const abs = resolveNamed(named);
  const header = `PATH: ${named}${abs === named ? "" : ` (resolves to ${abs})`}`;
  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return { text: `${header}\n  state: MISSING (does not exist)`, used: 0 };
  }
  const mode = `0${(st.mode & 0o7777).toString(8)}`;
  if (st.isSymbolicLink()) {
    let target = "?";
    try {
      target = fs.readlinkSync(abs);
    } catch { /* unreadable link */ }
    return { text: `${header}\n  state: symlink -> ${target} (mode ${mode})`, used: 0 };
  }
  if (st.isDirectory()) {
    let entries = -1;
    try {
      entries = fs.readdirSync(abs).length;
    } catch { /* unreadable */ }
    return {
      text: `${header}\n  state: type=directory entries=${entries < 0 ? "unreadable" : entries} mode=${mode}`,
      used: 0,
    };
  }
  if (!st.isFile()) {
    return { text: `${header}\n  state: type=special mode=${mode}`, used: 0 };
  }
  const statLine = `  state: type=file size=${st.size} mode=${mode}`;
  if (budget <= 256) {
    return { text: `${header}\n${statLine}\n  contents: <omitted — input budget exhausted>`, used: 0 };
  }
  let buf: Buffer;
  try {
    buf = fs.readFileSync(abs);
  } catch (e) {
    return { text: `${header}\n${statLine}\n  contents: <unreadable: ${String(e).slice(0, 120)}>`, used: 0 };
  }
  if (looksBinary(buf)) {
    return { text: `${header}\n${statLine}\n  contents: <binary, omitted>`, used: 0 };
  }
  const allowance = Math.min(PER_FILE_LIMIT, budget);
  const body = truncateHeadTail(buf.toString("utf-8"), allowance);
  return { text: `${header}\n${statLine}\n  contents:\n${body}`, used: body.length };
}

/**
 * `which`, in process.
 *
 * Deliberately NOT a `which` subprocess. This runs synchronously inside the
 * PreToolUse hook on every gated call; a spawn per call is measurable, and the
 * lookup rule (walk PATH, first executable regular file wins) is short enough to
 * implement exactly. Absolute and ./relative words are resolved directly, which
 * is also what `which` does.
 */
export function whichResolve(word: string): string | null {
  if (!word) return null;
  const direct = word.includes("/");
  const candidates: string[] = [];
  if (direct) {
    candidates.push(resolveNamed(word));
  } else {
    for (const dir of String(process.env.PATH ?? "").split(path.delimiter)) {
      if (dir) candidates.push(path.join(dir, word));
    }
  }
  for (const c of candidates) {
    try {
      const st = fs.statSync(c);
      if (!st.isFile()) continue;
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch { /* next candidate */ }
  }
  return null;
}

/**
 * argv[0] of the FIRST simple command on a shell line.
 *
 * Leading NAME=value assignments are skipped, and so are the wrappers that hide
 * the real program behind themselves (`sudo`, `env`, `command`, `exec`, `nohup`,
 * `time`) together with their options — `sudo -u qa sitefold` invokes sitefold,
 * and resolving `sudo` instead would paste /usr/bin/sudo, which decides nothing.
 */
export function firstWordOfCommand(command: string): string | null {
  const seg = String(command ?? "").split(/(?:&&|\|\||[|;\n])/)[0] ?? "";
  let tokens = seg.trim().split(/\s+/).filter(Boolean);
  const WRAPPERS = new Set(["sudo", "env", "command", "exec", "nohup", "time", "nice", "stdbuf"]);
  for (let guard = 0; guard < 6; guard++) {
    while (tokens.length && /^[A-Za-z_]\w*=/.test(tokens[0])) tokens = tokens.slice(1);
    if (!tokens.length) return null;
    const w = tokens[0];
    if (WRAPPERS.has(path.basename(w))) {
      tokens = tokens.slice(1);
      // drop the wrapper's own options and their obvious values
      while (tokens.length && tokens[0].startsWith("-")) {
        const opt = tokens[0];
        tokens = tokens.slice(1);
        if (/^-[uUgnp]$/.test(opt) && tokens.length && !tokens[0].startsWith("-")) tokens = tokens.slice(1);
      }
      continue;
    }
    return w;
  }
  return tokens.length ? tokens[0] : null;
}

/**
 * The SOURCE of the script a shell call invokes, when there is one.
 *
 * Item 3 of the checker's input, and the one that pays for the whole mechanism:
 * a quarter of at-risk shell calls invoke a project script, and what such a call
 * writes is decided inside the script, not on the command line. Compiled
 * binaries are skipped (nothing readable to paste).
 */
export function scriptSourceForCommand(
  command: string,
  budget: number,
): { path: string; text: string; used: number } | null {
  const word = firstWordOfCommand(command);
  if (!word) return null;
  const resolved = whichResolve(word);
  if (!resolved) return null;
  let buf: Buffer;
  try {
    buf = fs.readFileSync(resolved);
  } catch {
    return null;
  }
  if (looksBinary(buf)) return null;
  if (buf.length > 4 && buf[0] === 0x7f && buf[1] === 0x45) return null; // ELF
  const allowance = Math.min(PER_FILE_LIMIT, Math.max(0, budget));
  if (allowance <= 256) return { path: resolved, text: "<omitted — input budget exhausted>", used: 0 };
  const text = truncateHeadTail(buf.toString("utf-8"), allowance);
  return { path: resolved, text, used: text.length };
}

/**
 * ASSEMBLE THE CHECKER'S INPUT — the whole of what it is allowed to know.
 *
 * Order is fixed and is the order in the design: (1) the call, (2) the state of
 * every path the call names, (3) the script the call runs. The 32 KB total is
 * spent in that order too, so a call that names ten files does not lose the
 * script that decides what it does with them — the script is charged last only
 * because it is usually the smallest of the three.
 */
export function buildCheckerInput(
  ctx: HookContext,
  namedPaths: string[],
): { text: string; scriptPath: string | null; bytes: number } {
  let budget = TOTAL_LIMIT;
  const parts: string[] = [];

  let argsJson: string;
  try {
    argsJson = JSON.stringify(ctx.tool_input, null, 2);
  } catch {
    argsJson = String(ctx.tool_input);
  }
  parts.push(render(READONLY_CHECKER.sections["input-action"], { TOOL_NAME: ctx.tool_name, ARGS: truncateHeadTail(argsJson, PER_FILE_LIMIT) }));

  // ── ONE CONTENT SECTION, NOT TWO ─────────────────────────────────────
  // The paths' current state and the program's source are the same thing to
  // the checker -- "what this action uses" -- and splitting them invited the
  // model to reason about the sections rather than about the action. The
  // three-section layout produced verdicts whose stated reason was that
  // section 3 was empty ("psql binary source unavailable"), on calls whose
  // whole effect was written out in the arguments.
  const pathBlocks: string[] = [];
  for (const p of namedPaths) {
    const d = describePathState(p, budget);
    budget -= d.used;
    pathBlocks.push(d.text);
  }
  const command = String((ctx.tool_input as Record<string, unknown>)?.command ?? "");
  let script: { path: string; text: string; used: number } | null = null;
  if (command.trim()) {
    script = scriptSourceForCommand(command, budget);
    if (script) budget -= script.used;
  }
  const contentBlocks = [...pathBlocks];
  if (script) contentBlocks.push(render(READONLY_CHECKER.sections["input-program"], { PATH: script.path, SOURCE: script.text }));
  parts.push(render(READONLY_CHECKER.sections["input-content"], {
    CONTENT: contentBlocks.length ? contentBlocks.join("\n\n") : READONLY_CHECKER.sections["input-no-content"],
  }));

  // THE OUTPUT CONTRACT, restated where the parser can rely on it. See the
  // note on READONLY_CHECKER_SYSTEM_PROMPT.
  parts.push(READONLY_CHECKER.sections["input-output"]);

  return { text: parts.join("\n\n"), scriptPath: script ? script.path : null, bytes: TOTAL_LIMIT - budget };
}

/**
 * Parse the checker's answer.
 *
 * Tolerant about WRAPPING (fences, a stray sentence either side, the runner's
 * own JSON envelope) and strict about SHAPE: `read_only` must be a real boolean.
 * A missing or non-boolean `read_only` returns null, which the caller treats as
 * malformed and therefore as a spawn. Never guess the value that decides whether
 * a capture happens.
 */
export function parseCheckerVerdict(raw: string | null | undefined): CheckerVerdict | null {
  if (!raw) return null;
  const text = String(raw);
  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1]);
  // Every {...} span, longest first: the answer object is usually the biggest.
  const spans = text.match(/\{[\s\S]*\}/g) ?? [];
  candidates.push(...spans.sort((a, b) => b.length - a.length));
  candidates.push(text);

  for (const c of candidates) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(c) as Record<string, unknown>;
    } catch {
      continue;
    }
    // Unwrap a runner envelope such as {"result": "{...}"} one level deep.
    if (obj && typeof obj === "object" && typeof obj.result === "string" && obj.read_only === undefined) {
      const inner = parseCheckerVerdict(obj.result as string);
      if (inner) return inner;
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    if (typeof obj.read_only !== "boolean") continue;
    const targets = Array.isArray(obj.targets)
      ? (obj.targets as unknown[])
        .filter((t): t is string => typeof t === "string" && !!t.trim())
        .map((t) => t.trim())
        .slice(0, 32)
      : [];
    const why = typeof obj.why === "string" ? obj.why.trim().slice(0, 200) : "";
    return { readOnly: obj.read_only, targets, why };
  }
  return null;
}

/** The trace file: a sibling of effects.jsonl, in the same directory. */
export function checkerLogPath(config?: SandboxConfig): string {
  try {
    if (config?.effectLogPath) {
      return path.join(path.dirname(path.resolve(config.effectLogPath)), "checker.jsonl");
    }
  } catch { /* fall through */ }
  return path.join(path.dirname(path.resolve(config?.backupDir ?? ".chats-sandbox/backups")), "checker.jsonl");
}

/**
 * LEAVE A TRACE. One line per verdict, always, including the ones where the
 * checker was never asked (no paths) and the ones where it failed.
 *
 * `inputs` records WHAT the checker was shown — the named paths, the resolved
 * script, the assembled byte count — not just the answer. The measurement this
 * log exists for is the FALSE-NEGATIVE rate, and a "read_only:true" line is
 * only diagnosable if you can see what was in front of it when it said so.
 */
export function logCheckerVerdict(config: SandboxConfig | undefined, record: Record<string, unknown>): void {
  const p = checkerLogPath(config);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify({ timestamp: new Date().toISOString(), ...record }) + "\n", "utf-8");
  } catch { /* the trace must never break the hook */ }
  // Also one line into subagent.log — that is the file anyone investigating a
  // run actually opens, and a spawn that did or did not happen because of the
  // checker leaves no other mark there.
  try {
    const sandboxRoot = path.dirname(path.resolve(config?.backupDir ?? ".chats-sandbox/backups"));
    fs.appendFileSync(
      path.join(sandboxRoot, "subagent.log"),
      `[${new Date().toISOString()}] READ-ONLY CHECKER: ${record.spawn ? "SPAWN" : "SKIP"} ` +
      `(${record.reason}) tool=${record.toolName} why="${String(record.why ?? "").slice(0, 120)}" ` +
      `targets=${JSON.stringify(record.targets ?? [])}\n`,
    );
  } catch { /* best-effort */ }
}

/**
 * ASK THE CHECKER.
 *
 * Returns `{ spawn, verdict, targets, reason }`. `spawn:true` means "this call
 * is not read-only, or we could not establish that it is" — the caller ORs that
 * with the agent's declaration.
 *
 * Every failure path returns spawn:true. That is the whole risk posture: the
 * checker can only ever ADD spawns relative to a missing marker, and can never
 * remove one the declaration would have caused, because the caller ORs.
 */
export function runReadOnlyChecker(ctx: HookContext, config: SandboxConfig): CheckerOutcome {
  const started = Date.now();
  const command = String((ctx.tool_input as Record<string, unknown>)?.command ?? "");
  const namedPaths = collectArgumentPaths(ctx.tool_input, ctx.cwd);

  // ── THERE IS NO "NO PATHS" SHORTCUT, AND THAT IS DELIBERATE ──────────
  // An earlier version returned spawn:true here without asking, on the
  // argument that `sitefold` and `terraform apply` name nothing the checker
  // could read. Removed 2026-08-27 for two reasons.
  //
  // It was REDUNDANT. The absence of paths is already what the checker is
  // told: buildCheckerInput renders the content section as "<nothing
  // available>", and the prompt decides how to handle missing content.
  // The removed branch
  // hard-coded a judgement that belongs in the prompt.
  //
  // And it was CRUDER than the thing it replaced. It cannot tell `sitefold`
  // -- genuinely opaque -- from `rejls --all` or `pytest`, which say enough
  // about themselves to judge from the command alone. Measured live on the
  // campaign's first 526 consultations, 153 took this branch (29%) and the
  // population was dominated by `rejls`, `enrolcheck`, `rejcheck`, `idcheck`
  // and `pytest`: names that are read-only on their face, each costing an
  // unasked tier-3 subagent. Offline, removing the branch moved the false
  // positive rate from 17.2% to 5.2% and precision from 96.3% to 98.8%;
  // the five extra "misses" were all read afterwards and all were labelling
  // errors, not real ones.

  const assembled = buildCheckerInput(ctx, namedPaths);
  const inputs = {
    namedPaths, scriptPath: assembled.scriptPath, inputBytes: assembled.bytes, asked: true,
  };

  let raw: string | null = null;
  let transportError: string | null = null;
  try {
    // THE SAME SPAWN MECHANISM AS THE BACKUP SUBAGENT. runRunnerForText goes
    // through buildSubagentInvocation, so the runner, model, gateway env and
    // session-persistence flags are whatever the run configured — the only
    // differences are noTools and the system prompt. Required lazily for the
    // same reason strategies.ts does it: keep child_process off the common path.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { runRunnerForText } = require("./subagent.js");
    raw = runRunnerForText(assembled.text, config, checkerTimeoutSeconds(config), {
      noTools: true,
      systemPrompt: READONLY_CHECKER_SYSTEM_PROMPT,
    });
  } catch (e) {
    transportError = String(e).slice(0, 300);
  }

  const finish = (out: CheckerOutcome, extra?: Record<string, unknown>): CheckerOutcome => {
    logCheckerVerdict(config, {
      toolName: ctx.tool_name, sessionId: ctx.session_id ?? null,
      command: command.slice(0, 400), spawn: out.spawn, reason: out.reason,
      readOnly: out.verdict ? out.verdict.readOnly : null,
      targets: out.targets, why: out.verdict ? out.verdict.why : null,
      durationMs: Date.now() - started, inputs, ...(extra ?? {}),
    });
    return out;
  };

  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return finish({ spawn: true, verdict: null, targets: [], reason: "fail-open-no-answer" },
      { error: transportError });
  }
  const verdict = parseCheckerVerdict(raw);
  if (!verdict) {
    return finish({ spawn: true, verdict: null, targets: [], reason: "fail-open-unparseable" },
      { rawHead: String(raw).slice(0, 400) });
  }
  return finish({
    spawn: !verdict.readOnly,
    verdict,
    targets: verdict.targets,
    reason: verdict.readOnly ? "checker-read-only" : "checker-not-read-only",
  });
}
