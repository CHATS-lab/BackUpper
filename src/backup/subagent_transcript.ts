/**
 * Copies the tier-3 backup subagent's step-by-step session record from the
 * runner's own store into the action dir, or writes a marker saying why none exists.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Maximum bytes kept from a captured transcript. */
export const DEFAULT_TRANSCRIPT_CAP = Number.MAX_SAFE_INTEGER;

export function transcriptCapBytes(): number {
  return DEFAULT_TRANSCRIPT_CAP;
}

/** What the envelope records about this spawn's step-by-step record. */
export interface TranscriptCapture {
  /** Runner whose record this is (or would have been). */
  runner: string;
  /** One sentence describing where the runner keeps its record. */
  runnerRecord: string;
  /** true only when bytes actually landed in the action dir. */
  captured: boolean;
  /** File name inside the action dir, or null. */
  path: string | null;
  /** Absolute path it was copied from, or null when nothing was copied. */
  source: string | null;
  /** Size of the ORIGINAL record. */
  sourceBytes: number;
  /** Size of the kept copy. */
  bytes: number;
  /** Was the middle elided? */
  truncated: boolean;
  /** The cap that did the eliding (always reported, truncated or not). */
  capBytes: number;
  /** Elision accounting — zero when truncated === false. */
  droppedBytes: number;
  droppedLines: number;
  /** "lines" (whole JSONL records kept head+tail) or "bytes" (single huge
   *  document split mid-way) or "none". */
  truncationMode: "none" | "lines" | "bytes";
  /** Marker file written when captured === false. */
  marker: string | null;
  /** Why it landed / why it did not. Always populated. */
  reason: string;
  /** Roots that were searched. */
  searched: string[];
}

/** How each runner records its steps, and how to find that recording. */
interface RunnerTranscriptSpec {
  /** One sentence for the envelope describing the runner's record. */
  record: string;
  /** Extension for the copy in the action dir. */
  ext: ".jsonl" | ".json";
  /** Directories to search, given the spawn's env/cwd. */
  roots(o: LocateOpts): string[];
  /** Candidate file names within those roots. */
  match: RegExp;
  /** Returns a reason when the record provably does not exist, checked before searching. */
  suppressed?(o: LocateOpts): string | null;
}

export interface LocateOpts {
  runner: string;
  /** The runner's own session id for this spawn, when known. */
  sessionId?: string | null;
  /** Epoch ms the spawn started; older files cannot belong to it. */
  since: number | null;
  /** The environment the spawn actually ran with. */
  env: NodeJS.ProcessEnv;
  /** The spawn's cwd. */
  cwd: string;
  /** Session ids to skip, above all the main agent's live session. */
  exclude?: Array<string | null | undefined>;
}

function homeOf(env: NodeJS.ProcessEnv): string {
  return env.HOME || env.USERPROFILE || os.homedir();
}

/** The given directories that exist. */
function existing(dirs: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const d of dirs) {
    if (!d) continue;
    try {
      if (fs.statSync(d).isDirectory()) out.push(d);
    } catch { /* absent */ }
  }
  return out;
}

const SPECS: Record<string, RunnerTranscriptSpec> = {
  claude: {
    record: "Claude Code session JSONL under $CLAUDE_CONFIG_DIR/projects/<cwd-slug>/<session-id>.jsonl",
    ext: ".jsonl",
    // No session file exists when the spawn ran with --no-session-persistence.
    suppressed: (o) =>
      o.env.BACKUPPER_PERSIST_SUBAGENT_SESSIONS === "1"
        ? null
        : "the spawn ran with --no-session-persistence (BACKUPPER_PERSIST_SUBAGENT_SESSIONS is not 1), " +
          "so the CLI wrote no session file to copy; set that variable to 1 to keep it",
    roots: (o) => existing([
      o.env.CLAUDE_CONFIG_DIR ? path.join(o.env.CLAUDE_CONFIG_DIR, "projects") : null,
      path.join(homeOf(o.env), ".claude", "projects"),
    ]),
    match: /\.jsonl$/,
  },

  hermes: {
    record: "hermes full-conversation JSON at <home>/.hermes/sessions/session_<id>.json",
    ext: ".json",
    // HERMES_HOME first: the per-call temp home is wiped by a later spawn, so copy it now.
    roots: (o) => existing([
      o.env.HERMES_HOME ? path.join(o.env.HERMES_HOME, "sessions") : null,
      path.join(homeOf(o.env), ".hermes", "sessions"),
    ]),
    match: /^session_.*\.jsonl?$/,
  },

  codex: {
    record: "codex rollout JSONL under $CODEX_HOME/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl",
    ext: ".jsonl",
    roots: (o) => existing([
      o.env.CODEX_HOME ? path.join(o.env.CODEX_HOME, "sessions") : null,
      o.env.CODEX_HOME ? path.join(path.dirname(o.env.CODEX_HOME), "subcfg", "sessions") : null,
      path.join(homeOf(o.env), ".codex", "sessions"),
    ]),
    match: /^rollout-.*\.jsonl$|\.jsonl$/,
  },
};

/** Bounded recursive walk (depth and entry budget limited). */
function walkFiles(root: string, match: RegExp, budget: { left: number }): string[] {
  const out: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length && budget.left > 0) {
    const { dir, depth } = stack.pop() as { dir: string; depth: number };
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (budget.left-- <= 0) break;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 6) stack.push({ dir: full, depth: depth + 1 });
      } else if (e.isFile() && match.test(e.name)) {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * Finds this spawn's record: an exact session-id match wins; otherwise the newest
 * file created after the spawn started, excluding the listed ids.
 */
export function locateTranscript(o: LocateOpts): { file: string | null; roots: string[]; reason: string } {
  const spec = SPECS[o.runner];
  if (!spec) {
    return {
      file: null,
      roots: [],
      reason: `unknown runner "${o.runner}" — no transcript location is known for it`,
    };
  }

  const suppressedReason = spec.suppressed?.(o);
  if (suppressedReason) return { file: null, roots: [], reason: suppressedReason };

  const roots = spec.roots(o);
  if (roots.length === 0) {
    return {
      file: null,
      roots: [],
      reason: `no readable transcript directory for runner "${o.runner}" (${spec.record})`,
    };
  }

  const budget = { left: 20_000 };
  const excluded = new Set((o.exclude ?? []).filter(Boolean).map(String));
  const since = o.since === null ? 0 : o.since - 5_000; // clock-skew slack
  const candidates: Array<{ file: string; mtime: number; exact: boolean }> = [];

  for (const root of roots) {
    for (const file of walkFiles(root, spec.match, budget)) {
      const base = path.basename(file);
      const stem = base.replace(/\.jsonl?$/, "");
      if (excluded.has(stem)) continue;                       // the MAIN agent's session
      if ([...excluded].some((id) => base.includes(id))) continue;
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      const born = st.birthtimeMs || st.ctimeMs || st.mtimeMs;
      // Only files created during the spawn qualify.
      if (born < since) continue;
      const exact = !!o.sessionId && (stem === o.sessionId || base.includes(o.sessionId));
      candidates.push({ file, mtime: st.mtimeMs, exact });
    }
  }

  if (candidates.length === 0) {
    return {
      file: null,
      roots,
      reason: o.sessionId
        ? `no record for session ${o.sessionId} was found under ${roots.join(", ")}`
        : `no record created during this spawn was found under ${roots.join(", ")}`,
    };
  }
  const exact = candidates.filter((c) => c.exact);
  const pick = (exact.length ? exact : candidates).sort((a, b) => b.mtime - a.mtime)[0];
  return {
    file: pick.file,
    roots,
    reason: pick.exact
      ? `matched the spawn's own session id (${o.sessionId})`
      : `newest record created during the spawn (no session id to match on)`,
  };
}

/**
 * Caps a transcript by keeping both ends and inserting an explicit JSON elision record.
 */
export function capTranscript(text: string, cap: number): {
  out: string;
  truncated: boolean;
  droppedBytes: number;
  droppedLines: number;
  mode: "none" | "lines" | "bytes";
} {
  const total = Buffer.byteLength(text);
  if (total <= cap) {
    return { out: text, truncated: false, droppedBytes: 0, droppedLines: 0, mode: "none" };
  }

  const half = Math.floor(cap / 2);
  const lines = text.split("\n");
  if (lines.length > 2) {
    // Whole lines from the start, then from the end, each within half the cap.
    const head: string[] = [];
    let headBytes = 0;
    for (const line of lines) {
      const lineBytes = Buffer.byteLength(line) + 1;
      if (headBytes + lineBytes > half) break;
      head.push(line);
      headBytes += lineBytes;
    }
    const tail: string[] = [];
    let tailBytes = 0;
    for (let i = lines.length - 1; i >= head.length; i--) {
      const lineBytes = Buffer.byteLength(lines[i]) + 1;
      if (tailBytes + lineBytes > half) break;
      tail.unshift(lines[i]);
      tailBytes += lineBytes;
    }
    // If no complete line fits at an end, keep a marked fragment of it as its own JSON record.
    const fragBudget = Math.max(256, half - 512);
    const fragment = (position: "head" | "tail", line: string): string => {
      const b = Buffer.from(line, "utf-8");
      const kept = position === "head"
        ? b.subarray(0, fragBudget)
        : b.subarray(Math.max(0, b.length - fragBudget));
      const which = position === "head" ? "leading" : "trailing";
      return JSON.stringify({
        type: "backupper_transcript_fragment",
        note: `the ${position} record did not fit the cap on its own; this is a ${which} fragment of it, ` +
          "NOT a complete transcript entry",
        position,
        line_bytes: b.length,
        kept_bytes: kept.length,
        fragment: kept.toString("utf-8"),
      });
    };
    const headFrag = head.length === 0 ? fragment("head", lines[0]) : null;
    const tailFrag = tail.length === 0 ? fragment("tail", lines[lines.length - 1]) : null;
    const droppedLines = lines.length - head.length - tail.length;
    const droppedBytes = total - headBytes - tailBytes;
    const marker = JSON.stringify({
      type: "backupper_transcript_truncation",
      note: "MIDDLE ELIDED by the BackUpper transcript cap — both ends are kept (in full, or as a marked fragment when one record alone exceeded the cap)",
      dropped_lines: droppedLines,
      dropped_bytes: droppedBytes,
      cap_bytes: cap,
      original_bytes: total,
      original_lines: lines.length,
      head_lines_kept: head.length,
      tail_lines_kept: tail.length,
      head_fragment: headFrag !== null,
      tail_fragment: tailFrag !== null,
    });
    const out = [
      ...(headFrag ? [headFrag] : []), ...head,
      marker,
      ...tail, ...(tailFrag ? [tailFrag] : []),
    ].join("\n");
    return { out, truncated: true, droppedBytes, droppedLines, mode: "lines" };
  }
  // A single huge line: split by bytes with a plain-text elision note.
  const buf = Buffer.from(text, "utf-8");
  const headB = buf.subarray(0, half).toString("utf-8");
  const tailB = buf.subarray(buf.length - half).toString("utf-8");
  const droppedBytes = total - Buffer.byteLength(headB) - Buffer.byteLength(tailB);
  const note =
    `…[BackUpper: MIDDLE ELIDED — ${droppedBytes} bytes dropped from a ${total}-byte record at a ` +
    `${cap}-byte cap; both ends are intact and this text is NOT part of the transcript]…`;
  return {
    out: `${headB}\n${note}\n${tailB}`,
    truncated: true,
    droppedBytes,
    droppedLines: 0,
    mode: "bytes",
  };
}

/**
 * Captures this spawn's record into `actionDir`, or writes a marker file explaining
 * its absence. Never throws.
 */
export function captureTranscript(args: {
  actionDir: string;
  /** The forensic id every file of this spawn shares. */
  id: string;
  outcome: string;
  locate: LocateOpts;
}): TranscriptCapture {
  const { actionDir, id, outcome, locate } = args;
  const runner = locate.runner;
  const spec = SPECS[runner];
  const cap = transcriptCapBytes();
  const base: TranscriptCapture = {
    runner,
    runnerRecord: spec?.record ?? `unknown runner "${runner}"`,
    captured: false,
    path: null,
    source: null,
    sourceBytes: 0,
    bytes: 0,
    truncated: false,
    capBytes: cap,
    droppedBytes: 0,
    droppedLines: 0,
    truncationMode: "none",
    marker: null,
    reason: "",
    searched: [],
  };

  const writeMarker = (reason: string, searched: string[]): TranscriptCapture => {
    const name = `subagent_${id}.transcript.MISSING.txt`;
    try {
      fs.writeFileSync(path.join(actionDir, name),
        `BackUpper tier-3 subagent: NO STEP-BY-STEP TRANSCRIPT WAS CAPTURED\n` +
        `\n` +
        `runner        ${runner}\n` +
        `records       ${base.runnerRecord}\n` +
        `outcome       ${outcome}\n` +
        `reason        ${reason}\n` +
        `searched      ${searched.length ? searched.join("\n              ") : "(nothing to search — see 'records' above)"}\n` +
        `recorded at   ${new Date().toISOString()}\n` +
        `\n` +
        `This file exists so that "this runner emitted no record" stays\n` +
        `distinguishable from "the record was dropped on the floor". See\n` +
        `subagent_${id}.run.json for the rest of this spawn's envelope.\n`,
        "utf-8");
      return { ...base, marker: name, reason, searched };
    } catch {
      return { ...base, reason, searched };
    }
  };

  try {
    fs.mkdirSync(actionDir, { recursive: true });

    const found = locateTranscript(locate);
    if (!found.file) return writeMarker(found.reason, found.roots);

    const raw = fs.readFileSync(found.file, "utf-8");
    const sourceBytes = Buffer.byteLength(raw);
    if (sourceBytes === 0) return writeMarker(`the record at ${found.file} is empty`, found.roots);

    const capped = capTranscript(raw, cap);
    const name = `subagent_${id}.transcript${spec?.ext ?? ".jsonl"}`;
    fs.writeFileSync(path.join(actionDir, name), capped.out, "utf-8");
    return {
      ...base,
      captured: true,
      path: name,
      source: found.file,
      sourceBytes,
      bytes: Buffer.byteLength(capped.out),
      truncated: capped.truncated,
      droppedBytes: capped.droppedBytes,
      droppedLines: capped.droppedLines,
      truncationMode: capped.mode,
      reason: found.reason,
      searched: found.roots,
    };
  } catch (e) {
    return { ...base, reason: `transcript capture failed: ${String(e).slice(0, 300)}` };
  }
}

/** Files this module adds to an action dir. */
export const TRANSCRIPT_FILE_RE =
  /^subagent_[a-z0-9]{8}\.transcript(?:\.MISSING\.txt|\.jsonl|\.json)$/;
