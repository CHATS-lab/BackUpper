/**
 * Path of the pre-tool → post-tool timing file, keyed by a hash of
 * (cwd, session_id) so both hooks agree and separate projects never collide.
 */
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import type { HookContext } from "../types.js";

export function timingFilePath(ctx: HookContext): string {
  const key = `${process.cwd()}|${ctx.session_id ?? ""}`;
  const h = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), `backupper-timing-${h}.json`);
}
