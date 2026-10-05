/**
 * Per-host capabilities that change how the hook behaves.
 *
 * canRewrite: the host applies a PreToolUse hook's rewritten tool input (`updatedInput`).
 * Claude Code does; the Hermes plugin copies it into the live call arguments before dispatch;
 * Codex does when the same output also carries `permissionDecision: "allow"` (the pre-tool hook
 * adds it for Codex only; Codex still applies its approval policy and sandbox to the rewritten
 * command). On a host that cannot rewrite, tier 1 runs in
 * backup-only mode: it captures a restorable copy and executes nothing itself, so the host's
 * own run of the command is the only one.
 */

export const CAN_REWRITE: Readonly<Record<string, boolean>> = {
  "claude-code": true,
  hermes: true,
  codex: true,
};

/**
 * Whether tier 1 may rewrite the call for the host whose hook fired (BACKUPPER_HOST_AGENT,
 * set from the hook's `--agent` tag). BACKUPPER_NO_REWRITE=1 forces backup-only mode and
 * BACKUPPER_NO_REWRITE=0 forces rewriting. An unknown host gets backup-only mode, which is
 * correct on every host.
 */
export function tier1CanRewrite(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.BACKUPPER_NO_REWRITE === "1") return false;
  if (env.BACKUPPER_NO_REWRITE === "0") return true;
  const host = env.BACKUPPER_HOST_AGENT ?? "";
  return CAN_REWRITE[host] === true;
}

/**
 * How tier 1 treats a matching call:
 * - "rewrite": run the backup (and, for most rules, the effect) inside the hook and hand the
 *   agent a no-op. Only safe when the host runs no approval step after the hook, i.e. in a
 *   bypass / full-auto permission mode, or when the host does not report a mode at all
 *   (older hosts and plugins; unchanged behaviour).
 * - "chain": the hook executes nothing; it returns `<copy commands> && <original command>`, so
 *   the host's own deny rules, exec policy and approval dialog still see (and can stop) the
 *   original command, and a failed copy stops it via `&&`.
 * - "backup-only": capture in the hook, never rewrite (BACKUPPER_NO_REWRITE=1, unknown host).
 */
export type Tier1Mode = "rewrite" | "chain" | "backup-only";

export function tier1Mode(
  permissionMode: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Tier1Mode {
  if (!tier1CanRewrite(env)) return "backup-only";
  if (env.BACKUPPER_NO_REWRITE === "0") return "rewrite";
  if (!permissionMode || permissionMode === "bypassPermissions") return "rewrite";
  return "chain";
}

/**
 * The command that runs chain-mode copies: `node <dist>/hooks/capture.js`, with the path
 * double-quoted only when it needs quoting. `backupper install claude-code` allows exactly this
 * prefix (`Bash(<prefix>:*)`), so the copies need no approval of their own.
 */
export function captureCommandPrefix(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const p = require("node:path").join(__dirname, "..", "hooks", "capture.js") as string;
  return /^[\w\/.@+-]+$/.test(p) ? `node ${p}` : `node "${p}"`;
}
