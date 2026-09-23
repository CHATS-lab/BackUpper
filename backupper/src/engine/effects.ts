/**
 * Effect manifest logger — captures what each tool call actually changed.
 *
 * For now, uses simple heuristics (parse tool output, check timestamps).
 * Future: integrate with inotify / docker diff for ground-truth capture.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { EffectEntry, HookContext, SandboxConfig } from "../types.js";

/**
 * Build an effect entry from a PostToolUse context.
 */
export function captureEffect(
  ctx: HookContext,
  backupId: string | undefined,
  startTime: number
): EffectEntry {
  const entry: EffectEntry = {
    timestamp: new Date().toISOString(),
    sessionId: ctx.session_id,
    toolName: ctx.tool_name,
    toolInput: ctx.tool_input,
    success: ctx.hook_event === "PostToolUse",
    backupId,
    durationMs: Date.now() - startTime,
  };

  // Extract effect details from tool output
  const output = ctx.tool_output;
  if (typeof output === "object" && output !== null) {
    const out = output as Record<string, unknown>;
    if (typeof out.exit_code === "number") {
      entry.exitCode = out.exit_code;
    }
  }

  // Infer file effects from tool name + input
  const filePath = String(
    ctx.tool_input.path ?? ctx.tool_input.file_path ?? ""
  );

  switch (ctx.tool_name) {
    case "Write":
    case "write_file":
      if (filePath) {
        entry.filesCreated = [filePath];
      }
      break;
    case "FileEdit":
    case "patch":
      if (filePath) {
        entry.filesModified = [filePath];
      }
      break;
    case "Bash": {
      const cmd = String(ctx.tool_input.command ?? "");
      // Simple heuristic: detect rm commands
      const rmMatch = cmd.match(/\brm\s+(?:-\w+\s+)*(.+)/);
      if (rmMatch) {
        entry.filesDeleted = [rmMatch[1].trim()];
      }
      break;
    }
  }

  return entry;
}

/**
 * Append an effect entry to the JSONL log file.
 */
export function logEffect(entry: EffectEntry, config: SandboxConfig): void {
  if (!config.effectManifest) return;

  const logPath = path.resolve(config.effectLogPath);
  const dir = path.dirname(logPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
}
