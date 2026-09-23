/**
 * Where do the AGENT's tool calls actually execute?
 *
 * Almost every backup tier in this plugin assumes ONE thing: the filesystem
 * the hook process can see IS the filesystem the agent is about to mutate.
 * That holds for Claude Code (its Bash/Write tools act on the process that
 * hosts them) and for hermes with the LOCAL terminal backend.
 *
 * It does NOT hold when the harness gives the agent a REMOTE execution
 * backend — hermes' `TERMINAL_ENV=docker|ssh|modal|singularity|daytona`
 * docker-execs (or ssh's) every command into somewhere else while the hook
 * still runs on the host. Then:
 *
 *   * tiers 1-2 snapshot the wrong (empty) filesystem — a MISS, annoying but
 *     harmless; and
 *   * tier 0 is an ACTIVE HAZARD. Tier-0 policy rules do not merely describe
 *     a rewrite, they EXECUTE it themselves in the hook process (`mv <path>
 *     <trash>`, `cp`, `git stash`, …) and then no-op the agent's command. On
 *     a split host/container topology that runs `rm`/`mv` against the HOST's
 *     files — files nobody asked to touch — while the container the agent is
 *     really driving is left completely unprotected.
 *
 * So tier 0 must be able to answer "is the agent's execution target my own
 * filesystem?" and refuse to act when the answer is no. This module is that
 * answer. It deliberately fails SAFE in both directions:
 *
 *   * unknown/absent signals  → treated as local (the overwhelmingly common
 *     case; we must not disable tier 0 for every normal deployment), and
 *   * any recognised non-local backend → foreign, tier 0 stands down and the
 *     command passes through UNMODIFIED (tiers 1-3 still run; a miss is
 *     always better than mutating the wrong machine).
 *
 * The real fix for a split topology is to run the agent AND the plugin inside
 * the same box (see benchmarks/datasets/regretbench.sh `RB_PLUGIN_IN_CONTAINER`,
 * and RegretBench's harness/run_task_claude.sh). This guard exists so that a
 * deployment which has NOT done that is merely blind, never destructive.
 */

export interface ForeignExecTarget {
  /** The backend the agent executes through: "docker", "ssh", "modal", … */
  backend: string;
  /** Which environment signal told us (for the log line). */
  source: string;
}

/** hermes terminal backends. Only "local" runs on the hook's own filesystem. */
const HERMES_LOCAL_BACKENDS = new Set(["", "local", "host"]);

/**
 * Return a description of the agent's execution target when it is NOT this
 * process's own filesystem, or null when it is (or when we cannot tell).
 *
 * Signals, in precedence order:
 *
 *   1. `CHATS_SANDBOX_EXEC_TARGET` — explicit operator override. "local"
 *      (or "self") asserts same-filesystem; anything else names a foreign
 *      backend. Use this for harnesses this module does not know about.
 *   2. `TERMINAL_ENV` — hermes' terminal backend selector
 *      (tools/terminal_tool.py: local|docker|singularity|modal|daytona|ssh).
 *      Anything other than local means every command the agent issues is
 *      shipped somewhere else.
 *   3. `CHATS_SANDBOX_REMOTE_EXEC=1` — generic escape hatch for a wrapper
 *      that knows it has split the agent from the hook.
 */
export function foreignExecTarget(): ForeignExecTarget | null {
  const explicit = (process.env.CHATS_SANDBOX_EXEC_TARGET ?? "").trim().toLowerCase();
  if (explicit) {
    if (explicit === "local" || explicit === "self" || explicit === "same") return null;
    return { backend: explicit, source: "CHATS_SANDBOX_EXEC_TARGET" };
  }

  const terminalEnv = (process.env.TERMINAL_ENV ?? "").trim().toLowerCase();
  if (!HERMES_LOCAL_BACKENDS.has(terminalEnv)) {
    return { backend: terminalEnv, source: "TERMINAL_ENV" };
  }

  if (process.env.CHATS_SANDBOX_REMOTE_EXEC === "1") {
    return { backend: "unspecified-remote", source: "CHATS_SANDBOX_REMOTE_EXEC" };
  }

  return null;
}

/** Convenience: true when the agent runs on this very filesystem. */
export function execTargetIsSelf(): boolean {
  return foreignExecTarget() === null;
}
