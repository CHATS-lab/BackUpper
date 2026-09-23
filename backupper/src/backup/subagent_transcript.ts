/**
 * STEP-BY-STEP TRANSCRIPT CAPTURE for the tier-3 backup subagent.
 *
 * WHAT WAS MISSING. The per-action record already written by
 * `runSubagentBackup`'s forensic closure answers "what did the subagent
 * CONCLUDE" (`subagent_<id>.json`, a copy of the parsed result) and "how did
 * the spawn END" (`subagent_<id>.run.json`, the envelope). Neither answers
 * "what did it DO between calls" — and on the SUCCESS path the raw runner
 * output was not kept either (it is dumped only when `outcome !== "success"`),
 * so a clean-looking backup left no step-by-step evidence at all. Seven
 * consecutive backups were investigated with nothing but the final metrics.
 *
 * Every runner we spawn DOES keep such a record; they just keep it somewhere
 * that dies with the process's home/config dir. This module locates that
 * record, per runner, and copies it into the ACTION DIR so it is carried out
 * with the store exactly like `metadata.json` and the capture artifacts.
 *
 * THE RUNNERS ARE NOT THE SAME and this file does not pretend they are:
 *
 *   claude    Claude Code writes an incrementally-appended session JSONL to
 *             `$CLAUDE_CONFIG_DIR/projects/<cwd-slug>/<session-id>.jsonl`
 *             (`~/.claude` when the env var is unset). One JSON object per
 *             line, each user/assistant line carrying a raw Anthropic
 *             `message` — the richest record of the five. BUT the invocation
 *             builder passes `--no-session-persistence` unless
 *             CHATS_SANDBOX_PERSIST_SUBAGENT_SESSIONS=1, and with that flag
 *             the CLI writes NO session file at all. That is a real, provable
 *             "there is nothing to copy", and it is reported as such rather
 *             than as a capture failure.
 *
 *   hermes    Persists the WHOLE conversation (system_prompt + tools + every
 *             message) to `<home>/.hermes/sessions/session_<id>.json` — a
 *             single JSON document, not JSONL. The home is the per-call
 *             FILTERED home when one was built (filteredHermesHome hands the
 *             spawn HOME + HERMES_HOME), which is exactly why this must be
 *             copied out immediately: that temp home is pid-named and the
 *             NEXT spawn on a recycled pid wipes it (unless
 *             CHATS_KEEP_SUBAGENT_HOME=1).
 *
 *   codex     `codex exec` writes a rollout JSONL under
 *             `$CODEX_HOME/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl`
 *             (`~/.codex` by default). We get no MCP with this runner
 *             (runner_caps.codex.mcp === "none") but the rollout is still the
 *             full step record.
 *
 *   openclaw  Invoked with an explicit `--session-id chats-sandbox-<ts>` that
 *             WE mint, so the spawn's own record can be identified by name
 *             under `$OPENCLAW_HOME` / `~/.openclaw` without any mtime
 *             guessing. Layout below the home is version-dependent, so the
 *             search is a bounded recursive walk rather than a fixed path.
 *
 *   openhands No CLI and no session store of its own on our invocation: the
 *             shipped `openhands_subagent_runner.py` builds a `Conversation`
 *             in-process and exits. There is nothing on disk to find, so we
 *             do the opposite of the other four — the runner script DUMPS its
 *             own event stream straight into the action dir, at the path we
 *             hand it in CHATS_SANDBOX_OH_SUB_TRANSCRIPT. Nothing to locate;
 *             only to verify and cap.
 *
 * WHEN THERE IS NOTHING TO COPY we write a MARKER file naming the runner and
 * the reason. "This runner emits no session record under this invocation" and
 * "we dropped the record" must never look alike — that distinction is the
 * whole point of the exercise.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Default cap on a captured transcript. A runaway subagent must not be able
 *  to fill the store; overridable for a forensic run that wants everything. */
export const DEFAULT_TRANSCRIPT_CAP = Number.MAX_SAFE_INTEGER;

export function transcriptCapBytes(): number {
  return DEFAULT_TRANSCRIPT_CAP;
}

/** What the envelope records about this spawn's step-by-step record. */
export interface TranscriptCapture {
  /** Runner whose record this is (or would have been). */
  runner: string;
  /** Where the runner keeps it / that it keeps none — one plain sentence. */
  runnerRecord: string;
  /** true only when bytes actually landed in the action dir. */
  captured: boolean;
  /** File name inside the action dir, or null. */
  path: string | null;
  /** Absolute path it was copied FROM (null for openhands: self-written). */
  source: string | null;
  /** Size of the ORIGINAL record. */
  sourceBytes: number;
  /** Size of what we kept. */
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
  /** Roots that were searched (empty for a runner that writes its own). */
  searched: string[];
}

/** How each runner records its steps, and how to find that recording. */
interface RunnerTranscriptSpec {
  /** One sentence for the envelope — visible per-runner, not flattened. */
  record: string;
  /** Extension for the copy in the action dir. */
  ext: ".jsonl" | ".json";
  /** The runner writes the file into the action dir itself; nothing to find. */
  selfWritten?: boolean;
  /** Directories to search, given the spawn's own env/cwd. Empty list ⇒ the
   *  runner keeps nothing we can reach, and `record` says why. */
  roots(o: LocateOpts): string[];
  /** Candidate file names within those roots. */
  match: RegExp;
  /** A provable "the record does not exist", checked BEFORE searching so the
   *  reason is precise instead of "nothing found". */
  suppressed?(o: LocateOpts): string | null;
}

export interface LocateOpts {
  runner: string;
  /** The runner's own id for this spawn, when known: claude's is parsed out
   *  of the `-p --output-format json` wrapper, openclaw's we minted. */
  sessionId?: string | null;
  /** Epoch ms the spawn started. Nothing older can belong to it — this is
   *  what keeps a newest-file search off the MAIN agent's live session. */
  since: number | null;
  /** The environment the spawn ACTUALLY ran with (hermes' filtered home
   *  arrives as HOME/HERMES_HOME overrides, not as process.env). */
  env: NodeJS.ProcessEnv;
  /** The spawn's cwd. */
  cwd: string;
  /** Ids belonging to somebody else — above all the MAIN agent's session,
   *  which lives in the SAME projects dir and is being written the whole
   *  time we are looking. */
  exclude?: Array<string | null | undefined>;
}

function homeOf(env: NodeJS.ProcessEnv): string {
  return env.HOME || env.USERPROFILE || os.homedir();
}
function existing(dirs: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const d of dirs) {
    if (!d) continue;
    try { if (fs.statSync(d).isDirectory()) out.push(d); } catch { /* absent */ }
  }
  return out;
}

const SPECS: Record<string, RunnerTranscriptSpec> = {
  claude: {
    record: "Claude Code session JSONL under $CLAUDE_CONFIG_DIR/projects/<cwd-slug>/<session-id>.jsonl",
    ext: ".jsonl",
    // Suppressed by OUR OWN flag, not by anything the CLI decided: the
    // invocation builder adds --no-session-persistence unless the bench knob
    // is set, and with it the CLI writes no session file whatsoever. Report
    // the flag, not a fruitless search.
    suppressed: (o) =>
      o.env.CHATS_SANDBOX_PERSIST_SUBAGENT_SESSIONS === "1"
        ? null
        : "the spawn ran with --no-session-persistence (CHATS_SANDBOX_PERSIST_SUBAGENT_SESSIONS is not 1), " +
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
    // HERMES_HOME first — filteredHermesHome hands the spawn a per-call temp
    // home through it, and that home is wiped by the next spawn on a
    // recycled pid, so this copy is the only durable one.
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

  openclaw: {
    record: "openclaw session record under $OPENCLAW_HOME (we mint the --session-id, so it is found by name)",
    ext: ".jsonl",
    roots: (o) => existing([
      o.env.OPENCLAW_HOME || null,
      path.join(homeOf(o.env), ".openclaw"),
      path.join(homeOf(o.env), ".config", "openclaw"),
    ]),
    match: /\.jsonl$|\.json$/,
  },

  openhands: {
    // The one runner with no store of its own on this invocation. The shipped
    // python runner writes its event stream straight into the action dir.
    record: "openhands SDK spawn — no session store; openhands_subagent_runner.py dumps its events into the action dir",
    ext: ".jsonl",
    selfWritten: true,
    roots: () => [],
    match: /^$/,
  },
};

/** Bounded recursive walk. Deliberately small limits: this runs on the hook's
 *  critical path, once per backup, and a config dir can be enormous. */
function walkFiles(root: string, match: RegExp, budget: { left: number }): string[] {
  const out: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length && budget.left > 0) {
    const { dir, depth } = stack.pop() as { dir: string; depth: number };
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (budget.left-- <= 0) break;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 6) stack.push({ dir: full, depth: depth + 1 }); }
      else if (e.isFile() && match.test(e.name)) out.push(full);
    }
  }
  return out;
}

/**
 * Find THIS spawn's record. Two independent filters keep us off somebody
 * else's transcript:
 *   - the id, when we know it (exact filename match wins outright);
 *   - the clock: a file whose birth AND mtime both predate the spawn cannot
 *     be this spawn's. The MAIN agent's session lives in the same directory
 *     and is appended to throughout, so its mtime is always "newest" — the
 *     birthtime test, plus the explicit id exclusion, is what excludes it.
 */
export function locateTranscript(o: LocateOpts): { file: string | null; roots: string[]; reason: string } {
  const spec = SPECS[o.runner];
  if (!spec) return { file: null, roots: [], reason: `unknown runner "${o.runner}" — no transcript location is known for it` };

  const sup = spec.suppressed?.(o);
  if (sup) return { file: null, roots: [], reason: sup };

  const roots = spec.roots(o);
  if (roots.length === 0) {
    return { file: null, roots: [], reason: `no readable transcript directory for runner "${o.runner}" (${spec.record})` };
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
      try { st = fs.statSync(file); } catch { continue; }
      const born = st.birthtimeMs || st.ctimeMs || st.mtimeMs;
      // Belongs to this spawn only if it was CREATED during it (a file merely
      // appended to during the spawn is somebody else's live session).
      if (born < since) continue;
      const exact = !!o.sessionId && (stem === o.sessionId || base.includes(o.sessionId));
      candidates.push({ file, mtime: st.mtimeMs, exact });
    }
  }

  if (candidates.length === 0) {
    return {
      file: null, roots,
      reason: o.sessionId
        ? `no record for session ${o.sessionId} was found under ${roots.join(", ")}`
        : `no record created during this spawn was found under ${roots.join(", ")}`,
    };
  }
  const exact = candidates.filter((c) => c.exact);
  const pick = (exact.length ? exact : candidates).sort((a, b) => b.mtime - a.mtime)[0];
  return {
    file: pick.file, roots,
    reason: pick.exact
      ? `matched the spawn's own session id (${o.sessionId})`
      : `newest record created during the spawn (no session id to match on)`,
  };
}

/**
 * Cap a transcript WITHOUT silently losing the middle.
 *
 * A truncated record that SAYS it is truncated is fine; one that quietly
 * drops the interesting part is not. So both ends are kept and an explicit
 * elision record is written between them — as a JSON line, so a JSONL reader
 * still parses every line it is handed.
 */
export function capTranscript(text: string, cap: number): {
  out: string; truncated: boolean; droppedBytes: number; droppedLines: number;
  mode: "none" | "lines" | "bytes";
} {
  const total = Buffer.byteLength(text);
  if (total <= cap) return { out: text, truncated: false, droppedBytes: 0, droppedLines: 0, mode: "none" };

  const half = Math.floor(cap / 2);
  const lines = text.split("\n");
  if (lines.length > 2) {
    const head: string[] = []; let headBytes = 0;
    for (const l of lines) {
      const b = Buffer.byteLength(l) + 1;
      if (headBytes + b > half) break;
      head.push(l); headBytes += b;
    }
    const tail: string[] = []; let tailBytes = 0;
    for (let i = lines.length - 1; i >= head.length; i--) {
      const b = Buffer.byteLength(lines[i]) + 1;
      if (tailBytes + b > half) break;
      tail.unshift(lines[i]); tailBytes += b;
    }
    // A real Claude Code session line is a whole assistant message and can be
    // several KB on its own, so at a tight cap NEITHER end fits a complete
    // line — measured live: a 6000-byte cap on an 18.8 KB session kept zero
    // head lines. "Both ends are intact" then becomes a lie. Rather than drop
    // an end, keep a FRAGMENT of it, wrapped in its own JSON record so every
    // line of the output still parses and the fragment cannot be mistaken for
    // a real transcript entry.
    const fragBudget = Math.max(256, half - 512);
    const fragment = (position: "head" | "tail", line: string): string => {
      const b = Buffer.from(line, "utf-8");
      const kept = position === "head" ? b.subarray(0, fragBudget) : b.subarray(Math.max(0, b.length - fragBudget));
      return JSON.stringify({
        type: "chats_sandbox_transcript_fragment",
        note: `the ${position} record did not fit the cap on its own; this is a ${position === "head" ? "leading" : "trailing"} fragment of it, NOT a complete transcript entry`,
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
      type: "chats_sandbox_transcript_truncation",
      note: "MIDDLE ELIDED by the CHATS-Sandbox transcript cap — both ends are kept (in full, or as a marked fragment when one record alone exceeded the cap)",
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
  // One enormous line (hermes' single-document sessions land here): split by
  // bytes and say so in plain text between the halves.
  const buf = Buffer.from(text, "utf-8");
  const headB = buf.subarray(0, half).toString("utf-8");
  const tailB = buf.subarray(buf.length - half).toString("utf-8");
  const droppedBytes = total - Buffer.byteLength(headB) - Buffer.byteLength(tailB);
  return {
    out: `${headB}\n…[CHATS-Sandbox: MIDDLE ELIDED — ${droppedBytes} bytes dropped from a ${total}-byte record at a ${cap}-byte cap; both ends are intact and this text is NOT part of the transcript]…\n${tailB}`,
    truncated: true, droppedBytes, droppedLines: 0, mode: "bytes",
  };
}

/**
 * Capture this spawn's step-by-step record into `actionDir`, or explain in a
 * marker file why there is none. Never throws: a failure to record must not
 * take the backup down with it.
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
    captured: false, path: null, source: null,
    sourceBytes: 0, bytes: 0, truncated: false, capBytes: cap,
    droppedBytes: 0, droppedLines: 0, truncationMode: "none",
    marker: null, reason: "", searched: [],
  };

  const writeMarker = (reason: string, searched: string[]): TranscriptCapture => {
    const name = `subagent_${id}.transcript.MISSING.txt`;
    try {
      fs.writeFileSync(path.join(actionDir, name),
        `CHATS-Sandbox tier-3 subagent: NO STEP-BY-STEP TRANSCRIPT WAS CAPTURED\n` +
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

    // openhands: the runner script wrote straight into the action dir. There
    // is nothing to locate — only to confirm, and to cap if it ran long.
    if (spec?.selfWritten) {
      const name = `subagent_${id}.transcript${spec.ext}`;
      const dest = path.join(actionDir, name);
      let size = 0;
      try { size = fs.statSync(dest).size; } catch {
        return writeMarker(
          "the openhands runner script wrote no event dump (the SDK spawn produced no reachable events, " +
          "or CHATS_SANDBOX_OH_SUB_TRANSCRIPT never reached it)", []);
      }
      if (size === 0) {
        try { fs.rmSync(dest, { force: true }); } catch { /* */ }
        return writeMarker("the openhands runner script created an EMPTY event dump", []);
      }
      let bytes = size, truncated = false, droppedBytes = 0, droppedLines = 0;
      let mode: TranscriptCapture["truncationMode"] = "none";
      if (size > cap) {
        const capped = capTranscript(fs.readFileSync(dest, "utf-8"), cap);
        fs.writeFileSync(dest, capped.out, "utf-8");
        bytes = Buffer.byteLength(capped.out);
        truncated = capped.truncated; droppedBytes = capped.droppedBytes;
        droppedLines = capped.droppedLines; mode = capped.mode;
      }
      return {
        ...base, captured: true, path: name, source: null,
        sourceBytes: size, bytes, truncated, droppedBytes, droppedLines,
        truncationMode: mode,
        reason: "written in-process by openhands_subagent_runner.py",
        searched: [],
      };
    }

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
      captured: true, path: name, source: found.file,
      sourceBytes, bytes: Buffer.byteLength(capped.out),
      truncated: capped.truncated, droppedBytes: capped.droppedBytes,
      droppedLines: capped.droppedLines, truncationMode: capped.mode,
      reason: found.reason, searched: found.roots,
    };
  } catch (e) {
    return { ...base, reason: `transcript capture failed: ${String(e).slice(0, 300)}` };
  }
}

/** Files this module adds to an action dir — used by preserveTranscripts so a
 *  dropped read-only action dir does not take the transcript with it. */
export const TRANSCRIPT_FILE_RE =
  /^subagent_[a-z0-9]{8}\.transcript(?:\.MISSING\.txt|\.jsonl|\.json)$/;
