/**
 * Read-side view of the action store, shared by the CLI (`list`, `show`, `watch`).
 * An action is one folder `backups/action_<seq>_<timestamp>/` whose metadata.json lists the
 * artifacts every tier produced for a single tool call.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { BackupArtifact, IncompleteCapture, SandboxConfig } from "../types.js";
import { dirSize } from "../backup/strategies.js";

/** Tier that produces each artifact strategy. */
export const STRATEGY_TIER: Record<string, number> = {
  policy_rewrite: 1,
  pip_freeze: 2,
  npm_list: 2,
  env_snapshot: 2,
  git_tag: 2,
  git_snapshot: 3,
  file_copy: 3,
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

export function backupRoot(config: SandboxConfig): string {
  return path.resolve(config.backupDir);
}

/** Action folder names, oldest first, ordered by sequence number. */
export function actionNames(config: SandboxConfig): string[] {
  const root = backupRoot(config);
  if (!fs.existsSync(root)) return [];
  const seqOf = (d: string): number => parseInt(d.split("_")[1] ?? "", 10) || 0;
  return fs.readdirSync(root)
    .filter((d) => /^action_\d+_/.test(d))
    .sort((a, b) => seqOf(a) - seqOf(b) || a.localeCompare(b));
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
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(backupRoot(config), name, "metadata.json"), "utf-8"));
    if (Array.isArray(parsed)) return parsed as BackupArtifact[];
    return parsed && typeof parsed === "object" ? [parsed as BackupArtifact] : [];
  } catch {
    return [];
  }
}

function loadTimings(config: SandboxConfig): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    const ledger = path.join(path.dirname(backupRoot(config)), "backup-timings.jsonl");
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

  let incomplete: IncompleteCapture | undefined;
  try { incomplete = JSON.parse(fs.readFileSync(path.join(dir, "incomplete.json"), "utf-8")); } catch { /* complete */ }

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
