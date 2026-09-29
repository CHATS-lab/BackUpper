/**
 * Agent-written backup declarations. The agent marks a tool call with
 * `[Backup needed]` (optionally followed by free text) to request a tier-3
 * backup; the declaration is only a trigger and its text is never shown to
 * the backup subagent, which performs its own discovery.
 *
 * The marker may appear in any string anywhere in tool_input. A marker that
 * occurs as data also counts (the cost is an extra spawn, never a missed
 * backup), and an unterminated bracket still counts as a declaration.
 */

import type { HookContext } from "../types.js";

export interface BackupDeclaration {
  /** Path of the tool_input field containing the marker (e.g. "command",
   *  "args.query"). */
  surface: string;
  /** The matched marker, verbatim. */
  raw: string;
  /** Free text attached to the marker, trimmed; may be empty. */
  text: string;
  /** True when the bracket was never closed. */
  malformed: boolean;
}

/** The marker: case-insensitive, tolerating inner whitespace and joined or
 *  hyphenated words (`[BackupNeeded]`, `[backup-needed]`). */
const MARKER = /\[[ \t]*backup[ \t_-]*needed\b/i;

/** Depth and size limits for the tool_input walk, which runs on every PreToolUse call. */
const MAX_DEPTH = 8;
const MAX_STRINGS = 400;

/**
 * Parse a declaration from a string, or return null when the marker is absent.
 * Free text comes from inside the brackets, else from the rest of the line.
 */
export function parseDeclaration(
  text: string | undefined | null,
  surface = "(text)",
): BackupDeclaration | null {
  if (!text) return null;
  const m = MARKER.exec(text);
  if (!m) return null;

  const afterMarker = m.index + m[0].length;
  const rest = text.slice(afterMarker);
  const close = rest.indexOf("]");
  const nl = rest.search(/[\r\n]/);
  const terminated = close >= 0 && (nl < 0 || close < nl);

  // Text inside the brackets, minus a leading separator (":" or "-").
  const inner = (terminated ? rest.slice(0, close) : (nl >= 0 ? rest.slice(0, nl) : rest))
    .replace(/^[ \t]*[:—–-]?[ \t]*/, "").trim();
  // For a bare marker, the rest of the line.
  const trailing = terminated
    ? (() => {
        const after = rest.slice(close + 1);
        const end = after.search(/[\r\n]/);
        return (end < 0 ? after : after.slice(0, end)).trim();
      })()
    : "";

  return {
    surface,
    raw: text.slice(m.index, terminated ? afterMarker + close + 1 : afterMarker + (nl < 0 ? rest.length : nl)),
    text: (inner || trailing).slice(0, 500),
    malformed: !terminated,
  };
}

/** Walk a JSON-like value and return the first declaration found. */
function scanValue(
  value: unknown,
  pathName: string,
  depth: number,
  budget: { left: number },
): BackupDeclaration | null {
  if (budget.left <= 0 || depth > MAX_DEPTH) return null;
  if (typeof value === "string") {
    budget.left--;
    return parseDeclaration(value, pathName || "(root)");
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = scanValue(value[i], `${pathName}[${i}]`, depth + 1, budget);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const hit = scanValue(v, pathName ? `${pathName}.${k}` : k, depth + 1, budget);
      if (hit) return hit;
    }
    return null;
  }
  return null;
}

/** Find a declaration anywhere in a tool call's input. */
export function findDeclaration(ctx: HookContext): BackupDeclaration | null {
  return scanValue(ctx.tool_input ?? {}, "", 0, { left: MAX_STRINGS });
}

/**
 * Remove the marker from a free-text field. Applied to the `description` given
 * to the backup subagent, never to executable fields such as `command` or `sql`.
 * A no-op when no marker is present.
 */
export function stripDeclaration(text: string): string {
  const decl = parseDeclaration(text);
  if (!decl) return text;
  return text.replace(decl.raw, "").replace(/[ \t]{2,}/g, " ").trim();
}
