/**
 * Watcher wrapper for the backup subagent.
 *
 * The subagent's deliverable is a result file (`subagent_result.json`), and
 * it performs the actual backup BEFORE writing that file. So once a VALID
 * result file exists, the backup is done and every further LLM turn is pure
 * latency (the "post-backup tail" — ~40-80s of the model verifying / re-
 * reading / finalising). This wrapper runs the subagent and TERMINATES it
 * the instant the result file appears and parses — a discrete, validated
 * filesystem event, far more reliable than watching the runner's buffered,
 * TUI-decorated stdout.
 *
 * Usage:  node subagent_watch.js <resultFile> <timeoutMs> <bin> [args...]
 *
 * The child inherits this process's stdout/stderr, so the parent's
 * execFileSync still captures the runner output for fallback parsing.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const [resultFile, timeoutStr, bin, ...args] = process.argv.slice(2);
const timeoutMs = Math.max(5000, parseInt(timeoutStr || "120000", 10) || 120000);

// Remove a stale result file so we only react to THIS run's write.
try { fs.rmSync(resultFile, { force: true }); } catch { /* */ }

// A DEADLINE KILL IS INVISIBLE FROM THE OUTSIDE. `finish(0)` below is
// deliberate — our own kill must not surface to the caller as a child
// failure — but it also means a timeout arrives at the caller as "exit 0,
// no result file", i.e. exactly the shape of a malformed handoff. The two
// were indistinguishable, and a timed-out spawn was reported to the user as
// "subagent returned unparseable output". So say so in a file the caller can
// read. Written ONLY when the deadline fires; cleared here so a previous
// action's mark can never be read as this one's.
const watchMarker = path.join(path.dirname(resultFile), "subagent_watch.json");
try { fs.rmSync(watchMarker, { force: true }); } catch { /* */ }
function markTimeout(): void {
  try {
    fs.writeFileSync(watchMarker, JSON.stringify({
      timedOut: true, timeoutMs, at: new Date().toISOString(),
    }) + "\n", "utf-8");
  } catch { /* best-effort: the caller degrades to "unparseable" as before */ }
}

// `detached: true` makes the child a PROCESS-GROUP LEADER, so its own
// children join that group and one signal reaches the whole tree.
// Without it, killing `claude` left its node grandchildren alive holding
// the INHERITED stdout/stderr pipes -- and the caller's spawnSync does not
// return until those pipes hit EOF. Measured 2026-08-19 on task 1604: a
// 120000ms timeout the log reported correctly took 210s and 243s to
// surface, twice, and both times on the destructive turn.
const child = spawn(bin, args, { stdio: ["pipe", "inherit", "inherit"], detached: true });
try { child.stdin?.end(); } catch { /* */ }

let finished = false;
function finish(code: number): void {
  if (finished) return;
  finished = true;
  clearInterval(poll);
  clearTimeout(deadline);
  process.exit(code);
}
// Set the moment WE decide to stop the child — either the result file is ready
// or the deadline hit. Both are our own control flow, not a child failure, so
// the child's SIGTERM exit code must not surface as one.
//
// Without this the SUCCESS path always looked like a failure: the child writes
// subagent_result.json, we kill it to skip the 40-80s post-backup tail, and
// `child.on("exit")` then reported the SIGTERM code. Measured 2026-08-19 on two
// live runs: 13 invocations, 13 `FAILED` log lines, 13 results read back fine.
// The caller recovered every time, so backups were unaffected — but a real
// failure would have been invisible among the noise, and it cost an hour of
// debugging a subagent that was working.
let terminatedByUs = false;
function killChild(): void {
  terminatedByUs = true;
  // Signal the GROUP (negative pid), not just the direct child; fall back to
  // the child alone if the group is already gone.
  try { if (!child.pid) throw new Error("no pid"); process.kill(-child.pid, "SIGTERM"); }
  catch { try { child.kill("SIGTERM"); } catch { /* */ } }
  // Grace before SIGKILL: transcripts are written incrementally, but the
  // FINAL in-flight assistant record (and the -p JSON envelope) only lands
  // on graceful shutdown — an 800ms fuse could clip it. (tok_sub=0 itself
  // was --no-session-persistence, not this; the grace is accuracy-of-the-
  // last-record insurance.) The child's exit resolves finish() immediately
  // (see child.on("exit")), so a cooperative runner pays only its own
  // flush time; 10s is the cap for one that ignores SIGTERM.
  setTimeout(() => {
    try { if (!child.pid) throw new Error("no pid"); process.kill(-child.pid, "SIGKILL"); }
    catch { try { child.kill("SIGKILL"); } catch { /* */ } }
  }, 10_000);
}

/** A complete, shaped result — not a half-written draft. */
function resultValid(): boolean {
  try {
    const o = JSON.parse(fs.readFileSync(resultFile, "utf-8")) as Record<string, unknown>;
    // Mirror extractOurShape: any ONE recovery channel makes the result
    // complete — shell commands, structured MCP calls, or a no-op verdict.
    return !!o && typeof o === "object" &&
      (Array.isArray(o.recovery_commands) ||
       Array.isArray(o.recovery_mcp_calls) ||
       o.no_backup_needed === true);
  } catch { return false; }
}

// Require TWO consecutive valid reads (~0.6s) so we never catch a file the
// model is still mid-writing (a partial write won't parse anyway).
let stableHits = 0;
const poll = setInterval(() => {
  if (resultValid()) {
    // finish() comes from child.on("exit") the moment the runner shuts
    // down cleanly; 12s is only the backstop for a SIGTERM-ignoring child.
    if (++stableHits >= 2) { killChild(); setTimeout(() => finish(0), 12_000); }
  } else {
    stableHits = 0;
  }
}, 300);

const deadline = setTimeout(() => {
  markTimeout();
  killChild();
  setTimeout(() => finish(0), 12_000);
}, timeoutMs);

child.on("exit", (code) => finish(terminatedByUs ? 0 : (code ?? 0)));
child.on("error", () => finish(1));
// If the parent terminates us, take the child down too (no orphans).
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => { killChild(); finish(0); });
}
