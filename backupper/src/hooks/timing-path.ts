/**
 * Shared path for the pre-tool → post-tool timing handshake file.
 *
 * Scoped by a hash of (cwd + session_id) so that:
 *   - the pre- and post-tool hooks for the same call agree on the path,
 *   - agents that send no session_id (hermes/openclaw/openhands) running
 *     in different projects do NOT collide on one predictable,
 *     world-writable `/tmp/chats-sandbox-timing-default.json`
 *     (cross-attribution and local-user pre-creation).
 */
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import type { HookContext } from "../types.js";

export function timingFilePath(ctx: HookContext): string {
  const key = `${process.cwd()}|${ctx.session_id ?? ""}`;
  const h = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), `chats-sandbox-timing-${h}.json`);
}
