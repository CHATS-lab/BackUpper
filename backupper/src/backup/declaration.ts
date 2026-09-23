/**
 * Agent-written backup DECLARATIONS.
 *
 * The plugin used to decide by itself whether a tool call needed a tier-3
 * (subagent) backup. For Bash that meant escalating anything it could not
 * PROVE read-only, because a command line alone cannot tell you what
 * `bin/capctl status` does — only the program's source can. Measured on one
 * real run (capline-allot-release, 2026-08-23): 12 subagent wake-ups, 10 of
 * which the subagent itself concluded needed no backup at all.
 *
 * The agent, with the `waypoint` skill installed, already classifies this
 * correctly — it has read the program, it knows what its own step does. What
 * it is bad at is performing the capture, and doing so pollutes its context.
 * So the work splits:
 *
 *   the agent decides WHETHER a backup is needed  → it writes a declaration
 *   the plugin/subagent decides WHAT to capture   → unchanged, and it never
 *                                                   sees the declaration
 *
 * The second half of that split is deliberate and load-bearing. A declaration
 * is a TRIGGER and nothing else. Its text is never handed to the backup
 * subagent, because the main agent is sometimes wrong about what is at risk,
 * and a wrong hint steers the capture at exactly the moment the capture is the
 * only thing between the run and permanent loss. The subagent performs its own
 * discovery, from the same inputs it has always had.
 *
 * The declaration text is still RECORDED (see recordDeclaration in
 * strategies.ts) so a later investigation can see what the agent believed —
 * but nothing downstream reads it.
 *
 * ── THE MARKER ───────────────────────────────────────────────────────────
 *
 *   [Backup needed]
 *
 * Optional free text may follow it, inside the brackets or after them, and is
 * recorded for a human to read. Nothing parses it, so a bare `[Backup needed]`
 * is a complete declaration.
 *
 * ── WHERE IT MAY BE WRITTEN: ANY STRING IN tool_input ─────────────────────
 *
 * findDeclaration() walks the ENTIRE tool_input — nested objects and arrays
 * included — and treats the marker in ANY string value as a declaration. No
 * field is designated, which is what makes this general across tool types: the
 * agent writes the marker wherever the tool it is calling gives it room, and
 * the plugin does not have to be taught a new field per tool. Measured over
 * 1,266 real tool inputs, that room is:
 *
 *   Bash                     → `command` (required, so ALWAYS available) and
 *                              `description` (present in only 55% of calls,
 *                              and bimodally — 19 runs carry it on every call,
 *                              15 on none, so it cannot be relied on)
 *   mcp__postgres__execute_sql → `sql`
 *   browser_click            → `element` ("Username textbox" — human-readable)
 *   browser_evaluate         → `function`
 *
 * THE COST OF SCANNING EVERYTHING is that a marker occurring as DATA — inside
 * an INSERTed string literal, a file being written, a grep pattern — counts as
 * a declaration. That is accepted deliberately. The failure direction is one
 * wasted subagent spawn, never a missed backup, and no heuristic separating
 * "data" from "directive" can promise the same: every such heuristic
 * eventually errs in the other direction, which is the one that loses data.
 *
 * PRESENCE IS THE ONLY VERDICT-BEARING FACT. A marker with an unterminated
 * bracket still counts as present (`malformed: true`): the agent tried to
 * declare, and the fail-safe reading of a botched declaration is "escalate",
 * never "no declaration here".
 */

import type { HookContext } from "../types.js";

export interface BackupDeclaration {
  /** Path of the tool_input field the marker was found in — "command",
   *  "description", "sql", "element", "args.query", "edits[0].new_string"…
   *  Recorded, and used to decide what to sanitize before a subagent spawn. */
  surface: string;
  /** The matched marker, verbatim. */
  raw: string;
  /** Free text the agent attached, trimmed. May be "" — a bare marker is a
   *  complete declaration. */
  text: string;
  /** True when the bracket was never closed. Recorded, never acted on. */
  malformed: boolean;
}

/**
 * The sentinel. Case-insensitive; tolerant of whitespace inside the brackets
 * and of the two words being run together or hyphenated (`[BackupNeeded]`,
 * `[backup-needed]`) — a typo of a declaration is a declaration.
 */
const MARKER = /\[[ \t]*backup[ \t_-]*needed\b/i;

/** Recursion / work limits for the tool_input walk. This runs synchronously in
 *  the PreToolUse hook on every call, so it must not be possible for a large
 *  or deeply nested input to make it expensive. Both are far above anything a
 *  real tool_input reaches. */
const MAX_DEPTH = 8;
const MAX_STRINGS = 400;

/**
 * THE parser. Every surface goes through this and only this.
 *
 * Returns the declaration, or null when the marker is absent. Free text is
 * taken from inside the brackets when there is any, otherwise from the rest of
 * the line after the closing bracket.
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

  // Inside the brackets, minus a leading separator the agent may have used
  // ("[Backup needed: /var/lib/x]", "[Backup needed - /var/lib/x]").
  const inner = (terminated ? rest.slice(0, close) : (nl >= 0 ? rest.slice(0, nl) : rest))
    .replace(/^[ \t]*[:—–-]?[ \t]*/, "").trim();
  // ...or, for a bare marker, whatever the agent wrote after it on that line.
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

/** Walk any JSON-ish value, returning the FIRST declaration found. */
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

/**
 * Find a declaration anywhere in a tool call's input. No field is privileged:
 * whatever free-text room the tool offers, the marker counts there.
 */
export function findDeclaration(ctx: HookContext): BackupDeclaration | null {
  return scanValue(ctx.tool_input ?? {}, "", 0, { left: MAX_STRINGS });
}

/**
 * Remove the marker from a free-text field, leaving the agent's own wording.
 *
 * Used on ONE thing: the `description` field of the tool_input handed to the
 * backup subagent, which renders the whole input verbatim into its prompt. The
 * subagent must decide what to capture from the action itself, exactly as it
 * would have if the agent had never declared — a declaration riding along
 * inside the args is still a hint, and a WRONG hint is the failure this
 * separation exists to prevent.
 *
 * Deliberately NOT applied to `command` (or `sql`): those strings are what will
 * actually execute, and showing the backup subagent a command that differs from
 * the one about to run is a worse failure than the hint. A marker written into
 * the command is therefore visible to the subagent, by design.
 *
 * A no-op when no marker is present, so undeclared calls are byte-identical.
 */
export function stripDeclaration(text: string): string {
  const decl = parseDeclaration(text);
  if (!decl) return text;
  return text.replace(decl.raw, "").replace(/[ \t]{2,}/g, " ").trim();
}
