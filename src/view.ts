/**
 * Read views over the action store (summaries, details, diffs) and the side-panel renderer.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { BackupArtifact, IncompleteCapture, SandboxConfig } from "./types.js";
import { dirSize } from "./backup/strategies.js";
import { actionDirs, backupRoot, readActionArtifacts, storeRoot, readJson } from "./util.js";

// =============================================================================
// ── actions ──
// =============================================================================

/**
 * Read-side view of the action store, shared by the CLI (`list`, `show`, `watch`).
 * An action is one folder `backups/action_<seq>_<timestamp>/` whose metadata.json lists the
 * artifacts every tier produced for a single tool call.
 */

/** Tier that produces each artifact strategy. */
export const STRATEGY_TIER: Record<string, number> = {
  policy_rewrite: 1,
  command_pairing: 2,
  pip_freeze: 2,
  npm_list: 2,
  env_snapshot: 2,
  git_tag: 2,
  git_snapshot: 3,
  file_copy: 3,
  rule_copy: 3,
  subagent: 4,
  learned_rule: 4,
};

export function tierOf(strategy: string): number | null {
  return strategy in STRATEGY_TIER ? STRATEGY_TIER[strategy] : null;
}

export interface ActionSummary {
  /** Folder name, `action_<seq>_<YYYYMMDDhhmmss>`. */
  name: string;
  /** The number `restore`, `show` and `diff` accept. */
  seq: number;
  timestamp: string;
  timeFormatted: string;
  /** The user prompt in effect when the action ran, if recorded. */
  instruction: string;
  strategies: string[];
  tiers: number[];
  /** Workspace files in this action's tier-3 snapshot commit. */
  files: string[];
  stats: string;
  toolName: string;
  originalAction: string;
  sizeBytes: number;
  ageMs: number;
  /** Latency the hook added to the tool call (ms), from backup-timings.jsonl. */
  backupMs?: number;
  storage: Array<{ strategy: string; path: string; ref?: string; sizeBytes?: number }>;
  /** Set when part of the call's effect was not captured (incomplete.json). */
  incomplete?: IncompleteCapture;
  subagent?: {
    description: string;
    externalShadowFileCount: number;
    recoveryCommandCount: number;
    liveRestore: boolean;
  };
}

export interface ActionDetail extends ActionSummary {
  artifacts: BackupArtifact[];
  /** The tier-4 subagent's own result file, when one fired. */
  subagentResult?: Record<string, unknown>;
}

export { backupRoot };

/** Action folder names, oldest first, ordered by sequence number. */
export function actionNames(config: SandboxConfig): string[] {
  return actionDirs(config);
}

export function seqOf(name: string): number {
  return parseInt(name.split("_")[1] ?? "0", 10);
}

/**
 * Resolve an action reference: a sequence number, or `last` / `latest` / `--latest`.
 * Returns the folder name or null.
 */
export function resolveAction(config: SandboxConfig, ref: string | undefined): string | null {
  const names = actionNames(config);
  if (!ref) return null;
  if (["last", "latest", "--latest"].includes(ref)) return names[names.length - 1] ?? null;
  if (!/^\d+$/.test(ref)) return null;
  const n = parseInt(ref, 10);
  return names.find((d) => seqOf(d) === n) ?? null;
}

export function readArtifacts(config: SandboxConfig, name: string): BackupArtifact[] {
  return readActionArtifacts(path.join(backupRoot(config), name));
}

function loadTimings(config: SandboxConfig): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    const ledger = path.join(storeRoot(config), "backup-timings.jsonl");
    for (const line of fs.readFileSync(ledger, "utf-8").split("\n")) {
      try {
        const e = JSON.parse(line);
        if (e.action && typeof e.addedLatencyMs === "number") out[e.action] = e.addedLatencyMs;
      } catch { /* skip */ }
    }
  } catch { /* no ledger yet */ }
  return out;
}

function git(shadowDir: string, workTree: string, args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf-8",
    timeout: 10_000,
    cwd: workTree,
    env: { ...process.env, GIT_DIR: shadowDir, GIT_WORK_TREE: workTree },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Files and shortstat of a snapshot commit; the first commit lists its tree. */
function snapshotFiles(shadowDir: string, commit: string, workTree: string): { files: string[]; stats: string } {
  try {
    const files = git(shadowDir, workTree, ["show", "--name-only", "--format=", commit]).split("\n").filter(Boolean);
    let stats = "";
    try { stats = git(shadowDir, workTree, ["diff", "--shortstat", `${commit}~1`, commit]); } catch { /* root commit */ }
    if (files.length) return { files, stats };
  } catch { /* fall through */ }
  try {
    const files = git(shadowDir, workTree, ["ls-tree", "-r", "--name-only", commit]).split("\n").filter(Boolean);
    return { files, stats: `baseline snapshot (${files.length} files)` };
  } catch {
    return { files: [], stats: "" };
  }
}

function parseStamp(ts: string): number | null {
  if (ts.length < 14) return null;
  const n = (a: number, b: number) => parseInt(ts.slice(a, b), 10);
  const ms = new Date(n(0, 4), n(4, 6) - 1, n(6, 8), n(8, 10), n(10, 12), n(12, 14)).getTime();
  return Number.isNaN(ms) ? null : ms;
}

export function summarizeAction(
  config: SandboxConfig,
  name: string,
  workTree: string,
  timings?: Record<string, number>,
): ActionSummary {
  const dir = path.join(backupRoot(config), name);
  const artifacts = readArtifacts(config, name);
  const tsRaw = name.split("_").slice(2).join("_");
  const stamp = parseStamp(tsRaw);
  let instruction = "";
  try { instruction = fs.readFileSync(path.join(dir, "instruction.txt"), "utf-8").trim(); } catch { /* none */ }

  const strategies = artifacts.map((a) => String(a.strategy ?? "")).filter(Boolean);
  const tiers = [...new Set(strategies.map(tierOf).filter((t): t is number => t !== null))].sort();
  const first = artifacts[0];

  let files: string[] = [];
  let stats = "";
  const snap = artifacts.find((a) => a.strategy === "git_snapshot");
  if (snap) {
    const commit = String(snap.commitHash ?? snap.id ?? "");
    if (commit && fs.existsSync(snap.artifactPath)) ({ files, stats } = snapshotFiles(snap.artifactPath, commit, workTree));
  }

  let subagent: ActionSummary["subagent"];
  const sub = artifacts.find((a) => a.strategy === "subagent");
  if (sub) {
    let captured = 0;
    try {
      captured = fs.readdirSync(dir).filter((f) =>
        !["metadata.json", "instruction.txt", "incomplete.json"].includes(f) && !/^subagent_.*\.json$/.test(f) &&
        !/^(?:snapshot|external-shadow)-meta-.*\.json$/.test(f) && f !== "trash").length;
    } catch { /* unreadable */ }
    subagent = {
      description: String(sub.description ?? "").replace(/^Subagent backup:\s*/, ""),
      externalShadowFileCount: captured,
      recoveryCommandCount: Array.isArray(sub.subagentCommands) ? sub.subagentCommands.length : 0,
      liveRestore: Boolean(sub.liveRestore),
    };
  }

  const incomplete = readJson<IncompleteCapture | undefined>(path.join(dir, "incomplete.json"), undefined);

  const storage = artifacts
    .filter((a) => a.strategy)
    .map((a) => ({
      strategy: a.strategy,
      path: a.strategy === "git_tag" ? "" : String(a.artifactPath ?? ""),
      ref: typeof a.commitHash === "string" ? a.commitHash : undefined,
      sizeBytes: typeof a.sizeBytes === "number" ? a.sizeBytes : undefined,
    }));

  return {
    name,
    seq: seqOf(name),
    timestamp: typeof first?.timestamp === "string" ? first.timestamp : (stamp ? new Date(stamp).toISOString() : ""),
    timeFormatted: tsRaw.length >= 14
      ? `${tsRaw.slice(0, 4)}-${tsRaw.slice(4, 6)}-${tsRaw.slice(6, 8)} ${tsRaw.slice(8, 10)}:${tsRaw.slice(10, 12)}:${tsRaw.slice(12, 14)}`
      : tsRaw,
    instruction,
    strategies,
    tiers,
    files,
    stats,
    toolName: String(first?.toolName ?? ""),
    originalAction: String(artifacts.find((a) => a.originalAction)?.originalAction ?? ""),
    sizeBytes: dirSize(dir),
    ageMs: stamp ? Math.max(0, Date.now() - stamp) : 0,
    backupMs: timings?.[name],
    storage,
    subagent,
    ...(incomplete ? { incomplete } : {}),
  };
}

export function listActionSummaries(config: SandboxConfig, workTree: string): ActionSummary[] {
  const timings = loadTimings(config);
  return actionNames(config).map((n) => summarizeAction(config, n, workTree, timings));
}

export function actionDetail(config: SandboxConfig, name: string, workTree: string): ActionDetail {
  const summary = summarizeAction(config, name, workTree, loadTimings(config));
  const dir = path.join(backupRoot(config), name);
  let subagentResult: Record<string, unknown> | undefined;
  try {
    const f = fs.readdirSync(dir).find((x) => /^subagent_.*\.json$/.test(x) && !x.endsWith(".run.json"));
    if (f) subagentResult = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
  } catch { /* none */ }
  return { ...summary, artifacts: readArtifacts(config, name), subagentResult };
}

/**
 * Workspace changes since an action's tier-3 snapshot. The work tree is staged into a throwaway
 * index, so a diff never takes the shadow repo's index lock a concurrent backup may need.
 * Returns null when the action has no snapshot. Throws when git fails.
 */
export function snapshotDiff(
  config: SandboxConfig,
  name: string,
  workTree: string,
): { commit: string; stat: string; diff: string } | null {
  const snap = readArtifacts(config, name).find((a) => a.strategy === "git_snapshot");
  const commit = String(snap?.commitHash ?? snap?.id ?? "");
  if (!snap || !commit || !fs.existsSync(snap.artifactPath)) return null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "backupper-diff-"));
  const opts = {
    encoding: "utf-8" as const, timeout: 30_000, cwd: workTree, stdio: "pipe" as const,
    env: { ...process.env, GIT_DIR: snap.artifactPath, GIT_WORK_TREE: workTree, GIT_INDEX_FILE: path.join(tmp, "index") },
  };
  try {
    execFileSync("git", ["read-tree", commit], opts);
    execFileSync("git", ["add", "-A"], opts);
    const stat = execFileSync("git", ["diff", "--cached", "--stat", commit], opts).trim();
    const diff = execFileSync("git", ["diff", "--cached", "--no-color", commit], opts).trim();
    return { commit, stat, diff };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// =============================================================================
// ── watch ──
// =============================================================================

/**
 * Pure renderer for `backupper watch`: a store snapshot plus UI state in, terminal lines out.
 * No I/O here, so the layout is unit-tested without a terminal.
 */

/** Tier names, as in the paper. */
export const TIER_NAME: Record<number, string> = {
  1: "command rewriting",
  2: "command pairing",
  3: "snapshot",
  4: "backup subagent",
};

const TIER_COLOR: Record<number, number> = { 1: 32, 2: 36, 3: 33, 4: 35 };

export interface WatchState {
  project: string;
  /** `checker`, `off`, or `disabled` when the master switch is off. */
  mode: string;
  /** Personalization mode; empty means Full (capture everything). */
  personalization: string;
  storeBytes: number;
  /** Oldest first, so the newest action renders at the bottom. */
  actions: ActionSummary[];
  /** Index into `actions`. */
  selected: number;
  /** Detail block under the list. */
  expanded: boolean;
  /** Detail of the selected action, when loaded. */
  detail?: ActionDetail;
  /** Diff view lines replace the list while set. */
  diff?: string[];
  diffScroll: number;
  /** Pending y/n question. */
  confirm?: string;
  /** Result lines shown above the footer (restore outcome, errors). */
  message?: string[];
  busy?: boolean;
}

export function emptyState(): WatchState {
  return { project: "", mode: "", personalization: "", storeBytes: 0, actions: [], selected: 0, expanded: true, diffScroll: 0 };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Collapse whitespace and cut to `max` characters with an ellipsis. */
export function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  if (max <= 0) return "";
  return one.length > max ? (max === 1 ? "…" : one.slice(0, max - 1) + "…") : one;
}

/**
 * The headline tier of an action: the capture most specific to this call. The Tier 3
 * snapshot runs alongside the others as a workspace fallback, so it headlines only when
 * nothing else captured; among the rest, Tier 4 > Tier 1 > Tier 2.
 */
const HEADLINE_RANK: Record<number, number> = { 4: 4, 1: 3, 2: 2, 3: 1 };
export function headlineTier(a: ActionSummary): { tier: number; strategy: string } | null {
  let best: { tier: number; strategy: string } | null = null;
  for (const s of a.strategies) {
    const t = tierOf(s);
    if (t !== null && (!best || (HEADLINE_RANK[t] ?? 0) > (HEADLINE_RANK[best.tier] ?? 0))) best = { tier: t, strategy: s };
  }
  return best;
}

/** Short description of what one strategy stored for this action. */
export function artifactLabel(a: ActionSummary, strategy: string): string {
  const stored = a.storage.find((s) => s.strategy === strategy);
  switch (strategy) {
    case "policy_rewrite": return stored?.path ? path.basename(stored.path) : "reversible form";
    case "command_pairing": return "saved state";
    case "rule_copy": return "copies";
    case "pip_freeze": return "pip freeze";
    case "npm_list": return "npm list";
    case "env_snapshot": return "env dump";
    case "git_tag": return "git ref";
    case "git_snapshot": return a.files.length ? `${a.files.length} file${a.files.length === 1 ? "" : "s"}` : "workspace";
    case "file_copy": return stored?.path ? path.basename(stored.path) : "file copy";
    case "subagent": return a.subagent
      ? `${a.subagent.externalShadowFileCount} captured, ${a.subagent.recoveryCommandCount} undo cmd${a.subagent.recoveryCommandCount === 1 ? "" : "s"}`
      : "capture";
    case "learned_rule": return "learned rule";
    default: return strategy;
  }
}

interface Painter {
  c(code: number | string, s: string): string;
}

function painter(color: boolean): Painter {
  return { c: (code, s) => (color && s ? `\x1b[${code}m${s}\x1b[0m` : s) };
}

/** One action row: `#N <tool call> → Tier K <name> <artifact>`, fitted to `width`. */
export function actionRow(a: ActionSummary, width: number, selected: boolean, color = true): string {
  const p = painter(color);
  const mark = selected ? "›" : " ";
  const num = `#${a.seq}`;
  const head = headlineTier(a);
  const tierText = head ? `Tier ${head.tier} ${TIER_NAME[head.tier]}` : "no capture";
  const artifact = head ? ` ${artifactLabel(a, head.strategy)}` : "";
  const right = ` → ${tierText}${artifact}`;
  const call = a.originalAction || a.toolName || "(unknown call)";
  const room = width - mark.length - 1 - num.length - 1 - right.length;
  let callText = clip(call, Math.max(room, 8));
  let rightText = right;
  // Narrow terminals: shorten the right side before the call disappears.
  if (room < 8) rightText = clip(right, Math.max(width - mark.length - num.length - callText.length - 2, 0));
  const plainLen = mark.length + 1 + num.length + 1 + callText.length + rightText.length;
  if (plainLen > width) callText = clip(callText, callText.length - (plainLen - width));
  const tierPainted = head
    ? rightText.replace(tierText, p.c(TIER_COLOR[head.tier], tierText))
    : p.c(2, rightText);
  const body = `${mark} ${p.c(1, num)} ${callText}${tierPainted}`;
  return selected ? p.c(7, body.replace(/\x1b\[0m/g, "\x1b[0m\x1b[7m")) : body;
}

/** The MATCHED / RUNS / RESTORE block for one action. */
export function detailLines(a: ActionSummary | ActionDetail, later: number, width: number, color = true): string[] {
  const p = painter(color);
  const label = (s: string) => p.c(1, s.padEnd(8));
  const w = Math.max(width - 9, 10);
  const out: string[] = [];
  out.push(`${label("ACTION")} #${a.seq}  ${a.timeFormatted}${a.backupMs !== undefined ? `  (+${a.backupMs} ms)` : ""}`);
  if (a.instruction) out.push(`${label("ASKED")} ${clip(`"${a.instruction}"`, w)}`);
  out.push(`${label("RUNS")} ${clip(a.originalAction || a.toolName, w)}`);
  const artifacts = "artifacts" in a ? a.artifacts : undefined;
  if (artifacts?.length) {
    artifacts.forEach((art, i) => {
      const t = tierOf(art.strategy);
      const tierText = t ? `Tier ${t} ${TIER_NAME[t]}` : art.strategy;
      const desc = clip(art.description ?? "", Math.max(w - tierText.length - 3, 10));
      out.push(`${i === 0 ? label("MATCHED") : " ".repeat(8)} ${t ? p.c(TIER_COLOR[t], tierText) : tierText} · ${desc}`);
    });
  } else if (a.strategies.length) {
    out.push(`${label("MATCHED")} ${a.strategies.map((s) => {
      const t = tierOf(s);
      return t ? p.c(TIER_COLOR[t], `Tier ${t} ${TIER_NAME[t]}`) : s;
    }).join(", ")}`);
  } else {
    out.push(`${label("MATCHED")} nothing captured`);
  }
  if (a.files.length) out.push(`${" ".repeat(8)} snapshot: ${clip(a.files.join(", "), w - 10)}`);
  const undo = (artifacts ?? []).flatMap((x) => [...(x.recoveryCommands ?? []), ...(x.strategy === "subagent" ? x.subagentCommands ?? [] : [])]);
  for (const c of undo.slice(0, 3)) out.push(`${" ".repeat(8)} undo: ${clip(c, w - 6)}`);
  if (undo.length > 3) out.push(`${" ".repeat(8)} (+${undo.length - 3} more undo commands)`);
  const scope = later ? `#${a.seq} and the ${later} later action${later === 1 ? "" : "s"}` : `#${a.seq}`;
  out.push(`${label("RESTORE")} press r to undo ${scope}, or run: backupper restore ${a.seq}`);
  if (a.files.length) out.push(`${" ".repeat(8)} one file: backupper restore ${a.seq} --file <path>`);
  return out;
}

function headerLine(s: WatchState, width: number, p: Painter): string {
  const scope = s.personalization ? `personalized (${s.personalization})` : "Full";
  const left = ` BackUpper · ${path.basename(s.project) || s.project}`;
  const right = `mode ${s.mode} · ${scope} · ${formatBytes(s.storeBytes)} `;
  const gap = width - left.length - right.length;
  const text = gap >= 1 ? left + " ".repeat(gap) + right : clip(left + "  " + right, width);
  return p.c("1;7", text.padEnd(width));
}

function footerLine(s: WatchState, width: number, p: Painter): string {
  const hint = s.confirm
    ? `${s.confirm}  y = yes · n = no`
    : s.busy
      ? "working…  q quit"
      : s.diff
        ? "↑/↓ scroll · d back · q quit"
        : "↑/↓ j/k select · r restore · d diff · ⏎ details · q quit";
  return p.c(s.confirm ? "1;33" : 2, clip(hint, width));
}

function diffLine(l: string, width: number, p: Painter): string {
  const t = clip(l.replace(/\t/g, "  "), width);
  if (l.startsWith("+") && !l.startsWith("+++")) return p.c(32, t);
  if (l.startsWith("-") && !l.startsWith("---")) return p.c(31, t);
  if (l.startsWith("@@")) return p.c(36, t);
  if (l.startsWith("diff ")) return p.c(1, t);
  return t;
}

/**
 * Render the whole screen. With `height` the output is exactly `height` lines (the list is
 * windowed around the selection); without it every action is printed (non-TTY snapshot).
 */
export function renderWatch(s: WatchState, width: number, height?: number, color = true): string[] {
  const p = painter(color);
  const rule = p.c(2, "─".repeat(Math.max(width, 1)));
  const top = [headerLine(s, width, p)];
  const bottom: string[] = [];
  if (s.message?.length) for (const m of s.message) bottom.push(clip(m, width));
  bottom.push(footerLine(s, width, p));

  let body: string[];
  if (s.diff) {
    const room = height === undefined ? s.diff.length : Math.max(height - top.length - bottom.length, 0);
    const start = Math.min(s.diffScroll, Math.max(s.diff.length - room, 0));
    body = s.diff.slice(start, start + room).map((l) => diffLine(l, width, p));
  } else {
    const detail = s.expanded && s.actions.length
      ? [rule, ...detailLines(s.detail?.name === s.actions[s.selected]?.name ? s.detail! : s.actions[s.selected], s.actions.length - 1 - s.selected, width, color)]
      : [];
    const room = height === undefined ? Infinity : Math.max(height - top.length - bottom.length - detail.length, 1);
    let rows: string[];
    if (!s.actions.length) {
      rows = [p.c(2, clip(" No actions recorded yet. Captures appear here as the agent works.", width))];
    } else {
      // Window the list so the selection stays visible; the newest action sits at the bottom.
      const n = s.actions.length;
      let first = 0;
      let last = n;
      if (room !== Infinity && n > room) {
        // One row each for the "older" / "newer" markers, when shown.
        let fit = Math.max(room - 1, 1);
        first = Math.max(0, Math.min(n - fit, s.selected));
        if (first > 0 && first + fit < n) fit = Math.max(room - 2, 1);
        last = Math.min(n, first + fit);
      }
      rows = s.actions.slice(first, last).map((a, i) => actionRow(a, width, first + i === s.selected, color));
      if (first > 0) rows.unshift(p.c(2, clip(` ↑ ${first} older`, width)));
      if (last < n) rows.push(p.c(2, clip(` ↓ ${n - last} newer`, width)));
    }
    body = [...rows, ...detail];
    if (height !== undefined) {
      const pad = height - top.length - bottom.length - body.length;
      // Push the list down so the newest row sits just above the detail block, like a log.
      if (pad > 0) body = [...new Array(pad).fill(""), ...body];
    }
  }
  const lines = [...top, ...body, ...bottom];
  return height === undefined ? lines : lines.slice(0, height);
}
