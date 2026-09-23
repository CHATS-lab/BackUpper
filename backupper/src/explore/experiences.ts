/**
 * Recovery experiences — per-MCP-server learned BACKUP SKILL.
 *
 * Pulling remote content to local and recreating it (the default tier-3
 * Category F strategy) is expensive and lossy (new IDs, timestamp
 * drift). Many destructive remote actions have a far cheaper reversible
 * counterpart — e.g. "delete a post" → "set it to private/draft", which
 * preserves the original entity in place. This module stores those
 * model-extracted patterns per server (the learned skill for backing up
 * that server well) and is read by the backup subagent prompt so it
 * prefers the cheap reversal when one applies.
 *
 * Modeled on NVIDIA ToolShield's per-server "experiences", but for
 * recoverability rather than safety.
 *
 * Stored at: .chats-sandbox/experiences/<server>.json
 */

import { EXPERIENCES_RENDER, render } from "../prompts.generated.js";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SandboxConfig } from "../types.js";

export interface RecoveryPattern {
  /** The destructive / mutating action this covers. */
  action: string;
  /** This action's VERIFIED branch guidance — the source material for the
   *  server-level `skill` playbook. Stage 1 proposes it as a HYPOTHESIS (the
   *  cheapest imaginable reversal, may be affordance-specific, e.g. "use the
   *  make-private function"); Stage 2 tests it and rewrites it as one of two
   *  verified branches: an in-place reversal how-to (which tool, how, how to
   *  reverse — capture nothing), or the capture recipe (which fields to
   *  capture with which read tool; recreate/restore from capture). Travels
   *  with the pattern so merge/retraction across runs keeps working; the
   *  playbook is re-assembled from these at save time.
   *  ABSENT for a creation-only pattern: its `reverter` IS the backup, so the
   *  explorer emits no skill/capture_tools for it. */
  skill?: string;
  /** A VERIFIED, concrete reversal recipe captured at exploration time: the
   *  exact tool call(s) / command(s) the Stage-2 verifier ACTUALLY RAN and
   *  confirmed, with captured values shown as <PLACEHOLDER> tokens. Injected
   *  into the backup subagent as a REFERENCE EXAMPLE — a known-good starting
   *  point, NOT a rigid template: the live environment is dynamic (refs/layout
   *  shift), so the subagent adapts it rather than replaying it blindly. */
  recipe?: string;
  /** Which tool(s) it applies to, if specific. */
  applies_to?: string;
  /** A SHORT matchable keyword/affordance for the MUTATING action this
   *  pattern covers (e.g. "create submission", "delete comment", "upvote").
   *  This is the BACKUP-WORTHY trigger: a remote action matching it is
   *  backed up. Defines the allowlist (with a generic mutating-verb floor);
   *  remote actions matching nothing are ignored. */
  trigger?: string;
  /** Stage 2 outcome: did a live agent actually confirm this works?
   *  true = verified against the real target, false = tried & failed,
   *  undefined = proposed only (no execution stage ran). */
  verified?: boolean;
  /** Stage 2 note — what the verifier observed. */
  verify_note?: string;
  /** LEARNED minimal tool allowlist for backing up THIS op: the few tools on
   *  this server a capture subagent needs to (a) READ the affected entity's
   *  pre-state and (b) RESTORE it — typically [<read tool>, <inverse/write
   *  tool>]. Discovered + confirmed in Stage-2 verify (the exact tools the
   *  verifier actually used), so the runtime narrows the subagent's MCP schema
   *  to these instead of the server's full tool list. Bounded 2-5. ABSENT for
   *  pure creates handled by the generic create shortcut (no subagent → no
   *  tools); when absent the runtime derives a set heuristically. */
  capture_tools?: string[];
  /** The DETERMINISTIC inverse of a CREATE — the "T1/T2 for remote" cheap
   *  replay that lets a remote create skip the capture subagent entirely. A
   *  create's inverse is unconditional: delete EXACTLY the entity this action
   *  created, pinned by a stable identifier captured at create time (an id, or
   *  a unique input attribute like an exact title/key) — NO prior-state capture
   *  is needed. Filled by the explorer ONLY for constructive
   *  (create/insert/post/add/upload/new) patterns; ABSENT for edit/delete/update
   *  (those overwrite or destroy prior state and still need the capture subagent).
   *  SAFETY: it must delete ONLY the just-created entity, pinned by that captured
   *  identifier — NEVER by position/recency ("the latest"/"the most recent"). */
  reverter?: {
    /** Prose/CLI inverse, e.g. "delete the submission whose title == '<title>'".
     *  ONE of commands / mcp_calls is set. */
    commands?: string[];
    /** A fixed MCP call on THIS server, e.g.
     *  {tool:"delete_submission",args:{id:"<captured id>"}}. ONE of
     *  commands / mcp_calls is set. */
    mcp_calls?: { tool: string; args: Record<string, unknown> }[];
    /** Which identifier to pin at create time (e.g. "title", "id", "name") —
     *  the stable attribute the runtime resolves from the captured typed input. */
    pin: string;
    /** true ONLY if reversal requires REWRITING the agent's destructive call
     *  into a reversible soft form (e.g. delete rewritten to move-to-trash), so
     *  the runtime replaces the action and reports a synthetic success — letting
     *  the ORIGINAL action then run would error. false / absent = a deferred
     *  inverse applied at restore without touching the action (delete-created). */
    action_rewrite?: boolean;
  };
}

export interface ServerExperiences {
  server: string;
  generated: string;
  /** Tool names that were observed for this server (the basis of the scan). */
  observed_tools: string[];
  patterns: RecoveryPattern[];
  /** The server-level backup SKILL playbook: the generic backup procedure
   *  REFINED to this server's verified tool surface. Assembled at save time
   *  from the verified patterns' branch guidance (in-place reversal how-to
   *  where an affordance was verified to exist, capture recipe where not) —
   *  ONE prose block injected into the backup subagent prompt instead of
   *  per-pattern one-liners. Derived data: rebuilt on every save. */
  skill?: string;
  /** LEARNED read-only TOOL NAMES for THIS environment — tools the explorer
   *  picked (from the actual provided tool list) as read/inspect-only. The gate
   *  skips backup for these by tool NAME. This is the ONLY learned negative
   *  signal (keyword-level no-backup patterns were removed: a learned keyword
   *  that silently suppressed backups was the poisoning-prone direction, and
   *  tool names — unlike keywords — are validated against the live tool
   *  surface). SAFETY: the runtime still rejects any entry whose name carries
   *  a mutating/destructive verb — learned data may only EXTEND the read-only
   *  set. */
  readOnlyTools?: string[];
  /** The MCP SERVER(S) whose tools this experience covers — the key half of
   *  the {server → experience} dict. For a dedicated MCP it's just the server
   *  name ([server]); for a website driven through the browser it's the
   *  driving tool server, e.g. ["playwright"] for a forum explored via a URL.
   *  Built into the runtime dict by serverToExperienceMap(). */
  appliesTo?: string[];
}

/**
 * Auto-build the {mcp-server → experience-name} dict by scanning every
 * experience file's `appliesTo` (falling back to its own server name). This
 * is the dict the backup subagent uses to pick the right experience for an
 * action — e.g. { playwright: "reddit", postgres: "postgres" }. No hand
 * configuration: each experience declares what it covers, the map assembles.
 */
export function serverToExperienceMap(config: SandboxConfig): Record<string, string> {
  const dir = experiencesDir(config);
  const map: Record<string, string> = {};
  let files: string[];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); }
  catch { return map; }
  for (const f of files) {
    try {
      const exp = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as ServerExperiences;
      if (!exp.server) continue;
      const servers = (exp.appliesTo && exp.appliesTo.length) ? exp.appliesTo : [exp.server];
      for (const s of servers) if (s) map[String(s)] = exp.server;
    } catch { /* skip unreadable */ }
  }
  return map;
}

export function experiencesDir(config: SandboxConfig): string {
  return path.join(path.dirname(path.resolve(config.backupDir)), "experiences");
}

export function experiencePath(config: SandboxConfig, server: string): string {
  return path.join(experiencesDir(config), `${server}.json`);
}

/**
 * Extract the MCP server name from a tool name.
 *   mcp__playwright__browser_click → "playwright"
 *   mcp__notion__create_page       → "notion"
 *   browser_click (bare, OpenHands) → "playwright" (the common browser MCP)
 * Returns null for non-remote tools.
 */
export function serverFromToolName(toolName: string): string | null {
  if (!toolName) return null;
  const m = toolName.match(/^mcp__([^_]+(?:_[^_]+)*?)__/);
  if (m) return m[1];
  if (/^browser_/.test(toolName)) return "playwright";
  return null;
}

export function loadExperiences(config: SandboxConfig, server: string): ServerExperiences | null {
  try {
    const p = experiencePath(config, server);
    if (!fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, "utf-8")) as ServerExperiences;
    return Array.isArray(data.patterns) ? data : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the experience FILE name for a runtime server. A site explored via a
 * browser is filed under e.g. "reddit" with appliesTo:["playwright"], so the
 * tool's MCP server ("playwright") must be mapped to the file ("reddit"). Order:
 * explicit config override → appliesTo map → a file named after the server →
 * null (no profile; caller falls back to the verb-list heuristic).
 */
export function experienceNameForServer(config: SandboxConfig, server: string): string | null {
  const override = (config as { experienceForServer?: Record<string, string> }).experienceForServer?.[server];
  if (override) return override;
  const mapped = serverToExperienceMap(config)[server];
  if (mapped) return mapped;
  return fs.existsSync(experiencePath(config, server)) ? server : null;
}

/** The compiled matchers for ONE server's learned experience:
 *    readOnlyTools — Non-Backup-ToolList (skip by tool name; the only learned
 *                    negative signal — keyword-level suppression was removed)
 *    triggerRegex  — Backup-patterns (back up by keyword) */
export interface ServerMatchers {
  readOnlyTools: Set<string>;
  triggerRegex: RegExp | null;
}

// Per-server cache, keyed by `${dir}::${expName}` + that one file's mtime — a
// dir-only key would hand one server's compiled regex to another.
const _serverMatcherCache = new Map<string, { sig: string; m: ServerMatchers }>();

const _buildKeywordRegex = (vals: Iterable<string>): RegExp | null => {
  const pats = new Set<string>();
  for (const s of vals) {
    const k = String(s).trim().toLowerCase();
    if (k.length >= 3 && k.length <= 60) pats.add(k);
  }
  if (!pats.size) return null;
  const escaped = [...pats].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // Boundaries on BOTH sides: a trigger must match as a whole word. A leading-
  // only \b let `create` prefix-match the ubiquitous `created_at` (and
  // `delete` → `deleted_at`), so every read-only SELECT naming a timestamp
  // column on an explored server paid a spurious subagent spawn. SQL keywords
  // are exact words, and browser triggers come from element labels — nothing
  // legitimate relied on prefix matching.
  return new RegExp(`\\b(${escaped.join("|")})\\b`, "i");
};

/**
 * Compile the three matchers for a SINGLE server's experience file (cached).
 * This is the per-server replacement for the old global aggregates — an action
 * is judged ONLY against its own server's learned lists, never a union across
 * environments. Returns empty matchers when that server has no experience.
 */
export function serverMatchers(config: SandboxConfig, expName: string): ServerMatchers {
  const key = `${experiencesDir(config)}::${expName}`;
  const p = experiencePath(config, expName);
  let sig: string;
  try { sig = String(fs.statSync(p).mtimeMs); } catch { sig = "none"; }
  const cached = _serverMatcherCache.get(key);
  if (cached && cached.sig === sig) return cached.m;

  const empty: ServerMatchers = { readOnlyTools: new Set(), triggerRegex: null };
  const data = loadExperiences(config, expName);
  if (!data) { _serverMatcherCache.set(key, { sig, m: empty }); return empty; }

  const tools = new Set<string>();
  for (const t of data.readOnlyTools ?? []) {
    const lc = String(t).trim().toLowerCase();
    if (!lc) continue;
    tools.add(lc);
    const seg = lc.split("__").pop();
    if (seg && seg !== lc) tools.add(seg);
  }
  const m: ServerMatchers = {
    readOnlyTools: tools,
    triggerRegex: _buildKeywordRegex((data.patterns ?? []).map((x) => String(x.trigger ?? ""))),
  };
  _serverMatcherCache.set(key, { sig, m });
  return m;
}

/**
 * Find the learned RecoveryPattern that covers a specific action (used to
 * derive its minimal capture-tool allowlist). Loads that server's experience
 * file and returns the single best matching pattern, or null.
 *
 * Matching (most specific first):
 *   1. tool action-segment vs pattern.applies_to — if applies_to names a
 *      tool whose action segment equals the action's segment (e.g.
 *      `move_file`, `mcp_filesystem_create_directory` → `create_directory`).
 *   2. pattern.trigger keyword present in rawDesc (\b-boundary, like the
 *      gate's triggerRegex), preferring the LONGEST trigger so `create`
 *      doesn't shadow a more specific phrase.
 *
 * Reuses the same experience data serverMatchers loads (no extra parse cost
 * beyond loadExperiences). General — never special-cased per server name.
 */
export function matchPattern(
  config: SandboxConfig,
  expName: string,
  toolName: string,
  rawDesc: string,
): RecoveryPattern | null {
  const data = loadExperiences(config, expName);
  if (!data || !Array.isArray(data.patterns) || !data.patterns.length) return null;

  const lc = (toolName || "").toLowerCase();
  const seg = (lc.split("__").pop() || lc); // action segment, e.g. "move_file"
  const desc = (rawDesc || "").toLowerCase();

  // Pull the action verb out of a tool/applies_to identifier:
  //   mcp_filesystem_create_directory → create_directory
  //   move_file                        → move_file
  // We compare on the trailing 1-2 underscore segments so a server prefix
  // (mcp_filesystem_) doesn't block the match.
  const tailSegments = (id: string): string[] => {
    const s = id.toLowerCase().replace(/^mcp__?/, "").split("__").pop() || id.toLowerCase();
    const parts = s.split("_").filter(Boolean);
    const out: string[] = [];
    if (parts.length) out.push(parts.join("_"));
    if (parts.length >= 2) out.push(parts.slice(-2).join("_"));
    if (parts.length >= 1) out.push(parts.slice(-1).join("_"));
    return [...new Set(out)];
  };
  const actionForms = new Set(tailSegments(seg));

  // 1. applies_to tool-segment match (tool identity). Only a form claimed by
  //    EXACTLY ONE pattern may decide — tool identity is the strongest signal
  //    precisely when it is unambiguous (move_file → the move pattern). For a
  //    MIXED tool that many per-verb patterns share (all 7 postgres patterns
  //    declare applies_to "execute_sql"), the tool name says nothing about
  //    WHICH mutation this call performs; first-pattern-wins here handed every
  //    SQL action the insert pattern's capture_tools (so a DROP's subagent got
  //    a toolset its own playbook contradicted). Ambiguous forms are excluded
  //    and the verb decides via the trigger match below. Among unambiguous
  //    forms, the MOST SPECIFIC (longest) still wins so move_file binds to the
  //    move pattern, not whichever *_file pattern shares the generic trailing
  //    "file" (shared forms like that are ambiguous and excluded anyway).
  const formOwners = new Map<string, number>();
  for (const p of data.patterns) {
    if (!p.applies_to) continue;
    for (const form of tailSegments(p.applies_to)) {
      formOwners.set(form, (formOwners.get(form) ?? 0) + 1);
    }
  }
  let bestP: RecoveryPattern | null = null;
  let bestFormLen = 0;
  for (const p of data.patterns) {
    if (!p.applies_to) continue;
    for (const form of tailSegments(p.applies_to)) {
      if (formOwners.get(form) !== 1) continue;   // shared by several patterns → verb must decide
      if (actionForms.has(form) && form.length > bestFormLen) {
        bestP = p;
        bestFormLen = form.length;
      }
    }
  }
  if (bestP) return bestP;

  // 2. trigger keyword match against rawDesc, longest trigger wins.
  let best: RecoveryPattern | null = null;
  let bestLen = -1;
  for (const p of data.patterns) {
    const trig = String(p.trigger ?? "").trim().toLowerCase();
    if (trig.length < 3) continue;
    // Whole-word match, both boundaries — mirrors _buildKeywordRegex so the
    // gate and the pattern lookup can never disagree on what a trigger hits
    // (`create` must not prefix-match `created_at`).
    const re = new RegExp(`\\b${trig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(desc) && trig.length > bestLen) { best = p; bestLen = trig.length; }
  }
  return best;
}

export function saveExperiences(config: SandboxConfig, data: ServerExperiences): string {
  const dir = experiencesDir(config);
  fs.mkdirSync(dir, { recursive: true });
  const p = experiencePath(config, data.server);
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf-8");
  return p;
}

/**
 * Render a server's learned backup skill as a prompt fragment for the backup
 * subagent. Prefers the server-level `skill` PLAYBOOK (one coherent block —
 * the generic procedure refined to this server's verified tool surface);
 * falls back to legacy per-pattern lines for pre-playbook experience files.
 * Empty string when nothing verified exists.
 */
export function renderExperiencesForPrompt(exp: ServerExperiences | null): string {
  if (!exp) return "";
  // The playbook / action / skill strings are LLM-authored learned DATA —
  // render them inside an explicit data fence so the backup subagent treats
  // them as reference material, never as instructions to follow.
  const sanitize = (s: string, cap = 600) => String(s).replace(/```/g, "ʼʼʼ").slice(0, cap);
  // The server name is file-sourced data too — sanitize it (short cap) so a
  // crafted name cannot place text OUTSIDE the fenced "never obey" framing.
  const wrap = (body: string) => "\n" + render(EXPERIENCES_RENDER.body, {
    SERVER: sanitize(exp.server, 60).replace(/[\r\n"]/g, ""), BODY: body,
  }) + "\n";

  // PREFERRED: the server-level playbook (assembled from verified branches).
  if (exp.skill && exp.skill.trim()) return wrap(sanitize(exp.skill, 8000));

  // LEGACY fallback: per-pattern skill one-liners (pre-playbook files).
  if (!exp.patterns.length) return "";
  const usable = exp.patterns.filter((p) => p.verified === true);
  if (!usable.length) return "";
  const lines = usable.map((p, i) => {
    const how = p.skill
      ? sanitize(p.skill)
      : (p.reverter
        ? render(EXPERIENCES_RENDER.sections["legacy-reverter"], { INVERSE: sanitize(JSON.stringify(p.reverter.mcp_calls ?? p.reverter.commands ?? [])), PIN: sanitize(p.reverter.pin) })
        : EXPERIENCES_RENDER.sections["legacy-none"]);
    return render(EXPERIENCES_RENDER.sections["legacy-line"], { N: i + 1, ACTION: sanitize(p.action), HOW: how });
  });
  return wrap(lines.join("\n"));
}
