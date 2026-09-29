/**
 * Per-host capabilities that change how the hook behaves.
 *
 * canRewrite: the host applies a PreToolUse hook's rewritten tool input (`updatedInput`).
 * Claude Code does; the Hermes plugin copies it into the live call arguments before dispatch;
 * Codex ignores it and runs the original command. On a host that cannot rewrite, tier 0 runs in
 * backup-only mode: it captures a restorable copy and executes nothing itself, so the host's
 * own run of the command is the only one.
 */

export const CAN_REWRITE: Readonly<Record<string, boolean>> = {
  "claude-code": true,
  hermes: true,
  codex: false,
};

/**
 * Whether tier 0 may rewrite the call for the host whose hook fired (BACKUPPER_HOST_AGENT,
 * set from the hook's `--agent` tag). BACKUPPER_NO_REWRITE=1 forces backup-only mode and
 * BACKUPPER_NO_REWRITE=0 forces rewriting. An unknown host gets backup-only mode, which is
 * correct on every host.
 */
export function tier0CanRewrite(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.BACKUPPER_NO_REWRITE === "1") return false;
  if (env.BACKUPPER_NO_REWRITE === "0") return true;
  const host = env.BACKUPPER_HOST_AGENT ?? "";
  return CAN_REWRITE[host] === true;
}
