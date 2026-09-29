/**
 * Read-only checker.
 *
 * Before the tier-3 backup subagent is spawned, a tool-less model call decides whether the
 * pending tool call writes anything. The subagent is spawned when
 *
 *     outsideWorkspace && !targetedSucceeded && !externalFileSnapshot
 *     && ( declaration !== null || checker says NOT read-only )
 *
 * The checker uses the same runner as the backup subagent, with tools disabled and its own
 * system prompt. Its input is the tool call, the current state of every path it names, and
 * the source of the script it invokes (8 KB per file, 32 KB total). Every failure spawns.
 * The targets it identifies are passed to the backup subagent, and every verdict is logged
 * to `checker.jsonl` next to effects.jsonl.
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

// System prompt for the checker. The output contract is restated at the end of the user
// message (see buildCheckerInput) because the plugin parses the JSON answer.
export const READONLY_CHECKER_SYSTEM_PROMPT: string = READONLY_CHECKER.body;

/** 8 KB per pasted file. */
const PER_FILE_LIMIT = 8 * 1024;
/** 32 KB across everything pasted for one call (all files + the script). */
const TOTAL_LIMIT = 32 * 1024;
/** Maximum number of distinct paths described for one call. */
const MAX_PATHS = 24;

/** Timeout for one checker call, derived from the subagent timeout and clipped to [60, 300] s. */
function checkerTimeoutSeconds(config?: SandboxConfig): number {
  const base = Number(config?.subagentTimeoutSeconds ?? 120);
  if (!Number.isFinite(base) || base <= 0) return 180;
  return Math.max(60, Math.min(300, Math.round(base)));
}

/**
 * Re-exported from ../types.js so callers can check it without loading this module.
 * Enabled by mode="checker"; BACKUPPER_READONLY_CHECKER=1|0 overrides it.
 */
export { isReadOnlyCheckerEnabled } from "../types.js";

/** Head+tail truncation with an explicit elision marker. */
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
 * Paths named in the tool arguments: values of path-bearing keys, plus absolute or
 * ~-rooted tokens of at least two segments found in any string value.
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
  // A candidate must start at a token boundary, so `sed s/a/b/` does not yield "/a/b".
  const CANDIDATE = /(^|[\s"'`=(,;:<>|&{[])(~?\/[\w.@+~-]+(?:\/[\w.@+~-]+)*)/g;
  for (const s of strings) {
    CANDIDATE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CANDIDATE.exec(s)) !== null) add(m[2]);
  }
    // ── Relative candidates, kept only if they exist ─────────────────────
  const relAdd = (raw: unknown): void => {
    if (typeof raw !== "string") return;
    const s = raw.trim().replace(/^['"]|['"]$/g, "");
    if (!s || s.length > 4096 || s.startsWith("/") || s.startsWith("~")) return;
    if (!/^[\w.@+-][\w.@/+-]*$/.test(s)) return;
    // A bare word counts as a path only if it has a separator or a file extension.
    if (!s.includes("/") && !/\.[A-Za-z0-9]{1,8}$/.test(s)) return;
    try {
      const abs = path.resolve(cwd || process.cwd(), s);
      if (fs.existsSync(abs)) seen.add(abs);
    } catch { /* unresolvable */ }
  };
  // Split argument strings on shell separators so each token is tested separately.
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
 * Describe the current state of one named path: a file's stat line and contents, a
 * directory's type and entry count, or that it does not exist. Returns the bytes used.
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
 * In-process `which`: first executable regular file on PATH, or the path itself if it
 * contains a slash.
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
 * argv[0] of the first simple command on a shell line, skipping NAME=value assignments
 * and wrappers such as sudo, env, nohup and time.
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
      // Skip the wrapper's own options and their values.
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

/** Source of the script a shell call invokes, if it is a readable text file. */
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
 * Assemble the checker's input: the call, the state of each named path, then the script
 * source, charged against the 32 KB budget in that order.
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
  parts.push(render(READONLY_CHECKER.sections["input-action"], {
    TOOL_NAME: ctx.tool_name,
    ARGS: truncateHeadTail(argsJson, PER_FILE_LIMIT),
  }));

  // Path state and script source form one content section describing what the action uses.
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
  if (script) {
    contentBlocks.push(render(READONLY_CHECKER.sections["input-program"], {
      PATH: script.path,
      SOURCE: script.text,
    }));
  }
  parts.push(render(READONLY_CHECKER.sections["input-content"], {
    CONTENT: contentBlocks.length ? contentBlocks.join("\n\n") : READONLY_CHECKER.sections["input-no-content"],
  }));

  // Output contract, restated where the parser relies on it.
  parts.push(READONLY_CHECKER.sections["input-output"]);

  return { text: parts.join("\n\n"), scriptPath: script ? script.path : null, bytes: TOTAL_LIMIT - budget };
}

/**
 * Parse the checker's answer. Tolerates fences, surrounding text and a runner envelope;
 * returns null unless `read_only` is a boolean.
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
  return path.join(path.dirname(path.resolve(config?.backupDir ?? ".backupper/backups")), "checker.jsonl");
}

/** Append one verdict to the trace, with the inputs the checker was shown. */
export function logCheckerVerdict(config: SandboxConfig | undefined, record: Record<string, unknown>): void {
  const p = checkerLogPath(config);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify({ timestamp: new Date().toISOString(), ...record }) + "\n", "utf-8");
  } catch { /* the trace must never break the hook */ }
  // Also note the verdict in subagent.log.
  try {
    const sandboxRoot = path.dirname(path.resolve(config?.backupDir ?? ".backupper/backups"));
    fs.appendFileSync(
      path.join(sandboxRoot, "subagent.log"),
      `[${new Date().toISOString()}] READ-ONLY CHECKER: ${record.spawn ? "SPAWN" : "SKIP"} ` +
      `(${record.reason}) tool=${record.toolName} why="${String(record.why ?? "").slice(0, 120)}" ` +
      `targets=${JSON.stringify(record.targets ?? [])}\n`,
    );
  } catch { /* best-effort */ }
}

/**
 * Ask the checker. `spawn: true` means the call is not read-only or could not be shown to
 * be; the caller ORs it with the agent's declaration, so every failure spawns.
 */
export function runReadOnlyChecker(ctx: HookContext, config: SandboxConfig): CheckerOutcome {
  const started = Date.now();
  const command = String((ctx.tool_input as Record<string, unknown>)?.command ?? "");
  const namedPaths = collectArgumentPaths(ctx.tool_input, ctx.cwd);

  // Calls that name no path are still asked; the checker is told no content is available.

  const assembled = buildCheckerInput(ctx, namedPaths);
  const inputs = {
    namedPaths, scriptPath: assembled.scriptPath, inputBytes: assembled.bytes, asked: true,
  };

  let raw: string | null = null;
  let transportError: string | null = null;
  try {
    // Same runner as the backup subagent, with tools disabled; loaded lazily.
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
