/**
 * Runs the backup subagent and terminates it as soon as a valid result file appears.
 *
 * Usage:  node subagent_watch.js <resultFile> <timeoutMs> <bin> [args...]
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const [resultFile, timeoutStr, bin, ...args] = process.argv.slice(2);
const timeoutMs = Math.max(5000, parseInt(timeoutStr || "120000", 10) || 120000);

// Remove a stale result file so only this run's write is observed.
try {
  fs.rmSync(resultFile, { force: true });
} catch { /* nothing to remove */ }

// On deadline, write a marker file so the caller can tell a timeout from a malformed result.
const watchMarker = path.join(path.dirname(resultFile), "subagent_watch.json");
try {
  fs.rmSync(watchMarker, { force: true });
} catch { /* nothing to remove */ }
function markTimeout(): void {
  try {
    fs.writeFileSync(watchMarker, JSON.stringify({
      timedOut: true, timeoutMs, at: new Date().toISOString(),
    }) + "\n", "utf-8");
  } catch { /* best-effort */ }
}

// Detached: the child leads its own process group, so one signal reaches its whole tree.
const child = spawn(bin, args, { stdio: ["pipe", "inherit", "inherit"], detached: true });
try {
  child.stdin?.end();
} catch { /* stdin already closed */ }

let finished = false;
function finish(code: number): void {
  if (finished) return;
  finished = true;
  clearInterval(poll);
  clearTimeout(deadline);
  process.exit(code);
}
// Set when the watcher stops the child itself, so its SIGTERM exit is not reported as a failure.
let terminatedByWatcher = false;

/** Signal the child's whole process group, falling back to the child alone if the group is gone. */
function signalChildTree(signal: NodeJS.Signals): void {
  try {
    if (!child.pid) throw new Error("no pid");
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch { /* child already exited */ }
  }
}

function killChild(): void {
  terminatedByWatcher = true;
  signalChildTree("SIGTERM");
  // Allow up to 10s of graceful shutdown (which flushes the final transcript record) before SIGKILL.
  setTimeout(() => signalChildTree("SIGKILL"), 10_000);
}

/** A complete, shaped result — not a half-written draft. */
function resultValid(): boolean {
  try {
    const o = JSON.parse(fs.readFileSync(resultFile, "utf-8")) as Record<string, unknown>;
    // Complete if any recovery channel is present: shell commands, MCP calls, or a no-op verdict.
    return !!o && typeof o === "object" &&
      (Array.isArray(o.recovery_commands) ||
       Array.isArray(o.recovery_mcp_calls) ||
       o.no_backup_needed === true);
  } catch {
    return false;
  }
}

// Require two consecutive valid reads (~0.6s) so a file still being written is never
// accepted (a partial write does not parse in any case).
let stableHits = 0;
const poll = setInterval(() => {
  if (resultValid()) {
    // finish() normally fires from child.on("exit"); the 12s timer is a backstop.
    stableHits++;
    if (stableHits >= 2) {
      killChild();
      setTimeout(() => finish(0), 12_000);
    }
  } else {
    stableHits = 0;
  }
}, 300);

const deadline = setTimeout(() => {
  markTimeout();
  killChild();
  setTimeout(() => finish(0), 12_000);
}, timeoutMs);

child.on("exit", (code) => finish(terminatedByWatcher ? 0 : (code ?? 0)));
child.on("error", () => finish(1));
// If the watcher itself is terminated, take the child down too (no orphans).
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    killChild();
    finish(0);
  });
}
