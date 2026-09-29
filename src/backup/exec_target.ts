/**
 * Detects whether the agent's tool calls execute on this process's own
 * filesystem. Tier 0 executes its rewrites in the hook process, so under a
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
