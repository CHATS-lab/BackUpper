/**
 * Backup strategies, cheapest first:
 *   tier 2: command pairing (pip freeze, npm list, env snapshot, git tag);
 *   tier 3: commit of the workspace to a shared shadow git repo;
 *   tier 4: a backup subagent, for effects outside the workspace.
 * Artifacts live under .backupper/backups/action_NNN_<timestamp>/.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync, execSync, spawnSync } from "node:child_process";
import type { BackupArtifact, HookContext, SandboxConfig } from "../types.js";
import { describeToolAction, isReadOnlyCheckerEnabled } from "../types.js";
import {
  runSubagentBackup, findCapturedArtifacts, reportUnregisteredCapture, preserveTranscripts,
} from "./subagent.js";
import {
  findDeclaration, parseDeclaration, stripDeclaration, type BackupDeclaration,
} from "./declaration.js";
import {
  loadLearnedStore,
  matchLearnedReadOnly,
  recordLearnedHit,
} from "./learned_readonly.js";
import {
  serverFromToolName,
  experienceNameForServer,
  matchPattern,
  loadExperiences,
  experiencesDir,
} from "../explore/experiences.js";
import { isDangerousRecoveryCommand } from "../restore/restore.js";
import { tryLearnedBackup } from "../self-improving/learned_backup.js";
import { flushDeferredGeneralizations, generalizeAfterNativeRule, reflectAfterBackup } from "../self-improving/reflection.js";
import { recordExternalShadowMeta, recordTreeMeta, shortHash, writeTreeMeta, type TreeMeta } from "./fsmeta.js";
import { planCommand, wordsAndRedirects, type CmdSegment } from "./compound.js";
import type { IncompleteCapture } from "../types.js";

/** Expand a leading `~` or `~/` to the home directory. */
function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

// ── Action folder management (LAZY) ─────────────────────────────

// Name of the next action folder, and the folder itself once an artifact exists (created lazily).
let _pendingActionName: string | null = null;
let _currentActionDir: string | null = null;
let _currentActionId: string | null = null;

/** Reserve the next action name without creating its folder. */
function preparePendingAction(config: SandboxConfig): string {
  if (_pendingActionName) return _pendingActionName;

  const backupRoot = path.resolve(config.backupDir);
  const existing = listActionDirs(backupRoot);
  // Next sequence number is max existing + 1, so pruned numbers are never reused.
  let maxSeq = 0;
  for (const d of existing) {
    const n = parseInt(d.split("_")[1] ?? "0", 10);
    if (!isNaN(n) && n > maxSeq) maxSeq = n;
  }
  const seq = String(maxSeq + 1).padStart(3, "0");
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  _pendingActionName = `action_${seq}_${ts}`;
  return _pendingActionName;
}

/** Create the pending action folder on disk (idempotent). */
function materializeActionDir(config: SandboxConfig): string {
  if (_currentActionDir && fs.existsSync(_currentActionDir)) {
    return _currentActionDir;
  }

  const backupRoot = path.resolve(config.backupDir);
  if (!fs.existsSync(backupRoot)) {
    fs.mkdirSync(backupRoot, { recursive: true });
  }

  const dirName = _pendingActionName ?? preparePendingAction(config);
  const dirPath = path.join(backupRoot, dirName);
  fs.mkdirSync(dirPath, { recursive: true });

  _currentActionDir = dirPath;
  _currentActionId = dirName;

  // Copy the current user instruction, written by the UserPromptSubmit hook, into the action folder.
  try {
    const sandboxDir = path.dirname(backupRoot);
    const currentInstructionPath = path.join(sandboxDir, "current-instruction.txt");
    if (fs.existsSync(currentInstructionPath)) {
      const text = fs.readFileSync(currentInstructionPath, "utf-8");
      fs.writeFileSync(path.join(dirPath, "instruction.txt"), text, "utf-8");
    }
  } catch {
    // best-effort
  }

  pruneActions(backupRoot, config);

  return dirPath;
}

export function resetAction(): void {
  _pendingActionName = null;
  _currentActionDir = null;
  _currentActionId = null;
}

export function getCurrentActionId(): string | null {
  return _currentActionId;
}

function listActionDirs(backupRoot: string): string[] {
  if (!fs.existsSync(backupRoot)) return [];
  // Sort numerically by sequence number, tie-breaking on the timestamp suffix.
  const seqOf = (d: string): number => {
    const n = parseInt(d.split("_")[1] ?? "", 10);
    return Number.isNaN(n) ? -1 : n;
  };
  return fs
    .readdirSync(backupRoot)
    .filter((d: string) => d.startsWith("action_"))
    .sort((a, b) => seqOf(a) - seqOf(b) || a.localeCompare(b));
}

/**
 * Prune action folders by age (maxAgeHours), count (maxActions) and total size
 * (maxTotalSizeMB), oldest first; a knob set to 0 is disabled.
 */
function pruneActions(backupRoot: string, config: SandboxConfig): void {
  let dirs = listActionDirs(backupRoot);

  // 1. Age-based pruning
  if (config.maxAgeHours > 0) {
    const cutoffMs = Date.now() - config.maxAgeHours * 3600 * 1000;
    const kept: string[] = [];
    for (const d of dirs) {
      const ts = parseActionTimestamp(d);
      if (ts !== null && ts < cutoffMs) {
        removeDir(path.join(backupRoot, d));
      } else {
        kept.push(d);
      }
    }
    dirs = kept;
  }

  // 2. Count-based pruning
  if (config.maxActions > 0) {
    while (dirs.length > config.maxActions) {
      const oldest = dirs.shift()!;
      removeDir(path.join(backupRoot, oldest));
    }
  }

  // 3. Size-based pruning, applied to the survivors
  if (config.maxTotalSizeMB > 0) {
    const capBytes = config.maxTotalSizeMB * 1024 * 1024;
    const sizes = dirs.map((d) => ({ name: d, size: dirSize(path.join(backupRoot, d)) }));
    let total = sizes.reduce((sum, s) => sum + s.size, 0);
    while (total > capBytes && sizes.length > 0) {
      const oldest = sizes.shift()!;
      removeDir(path.join(backupRoot, oldest.name));
      total -= oldest.size;
    }
  }
}

function removeDir(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/** Parse the YYYYMMDDHHMMSS timestamp out of an `action_NNN_<ts>` folder name. */
function parseActionTimestamp(dirName: string): number | null {
  const parts = dirName.split("_");
  const ts = parts.slice(2).join("_");
  if (ts.length < 14) return null;
  // Parse as UTC; only relative ages are compared.
  const y = parseInt(ts.slice(0, 4), 10);
  const mo = parseInt(ts.slice(4, 6), 10) - 1;
  const d = parseInt(ts.slice(6, 8), 10);
  const h = parseInt(ts.slice(8, 10), 10);
  const mi = parseInt(ts.slice(10, 12), 10);
  const s = parseInt(ts.slice(12, 14), 10);
  if ([y, mo, d, h, mi, s].some(Number.isNaN)) return null;
  return new Date(y, mo, d, h, mi, s).getTime();
}

/** Recursively sum file sizes under a directory. */
export function dirSize(p: string): number {
  let total = 0;
  const walk = (q: string): void => {
    try {
      const entries = fs.readdirSync(q, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(q, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile()) {
          try {
            total += fs.statSync(full).size;
          } catch { /* vanished between listing and stat */ }
        }
      }
    } catch {
      // best-effort
    }
  };
  walk(p);
  return total;
}

// ── Shared shadow git repo ───────────────────────────────────────────

/** Return the single shadow git repo shared by all snapshots of this project, creating it if needed. */
function getSharedShadowRepo(config: SandboxConfig): string {
  const backupRoot = path.resolve(config.backupDir);
  return path.join(path.dirname(backupRoot), "shadow-repo");
}

/**
 * Files `backupper install` writes into the project. They are BackUpper's own, not the
 * agent's work: a snapshot must not list them, and a restore must not roll them back.
 * (.hermes/ is excluded wholesale below.)
 */
const INSTALLED_FILE_EXCLUDES = [
  "/.claude/settings.local.json",
  "/.claude/commands/backupper-*.md",
  "/.codex/hooks.json",
  "/.hermes/plugins/backupper/",
];

/** Add any missing install excludes to a shadow repo created by an older version. */
function ensureInstallExcludes(shadowDir: string): void {
  try {
    const file = path.join(shadowDir, "info", "exclude");
    const cur = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
    const lines = new Set(cur.split("\n").map((l) => l.trim()));
    const missing = INSTALLED_FILE_EXCLUDES.filter((p) => !lines.has(p));
    if (missing.length === 0) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, (cur && !cur.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n");
  } catch { /* best-effort */ }
}

function ensureSharedShadowRepo(config: SandboxConfig): string {
  const shadowDir = getSharedShadowRepo(config);
  if (fs.existsSync(path.join(shadowDir, "HEAD"))) {
    ensureInstallExcludes(shadowDir);
    return shadowDir;
  }

  fs.mkdirSync(shadowDir, { recursive: true });
  const cwd = process.cwd();
  const env = { ...process.env, GIT_DIR: shadowDir, GIT_WORK_TREE: cwd };
  const execOpts = { encoding: "utf-8" as const, timeout: 30_000, env, cwd };

  try {
    execSync("git init", { ...execOpts, stdio: "pipe" });
    execSync('git config user.email "backupper@local"', { ...execOpts, stdio: "pipe" });
    execSync('git config user.name "BackUpper"', { ...execOpts, stdio: "pipe" });

    const infoDir = path.join(shadowDir, "info");
    fs.mkdirSync(infoDir, { recursive: true });
    fs.writeFileSync(
      path.join(infoDir, "exclude"),
      [
        // .env files are deliberately not excluded: the shadow snapshot is their only pre-state capture.
        "node_modules/", ".git/", "dist/", "build/", "__pycache__/",
        "*.pyc", ".venv/", "venv/", ".cache/",
        ".backupper/",
        // Agent and harness infrastructure directories.
        ".hermes/", ".baseline/", ".native/", ".cpall/",
        // Transient browser-tool scratch files, which would otherwise be snapshotted on every browser call.
        ".playwright-mcp/", "page-*.yml", "console-*.log", "traces/",
        ".DS_Store", "Thumbs.db",  // macOS/Windows filesystem noise
        // BackUpper's own hook registration and slash commands.
        ...INSTALLED_FILE_EXCLUDES,
      ].join("\n") + "\n",
      "utf-8"
    );
  } catch {
    // best-effort init
  }

  return shadowDir;
}

// ── Shell helper ─────────────────────────────────────────────────────

function exec(cmd: string, cwd?: string): string | null {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      timeout: 15_000,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function makeId(): string {
  return Math.random().toString(36).slice(2, 8);
}

// =====================================================================
// Tier 2: command pairing (cheapest — saves recipes, not files)
// =====================================================================

function pipFreezeBackup(
  actionDir: string,
  ctx: HookContext
): BackupArtifact | null {
  const id = makeId();
  const dest = path.join(actionDir, `pip_freeze_${id}.txt`);

  // Try several pip invocations; write an empty manifest if none is available.
  const candidates = [
    "pip freeze",
    "pip3 freeze",
    "python3 -m pip freeze",
    "python -m pip freeze",
  ];
  let freeze = "";
  let source = "";
  for (const cmd of candidates) {
    const out = exec(`${cmd} 2>/dev/null`);
    if (out !== null) {
      freeze = out;
      source = cmd;
      break;
    }
  }

  // An empty manifest still marks the action as handled by tier 2, so tier 4 is not spawned.
  fs.writeFileSync(dest, freeze + "\n", "utf-8");
  return {
    id,
    timestamp: new Date().toISOString(),
    trigger: "rule",
    toolName: ctx.tool_name,
    description: source
      ? `Saved pip freeze snapshot (${source})`
      : "Saved empty pip freeze (no pip on PATH)",
    strategy: "pip_freeze",
    artifactPath: dest,
    sizeBytes: Buffer.byteLength(freeze),
  };
}

function npmListBackup(
  actionDir: string,
  ctx: HookContext
): BackupArtifact | null {
  const id = makeId();
  const dest = path.join(actionDir, `npm_list_${id}.json`);

  const list = exec("npm list --json --depth=0 2>/dev/null");
  if (!list) return null;

  fs.writeFileSync(dest, list + "\n", "utf-8");
  return {
    id,
    timestamp: new Date().toISOString(),
    trigger: "rule",
    toolName: ctx.tool_name,
    description: "Saved npm package list snapshot",
    strategy: "npm_list",
    artifactPath: dest,
    sizeBytes: Buffer.byteLength(list),
  };
}

function envSnapshotBackup(
  actionDir: string,
  ctx: HookContext
): BackupArtifact | null {
  const id = makeId();
  const dest = path.join(actionDir, `env_snapshot_${id}.txt`);

  const env = exec("env | sort");
  if (!env) return null;

  fs.writeFileSync(dest, env + "\n", "utf-8");
  return {
    id,
    timestamp: new Date().toISOString(),
    trigger: "rule",
    toolName: ctx.tool_name,
    description: "Saved environment variable snapshot",
    strategy: "env_snapshot",
    artifactPath: dest,
    sizeBytes: Buffer.byteLength(env),
  };
}

function gitTagBackup(
  ctx: HookContext,
  actionDir: string
): BackupArtifact | null {
  const head = exec("git rev-parse HEAD");
  if (!head) return null;

  const id = makeId();
  const tagName = `backupper/pre-${ctx.tool_name.toLowerCase()}-${id}`;

  const result = exec(`git tag ${tagName}`);
  if (result === null) return null;

  fs.writeFileSync(
    path.join(actionDir, `git_tag_${id}.txt`),
    `tag: ${tagName}\ncommit: ${head}\n`,
    "utf-8"
  );

  return {
    id,
    timestamp: new Date().toISOString(),
    trigger: "rule",
    toolName: ctx.tool_name,
    description: `Created git tag ${tagName} at ${head.slice(0, 8)}`,
    strategy: "git_tag",
    artifactPath: tagName,
  };
}

/** Run the command-pairing backup matching the command; returns null if none matches. */
function tryTargetedManifest(
  ctx: HookContext,
  actionDir: string
): BackupArtifact | null {
  const command = String(ctx.tool_input.command ?? "");

  // pip install/uninstall → save package list
  if (/pip3?\s+(install|uninstall)/i.test(command)) {
    return pipFreezeBackup(actionDir, ctx);
  }

  // npm install/uninstall → save package list
  if (/npm\s+(install|uninstall|remove)/i.test(command)) {
    return npmListBackup(actionDir, ctx);
  }

  // env/export changes → save env vars
  if (/\b(export|unset|source\s+\.env)/i.test(command)) {
    return envSnapshotBackup(actionDir, ctx);
  }

  // git push/rebase/reset → create a tag (pointer to current HEAD)
  if (/git\s+(push|rebase|reset|commit\s+--amend)/i.test(command)) {
    return gitTagBackup(ctx, actionDir);
  }

  return null;
}

// =====================================================================
// Tier 3: snapshot in the shared shadow repo
// =====================================================================

/**
 * Modes, owners, empty directories and the project's stash list as they stand when a snapshot
 * is taken; git keeps none of them. Set by gitSnapshotBackup, written next to the artifact.
 */
let _lastSnapshotMeta: TreeMeta | null = null;

function captureSnapshotMeta(execOpts: { encoding: "utf-8"; timeout: number; env: NodeJS.ProcessEnv; cwd: string }): TreeMeta | null {
  try {
    const files = execSync("git ls-files -z", { ...execOpts, stdio: "pipe", maxBuffer: 256 * 1024 * 1024 })
      .split("\0").filter(Boolean);
    let empty: string[] = [];
    try {
      empty = execSync("git ls-files -z -o --directory --exclude-standard", { ...execOpts, stdio: "pipe", maxBuffer: 64 * 1024 * 1024 })
        .split("\0").filter((p) => p.endsWith("/"));
    } catch { /* no empty directories recorded */ }
    const meta = recordTreeMeta(execOpts.cwd, files, empty);
    if (meta && fs.existsSync(path.join(execOpts.cwd, ".git"))) {
      try {
        const env = { ...process.env };
        delete env.GIT_DIR;
        delete env.GIT_WORK_TREE;
        meta.stash = execFileSync("git", ["stash", "list", "--format=%H"], {
          cwd: execOpts.cwd, env, encoding: "utf-8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"],
        }).split("\n").filter(Boolean);
      } catch { /* not a repository after all */ }
    }
    return meta;
  } catch {
    return null;
  }
}

/** Commit the workspace to the shadow repo; returns null when nothing changed. */
function gitSnapshotBackup(
  ctx: HookContext,
  config: SandboxConfig
): BackupArtifact | null {
  const shadowDir = ensureSharedShadowRepo(config);
  const cwd = process.cwd();
  const env = { ...process.env, GIT_DIR: shadowDir, GIT_WORK_TREE: cwd };
  const execOpts = { encoding: "utf-8" as const, timeout: 30_000, env, cwd };

  try {
    execSync("git add -A", { ...execOpts, stdio: "pipe" });
    // Untrack install files that an older snapshot (taken before they were excluded) still holds.
    try {
      execFileSync("git", ["rm", "-r", "--cached", "-q", "--ignore-unmatch", "--",
        ...INSTALLED_FILE_EXCLUDES.map((p) => `:(glob)${p.replace(/^\//, "").replace(/\/$/, "/**")}`)],
        { ...execOpts, stdio: "pipe" });
    } catch { /* nothing tracked */ }

    // Detect staged changes; with no commits yet, any staged file counts.
    let hasChanges = false;
    try {
      execSync("git rev-parse HEAD", { ...execOpts, stdio: "pipe" });
      // Repo has at least one commit — compare against HEAD
      const diffResult = execSync(
        "git diff --cached --quiet || echo CHANGES",
        { ...execOpts, stdio: "pipe" }
      );
      hasChanges = diffResult.includes("CHANGES");
    } catch {
      // No HEAD yet (first commit). Check if there's anything staged at all.
      const status = execSync("git status --porcelain", { ...execOpts, stdio: "pipe" });
      hasChanges = status.trim().length > 0;
    }

    // Remote (MCP / browser) actions take no workspace snapshot; their effects are handled by tier 4.
    if (ctx.tool_name.startsWith("mcp__") || /(^|_)browser_[a-z]/.test(ctx.tool_name)) {
      return null;
    }

    // Record what git does not keep, for this call specifically (a mode-only change leaves
    // the commit unchanged, so the manifest belongs to the call, not to the commit).
    _lastSnapshotMeta = captureSnapshotMeta(execOpts);

    if (!hasChanges) {
      // Workspace unchanged: return a pointer to HEAD, which already holds this action's pre-state.
      let head = "";
      try {
        head = execSync("git rev-parse HEAD", { ...execOpts, stdio: "pipe" }).trim();
      } catch {
        // No HEAD yet AND no changes → truly empty repo, nothing to snapshot.
        return null;
      }
      if (!head) return null;
      return {
        id: head.slice(0, 8),
        timestamp: new Date().toISOString(),
        trigger: "rule",
        toolName: ctx.tool_name,
        // The description names the separate shadow store, not the user's repository.
        description: `workspace snapshot → .backupper/shadow-repo (pointer → ${head.slice(0, 8)}, unchanged since previous action)`,
        strategy: "git_snapshot",
        originalAction: describeToolAction(ctx.tool_name, ctx.tool_input),
        artifactPath: shadowDir,
        commitHash: head,
      };
    }

    const reason = `before ${ctx.tool_name}`;
    execSync(`git commit -m "${reason}" --allow-empty-message`, {
      ...execOpts,
      stdio: "pipe",
    });

    const hash = execSync("git rev-parse HEAD", { ...execOpts, stdio: "pipe" }).trim();

    // Summarise what this commit captured, so the message reflects the specific action.
    let scope = "";
    try {
      const changed = execSync("git show --stat --format= --name-only HEAD", {
        ...execOpts, stdio: "pipe",
      }).split("\n").filter(Boolean).length;
      scope = changed > 0 ? `, ${changed} file(s)` : ", no change";
    } catch { /* stat is cosmetic; never fail the backup over it */ }

    return {
      id: hash.slice(0, 8),
      timestamp: new Date().toISOString(),
      trigger: "rule",
      toolName: ctx.tool_name,
      // The description names the separate shadow store, not the user's repository.
      description: `workspace snapshot → .backupper/shadow-repo (${hash.slice(0, 8)}${scope})`,
      strategy: "git_snapshot",
      originalAction: describeToolAction(ctx.tool_name, ctx.tool_input),
      artifactPath: shadowDir,
      commitHash: hash,
    };
  } catch {
    return null;
  }
}

// =====================================================================
// Workspace scope detection
// =====================================================================

/**
 * True for a browser-automation tool exposed under a bare `browser_*` name
 * (no `mcp__` prefix); treated like an MCP browser tool for tier-4 detection.
 */
function isBareBrowserTool(toolName: string): boolean {
  return /^browser_/.test(toolName);
}

/** Regex matching any of `words` as a whole `_`-delimited segment of a tool name. */
function toolNameVerbRegex(words: string[]): RegExp {
  return new RegExp(`(^|_)(${words.join("|")})(_|$)`, "i");
}

// Mutating verbs in an MCP tool's action segment; shared by the read-only checks below.
const MUTATING_VERB = toolNameVerbRegex([
  "create", "delete", "update", "remove", "insert", "drop", "truncate", "purge",
  "ack", "acknowledge", "replace", "write", "set", "post", "put", "send", "publish",
  "destroy", "kill", "cancel", "revoke", "grant", "upsert", "patch", "rename", "merge",
  "install", "uninstall", "close", "submit", "clear", "reset", "flush", "move", "edit",
  "modify",
]);

/** Read-style verbs in an MCP tool's action segment. */
const READ_VERB = toolNameVerbRegex([
  "get", "list", "search", "fetch", "read", "view", "describe", "inspect", "show",
  "status", "count", "find", "query", "history", "info", "head", "peek",
]);

/** Browser verbs that do not commit page state; form input is committed by a later click. */
const BROWSER_READ_VERB = toolNameVerbRegex([
  "navigate", "navigate_back", "snapshot", "screenshot", "take_screenshot",
  "console_messages", "network_requests", "wait_for", "resize", "tabs", "scroll",
  "hover", "fill", "fill_form", "type", "select_option", "drag",
]);

export function isReadOnlyMcpTool(toolName: string): boolean {
  // Accept `mcp__*` tools and bare `browser_*` tools.
  if (!toolName.startsWith("mcp__") && !isBareBrowserTool(toolName)) return false;

  // Classify on the final `__` segment so a server name cannot mask the action verb.
  const action = toolName.split("__").pop() || toolName;

  // A mutating verb anywhere in the action overrides a read verb (e.g. `get_and_delete`).
  if (MUTATING_VERB.test(action)) return false;

  if (READ_VERB.test(action)) return true;
  if (BROWSER_READ_VERB.test(action)) return true;
  return false;
}

/** Browser tools whose effect depends on the element clicked rather than the tool name. */
function isBrowserActuationTool(toolName: string): boolean {
  const action = (toolName.split("__").pop() || toolName).toLowerCase();
  return action === "browser_click" || action === "click";
}

/** Case-insensitive regex matching any of `words` (regex fragments) as a whole word. */
function wordRegex(words: string[]): RegExp {
  return new RegExp(`\\b(${words.join("|")})\\b`, "i");
}

// Affordances that COMMIT state — a click on one of these is worth a backup.
const MUTATING_AFFORDANCE = wordRegex([
  "submit", "create", "post", "publish", "save", "delete", "remove", "discard",
  "subscribe", "unsubscribe", "join", "leave", "follow", "unfollow", "vote", "upvote",
  "downvote", "reply", "comment", "edit", "update", "send", "confirm", "apply", "add",
  "upload", "sticky", "lock", "ban", "message", "sign\\s?up", "register", "checkout",
  "buy", "order", "pay", "reserve", "accept", "approve", "reject", "merge", "deploy",
]);
// Verbs whose remote effect is irreversible without a backup: destruction, overwrite,
// creation and commits. Reversible toggles (vote, follow, subscribe, ...) are excluded.
const IRREVERSIBLE_VERB = wordRegex([
  "delete", "remove", "destroy", "drop", "truncate", "erase", "wipe", "purge", "clear",
  "edit", "update", "overwrite", "replace", "modify", "rename", "save", "create", "add",
  "insert", "post", "submit", "publish", "upload", "send", "write", "append", "import",
  "reply", "buy", "order", "pay", "checkout", "purchase", "charge", "transfer", "deploy",
  "release", "push",
]);
// Destructive verbs: always backed up, even when the element is a link.
const STRONG_MUTATING = wordRegex([
  "delete", "remove", "destroy", "ban", "purge", "drop", "truncate", "wipe", "erase",
  "deactivate", "revoke",
]);
// Affordances that only navigate or read.
const READ_AFFORDANCE = wordRegex([
  "log\\s?in", "sign\\s?in", "log\\s?out", "sign\\s?out", "back", "forward", "next",
  "prev", "previous", "home", "page", "pagination", "tab", "sort", "filter", "search",
  "browse", "view", "expand", "collapse", "show\\s?more", "load\\s?more", "read\\s?more",
  "see\\s?more", "menu", "breadcrumb", "scroll", "hover", "open", "close", "dismiss",
  "cancel", "option", "combobox", "dropdown", "listbox", "checkbox", "radio",
  "spinbutton", "slider",
]);

/** Classify a browser click by its target: destructive or mutating → back up;
 *  link, navigation or read → skip; unknown → back up. */
export function isMutatingBrowserClick(input: Record<string, unknown>): boolean {
  const desc = String(
    input.element ?? input.text ?? input.selector ?? input.ref ?? input.name ?? ""
  ).toLowerCase();
  if (STRONG_MUTATING.test(desc)) return true;
  // A link navigates rather than commits, unless it matched a destructive verb above.
  if (/\blink\b/.test(desc)) return false;
  if (MUTATING_AFFORDANCE.test(desc)) return true;
  if (READ_AFFORDANCE.test(desc)) return false;
  return true; // Unknown affordance: back up.
}

/** Page-mutating calls inside arbitrary browser code (fill, click, submit, ...). */
const PAGE_MUTATION_CALL = new RegExp(
  [
    String.raw`\.(fill|click|type|press|check|uncheck|select_?option|set_?input_?files|tap|drag_?to|set_?checked|clear)\s*\(`,
    String.raw`\.submit\s*\(`,
    String.raw`get_?by\w*\([^)]*\)\s*\.\s*(click|fill|check|press|type|select)`,
  ].join("|"),
  "i",
);

/**
 * Decide whether a remote (MCP / browser) action is backup-worthy. In order:
 * read-verb tool name → skip; destructive verb in name, UI fields or payload → back up;
 * the server's learned lists (read-only tools → skip, backup patterns → back up);
 * otherwise the generic verb fallback, which defaults to skip.
 */
function isBackupWorthyRemote(ctx: HookContext, config?: SandboxConfig): boolean {
  const toolName = ctx.tool_name;
  const input = (ctx.tool_input ?? {}) as Record<string, unknown>;

  // SQL and query arguments are scanned as part of rawDesc below.

  // Arbitrary-code browser tools: inspect the code for mutating page actions; escalate if absent.
  const action = (toolName.split("__").pop() || toolName).toLowerCase();
  if (/run_code|evaluate/.test(action)) {
    const code = String(input.code ?? input.function ?? input.expression ?? "");
    if (!code) return true;
    return PAGE_MUTATION_CALL.test(code);
  }

  // Hardcoded read-verb tool-name skip (applies to any tool, learned or not).
  if (toolName.startsWith("mcp__") && isReadOnlyMcpTool(toolName)) return false;

  // Normalise `_` to spaces so word-boundary verb regexes match tool names.
  const desc = [
    toolName, input.element, input.text, input.selector, input.name,
  ].filter(Boolean).map(String).join(" ").toLowerCase().replace(/_/g, " ");
  // Raw text (incl. command/sql/query) for the learned keyword matchers.
  const rawDesc = [
    toolName, input.element, input.text, input.selector, input.name,
    input.command, input.sql, input.query,
  ].filter(Boolean).map(String).join(" ").toLowerCase();

  // Destructive floor: always back up. Tested against both the normalised description and the
  // raw payload (sql / command / query); learned entries cannot suppress it.
  if (STRONG_MUTATING.test(desc) || STRONG_MUTATING.test(rawDesc)) return true;

  // Per-server learned judgment, in order: read-only tool list → skip; learned pattern → back up.
  // Anything unmatched falls through to the generic fallback.
  try {
    const { serverFromToolName, experienceNameForServer, serverMatchers, matchPattern } =
      require("../explore/experiences.js");
    const server = config ? serverFromToolName(toolName) : null;
    const expName = server ? experienceNameForServer(config, server) : null;
    if (expName) {
      const m = serverMatchers(config, expName);
      const lc = toolName.toLowerCase();
      const seg = lc.split("__").pop() || lc;
      // 1. Read-only tool list; a tool with a mutating name is never cleared.
      if ((m.readOnlyTools.has(lc) || m.readOnlyTools.has(seg)) && !MUTATING_VERB.test(seg)) return false;
      // 2. Learned pattern verified as mutating → back up. Browser actuation tools are excluded:
      //    they gate on element-label triggers instead.
      const pat = matchPattern(config, expName, toolName, rawDesc);
      if (pat && !isBrowserActuationTool(toolName)) return true;
      if (pat?.reverter) return true;
      if (m.triggerRegex && m.triggerRegex.test(rawDesc)) return true;   // 3. Backup-patterns
    }
  } catch { /* fall through to the generic verb-list fallback */ }

  // Fallback when no server profile matches: generic verb-list heuristic.
  if (/\blink\b/.test(desc)) return false;
  // Verbs in the tool name or UI fields.
  if (IRREVERSIBLE_VERB.test(desc)) return true;
  // Verbs in the SQL / query payload, scanned with quoted string literals blanked out.
  const sqlPayload = [input.sql, input.query].filter(Boolean).map(String).join(" ").toLowerCase();
  // Strip ORDER BY / GROUP BY so these clauses are not read as mutating verbs.
  const sqlNoLiterals = sqlPayload
    .replace(/'[^']*'/g, "' '").replace(/"[^"]*"/g, '" "')
    .replace(/\border\s+by\b/gi, " ").replace(/\bgroup\s+by\b/gi, " ");
  if (sqlNoLiterals && (IRREVERSIBLE_VERB.test(sqlNoLiterals) ||
      // SQL-specific mutations absent from IRREVERSIBLE_VERB.
      /\b(merge|upsert|grant|vacuum|reindex|cluster|refresh|call|load|comment\s+on)\b/.test(sqlNoLiterals))) {
    return true;
  }
  return false; // Reversible toggle, unknown or read: skip.
}

/** Database command-line clients whose statements can mutate remote state. */
const DB_CLIENT = wordRegex(["psql", "mysql", "mariadb", "mongo", "mongosh", "redis-cli", "sqlite3"]);

/** SQL and key-value verbs that mutate a database. */
const DB_MUTATING_VERB = wordRegex([
  "delete", "update", "drop", "truncate", "insert", "alter", "replace", "upsert", "merge",
  "grant", "revoke", "call", "load", "reindex", "cluster", "vacuum", "refresh", "rename",
  "create", "comment\\s+on", "flushall", "flushdb", "hset", "hdel", "lpush", "rpush",
  "sadd", "zadd", "expire", "copy",
]);

/**
 * Whether a resolved absolute path lies outside the workspace. /dev, /proc and /tmp
 * are treated as non-durable and never count as outside.
 */
function outsideWorkspaceResolved(resolved: string, workspace: string): boolean {
  return (
    !resolved.startsWith(workspace + path.sep) &&
    resolved !== workspace &&
    !resolved.startsWith("/dev/") &&
    !resolved.startsWith("/proc/") &&
    !resolved.startsWith("/tmp/")
  );
}

/**
 * Whether the tool call may affect state outside the workspace: an explicit path argument
 * outside cwd, a command with global effects, or a remote tool judged backup-worthy.
 */
export function touchesOutsideWorkspace(ctx: HookContext, config?: SandboxConfig): boolean {
  const workspace = path.resolve(process.cwd());
  const toolName = ctx.tool_name;
  const input = ctx.tool_input;

  // Remote (MCP / browser) actions: backed up only if judged consequential.
  if (isBrowserActuationTool(toolName) || toolName.startsWith("mcp__")) {
    // BACKUPPER_NAIVE_GATE=1: escalate every remote action not cleared by the read-only
    // name filter, and let the backup subagent decide.
    if (process.env.BACKUPPER_NAIVE_GATE === "1") {
      return !isReadOnlyMcpTool(toolName);
    }
    return isBackupWorthyRemote(ctx, config);
  }

  // Check explicit file paths in tool args
  const pathArgs = [
    input.path, input.file_path, input.target, input.destination,
  ].filter(Boolean).map((p) => String(p));

  for (const p of pathArgs) {
    try {
      const resolved = path.resolve(expandHome(p));
      if (!resolved.startsWith(workspace + path.sep) && resolved !== workspace) {
        return true; // Path is outside the workspace
      }
    } catch {
      // ignore unresolvable paths
    }
  }

  // Local Bash commands escalate unless known safe: the command is read-only, or every
  // effect is spelled out in its arguments and lands inside the workspace.
  if (toolName === "Bash") {
    const cmd = String(input.command ?? "");

    // (1) Read-only commands need no backup.
    if (isReadOnlyBash(cmd)) return false;

    // Explicit patterns for commands with effects outside the workspace.
    const outsidePatterns = [
      /\bpip3?\s+(install|uninstall)/i,        // system/venv packages
      /\bnpm\s+(install|uninstall)\s+-g/i,      // global node packages
      /\bapt(-get)?\s+(install|remove|purge)/i, // system packages
      /\bbrew\s+(install|uninstall|remove)/i,   // homebrew
      /\bgit\s+(push|fetch|pull|remote)/i,      // remote git state
      /\bcurl\s+.*-X\s*(POST|PUT|DELETE|PATCH)/i, // remote API mutation
      /\bwget\s/i,                              // network download
      /\bssh\s/i,                               // remote commands
      /\bscp\s/i,                               // remote file copy
      /\bdocker\s+(run|stop|rm|build|push|cp|kill|restart|commit)/i, // container state
      // DB-client mutations are handled separately below.
      /\bkubectl\s+(apply|delete|create|patch|replace|scale|edit|drain|cordon|rollout|set|annotate|label|taint)\b/i, // k8s state
      /\bsystemctl\s+(start|stop|restart|enable|disable)/i, // services
      /\bexport\s+\w+=/i,                       // env vars
      /\bunset\s+\w+/i,                         // env vars
      /\bsource\s+/i,                           // shell config
      // Cloud and infrastructure-as-code CLIs.
      /\b(aws|gcloud|az|doctl|ibmcloud)\s/i,    // cloud provider CLIs
      /\b(terraform|pulumi|terragrunt)\s+(apply|destroy|import|state|up)\b/i, // IaC
      /\bhelm\s+(install|uninstall|upgrade|rollback|delete)\b/i, // k8s charts
      /\bgh\s+(repo|release|secret|api|pr|issue|gist|workflow|run)\b/i, // GitHub API
      /\bdocker\s+(exec|volume|network|system|compose)\b/i, // docker beyond the basic verbs
      // Package managers beyond pip/npm-g/apt/brew — write outside the workspace.
      /\b(cargo|go|gem|pipx|conda|mamba|poetry|pnpm|bundle)\s+(install|add|remove|uninstall|get)\b/i,
      /\byarn\s+global\s+(add|remove)\b/i,
      /\b(dnf|yum|apk|pacman|zypper|snap)\s+(install|remove|add|erase|delete)\b/i,
      /\b(make|ninja)\s+install\b/i,
      /\bpython3?\s+setup\.py\s+install\b/i,
      // Identity / scheduling / system writes.
      /\bcrontab\b/i,                           // scheduled jobs
      /\b(chsh|usermod|useradd|userdel|groupadd|passwd)\b/i, // accounts
      // Network mutation the curl `-X` pattern misses, plus other transports.
      /\bcurl\s+[\s\S]*(--request\s+(POST|PUT|DELETE|PATCH)|--data\b|--data-raw\b|-d\s|-T\s|--upload-file\b)/i,
      /\b(rsync|sftp|nc|ncat|telnet|ftp)\s/i,   // remote transports
    ];

    for (const pattern of outsidePatterns) {
      if (pattern.test(cmd)) return true;
    }

    // DB-client mutation (direct, or via docker exec / ssh): a client token and a mutating verb,
    // tested separately to keep both regexes linear.
    const usesDbClient = DB_CLIENT.test(cmd);
    if (usesDbClient && (DB_MUTATING_VERB.test(cmd) || /\\copy/i.test(cmd))) {
      return true;
    }

    // Scan for absolute paths outside the workspace, ignoring only an interpreter executable at argv[0].
    const INTERPRETER = /^(?:python[0-9.]*|node|nodejs|ts-node|tsx|deno|bun|ruby|perl|php|bash|sh|dash|zsh|fish|java|Rscript|pytest)$/;
    const isOutside = (token: string): boolean => {
      // Require at least two path segments, so sed/awk fragments like "/retries" are ignored.
      const paths = token.match(/\/[\w./-]+/g) ?? [];
      for (const p of paths) {
        if (p.split("/").filter(Boolean).length < 2) continue;
        try {
          if (outsideWorkspaceResolved(path.resolve(p), workspace)) return true;
        } catch {
          // ignore unresolvable
        }
      }
      return false;
    };

    for (const seg of cmd.split(/(?:&&|\|\||[|;&\n])/)) {
      const tokens = seg.trim().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) continue;
      // Skip leading env-assignments (NAME=value) to locate argv[0].
      let ai = 0;
      while (ai < tokens.length && /^[A-Za-z_]\w*=/.test(tokens[ai])) ai++;
      const argv0 = tokens[ai];
      const argv0IsInterpreter =
        !!argv0 && argv0.startsWith("/") &&
        INTERPRETER.test(argv0.split("/").pop() ?? "");
      for (let j = 0; j < tokens.length; j++) {
        if (j === ai && argv0IsInterpreter) continue; // skip interpreter exe
        if (isOutside(tokens[j])) return true;
      }
    }

    // (2) Otherwise the command is cleared only if it is effect-bounded inside the workspace.
    return !bashIsEffectBounded(cmd, workspace);
  }

  return false;
}

// =====================================================================
// Main dispatcher
// =====================================================================

export interface BackupResult {
  /** Artifacts created (may be multiple). */
  artifacts: BackupArtifact[];
  /** Whether a tier-4 subagent should be called. */
  needsSubagent: boolean;
  /** Reason the subagent is needed. */
  subagentReason?: string;
  /** Rewritten tool_input when a tier-1 command-rewriting rule changed the command. */
  updatedInput?: Record<string, unknown>;
  /** Folder of the action recorded for this backup, when one was created. */
  actionDir?: string;
  /**
   * Set when the call must be blocked: a backup-only tier-1 rule found the backup store in
   * the victim set of a command it cannot rewrite. The text is the reason shown to the agent.
   */
  deny?: string;
  /** Effects outside what tiers 1-3 capture, which tier 4 (or tier 2) had to take. */
  uncovered?: IncompleteCapture;
  /** True once a lower tier captured `uncovered` or judged it read-only. */
  uncoveredHandled?: boolean;
  /** Set when the action was recorded as incompletely captured (incomplete.json written). */
  incomplete?: IncompleteCapture;
}

/** Tools that never modify state and need no backup. */
const READ_ONLY_TOOLS = new Set([
  "Read", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite",
  // Harness-internal tools that do not touch project state.
  "ToolSearch",
]);

/** `git` followed by any number of repository-selection options. */
const GIT_GLOBAL_OPTIONS =
  "git\\s+(?:-C\\s+\\S+\\s+|--git-dir=\\S+\\s+|--work-tree=\\S+\\s+|--no-pager\\s+)*";

/**
 * Introspection Bash verbs that read and print without mutating. A segment matching
 * this pattern (and its layer-2 classifier, if any) needs no backup.
 */
const READ_ONLY_BASH_PATTERN = new RegExp(
  "^\\s*(?:" +
    "which|command\\s+-v|type(?:\\s+-[aPpt]+)?|" +       // what-is
    "ls(?:\\s+-[a-zA-Z]*)?|stat|file|readlink|realpath|dirname|basename|" +  // fs introspection
    "cat|head|tail|wc|grep|egrep|fgrep|zcat|zgrep|rg|" +  // read contents (rg has a layer-2 classifier)
    // Stdin formatters via `python3 -m`; only read-only with no positional arguments (pyModuleIsReadOnly).
    "python3?\\s+-m\\s+(?:json\\.tool|base64)|" +
    // Further read-only verbs. sort, uniq and crontab can write through their own options and
    // rely on their layer-2 classifiers.
    "cut|tr|paste|comm|cmp|nl|od|strings|column|diff|sleep|test|\\[|" +
    "(?:md5|sha1|sha224|sha256|sha384|sha512)sum|cksum|b2sum|" +
    "getent|pgrep|pidof|findmnt|lsblk|netstat|pg_isready|nproc|lscpu|tac|rev|seq|" +
    "du|sort|uniq|crontab|" +
    "systemctl(?:\\s+(?:--user|--system|--no-pager|--all|-a))*\\s+" +
      "(?:status|show|cat|is-active|is-enabled|is-failed|list-units|list-timers|list-sockets|" +
      "list-unit-files|list-dependencies)|" +
    "docker\\s+(?:volume|network|container|image|node|secret|config)\\s+(?:ls|inspect)|" +
    "docker\\s+system\\s+df|docker\\s+builder\\s+du|" +
    "kubectl\\s+config\\s+(?:current-context|get-contexts|get-clusters)|" +
    "kubectl\\s+(?:api-resources|api-versions)|" +
    // git read subcommands. Each name must be followed by whitespace or end of segment
    // (so `cherry` does not match `cherry-pick`); `git -c` is excluded because it can execute commands.
    GIT_GLOBAL_OPTIONS + "(?:" +
      "status|log|show|diff|rev-parse|ls-(?:files|tree|remote)|describe|blame|cat-file|" +
      "rev-list|count-objects|for-each-ref|check-ignore|check-attr|merge-base|diff-tree|" +
      "diff-index|diff-files|show-ref|show-branch|name-rev|shortlog|whatchanged|" +
      "verify-pack|verify-commit|verify-tag|var|grep|" +
      "stash\\s+(?:list|show)|worktree\\s+list|submodule\\s+status|" +
      "bundle\\s+(?:verify|list-heads)|remote\\s+(?:-v|--verbose|show|get-url)|" +
      "config\\s+(?:--local\\s+|--global\\s+|--system\\s+|--worktree\\s+)*" +
        "(?:--list|-l|--get|--get-all|--get-regexp|--get-urlmatch)|" +
      "tag\\s+(?:-l|--list|--contains|--points-at|--merged|--no-merged|--sort)|" +
      "reflog(?:\\s+show|\\s+--[a-z]))|" +
    // Bare listing forms only: `git branch` lists, `git branch NAME` creates.
    GIT_GLOBAL_OPTIONS + "(?:" +
      "branch(?:\\s+(?:-[arv]+|--all|--list|--verbose|--show-current))*|remote|tag|reflog|" +
      "fsck(?:\\s+(?:--unreachable|--dangling|--no-dangling|--no-reflogs?|--full|--strict|" +
        "--no-progress|--progress|--connectivity-only|--name-objects|--cache|--root|--tags|" +
        "--verbose))*|" +
      "version|--version)\\s*$|" +
    // `find` is read-only only with walk/test/print flags (findIsReadOnly).
    "find|" +
    // `curl` is read-only only with allowlisted options (curlIsReadOnly).
    "curl|" +
    // sed and awk are excluded: their scripts can write files or execute commands.
    "pwd|id|whoami|groups|uname|date|echo|printf|true|false|" +  // environment (mutating `date` forms are handled by dateIsReadOnly)
    "cd|pushd|popd|" +                                   // directory navigation
    "printenv|locale|" +                                 // env vars (`env` is excluded: `env PROG` runs a command)
    "ps|top|df|du(?:\\s+-[a-zA-Z]+)*\\s*$|free|uptime|" + // sysinfo (du without a target)
    // git read-only
    "git\\s+(?:status|log|show|diff|branch\\s*$|remote\\s*$|config\\s+--get|rev-parse|" +
      "ls-(?:files|tree|remote)|describe|blame|cat-file)|" +
    "pip(?:3)?\\s+(?:list|show|freeze|check)|" +         // pip introspection (list/show/freeze/check)
    "npm\\s+(?:list|ls|view|show|search|outdated|root|config\\s+get)|" +  // npm read-only
    "docker\\s+(?:ps|images|inspect|logs|version|info|stats|top|events|history|port)|" +  // docker read-only
    "kubectl\\s+(?:get|describe|logs|version|config\\s+view|cluster-info|explain)" +  // kubectl read-only
    // Interpreters (`python -c`, `node -e`) are excluded: they execute arbitrary code.
  ")" +
  // Trailing args. Operators are already split by the caller, so any remaining one is literal text.
  "(?:\\s+[^\\n\\r]*)?" +
  "\\s*$"
);

// ── curl / find argument classifiers ─────────────────────────────────
// Positive allowlists: an invocation is read-only only if every flag is known to produce
// no file, upload or state change; any unrecognised flag means "not read-only".

/** True only for the literal null device, the one destination that keeps no state. */
function isNullDevice(target: string): boolean {
  return target === "/dev/null";
}

/** Split a command segment into shell words, honouring quotes and backslash escapes.
 *  Returns null on an unbalanced quote. */
function shellWords(seg: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (quote) {
      if (c === quote) {
        quote = null;
      } else if (c === "\\" && quote === '"' && i + 1 < seg.length) {
        cur += seg[++i];
        started = true;
      } else {
        cur += c;
        started = true;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (c === "\\" && i + 1 < seg.length) {
      cur += seg[++i];
      started = true;
    } else if (/\s/.test(c)) {
      if (started) {
        out.push(cur);
        cur = "";
        started = false;
      }
    } else {
      cur += c;
      started = true;
    }
  }
  if (quote) return null;
  if (started) out.push(cur);
  return out;
}

/** curl long options that take NO argument and produce no file. */
const CURL_SAFE_LONG_NOARG = new Set([
  "silent", "show-error", "location", "location-trusted", "insecure",
  "include", "head", "verbose", "fail", "fail-early", "fail-with-body",
  "get", "globoff", "compressed", "no-buffer", "no-progress-meter",
  "no-keepalive", "no-sessionid", "path-as-is", "tcp-nodelay", "raw",
  "http1.0", "http1.1", "http2", "http2-prior-knowledge", "http3",
  "ipv4", "ipv6", "anyauth", "basic", "digest", "negotiate", "ntlm",
  "junk-session-cookies", "ssl", "ssl-reqd", "tlsv1", "tlsv1.0",
  "tlsv1.1", "tlsv1.2", "tlsv1.3", "help", "version", "styled-output",
]);

/** curl long options taking one argument that names no output file and carries no body. */
const CURL_SAFE_LONG_ARG = new Set([
  "header", "user-agent", "referer", "user", "proxy-user", "url",
  "max-time", "connect-timeout", "expect100-timeout",
  "happy-eyeballs-timeout-ms", "retry", "retry-delay", "retry-max-time",
  "retry-connrefused", "proxy", "preproxy", "noproxy", "resolve",
  "interface", "limit-rate", "cookie", "range", "max-redirs",
  "max-filesize", "cacert", "capath", "cert", "cert-type", "key",
  "key-type", "pass", "ciphers", "tls-max", "dns-servers", "dns-interface",
  "socks5", "socks5-hostname", "socks4", "socks4a", "unix-socket",
  "abstract-unix-socket", "oauth2-bearer", "aws-sigv4", "proxy-header",
  // Options whose argument decides the verdict (curlArgIsReadOnly).
  "request", "output", "write-out",
]);

/** curl short options taking no argument (bundle-safe: `-sSL`). */
const CURL_SAFE_SHORT_NOARG = "sSLkiIvfGgjNh46V";
/** curl short options taking one argument (value may be glued or next word). */
const CURL_SAFE_SHORT_ARG = "HAeuxmbrXtzow";

/** Short spellings of the options whose argument is checked in curlArgIsReadOnly. */
const CURL_SHORT_TO_LONG: Readonly<Record<string, string>> = {
  X: "request", o: "output", w: "write-out",
};

/**
 * Check the argument of --request (GET/HEAD only), --output (null device only) and
 * --write-out (plain `%{variable}` / `%%` format only; other directives can open files).
 */
function curlArgIsReadOnly(name: string, val: string): boolean {
  switch (name) {
    case "request": return /^(?:GET|HEAD)$/i.test(val);
    case "output": return isNullDevice(val);
    case "write-out": return !val.startsWith("@") && !/%(?![{%])/.test(val);
    default: return true;
  }
}

/** A `curl` invocation is read-only iff every option is allowlisted and the method is GET or HEAD. */
function curlIsReadOnly(seg: string): boolean {
  const words = shellWords(seg);
  if (!words || words.length === 0) return false;
  if (words[0] !== "curl" && !/(?:^|\/)curl$/.test(words[0])) return false;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === "-" || !w.startsWith("-")) continue;        // URL / positional
    if (w === "--") return false;                          // end-of-options: unclassified tail
    if (w.startsWith("--")) {
      const eq = w.indexOf("=");
      const name = (eq === -1 ? w.slice(2) : w.slice(2, eq)).toLowerCase();
      if (CURL_SAFE_LONG_NOARG.has(name)) {
        if (eq !== -1) return false;                       // no-arg flag given a value
        continue;
      }
      if (CURL_SAFE_LONG_ARG.has(name)) {
        const val = eq === -1 ? words[++i] : w.slice(eq + 1);
        if (val === undefined) return false;
        if (!curlArgIsReadOnly(name, val)) return false;
        continue;
      }
      return false;                                        // unknown long option
    }
    // Short cluster: all no-arg options, except that the last may take an argument.
    for (let c = 1; c < w.length; c++) {
      const ch = w[c];
      if (CURL_SAFE_SHORT_NOARG.includes(ch)) continue;
      if (CURL_SAFE_SHORT_ARG.includes(ch)) {
        const glued = w.slice(c + 1);
        const val = glued.length > 0 ? glued : words[++i];
        if (val === undefined) return false;
        const long = CURL_SHORT_TO_LONG[ch];
        if (long !== undefined && !curlArgIsReadOnly(long, val)) return false;
        break;                                             // the rest is the value
      }
      return false;                                        // unknown short option
    }
  }
  return true;
}

/** find flags that only walk, test and print to stdout; writing and executing actions are absent. */
const FIND_SAFE_FLAGS = new Set([
  // positional/global options
  "-H", "-L", "-P", "-depth", "-d", "-mindepth", "-maxdepth", "-follow",
  "-xdev", "-mount", "-noleaf", "-ignore_readdir_race",
  "-noignore_readdir_race", "-daystart", "-regextype", "-warn", "-nowarn",
  "-files0-from", "-help", "--help", "-version", "--version",
  // name / path tests
  "-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename",
  "-regex", "-iregex", "-lname", "-ilname",
  // metadata tests
  "-type", "-xtype", "-size", "-empty", "-perm", "-user", "-group",
  "-uid", "-gid", "-nouser", "-nogroup", "-readable", "-writable",
  "-executable", "-links", "-inum", "-samefile", "-fstype", "-context",
  // time tests
  "-newer", "-anewer", "-cnewer", "-atime", "-ctime", "-mtime", "-amin",
  "-cmin", "-mmin", "-used",
  // operators
  "-a", "-and", "-o", "-or", "-not", "-true", "-false",
  // print-only actions
  "-print", "-print0", "-printf", "-ls", "-prune", "-quit",
]);

/** Allowlisted `find` predicates that consume the next word as a value (which may start with `-`). */
const FIND_VALUE_FLAGS = new Set([
  "-size", "-mmin", "-amin", "-cmin", "-mtime", "-atime", "-ctime", "-used",
  "-links", "-inum", "-maxdepth", "-mindepth", "-perm", "-newer", "-anewer",
  "-cnewer", "-regextype", "-name", "-iname", "-path", "-ipath", "-wholename",
  "-iwholename", "-regex", "-iregex", "-lname", "-ilname", "-type", "-xtype",
  "-user", "-group", "-uid", "-gid", "-fstype", "-context", "-samefile",
  "-printf", "-files0-from",
]);
function findIsReadOnly(seg: string): boolean {
  const words = shellWords(seg);
  if (!words || words.length === 0) return false;
  if (words[0] !== "find" && !/(?:^|\/)find$/.test(words[0])) return false;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (!w.startsWith("-")) continue;                      // path, value, ( ) ! ,
    if (FIND_SAFE_FLAGS.has(w)) continue;
    if (/^-newer[aBcm][aBcmt]$/.test(w)) continue;         // -newermt, -newerct, …
    if (/^-O[0-9]$/.test(w)) continue;                     // optimization level
    // A value of the preceding allowlisted predicate (e.g. `-size -1k`), not a flag.
    if (i > 1 && FIND_VALUE_FLAGS.has(words[i - 1])) continue;
    if (i > 1 && /^-newer[aBcm][aBcmt]$/.test(words[i - 1])) continue;
    return false;                                          // -delete, -exec, unknown
  }
  return true;
}

// ── `file` ───────────────────────────────────────────────────────────
// `file -C` writes a compiled magic file, so options are allowlisted.

/** `file` long options that take no argument and only read/print. */
const FILE_SAFE_LONG_NOARG = new Set([
  "brief", "dereference", "no-dereference", "mime", "mime-type",
  "mime-encoding", "apple", "extension", "keep-going", "list", "no-buffer",
  "no-pad", "preserve-date", "print0", "raw", "special-files", "uncompress",
  "uncompress-noreport", "help", "version",
]);
/** `file` long options taking one argument, none of which names an output. */
const FILE_SAFE_LONG_ARG = new Set([
  "magic-file", "exclude", "exclude-quiet", "separator", "files-from",
  "parameter",
]);
/** `file` short options: no-arg, then arg-taking. `C` is on neither. */
const FILE_SAFE_SHORT_NOARG = "bhLiklnNprszZ0v";
const FILE_SAFE_SHORT_ARG = "meFfP";

/** A `file` invocation is read-only iff every option is a known read/print option. */
function fileIsReadOnly(seg: string): boolean {
  const words = shellWords(seg);
  if (!words || words.length === 0) return false;
  if (words[0] !== "file" && !/(?:^|\/)file$/.test(words[0])) return false;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === "-" || !w.startsWith("-")) continue;          // filename operand
    if (w === "--") return false;                           // unclassified tail
    if (w.startsWith("--")) {
      const eq = w.indexOf("=");
      const name = (eq === -1 ? w.slice(2) : w.slice(2, eq)).toLowerCase();
      if (FILE_SAFE_LONG_NOARG.has(name)) {
        if (eq !== -1) return false;
        continue;
      }
      if (FILE_SAFE_LONG_ARG.has(name)) {
        if (eq === -1 && words[++i] === undefined) return false;
        continue;
      }
      return false;                                         // --compile, unknown
    }
    for (let c = 1; c < w.length; c++) {
      const ch = w[c];
      if (FILE_SAFE_SHORT_NOARG.includes(ch)) continue;
      if (FILE_SAFE_SHORT_ARG.includes(ch)) {
        const glued = w.slice(c + 1);
        if (glued.length === 0 && words[++i] === undefined) return false;
        break;                                              // the rest is the value
      }
      return false;                                         // -C, unknown short
    }
  }
  return true;
}

// ── `date` ───────────────────────────────────────────────────────────
// Options are allowlisted, since long options accept any unambiguous prefix (e.g. `--se` for `--set`).

/** `date` long options that take no argument and only print. */
const DATE_SAFE_LONG_NOARG = new Set([
  "utc", "universal", "rfc-email", "rfc-822", "rfc-2822", "debug",
  "help", "version", "resolution",
]);
/** `date` long options that take one argument and only print. */
const DATE_SAFE_LONG_ARG = new Set(["date", "file", "reference", "rfc-3339"]);
/** `date` long options whose argument is optional (`--iso-8601[=FMT]`). */
const DATE_SAFE_LONG_OPTARG = new Set(["iso-8601"]);

/** A `date` invocation is read-only iff every option only prints and every operand is `+FORMAT`. */
function dateIsReadOnly(seg: string): boolean {
  const words = shellWords(seg);
  if (!words || words.length === 0) return false;
  if (words[0] !== "date" && !/(?:^|\/)date$/.test(words[0])) return false;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (!w.startsWith("-")) {
      if (w.startsWith("+")) continue;                      // +FORMAT: printing
      return false;                                         // operand → sets clock
    }
    if (w === "--") return false;
    if (w.startsWith("--")) {
      const eq = w.indexOf("=");
      const name = eq === -1 ? w.slice(2) : w.slice(2, eq);
      if (DATE_SAFE_LONG_NOARG.has(name)) {
        if (eq !== -1) return false;
        continue;
      }
      if (DATE_SAFE_LONG_OPTARG.has(name)) continue;        // arg is glued or absent
      if (DATE_SAFE_LONG_ARG.has(name)) {
        if (eq === -1 && words[++i] === undefined) return false;
        continue;
      }
      return false;                                         // --set, --se, --s, …
    }
    // Short cluster: `-u`/`-R` take nothing, `-I` an optional glued value, `-d`/`-f`/`-r` one value.
    for (let c = 1; c < w.length; c++) {
      const ch = w[c];
      if (ch === "u" || ch === "R") continue;
      if (ch === "I") break;                                // -I / -Iseconds
      if ("dfr".includes(ch)) {
        const glued = w.slice(c + 1);
        if (glued.length === 0 && words[++i] === undefined) return false;
        break;
      }
      return false;                                         // -s, unknown short
    }
  }
  return true;
}

/** ripgrep flags that only search and print; exec-capable flags such as `--pre` are absent. */
const RG_SAFE_LONG_NOARG = new Set([
  "line-number", "no-line-number", "ignore-case", "smart-case",
  "case-sensitive", "word-regexp", "line-regexp", "fixed-strings",
  "invert-match", "files-with-matches", "files-without-match", "count",
  "count-matches", "only-matching", "no-heading", "heading",
  "with-filename", "no-filename", "hidden", "no-ignore", "no-ignore-vcs",
  "follow", "text", "null", "null-data", "quiet", "stats", "files",
  "json", "pretty", "search-zip", "multiline", "multiline-dotall",
  "crlf", "no-messages", "vimgrep", "column", "byte-offset", "help",
  "version", "one-file-system", "binary", "trim", "block-buffered",
  "line-buffered", "debug", "no-config",
]);
const RG_SAFE_LONG_ARG = new Set([
  "regexp", "glob", "iglob", "type", "type-not", "type-add", "max-count",
  "max-depth", "maxdepth", "max-columns", "max-filesize", "after-context",
  "before-context", "context", "color", "colors", "replace", "sort",
  "sortr", "encoding", "threads", "ignore-file", "context-separator",
  "field-match-separator", "field-context-separator", "path-separator",
  "engine", "dfa-size-limit", "regex-size-limit", "binary-files",
]);
const RG_SAFE_SHORT_NOARG = "nNiSswxFvlLcoIauHhqzpUPJ0V";
const RG_SAFE_SHORT_ARG = "egtTmABCdM";

/** `rg` is read-only iff every option is on the search/print allowlist. */
function rgIsReadOnly(seg: string): boolean {
  const words = shellWords(seg);
  if (!words || words.length === 0) return false;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === "-" || !w.startsWith("-")) continue;   // pattern / path
    if (w === "--") return false;
    if (w.startsWith("--")) {
      const eq = w.indexOf("=");
      const name = eq === -1 ? w.slice(2) : w.slice(2, eq);
      if (RG_SAFE_LONG_NOARG.has(name)) {
        if (eq !== -1) return false;
        continue;
      }
      if (RG_SAFE_LONG_ARG.has(name)) {
        if (eq === -1 && words[++i] === undefined) return false;
        continue;
      }
      return false;
    }
    for (let c = 1; c < w.length; c++) {
      const ch = w[c];
      if (RG_SAFE_SHORT_NOARG.includes(ch)) continue;
      if (RG_SAFE_SHORT_ARG.includes(ch)) {
        // The value is glued (`-m5`) or the next word.
        if (w.length === c + 1 && words[++i] === undefined) return false;
        break;
      }
      return false;
    }
  }
  return true;
}

/** Flags accepted by the two stdin filters allowlisted as `python -m …`. */
const PY_MODULE_SAFE_NOARG = new Set([
  "--sort-keys", "--no-ensure-ascii", "--json-lines", "--tab",
  "--no-indent", "--compact", "-h", "--help", "-e", "-d", "-u", "-t",
]);
const PY_MODULE_SAFE_ARG = new Set(["--indent"]);

/**
 * `python3 -m json.tool` / `-m base64` are read-only only as stdin filters with no
 * positional argument: json.tool's second positional is an output file it overwrites.
 */
function pyModuleIsReadOnly(seg: string): boolean {
  const words = shellWords(seg);
  if (!words || words.length === 0) return false;
  // words: python3 -m <module> [rest…]
  let i = 1;
  while (i < words.length && words[i] !== "-m") i++;
  if (i >= words.length) return false;
  i += 2;                                    // skip "-m" and the module name
  for (; i < words.length; i++) {
    const w = words[i];
    if (!w.startsWith("-")) return false;    // POSITIONAL → possible outfile
    const eq = w.indexOf("=");
    const name = eq === -1 ? w : w.slice(0, eq);
    if (PY_MODULE_SAFE_NOARG.has(name)) {
      if (eq !== -1) return false;
      continue;
    }
    if (PY_MODULE_SAFE_ARG.has(name)) {
      if (eq === -1) i++;                    // the value is the next word
      continue;
    }
    return false;
  }
  return true;
}

// ── sort / uniq / crontab ────────────────────────────────────────────
// Layer-2 classifiers for verbs that can write or delete through their own options.

/** `sort` long options taking no argument. */
const SORT_SAFE_LONG_NOARG = new Set([
  "ignore-leading-blanks", "dictionary-order", "ignore-case",
  "general-numeric-sort", "ignore-nonprinting", "month-sort",
  "human-numeric-sort", "numeric-sort", "random-sort", "reverse", "sort",
  "stable", "unique", "zero-terminated", "check", "c", "debug", "help",
  "version", "version-sort", "merge",
]);
/** `sort` long options taking one argument. */
const SORT_SAFE_LONG_ARG = new Set([
  "key", "field-separator", "buffer-size", "batch-size", "parallel", "check",
]);
/** `sort` short options taking no argument, then those taking one. */
const SORT_SAFE_SHORT_NOARG = "bdfgiMhnRrsuzVcm";
const SORT_SAFE_SHORT_ARG = "ktS";

/** `sort` is read-only unless it writes (`-o`, `--output`) or executes (`--compress-program`);
 *  those options are absent from the allowlists above. */
function sortIsReadOnly(seg: string): boolean {
  const words = shellWords(seg);
  if (!words || words.length === 0) return false;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === "-" || !w.startsWith("-")) continue;         // stdin / filename
    if (w === "--") return false;
    if (w.startsWith("--")) {
      const eq = w.indexOf("=");
      const name = eq === -1 ? w.slice(2) : w.slice(2, eq);
      if (SORT_SAFE_LONG_NOARG.has(name)) {
        if (eq !== -1) return false;
        continue;
      }
      if (SORT_SAFE_LONG_ARG.has(name)) {
        if (eq === -1 && words[++i] === undefined) return false;
        continue;
      }
      return false;                                        // --output, --compress-program
    }
    for (let c = 1; c < w.length; c++) {
      const ch = w[c];
      if (SORT_SAFE_SHORT_NOARG.includes(ch)) continue;
      if (SORT_SAFE_SHORT_ARG.includes(ch)) {
        // The value is glued (`-k2`) or the next word.
        if (w.length === c + 1 && words[++i] === undefined) return false;
        break;
      }
      return false;                                        // -o, unknown short
    }
  }
  return true;
}

/** Verbs read-only only with at most one positional, since the second is an output file (`uniq IN OUT`). */
const ONE_POSITIONAL_FLAGS: Record<string, { noarg: Set<string>; arg: Set<string> }> = {
  uniq: {
    noarg: new Set([
      "-c", "--count", "-d", "--repeated", "-D", "-u", "--unique",
      "-i", "--ignore-case", "-z", "--zero-terminated", "--help",
      "--version", "--all-repeated", "--group",
    ]),
    arg: new Set([
      "-f", "--skip-fields", "-s", "--skip-chars", "-w", "--check-chars",
    ]),
  },
};

function onePositionalIsReadOnly(seg: string): boolean {
  const words = shellWords(seg);
  if (!words || words.length === 0) return false;
  const base = words[0].replace(/^.*\//, "");
  const spec = ONE_POSITIONAL_FLAGS[base];
  if (!spec) return false;
  let positionals = 0;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === "-" || !w.startsWith("-")) {
      positionals++;
      continue;
    }
    if (w === "--") return false;
    const eq = w.indexOf("=");
    const name = eq === -1 ? w : w.slice(0, eq);
    if (spec.noarg.has(name)) {
      if (eq !== -1) return false;
      continue;
    }
    if (spec.arg.has(name)) {
      if (eq === -1) i++;                                  // the value is the next word
      continue;
    }
    if (/^-[fsw][0-9]+$/.test(w)) continue;                // glued value: -w4
    return false;
  }
  return positionals <= 1;
}

/** `crontab` is read-only only as `-l` (optionally with `-u USER`). */
function crontabIsReadOnly(seg: string): boolean {
  const words = shellWords(seg);
  if (!words || words.length === 0) return false;
  let sawList = false;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === "-l" || w === "--list") { sawList = true; continue; }
    if (w === "-u" || w === "--user") {
      if (words[++i] === undefined) return false;
      continue;
    }
    return false;                                          // -r, -e, FILE, …
  }
  return sawList;
}

const BASH_ARG_CLASSIFIERS: ReadonlyArray<readonly [RegExp, (seg: string) => boolean]> = [
  [/^\s*(?:\S*\/)?curl\b/, curlIsReadOnly],
  [/^\s*(?:\S*\/)?find\b/, findIsReadOnly],
  [/^\s*(?:\S*\/)?rg\b/, rgIsReadOnly],
  [/^\s*(?:\S*\/)?file\b/, fileIsReadOnly],
  [/^\s*(?:\S*\/)?date\b/, dateIsReadOnly],
  [/^\s*python3?\s+-m\b/, pyModuleIsReadOnly],
  [/^\s*(?:\S*\/)?sort\b/, sortIsReadOnly],
  [/^\s*(?:\S*\/)?uniq\b/, onePositionalIsReadOnly],
  [/^\s*(?:\S*\/)?crontab\b/, crontabIsReadOnly],
];

// ── Shell structure: substitutions, segmentation, control keywords ───
// Determines which commands a shell line runs; each is then judged by the verb allowlist.

/** Placeholder for a resolved command substitution; never matches the allowlist. */
const SUBST_PLACEHOLDER = "__rb_subst__";

/**
 * Replace each command substitution (`$( … )`, backquotes) with an opaque word, after checking
 * that the inner command is itself read-only. Returns null on an unterminated substitution,
 * a non-read-only inner command, or excessive nesting.
 */
function resolveSubstitutions(command: string, depth: number): string | null {
  let out = command;
  for (let round = 0; round < 32; round++) {
    // Find the first ACTIVE substitution opener, honouring quoting.
    let start = -1;
    let kind: "paren" | "tick" | null = null;
    let quote: '"' | "'" | null = null;
    for (let i = 0; i < out.length; i++) {
      const c = out[i];
      if (c === "\\" && i + 1 < out.length) {
        i++;                                // skip the escaped character
        continue;
      }
      if (quote) {
        if (c === quote) quote = null;
        continue;
      }
      if (c === "'" || c === '"') {
        quote = c;
        continue;
      }
      if (c === "`" || (c === "$" && out[i + 1] === "(")) {
        start = i;
        kind = c === "`" ? "tick" : "paren";
        break;
      }
    }
    if (quote) return null;                 // unbalanced quote → unparseable
    if (start === -1) return out;           // nothing left to resolve
    let inner: string;
    let end: number;                        // index just past the closer
    if (kind === "tick") {
      const close = out.indexOf("`", start + 1);
      if (close === -1) return null;
      inner = out.slice(start + 1, close);
      end = close + 1;
    } else {
      // Match the closing paren, counting nesting and skipping quotes.
      let depthParen = 0;
      let q: string | null = null;
      let close = -1;
      for (let i = start + 1; i < out.length; i++) {
        const c = out[i];
        if (c === "\\" && i + 1 < out.length) {
          i++;
          continue;
        }
        if (q) {
          if (c === q) q = null;
          continue;
        }
        if (c === "'" || c === '"') {
          q = c;
          continue;
        }
        if (c === "(") {
          depthParen++;
        } else if (c === ")") {
          depthParen--;
          if (depthParen === 0) {
            close = i;
            break;
          }
        }
      }
      if (close === -1) return null;
      inner = out.slice(start + 2, close);
      end = close + 1;
    }
    // Judge the inner command recursively; an arithmetic expansion `$(( … ))` is not read-only.
    if (!isReadOnlyBashInner(inner, depth + 1)) return null;
    out = out.slice(0, start) + SUBST_PLACEHOLDER + out.slice(end);
  }
  return null;                               // absurd nesting → bail
}

/**
 * Split a command line into the segments the shell would run, quote-aware, resolving
 * redirections: null-device and descriptor duplications are dropped, input redirections
 * are dropped, and heredocs, process substitutions and subshells return null.
 * A redirect to a real file returns null, unless `redirectTargets` is given, in which
 * case the target is collected and parsing continues.
 */
function splitTopLevel(command: string, redirectTargets?: string[]): string[] | null {
  const segs: string[] = [];
  let buf = "";
  const push = (): void => {
    const trimmed = buf.trim();
    if (trimmed) segs.push(trimmed);
    buf = "";
  };

  /** Read one shell word starting at `from` (skipping blanks). Returns the
   *  unquoted word and the index just past it, or null if there is none. */
  const readWord = (from: number): [string, number] | null => {
    let j = from;
    while (j < command.length && (command[j] === " " || command[j] === "\t")) j++;
    let w = "";
    let q: string | null = null;
    for (; j < command.length; j++) {
      const c = command[j];
      if (q) {
        if (c === q) q = null;
        else w += c;
      } else if (c === '"' || c === "'") {
        q = c;
      } else if (c === "\\" && j + 1 < command.length) {
        w += command[++j];
      } else if (/[\s;|&<>()]/.test(c)) {
        break;
      } else {
        w += c;
      }
    }
    if (q) return null;
    return w === "" ? null : [w, j];
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'" || c === '"') {                      // copy the quoted run verbatim
      buf += c;
      i++;
      let closed = false;
      for (; i < command.length; i++) {
        if (command[i] === "\\" && c === '"' && i + 1 < command.length) {
          buf += command[i] + command[++i];
          continue;
        }
        buf += command[i];
        if (command[i] === c) { closed = true; break; }
      }
      if (!closed) return null;                        // unbalanced quote
      continue;
    }
    if (c === "\\" && i + 1 < command.length) {
      buf += c + command[++i];
      continue;
    }
    // Substitutions are resolved before this call; any left are unparseable.
    if (c === "`" || (c === "$" && command[i + 1] === "(")) return null;
    if (c === "(" || c === ")") return null;           // subshell / grouping
    if (c === "<") {
      if (command[i + 1] === "<" || command[i + 1] === "(") return null;
      const r = readWord(i + 1);
      if (!r) return null;
      i = r[1] - 1;                                    // input redirection: reads only
      continue;
    }
    if (c === ">" || (c === "&" && command[i + 1] === ">")) {
      let j = i;
      if (c === "&") j++;                              // `&>`: stdout+stderr
      else buf = buf.replace(/(^|\s)\d+$/, "$1");      // `2>`: fd belongs to the operator
      j++;                                             // the `>`
      if (command[j] === ">") j++;                     // `>>`
      if (command[j] === "|") j++;                     // `>|`
      const dup = command[j] === "&";                  // `>&N`: descriptor duplication
      if (dup) j++;
      const r = readWord(j);
      if (!r) return null;
      const [target, next] = r;
      if (dup) {
        if (!/^\d+$/.test(target) && target !== "-") return null;
      } else if (!isNullDevice(target)) {
        // A real destination: bail, or collect it for the caller to judge.
        if (!redirectTargets) return null;
        redirectTargets.push(target);
      }
      i = next - 1;
      continue;
    }
    // A newline separates commands like `;`.
    if (c === "\n" || c === "\r") {
      push();
      continue;
    }
    // `&`, `|`, `;` and their doubled forms (`&&`, `||`, `;;`) end a segment.
    if (c === "&" || c === "|" || c === ";") {
      push();
      if (command[i + 1] === c) i++;
      continue;
    }
    buf += c;
  }
  push();
  return segs;
}

/** Shell keywords that introduce a command (`do rm x`, `if grep …`); stripped before classification. */
const KEYWORD_PREFIX = /^(?:!|do|then|else|elif|if|while|until)\s+/;
/** Shell keywords that are a whole segment and run nothing at all. */
const KEYWORD_ONLY = /^(?:done|fi|esac|do|then|else|;;)$/;
/** `for NAME in WORD…` loop header; runs no command itself. */
const FOR_HEADER = /^for\s+[A-Za-z_][A-Za-z0-9_]*(?:\s+in(?:\s[^\n\r]*)?)?$/;
/** A `NAME=VALUE` prefix; stripped so the following command is judged. */
const ASSIGN_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;|&<>]*)\s*/;

/**
 * Environment assignments that cannot change which code runs (locale, timezone, terminal size).
 * Any other assignment prefix (e.g. LD_PRELOAD, PATH, BASH_ENV) makes the segment not read-only.
 */
const INERT_ENV_ASSIGNMENT =
  /^(?:LC_[A-Z]+|LANG|LANGUAGE|TZ|COLUMNS|LINES|TERM)=/;
/** Programs that run another program; never read-only themselves. */
const COMMAND_LAUNCHERS = new Set([
  "env", "sudo", "doas", "nice", "ionice", "chrt", "nohup", "setsid",
  "stdbuf", "unbuffer", "timeout", "xargs", "time", "watch", "exec",
  "eval", "builtin", "source", ".", "bash", "sh", "zsh", "dash", "ksh",
]);

/** One segment of a split command line: read-only or not. */
function segmentIsReadOnly(segment: string): boolean {
  let seg = segment.trim();
  // Peel control keywords off the front until a command remains.
  for (let n = 0; n < 8; n++) {
    if (KEYWORD_ONLY.test(seg)) return true;           // `done`, `fi`, … run nothing
    if (FOR_HEADER.test(seg)) return true;             // loop header runs nothing
    const stripped = seg.replace(KEYWORD_PREFIX, "");
    if (stripped === seg) break;
    seg = stripped.trim();
  }
  if (seg === "") return true;
  // Peel `NAME=VALUE` prefixes. An assignment-only segment runs nothing; an assignment of a
  // non-inert variable before a command makes the segment not read-only.
  let sawUnknownAssignment = false;
  for (let n = 0; n < 16; n++) {
    const m = ASSIGN_PREFIX.exec(seg);
    if (!m) break;
    if (!INERT_ENV_ASSIGNMENT.test(m[0])) sawUnknownAssignment = true;
    seg = seg.slice(m[0].length).trim();
  }
  if (seg === "") return true;                 // assignments only: runs nothing
  if (sawUnknownAssignment) return false;      // becomes a command's environment
  const verb = seg.split(/\s+/)[0];
  if (COMMAND_LAUNCHERS.has(verb)) return false;
  if (!READ_ONLY_BASH_PATTERN.test(seg)) return false;
  // Layer 2: a verb with an argument classifier gets that classifier's verdict.
  for (const [verbPattern, classify] of BASH_ARG_CLASSIFIERS) {
    if (verbPattern.test(seg)) return classify(seg);
  }
  // Allowlisted verbs that write with `--output=FILE` / `-O FILE`.
  if (/(?:^|\s)(?:--output(?:[=\s]|$)|-O\b)/.test(seg)) return false;
  return true;
}

/**
 * True only when every command the line runs is on the read-only verb allowlist and
 * passes that verb's argument classifier; anything unknown or unparseable returns false.
 */
export function isReadOnlyBash(command: string): boolean {
  return isReadOnlyBashInner(command, 0);
}

/**
 * The argv of a command line that is exactly one simple command, or null. Used before
 * consulting the learned read-only store: redirections, pipelines, substitutions,
 * expansions, keyword prefixes and assignments all return null.
 */
export function singleSimpleArgv(command: string): string[] | null {
  if (!command || /[\n\r]/.test(command)) return null;
  const resolved = resolveSubstitutions(command, 0);
  if (resolved === null) return null;
  // Reject any redirection, including input redirection, before splitting.
  {
    let q: string | null = null;
    for (let i = 0; i < resolved.length; i++) {
      const c = resolved[i];
      if (q) {
        if (c === q) q = null;
      } else if (c === '"' || c === "'") {
        q = c;
      } else if (c === "\\") {
        i++;                                    // skip the escaped character
      } else if (c === "<" || c === ">") {
        return null;
      }
    }
  }
  const segments = splitTopLevel(resolved);
  if (segments === null || segments.length !== 1) return null;

  const seg = segments[0].trim();
  if (!seg) return null;
  // A keyword prefix means the segment is not a plain command invocation.
  if (KEYWORD_ONLY.test(seg) || FOR_HEADER.test(seg) || KEYWORD_PREFIX.test(seg)) return null;
  // `NAME=VALUE cmd` changes the environment the program runs in.
  if (ASSIGN_PREFIX.test(seg)) return null;

  // Quote-aware split into words, rejecting anything the shell would still expand.
  const argv: string[] = [];
  let word = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (quote) {
      if (c === quote) {
        quote = null;
        continue;
      }
      // A `$` inside double quotes still expands.
      if (quote === '"' && c === "$") return null;
      word += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      continue;
    }
    if (c === "\\") {
      if (i + 1 >= seg.length) return null;
      word += seg[++i];
      started = true;
      continue;
    }
    if (c === " " || c === "\t") {
      if (started) {
        argv.push(word);
        word = "";
        started = false;
      }
      continue;
    }
    // Expansion or globbing characters: the argv matched would not be the argv that runs.
    if (c === "$" || c === "`" || c === "*" || c === "?" || c === "[" || c === "]" ||
        c === "{" || c === "}" || c === "~" || c === "!" || c === "#") return null;
    if (c === ";" || c === "|" || c === "&" || c === "<" || c === ">" ||
        c === "(" || c === ")") return null;
    word += c;
    started = true;
  }
  if (quote) return null;
  if (started) argv.push(word);
  if (!argv.length) return null;

  // An argument containing whitespace or shell syntax is a code payload (`bash -lc '…'`),
  // so the argv no longer describes what runs.
  for (let i = 1; i < argv.length; i++) {
    if (/[\s;|&<>()$`{}[\]*?!#'"\\]/.test(argv[i])) return null;
  }
  return argv;
}

function isReadOnlyBashInner(command: string, depth: number): boolean {
  if (!command) return false;
  if (depth > 4) return false;                    // runaway nesting → bail
  // Multi-line commands are not read-only.
  if (/[\n\r]/.test(command)) return false;
  const resolved = resolveSubstitutions(command, depth);
  if (resolved === null) return false;
  const segments = splitTopLevel(resolved);
  if (segments === null || segments.length === 0) return false;
  return segments.every(segmentIsReadOnly);
}

// ── Effect-bounded Bash ───────────────────────────────────────────────
// A command whose every segment has its effect fully described by its arguments, all
// resolving inside the workspace, is already covered by the tier-3 snapshot and needs no
// tier-4 subagent. Commands that execute a program (interpreters, scripts, launchers) are
// never effect-bounded.

/**
 * Utilities whose complete effect is described by their arguments: they execute no other
 * program and touch nothing they were not given as an argument. Read-only verbs are
 * handled by segmentIsReadOnly and are not repeated here.
 */
const EFFECT_BOUNDED_UTILS: ReadonlySet<string> = new Set([
  // Filesystem mutation, fully described by the paths in argv.
  "mkdir", "rmdir", "rm", "unlink", "cp", "mv", "ln", "touch", "truncate",
  "chmod", "chown", "chgrp", "tee", "split", "mktemp",
  // Text and hash utilities that write only to a path they are given.
  "sort", "uniq", "cut", "tr", "comm", "join", "paste", "nl", "rev", "tac",
  "fold", "expand", "unexpand", "column", "diff", "cmp", "cksum", "sum",
  "md5sum", "sha1sum", "sha224sum", "sha256sum", "sha384sum", "sha512sum",
  "b2sum", "base64", "base32", "od", "hexdump", "xxd", "strings", "shuf",
  "seq", "sleep",
]);

/** Whether a word, resolved as a path, lies outside the workspace. */
function wordEscapesWorkspace(word: string, workspace: string): boolean {
  try {
    return outsideWorkspaceResolved(path.resolve(expandHome(word)), workspace);
  } catch {
    return true;                                  // unresolvable → assume out
  }
}

/** Whether a segment's verb is effect-bounded and every path argument lies inside the workspace. */
function segmentIsEffectBounded(segment: string, workspace: string): boolean {
  let seg = segment.trim();
  // Strip keyword prefixes, as in segmentIsReadOnly.
  for (let n = 0; n < 8; n++) {
    if (KEYWORD_ONLY.test(seg)) return true;      // `done`, `fi` — runs nothing
    if (FOR_HEADER.test(seg)) return true;        // loop header — runs nothing
    const stripped = seg.replace(KEYWORD_PREFIX, "");
    if (stripped === seg) break;
    seg = stripped.trim();
  }
  if (seg === "") return true;
  // Strip `NAME=VALUE` prefixes; a non-inert assignment before a command is not bounded.
  let sawUnknownAssignment = false;
  for (let n = 0; n < 16; n++) {
    const m = ASSIGN_PREFIX.exec(seg);
    if (!m) break;
    if (!INERT_ENV_ASSIGNMENT.test(m[0])) sawUnknownAssignment = true;
    seg = seg.slice(m[0].length).trim();
  }
  if (seg === "") return true;                  // assignments only: runs nothing
  if (sawUnknownAssignment) return false;

  const words = shellWords(seg);
  if (words === null || words.length === 0) return false;   // unparseable → out
  const verb = words[0];

  // ── The verb must not run a program. ──
  if (COMMAND_LAUNCHERS.has(verb)) return false;
  // A verb with a path component is an executable invoked by path.
  if (verb.includes("/")) return false;
  // Unknown verbs escalate; read-only verbs are checked with their layer-2 classifiers.
  if (!EFFECT_BOUNDED_UTILS.has(verb) && !segmentIsReadOnly(seg)) return false;

  // ── Every word must name something inside the workspace. ──
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    // An unexpanded variable or substitution hides its value.
    if (/[$`]/.test(w) || w.includes(SUBST_PLACEHOLDER)) return false;
    let candidate = w;
    if (i > 0 && w.startsWith("-")) {
      const eq = w.indexOf("=");
      if (eq !== -1) candidate = w.slice(eq + 1);  // `--output=/etc/x`
      else if (!w.includes("/")) continue;         // an ordinary flag
    }
    if (candidate === "") continue;
    if (wordEscapesWorkspace(candidate, workspace)) return false;
  }
  return true;
}

/**
 * Whether every effect of this Bash line is confined to the workspace and visible in its
 * arguments; any uncertainty returns false. Each line of a multi-line command is
 * classified separately; heredocs are rejected.
 */
export function bashIsEffectBounded(command: string, workspace: string): boolean {
  if (!command) return false;
  if (command.includes("<<")) return false;       // heredoc / herestring body
  const resolved = resolveSubstitutions(command, 0);
  if (resolved === null) return false;
  if (resolved.includes(SUBST_PLACEHOLDER)) return false;  // value is invisible
  const redirectTargets: string[] = [];
  const segments = splitTopLevel(resolved, redirectTargets);
  if (segments === null || segments.length === 0) return false;
  for (const target of redirectTargets) {
    if (/[$`]/.test(target)) return false;
    if (wordEscapesWorkspace(target, workspace)) return false;
  }
  return segments.every((s) => segmentIsEffectBounded(s, workspace));
}

function recentInputPath(config: SandboxConfig): string {
  return path.join(path.dirname(path.resolve(config.backupDir)), "recent-input.json");
}

/** Persist the most recent values typed into the browser, for use in the backup subagent prompt. */
export function recordBrowserInput(ctx: HookContext, config: SandboxConfig): void {
  try {
    const action = (ctx.tool_name.split("__").pop() || ctx.tool_name).toLowerCase();
    if (!/^browser_(type|fill_form|fill|select_option)$/.test(action)) return;
    const input = (ctx.tool_input ?? {}) as Record<string, unknown>;
    const values: string[] = [];
    const addValue = (v: unknown): void => {
      if (typeof v === "string" && v.trim() && v.length < 2000) values.push(v.trim());
    };
    addValue(input.text);
    addValue(input.value);
    if (Array.isArray(input.fields)) {
      for (const field of input.fields) addValue((field as { value?: unknown })?.value);
    }
    if (Array.isArray(input.values)) {
      for (const v of input.values) addValue(v);
    }
    if (!values.length) return;
    const file = recentInputPath(config);
    let history: { t: string; values: string[] }[] = [];
    try {
      history = JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch { /* no history yet */ }
    history.push({ t: new Date().toISOString(), values });
    history = history.slice(-12);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(history));
  } catch { /* best-effort — never block the action */ }
}

/** The recent typed values, newest last, deduplicated. */
export function loadRecentBrowserInput(config: SandboxConfig): string[] {
  try {
    const history = JSON.parse(fs.readFileSync(recentInputPath(config), "utf-8")) as { values: string[] }[];
    const out: string[] = [];
    for (const entry of history.slice(-8)) {
      for (const v of entry.values ?? []) out.push(v);
    }
    return [...new Set(out)].slice(-10);
  } catch {
    return [];
  }
}

function recentSnapshotPath(config: SandboxConfig): string {
  return path.join(path.dirname(path.resolve(config.backupDir)), "recent-snapshot.json");
}

/**
 * Cache the most recent browser page view (snapshot / navigate output), which holds the
 * pre-state of an entity about to be edited. Called from the post-tool hook.
 */
export function recordBrowserSnapshot(ctx: HookContext, config: SandboxConfig): void {
  try {
    const action = (ctx.tool_name.split("__").pop() || ctx.tool_name).toLowerCase();
    if (!/^browser_(snapshot|navigate|navigate_back)$/.test(action)) return;
    const out = ctx.tool_output;
    let text = typeof out === "string" ? out : "";
    if (!text && out && typeof out === "object") {
      const o = out as Record<string, unknown>;
      text = typeof o.result === "string" ? o.result
        : typeof o.content === "string" ? o.content
        : JSON.stringify(o);
    }
    if (!text || text.length < 20) return;
    const m = text.match(/Page URL:\s*(\S+)/i) || text.match(/https?:\/\/\S+/);
    const url = m ? (m[1] || m[0]) : "";
    // Store the full page; snapshots written to files are inlined (inlineSnapshotFiles).
    const snippet = inlineSnapshotFiles(text, config, ctx.cwd);
    const p = recentSnapshotPath(config);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ t: new Date().toISOString(), url, action, text: snippet }));
  } catch { /* best-effort — never block the action */ }
}

/**
 * Inline page snapshots that the browser MCP returned as file links (`[Snapshot](….yml)`),
 * since the files are evicted by later tool calls. An unreadable link is marked NOT CAPTURED;
 * a file too large to inline is copied into the backup store and the link rewritten.
 * Text without such a link is returned unchanged.
 */
const SNAPSHOT_FILE_LINK_RE = /\[Snapshot\]\(([^()\s]+?\.ya?ml)\)/g;
const SNAPSHOT_INLINE_MAX_BYTES = 80_000;

function resolveSnapshotFile(ref: string, cwd: string | undefined): string | null {
  const base = path.basename(ref);
  const cands: string[] = [];
  if (path.isAbsolute(ref)) cands.push(ref);
  const outDir = process.env.PLAYWRIGHT_MCP_OUTPUT_DIR;
  if (outDir) cands.push(path.join(outDir, base));
  if (cwd) cands.push(path.resolve(cwd, ref));
  cands.push(path.resolve("/", ref));          // relative link resolved from a depth-2 cwd
  for (const c of [...new Set(cands)]) {
    try {
      if (path.basename(c) === base && fs.statSync(c).isFile()) return c;
    } catch { /* next candidate */ }
  }
  return null;
}

function inlineSnapshotFiles(text: string, config: SandboxConfig, cwd: string | undefined): string {
  const refs = [...new Set([...text.matchAll(SNAPSHOT_FILE_LINK_RE)].map((m) => m[1]))];
  if (refs.length === 0) return text;
  let out = text;
  const blocks: string[] = [];
  for (const ref of refs) {
    const base = path.basename(ref);
    const file = resolveSnapshotFile(ref, cwd);
    let body = "";
    try {
      if (file) body = fs.readFileSync(file, "utf-8");
    } catch {
      body = "";
    }
    if (!file || !body.trim()) {
      blocks.push(
        `===== PAGE SNAPSHOT ${base} NOT CAPTURED: the linked file ${ref} was ` +
        `${file ? "empty" : "not readable"} when this page view was recorded ` +
        `(evicted by the Playwright MCP output budget, or on a filesystem this hook cannot see). ` +
        `The page's CONTENT is ABSENT from this PAGE_STATE — only the URL/title lines above are real. =====`);
      continue;
    }
    const bytes = Buffer.byteLength(body, "utf-8");
    if (bytes <= SNAPSHOT_INLINE_MAX_BYTES) {
      out = out.split(`](${ref})`).join(`](inlined below: PAGE SNAPSHOT ${base})`);
      blocks.push(
        `===== PAGE SNAPSHOT ${base} — the page as the agent saw it ` +
        `(inlined at capture time from ${file}, ${bytes} bytes) =====\n` +
        `${body.replace(/\n+$/, "")}\n===== END PAGE SNAPSHOT ${base} =====`);
    } else {
      const dest = path.join(path.dirname(recentSnapshotPath(config)), "page-snapshots", base);
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, body);
        out = out.split(`](${ref})`).join(`](${dest})`);
        blocks.push(
          `===== PAGE SNAPSHOT ${base} — the page as the agent saw it, ${bytes} bytes, too large ` +
          `to inline here: copied IN FULL at capture time to the LOCAL file ${dest}. ` +
          `Read that file (it is not a browser) for the pre-state. =====`);
      } catch {
        blocks.push(
          `===== PAGE SNAPSHOT ${base} NOT CAPTURED: ${bytes} bytes, too large to inline and the ` +
          `copy to ${dest} failed. The page's CONTENT is ABSENT from this PAGE_STATE. =====`);
      }
    }
  }
  return out + "\n" + blocks.join("\n");
}

/** Extract a compact JSON digest of editable form controls and their values from HTML;
 *  returns "" if none are found. */
function digestFormControls(html: string): string {
  try {
    const attr = (tagHtml: string, name: string): string | undefined => {
      const m = tagHtml.match(
        new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"),
      );
      if (!m) return undefined;
      return m[1] ?? m[2] ?? m[3];
    };
    const decode = (s: string): string =>
      s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
    const skip = (key: string | undefined): boolean => {
      if (!key) return false;
      const k = key.toLowerCase();
      // DROP: CSRF/_token fields, search box.
      return k.includes("csrf") || k.startsWith("_") || k === "q";
    };

    const controls: Array<Record<string, string>> = [];
    const push = (tag: string, key: string | undefined, type: string | undefined, value: string) => {
      const rec: Record<string, string> = { tag };
      if (key !== undefined) rec.name = key;
      if (type !== undefined) rec.type = type;
      rec.value = value.length > 300 ? value.slice(0, 300) : value;
      controls.push(rec);
    };

    // <textarea ...>inner text</textarea>
    for (const m of html.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
      const tagAttrs = m[1];
      const key = attr(tagAttrs, "name") ?? attr(tagAttrs, "id");
      if (skip(attr(tagAttrs, "name")) || skip(attr(tagAttrs, "id"))) continue;
      push("textarea", key, undefined, decode(m[2]).trim());
    }
    // <input ...>
    for (const m of html.matchAll(/<input\b([^>]*)>/gi)) {
      const tagAttrs = m[1];
      const type = (attr(tagAttrs, "type") ?? "text").toLowerCase();
      // DROP: hidden inputs, submit/button.
      if (type === "hidden" || type === "submit" || type === "button") continue;
      const key = attr(tagAttrs, "name") ?? attr(tagAttrs, "id");
      if (skip(attr(tagAttrs, "name")) || skip(attr(tagAttrs, "id"))) continue;
      push("input", key, type, decode(attr(tagAttrs, "value") ?? ""));
    }
    // <select ...>...</select> → value = the selected option (or first).
    for (const m of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
      const tagAttrs = m[1];
      const key = attr(tagAttrs, "name") ?? attr(tagAttrs, "id");
      if (skip(attr(tagAttrs, "name")) || skip(attr(tagAttrs, "id"))) continue;
      const body = m[2];
      let sel = body.match(/<option\b[^>]*\bselected\b[^>]*>([\s\S]*?)<\/option>/i);
      const selTag = body.match(/<option\b[^>]*\bselected\b[^>]*>/i);
      let value = "";
      if (selTag) value = attr(selTag[0], "value") ?? (sel ? decode(sel[1]).trim() : "");
      push("select", key, undefined, value);
    }

    if (controls.length === 0) return "";
    return JSON.stringify(controls);
  } catch {
    return "";
  }
}

/**
 * Before an opaque-code browser mutation (browser_run_code_unsafe / browser_evaluate), fetch the
 * pages whose URLs appear in the code with the seeded session cookies, and merge their editable
 * values into the snapshot cache that feeds PAGE_STATE. Best-effort.
 */
export function presnapshotCodeUrls(ctx: HookContext, config: SandboxConfig): void {
  try {
    const action = (ctx.tool_name.split("__").pop() || ctx.tool_name).toLowerCase();
    if (!/run_code|evaluate/.test(action)) return;
    const input = (ctx.tool_input ?? {}) as Record<string, unknown>;
    const code = String(input.code ?? input.function ?? input.expression ?? "");
    if (!code) return;

    // Parse candidate URLs/paths from the code.
    const urls = new Set<string>();
    // page.goto('...') / page.navigate('...') first arg
    for (const m of code.matchAll(/\.(?:goto|navigate)\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
      urls.add(m[1]);
    }
    // bare absolute URLs
    for (const m of code.matchAll(/https?:\/\/[^\s'"`)]+/g)) urls.add(m[0]);
    // string-literal absolute paths
    for (const m of code.matchAll(/['"`](\/[A-Za-z0-9][^'"`\s]*)['"`]/g)) urls.add(m[1]);
    if (urls.size === 0) return;

    // Base origin: the first absolute URL seen, else the origin of the cached snapshot.
    let base = "";
    for (const u of urls) {
      const mm = u.match(/^(https?:\/\/[^/]+)/);
      if (mm) {
        base = mm[1];
        break;
      }
    }
    if (!base) {
      const snap = loadRecentBrowserSnapshot(config, 30 * 60_000);
      const mm = snap?.url?.match(/^(https?:\/\/[^/]+)/);
      if (mm) base = mm[1];
    }

    // Resolve to absolute URLs (dedup), keep only http(s).
    const abs: string[] = [];
    for (const u of urls) {
      let full = u;
      if (!/^https?:\/\//.test(u)) {
        if (!base) continue;            // can't resolve a relative path
        full = base + (u.startsWith("/") ? u : "/" + u);
      }
      if (!abs.includes(full)) abs.push(full);
    }
    if (abs.length === 0) return;

    // Authenticated cookie jar from the environment's login seeding.
    const jar = process.env.SEED_COOKIE_JAR || "/tmp/wa-pw-profile/seed-cookies.txt";
    if (!fs.existsSync(jar)) return;    // no credentials available: leave the cache unchanged

    // Fetch each page (bounded count + size) and build a tagged blob.
    const parts: string[] = [];
    const MAX_URLS = 6;
    const MAX_BYTES = 200_000;          // per-page cap to keep the prompt bounded
    let captured = false;
    for (const url of abs.slice(0, MAX_URLS)) {
      try {
        const out = execSync(
          `curl -sS -L --max-time 15 -b ${JSON.stringify(jar)} ${JSON.stringify(url)}`,
          { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024, timeout: 20_000 },
        );
        if (out && out.length > 20) {
          const digest = digestFormControls(out);
          if (digest && digest.length > 2) {
            // Compact digest of editable form controls (original values), capped at ~1.5 KB.
            const blob = digest.length > 1500 ? digest.slice(0, 1500) : digest;
            parts.push(`\nPRE-CAPTURED FORM CONTROLS (authenticated GET) ${url} = ${blob}`);
            captured = true;
          } else {
            // No editable controls (e.g. a delete-confirmation page): keep a length-capped raw HTML slice.
            const body = out.length > MAX_BYTES ? out.slice(0, MAX_BYTES) : out;
            parts.push(`\n===== PRE-CAPTURED PAGE (authenticated GET) ${url} =====\n${body}`);
            captured = true;
          }
        }
      } catch { /* skip this URL */ }
    }
    if (!captured) return;

    // Merge into the recent-snapshot cache that feeds PAGE_STATE, keeping the existing view.
    const p = recentSnapshotPath(config);
    let prev: { url?: string; text?: string } = {};
    try { prev = JSON.parse(fs.readFileSync(p, "utf-8")); } catch { /* fresh */ }
    const merged = (prev.text ? prev.text + "\n" : "") + parts.join("\n");
    const urlField = prev.url || abs[0];
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({
      t: new Date().toISOString(),
      url: urlField,
      action: "presnapshot_code",
      text: merged,
    }));
  } catch { /* best-effort — never block the action */ }
}

/** The agent's last page view if fresh, else null (the subagent then reports UNVERIFIED). */
export function loadRecentBrowserSnapshot(
  config: SandboxConfig, maxAgeMs = 10 * 60_000,
): { url: string; text: string; t: string } | null {
  try {
    const s = JSON.parse(fs.readFileSync(recentSnapshotPath(config), "utf-8")) as { t: string; url: string; text: string };
    if (!s || !s.text) return null;
    const age = Date.now() - new Date(s.t).getTime();
    if (Number.isFinite(age) && age > maxAgeMs) return null;  // stale: not trustworthy pre-state
    return s;
  } catch {
    return null;
  }
}

// =====================================================================
// Tier-4 (cheap): a create whose learned pattern carries a deterministic `reverter`
// records its native MCP inverse (e.g. create_directory → delete_directory), with no subagent.
// =====================================================================

/** Build the rawDesc the gate/matcher use to key learned patterns. */
function rawDescForMatch(ctx: HookContext): string {
  const input = (ctx.tool_input ?? {}) as Record<string, unknown>;
  return [
    ctx.tool_name, input.element, input.text, input.selector, input.name,
    input.command, input.sql, input.query, input.path, input.source, input.destination,
  ].filter(Boolean).map(String).join(" ").toLowerCase();
}

/**
 * The minimal MCP tool allowlist a capture subagent needs for this action, from the learned
 * experience: the pattern's `capture_tools`, else the action's tool plus a few read tools
 * (at most 5). Returns undefined when no experience matches (server left unfiltered).
 */
export function minimalToolAllow(ctx: HookContext, config: SandboxConfig): string[] | undefined {
  const server = serverFromToolName(ctx.tool_name);
  if (!server) return undefined;
  const expName = experienceNameForServer(config, server);
  if (!expName) return undefined;
  const exp = loadExperiences(config, expName);
  if (!exp) return undefined;
  const seg = (t: string): string => (t.split("__").pop() || t).toLowerCase();
  const pat = matchPattern(config, expName, ctx.tool_name, rawDescForMatch(ctx));

  // Preferred: the learned `capture_tools` for this pattern, used verbatim after intersecting
  // with the observed tools; if nothing survives, fall through to the heuristic below.
  if (pat?.capture_tools && pat.capture_tools.length) {
    const observed = new Set((exp.observed_tools ?? []).map(seg));
    const learned = pat.capture_tools.filter((t) => observed.has(seg(t)));
    if (learned.length) return learned;
  }

  // Fallback: the action's own tool plus read tools.
  const allow = new Set<string>();
  allow.add(seg(ctx.tool_name));                       // the action's own tool
  const READ_LIKE = /(^|_)(read|get|cat|stat|info|list|search|find|show|view)(_|$)/;
  for (const t of exp.readOnlyTools ?? []) {           // read/snapshot tools (to capture pre-state)
    if (allow.size >= 5) break;
    if (READ_LIKE.test(seg(t))) allow.add(seg(t));
  }
  const out = [...allow].slice(0, 5);
  return out.length ? out : undefined;
}

/**
 * Deterministic create reverter: when the matched learned pattern is a create with a
 * `reverter`, record its inverse (a native MCP call on the same server, or a guarded command),
 * pinned by a stable identifier resolved from the captured input. Returns null, deferring to
 * the capture subagent, when the identifier cannot be resolved unambiguously.
 */
export function tryPatternCreateReverter(
  ctx: HookContext,
  config: SandboxConfig,
): BackupArtifact | null {
  const server = serverFromToolName(ctx.tool_name);
  if (!server) return null;                          // not a remote / MCP action
  const expName = experienceNameForServer(config, server);
  if (!expName) return null;
  const pat = matchPattern(config, expName, ctx.tool_name, rawDescForMatch(ctx));
  const rev = pat?.reverter;
  if (!rev || !rev.pin) return null;                 // no deterministic create-inverse
  if (!(rev.commands?.length) && !(rev.mcp_calls?.length)) return null;

  // Resolve the pinned identifier from the action's own arguments (exact key, then case-insensitive).
  const input = (ctx.tool_input ?? {}) as Record<string, unknown>;
  const pin = rev.pin.trim();
  const pinLc = pin.toLowerCase();
  const stringify = (v: unknown): string | null => {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    return null;
  };
  let pinned: string | null = stringify(input[pin]);
  if (pinned === null) {
    for (const [k, v] of Object.entries(input)) {
      if (k.toLowerCase() === pinLc) {
        pinned = stringify(v);
        break;
      }
    }
  }
  // Browser creates: use the recently typed text only if there is exactly one candidate.
  if (pinned === null) {
    try {
      const recent = loadRecentBrowserInput(config);
      if (recent.length === 1) pinned = recent[0];
    } catch { /* optional */ }
  }
  if (pinned === null) return null;                  // unresolved: fall through to the subagent

  // Refuse pinned values containing quotes, statement separators, comment markers, backslashes
  // or newlines, since they are spliced into the recorded inverse; defer to the subagent instead.
  if (/['"`;\\\n\r\x00]|--|\/\*|\*\//.test(pinned)) {
    if (config.verbose) {
      process.stderr.write(
        "[BackUpper] create reverter: pin has injection-prone chars — deferring to subagent\n",
      );
    }
    return null;
  }

  const description =
    `Deterministic create reverter (${server}): delete the created entity pinned by ${pin}=${pinned.slice(0, 80)}`;

  // MCP-call inverse: substitute the pinned value into "<...>" placeholders and replay on the same server.
  if (rev.mcp_calls?.length) {
    const fill = (v: unknown): unknown =>
      (typeof v === "string" && /<[^>]*>/.test(v)) ? v.replace(/<[^>]*>/g, pinned!) : v;
    const calls = rev.mcp_calls.map((c) => ({
      server,
      tool: c.tool,
      args: Object.fromEntries(Object.entries(c.args ?? {}).map(([k, v]) => [k, fill(v)])),
    }));
    return recordDeterministicArtifact(ctx, config, { recoveryMcpCalls: calls, description });
  }

  // Command inverse: substitute the pinned value, then check each command with isDangerousRecoveryCommand.
  const cmds = rev.commands!.map((c) => c.replace(/<[^>]*>/g, pinned!));
  for (const cmd of cmds) {
    if (isDangerousRecoveryCommand(cmd)) return null; // refused: fall through to the subagent
  }
  return recordDeterministicArtifact(ctx, config, { recoveryCommands: cmds, description });
}

/** Record a tier-4 artifact carrying a deterministic reversal, either recoveryCommands or
 *  recoveryMcpCalls, which restore replays without a subagent. */
function recordDeterministicArtifact(
  ctx: HookContext,
  config: SandboxConfig,
  parts: {
    recoveryCommands?: string[];
    recoveryMcpCalls?: Array<{ server?: string; tool: string; args: Record<string, unknown> }>;
    description: string;
  },
): BackupArtifact {
  const dir = materializeActionDir(config);
  const artifact: BackupArtifact = {
    id: makeId(),
    timestamp: new Date().toISOString(),
    trigger: "rule",
    toolName: ctx.tool_name,
    description: parts.description,
    strategy: "subagent",
    artifactPath: dir,
    liveRestore: false,
    originalAction: describeToolAction(ctx.tool_name, ctx.tool_input),
    ...(parts.recoveryCommands ? { recoveryCommands: parts.recoveryCommands } : {}),
    ...(parts.recoveryMcpCalls ? { recoveryMcpCalls: parts.recoveryMcpCalls } : {}),
  };
  writeMetadata(dir, artifact);
  return artifact;
}

/**
 * Append the agent's declaration to `.backupper/declarations.jsonl` for later analysis;
 * nothing reads it back. Best-effort.
 */
function recordDeclaration(
  ctx: HookContext,
  config: SandboxConfig,
  declaration: BackupDeclaration,
): void {
  try {
    const sandboxRoot = path.dirname(path.resolve(config.backupDir));
    fs.mkdirSync(sandboxRoot, { recursive: true });
    fs.appendFileSync(
      path.join(sandboxRoot, "declarations.jsonl"),
      JSON.stringify({
        recordedAt: new Date().toISOString(),
        sessionId: ctx.session_id ?? null,
        toolName: ctx.tool_name,
        surface: declaration.surface,
        malformed: declaration.malformed,
        declared: declaration.text,
        raw: declaration.raw,
        // The action: command or sql when present, else the whole input.
        action: String(
          (ctx.tool_input as { command?: unknown; sql?: unknown }).command ??
          (ctx.tool_input as { sql?: unknown }).sql ??
          JSON.stringify(ctx.tool_input ?? {}),
        ).slice(0, 400),
        mode: config.mode,
      }) + "\n",
      "utf-8",
    );
  } catch { /* non-fatal */ }
}

/** Flatten an absolute path into one filename. */
function snapName(abs: string): string {
  return abs.replace(/^\//, "").replace(/[^A-Za-z0-9._-]/g, "_").slice(-160);
}

const LOCAL_TARGETS = new Set(["", "local", "host", "self", "same"]);

/** True when the agent's tool calls execute on a different filesystem from this process
 *  (e.g. commands run inside a task container via docker exec). */
function isForeignExec(): boolean {
  const explicit = (process.env.BACKUPPER_EXEC_TARGET ?? "").trim().toLowerCase();
  const te = (process.env.TERMINAL_ENV ?? "").trim().toLowerCase();
  return (explicit !== "" && !LOCAL_TARGETS.has(explicit)) ||
    (explicit === "" && te !== "" && !LOCAL_TARGETS.has(te)) ||
    process.env.BACKUPPER_REMOTE_EXEC === "1";
}

/** The container the agent's commands run in, when they run elsewhere; null locally. */
function foreignContainer(): string | null {
  if (!isForeignExec()) return null;
  const cid = (process.env.HERMES_TERMINAL_DOCKER_ADOPT
            ?? process.env.BACKUPPER_CONTAINER ?? "").trim();
  return cid !== "" ? cid : null;
}

/** The agent's working directory inside the container, used to resolve relative paths. */
function containerCwd(): string {
  return (process.env.TERMINAL_CWD ?? "").trim();
}

/** Copy a file out of the container onto a host path with `docker cp`. */
function containerCopyOut(cid: string, abs: string, dest: string): boolean {
  try {
    const r = spawnSync("docker", ["cp", cid + ":" + abs, dest],
      { encoding: "utf-8", timeout: 120000 });
    return !!r && r.status === 0 && fs.existsSync(dest);
  } catch {
    return false;
  }
}

/** [size, mode] of a regular file inside the container, or null. */
function containerStat(cid: string, abs: string): [number, number] | null {
  try {
    const r = spawnSync("docker", ["exec", cid, "stat", "-c", "%F|%s|%a", abs],
      { encoding: "utf-8", timeout: 30000 });
    if (!r || r.status !== 0) return null;
    const m = /^([^|]*)\|([0-9]+)\|([0-7]+)$/.exec(String(r.stdout ?? "").trim());
    if (!m || !/^regular/.test(m[1])) return null;
    return [parseInt(m[2], 10), parseInt(m[3], 8)];
  } catch {
    return null;
  }
}

/** Largest file copied inline; larger files fall through to tier 4. */
const EXTERNAL_COPY_MAX_BYTES = 64 * 1024 * 1024;

/** Path of the ledger mapping each absolute path to the artifact holding its pre-agent state. */
function externalLedgerPath(config: SandboxConfig): string {
  return path.join(path.dirname(path.resolve(config.backupDir)), "external-copies.json");
}

function readExternalLedger(config: SandboxConfig): Record<string, string> {
  try {
    const v = JSON.parse(fs.readFileSync(externalLedgerPath(config), "utf-8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function writeExternalLedger(config: SandboxConfig, abs: string, dest: string): void {
  try {
    const ledger = readExternalLedger(config);
    ledger[abs] = dest;
    const p = externalLedgerPath(config);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(ledger, null, 1), "utf-8");
  } catch { /* non-fatal: worst case is one redundant copy */ }
}

/**
 * Copy the single out-of-workspace file an Edit/Write is about to change. Returns null when
 * the case is not mechanically decidable, leaving the action to tier 4.
 */
function tryExternalFileSnapshot(
  ctx: HookContext,
  config: SandboxConfig,
): BackupArtifact | null {
  const MUTATORS = new Set(["Edit", "Write", "write_file", "patch", "NotebookEdit"]);

  // Only Edit/Write-style tools; Bash goes to tier 4.
  if (!MUTATORS.has(ctx.tool_name)) return null;

  const input = ctx.tool_input as { file_path?: unknown; path?: unknown };
  const raw = typeof input.file_path === "string" ? input.file_path
            : typeof input.path === "string" ? input.path : null;
  if (!raw) return null;

  // Decide which filesystem holds the target: local (copy directly), a foreign container
  // (stat and copy through it), or foreign without a container (return null).
  const cid = foreignContainer();
  if (isForeignExec() && !cid) return null;

  let abs: string;
  let size: number;
  let mode: number;
  if (cid) {
    const ccwd = containerCwd();
    // A relative path is relative to the container's working directory.
    if (!raw.startsWith("/")) {
      if (!ccwd) return null;
      abs = path.posix.normalize(path.posix.join(ccwd, raw));
    } else {
      abs = path.posix.normalize(raw);
    }
    // The container's working directory is covered by tier 3.
    if (ccwd && (abs === ccwd || abs.startsWith(ccwd + "/"))) return null;
    // So is the host run directory, which is bind-mounted into the container.
    const hostWs = path.resolve(process.cwd());
    if (abs === hostWs || abs.startsWith(hostWs + path.sep)) return null;
    const cst = containerStat(cid, abs);
    if (!cst) return null;
    size = cst[0];
    mode = cst[1];
    if (size > EXTERNAL_COPY_MAX_BYTES) return null;
  } else {
    abs = path.resolve(raw);
    const ws = path.resolve(process.cwd());
    // Paths inside the workspace are covered by tier 3.
    if (abs === ws || abs.startsWith(ws + path.sep)) return null;
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      return null;
    }
    if (!st.isFile() || st.size > EXTERNAL_COPY_MAX_BYTES) return null;
    size = st.size;
    mode = st.mode & 0o7777;
  }

  const dir = materializeActionDir(config);
  // A fresh copy at every step: this action's artifact must be the file as it was right
  // before THIS call, so `restore N` lands on the state before step N (a reused first copy
  // would rewind to the pre-session state instead). The ledger is bookkeeping only.
  const prior = readExternalLedger(config)[abs];
  // Name the copy after the whole path plus its hash, so neither two files with the same
  // basename nor two paths that sanitise to the same name collide.
  const dest = path.join(dir, `${snapName(abs)}-${shortHash(abs)}.pre-action`);
  try {
    // Copy the bytes, then restore the file mode (neither copy method preserves it);
    // the mode is also recorded in the description.
    if (cid) {
      if (!containerCopyOut(cid, abs, dest)) return null;
    } else {
      fs.copyFileSync(abs, dest);
    }
    try { fs.chmodSync(dest, mode & 0o7777); } catch { /* best effort */ }
    if (!prior || !fs.existsSync(prior)) writeExternalLedger(config, abs, dest);
  } catch {
    return null;
  }

  return {
    id: makeId(),
    timestamp: new Date().toISOString(),
    trigger: "rule",
    toolName: ctx.tool_name,
    description: `external file snapshot \u2192 ${path.basename(dest)} (${abs}, ${size} bytes,`
        + ` mode 0${(mode & 0o7777).toString(8)}`
        + `${cid ? ", from container " + cid : ""})`,
    strategy: "file_copy",
    artifactPath: dest,
    targetPath: abs,
    ...(cid ? { containerId: cid } : {}),
  };
}

/** Run the backup tiers for one tool call (see runBackupTiers). */
export function runBackup(
  ctx: HookContext,
  config: SandboxConfig
): BackupResult {
  // Deferred generalizations run after all tiers have finished, on every return path.
  try {
    const r = runBackupTiers(ctx, config);
    if (r.uncovered && !r.uncoveredHandled && !r.deny) {
      // Nothing captured these effects: say so in the action, so `list`/`show` flag it and
      // `restore` names what it cannot bring back instead of reporting a silent [OK].
      try {
        const dir = materializeActionDir(config);
        r.actionDir = dir;
        fs.writeFileSync(path.join(dir, "incomplete.json"), JSON.stringify(r.uncovered, null, 2) + "\n", "utf-8");
        if (!fs.existsSync(path.join(dir, "metadata.json"))) fs.writeFileSync(path.join(dir, "metadata.json"), "[]\n", "utf-8");
        r.incomplete = r.uncovered;
      } catch { /* best-effort */ }
    }
    return r;
  } finally {
    flushDeferredGeneralizations();
  }
}

/**
 * A database client running only queries (no mutating verb, no output redirect). Such a call
 * still escalates to tier 4 like before, but is not recorded as an uncaptured change.
 */
function dbQueryOnly(text: string): boolean {
  return DB_CLIENT.test(text) && !DB_MUTATING_VERB.test(text) && !/\\copy/i.test(text) &&
    (wordsAndRedirects(text)?.redirects ?? ["?"]).length === 0;
}

/** What a call that escalates past tiers 1-3 may change: the call itself and the paths it names. */
function uncoveredForCall(ctx: HookContext): IncompleteCapture | undefined {
  const input = ctx.tool_input as Record<string, unknown>;
  if (ctx.tool_name === "Bash") {
    const cmd = String(input.command ?? "");
    if (dbQueryOnly(cmd)) return undefined;
    return {
      reason: "a command with effects outside the workspace snapshot that no rule captured",
      segments: [cmd.slice(0, 500)],
      paths: segmentPaths(cmd, process.cwd()),
    };
  }
  const p = [input.file_path, input.path, input.target, input.destination].find((x) => typeof x === "string") as string | undefined;
  return {
    reason: "a tool call with effects outside the workspace snapshot that no tier captured",
    segments: [describeToolAction(ctx.tool_name, input)],
    paths: p ? [path.resolve(expandHome(p))] : [],
  };
}

/** Path-like operands and redirect targets of a command, resolved against `cwd`. */
function segmentPaths(text: string, cwd: string | null): string[] {
  const parsed = wordsAndRedirects(text);
  if (!parsed) return [];
  const out: string[] = [];
  const cand = [...parsed.words.slice(1).filter((w) => !w.startsWith("-")), ...parsed.redirects];
  for (const w of cand) {
    if (/[$`]/.test(w) || w === "") continue;
    const e = expandHome(w);
    if (path.isAbsolute(e)) out.push(path.resolve(e));
    else if (cwd && (w.includes("/") || fs.existsSync(path.resolve(cwd, e)))) out.push(path.resolve(cwd, e));
  }
  return [...new Set(out)].slice(0, 50);
}

/**
 * Capture each segment of a compound command copy-only: tier-1 rules run in backup-only mode in
 * the segment's own directory, and write-redirect targets outside the workspace are copied.
 * A segment is covered when a rule captured it, it is read-only, or its effects are confined to
 * the workspace (tier 3 takes those). The rest are returned as uncovered.
 */
function captureCompoundSegments(
  ctx: HookContext,
  segments: CmdSegment[],
  trashDir: string,
  storeRoot: string,
  applyPolicyRules: (c: HookContext, t: string, s?: string, o?: { rewrite?: boolean }) => import("./policy_rules.js").PolicyRuleResult | null,
): { artifacts: BackupArtifact[]; uncovered: Array<{ text: string; paths: string[] }>; deny?: string } {
  const workspace = path.resolve(process.cwd());
  const artifacts: BackupArtifact[] = [];
  const uncovered: Array<{ text: string; paths: string[] }> = [];
  const home = process.cwd();
  const { copyVictimsToTrash } = require("./policy_rules_extra.js") as typeof import("./policy_rules_extra.js");
  const record = (seg: CmdSegment, r: import("./policy_rules.js").PolicyRuleResult): void => {
    artifacts.push({
      id: r.ruleId.slice(0, 8),
      timestamp: new Date().toISOString(),
      trigger: "rule",
      toolName: ctx.tool_name,
      description: `[segment \`${seg.text.slice(0, 80)}\`] ${r.description}`,
      strategy: "policy_rewrite",
      artifactPath: trashDir,
      recoveryCommands: r.recoveryCommands,
      policyRuleId: r.ruleId,
      originalAction: describeToolAction(ctx.tool_name, ctx.tool_input),
      backupOnly: true,
      segment: seg.text.slice(0, 300),
      ...(r.captures?.length ? { captures: r.captures } : {}),
    });
  };
  try {
    for (const seg of segments) {
      if (seg.noop) continue;
      if (seg.unparseable) {
        if (!isReadOnlyBash(seg.text)) uncovered.push({ text: `${seg.text} (${seg.unparseable})`, paths: segmentPaths(seg.text, seg.cwd) });
        continue;
      }
      if (seg.cwd === null) {
        if (!isReadOnlyBash(seg.text)) uncovered.push({ text: `${seg.text} (directory unknown)`, paths: [] });
        continue;
      }
      let cwdOk = false;
      try { cwdOk = fs.statSync(seg.cwd).isDirectory(); } catch { /* created by an earlier segment */ }
      const inWorkspace = seg.cwd === workspace || seg.cwd.startsWith(workspace + path.sep);
      if (!cwdOk) {
        // The directory does not exist yet, so nothing in it predates the command.
        if (!inWorkspace && !isReadOnlyBash(seg.text)) uncovered.push({ text: `${seg.text} (in ${seg.cwd}, created by this command)`, paths: [] });
        continue;
      }
      process.chdir(seg.cwd);
      let covered = false;
      // Write redirects onto existing files outside the workspace: copy them.
      const outsideTargets: string[] = [];
      let redirectsOk = true;
      for (const t of seg.redirects) {
        if (/[$`*?]/.test(t)) { redirectsOk = false; continue; }
        const abs = path.resolve(seg.cwd, expandHome(t));
        if (abs === workspace || abs.startsWith(workspace + path.sep)) continue;   // tier 3
        if (abs.startsWith("/dev/") || abs.startsWith("/proc/")) continue;
        try { if (fs.lstatSync(abs).isFile()) outsideTargets.push(abs); } catch { /* created by the call */ }
      }
      if (outsideTargets.length) {
        const copied = copyVictimsToTrash([...new Set(outsideTargets)], trashDir, "redirect", storeRoot);
        if (copied) {
          record(seg, {
            preCommands: copied.preCommands, recoveryCommands: copied.recoveryCommands, captures: copied.captures,
            description: `copied ${outsideTargets.length} redirect target(s) before the write`, ruleId: "redirect-target",
          });
        } else redirectsOk = false;
      }
      const segCtx: HookContext = { ...ctx, tool_input: { ...ctx.tool_input, command: seg.text } };
      const r = applyPolicyRules(segCtx, trashDir, storeRoot, { rewrite: false });
      if (r?.deny) return { artifacts: [], uncovered: [], deny: r.deny };
      if (r) {
        record(seg, r);
        covered = true;
      } else if (isReadOnlyBash(seg.text) || dbQueryOnly(seg.text)) {
        covered = true;
      } else if (inWorkspace && bashIsEffectBounded(seg.text.replace(/\s*(?:\d|&)?>>?\|?\s*\S+/g, ""), workspace)) {
        covered = true;   // the workspace snapshot holds the pre-state
      } else if (seg.text.trim().replace(/^(?::|true)\s*/, "").startsWith(">") && outsideTargets.length) {
        covered = true;   // a bare `> file`: the redirect copy is the capture
      }
      if (!redirectsOk) covered = false;
      if (!covered) uncovered.push({ text: seg.text, paths: segmentPaths(seg.text, seg.cwd) });
    }
  } finally {
    try { process.chdir(home); } catch { /* stays where it was */ }
  }
  return { artifacts, uncovered };
}

/**
 * Run backup strategies in order: tier 1 command rewriting, tier 3 snapshot, tier 2
 * command pairing, external file copy, then the tier-4 gate and subagent. Action folders are
 * created only when an artifact is produced.
 */
function runBackupTiers(
  ctx: HookContext,
  config: SandboxConfig
): BackupResult {
  // The agent's own declaration, if any, found in any string of the tool_input.
  const declaration = findDeclaration(ctx);

  // Record typed browser input before the read-only short-circuit; it pins a later create.
  recordBrowserInput(ctx, config);

  // For opaque-code browser mutations, pre-capture the pages named in the code (presnapshotCodeUrls).
  try {
    const action = (ctx.tool_name.split("__").pop() || ctx.tool_name).toLowerCase();
    if (/run_code|evaluate/.test(action)) presnapshotCodeUrls(ctx, config);
  } catch { /* never block the action */ }

  // Read-only tools cannot mutate anything.
  if (READ_ONLY_TOOLS.has(ctx.tool_name)) {
    return { artifacts: [], needsSubagent: false };
  }

  // The declaration is used only for the tier-4 gate and this record; the subagent never sees it.
  if (declaration) recordDeclaration(ctx, config, declaration);
  // A declaration overrides the inferred read-only checks below, but not READ_ONLY_TOOLS.
  const declaredOverride = declaration !== null;

  // MCP tools with a read-only verb.
  if (isReadOnlyMcpTool(ctx.tool_name) && !declaredOverride) {
    return { artifacts: [], needsSubagent: false };
  }

  // Read-only Bash commands.
  if (ctx.tool_name === "Bash") {
    const cmd = String((ctx.tool_input as { command?: unknown }).command ?? "");
    if (isReadOnlyBash(cmd) && !declaredOverride) {
      return { artifacts: [], needsSubagent: false };
    }
  }

  // Personalization: the preference-scoped checker decides whether this action touches qualifying
  // state; if so, the action proceeds through the tiers with the preference as the capture scope.
  let personalizationDecision: import("./personalization.js").PersonalizationDecision | null = null;
  if (config.personalization) {
    const { runPersonalizationChecker } = require("./personalization.js");
    // A declared action bypasses the checker and is treated as in scope.
    const decision = declaration
      ? {
          readOnly: false,
          targets: ["State affected by the tagged action that meets the user backup preference"],
          why: "main-agent-tag: checker bypassed",
        }
      : runPersonalizationChecker(ctx, config);
    if (decision.readOnly) return { artifacts: [], needsSubagent: false };
    personalizationDecision = decision;
  }

  // Reserve a pending action name without creating the folder.
  preparePendingAction(config);
  const result: BackupResult = { artifacts: [], needsSubagent: false };

  // ── Tier 1: command rewriting ──────────────────────────────────────────
  // Destructive commands are rewritten into reversible equivalents (e.g. mv to a per-action
  // trash) on hosts that apply a rewritten input. On hosts that do not (Codex), or with
  // BACKUPPER_NO_REWRITE=1, the rules run in backup-only mode: they capture a restorable copy,
  // execute nothing, and the host runs the original command once.
  const { tier1Mode } = require("../agents/capabilities.js");
  // "chain" (a non-bypass permission mode): the host may still deny or ask about the call, so
  // the hook executes nothing and returns `<copies> && <original command>` instead.
  const originalCommand = ctx.tool_name === "Bash" ? String(ctx.tool_input.command ?? "") : "";
  const mode: "rewrite" | "chain" | "backup-only" = tier1Mode(ctx.permission_mode);
  const chain = mode === "chain" && ctx.tool_name === "Bash" && !originalCommand.includes("\n");
  const rewrite: boolean = mode === "rewrite";
  const { applyPolicyRules } = require("./policy_rules.js");
  const pendingDir = path.join(path.resolve(config.backupDir), _pendingActionName ?? "");
  const trashDir = path.join(pendingDir, "trash");
  // The sandbox store root, excluded from the victim sets of rules that move or delete paths.
  const sandboxStoreRoot = path.dirname(path.resolve(config.backupDir));

  // ── Compound commands: capture each segment, copy-only; the command runs unchanged ──
  let compoundUncovered: IncompleteCapture | null = null;
  const compoundPlan = ctx.tool_name === "Bash"
    ? planCommand(String(ctx.tool_input.command ?? ""), process.cwd())
    : null;
  if (compoundPlan && compoundPlan.compound) {
    const cap = captureCompoundSegments(ctx, compoundPlan.segments, trashDir, sandboxStoreRoot, applyPolicyRules);
    if (cap.deny) return { artifacts: [], needsSubagent: false, deny: cap.deny };
    if (cap.artifacts.length) {
      const dir = materializeActionDir(config);
      result.actionDir = dir;
      for (const a of cap.artifacts) {
        result.artifacts.push(a);
        writeMetadata(dir, a);
      }
    }
    if (cap.uncovered.length) {
      compoundUncovered = {
        reason: "segments of a compound command that no rule captured and the workspace snapshot does not cover",
        segments: cap.uncovered.map((u) => u.text),
        paths: [...new Set(cap.uncovered.flatMap((u) => u.paths))],
      };
    }
  }

  let deferred: Array<{ command: string; src: string; dest: string }> = [];
  let policyResult = null;
  if (!compoundPlan?.compound) {
    if (chain) {
      const { withDeferredCopies } = require("./policy_rules_extra.js");
      const d = withDeferredCopies(() => applyPolicyRules(ctx, trashDir, sandboxStoreRoot, { rewrite: false }));
      policyResult = d.result;
      deferred = d.commands;
    } else {
      policyResult = applyPolicyRules(ctx, trashDir, sandboxStoreRoot, { rewrite });
    }
  }
  if (policyResult && !policyResult.deny && deferred.length > 0) {
    // Copies first, through hooks/capture.js (see there); `&&` keeps the original from running
    // if a copy fails. The original is passed verbatim so the host's permission rules still
    // match it.
    const { captureCommandPrefix } = require("../agents/capabilities.js");
    const q = (x: string) => /^[\w\/.@+:=,-]+$/.test(x) ? x : `'${x.replace(/'/g, "'\\''")}'`;
    const copy = `${captureCommandPrefix()} ${deferred.map((c) => `${q(c.src)} ${q(c.dest)}`).join(" ")}`;
    policyResult.updatedInput = { ...ctx.tool_input, command: `${copy} && ${originalCommand}` };
    policyResult.preCommands = [copy];
  }
  if (policyResult && policyResult.deny) {
    return { artifacts: [], needsSubagent: false, deny: policyResult.deny };
  }
  if (policyResult) {
    const dir = materializeActionDir(config);
    result.actionDir = dir;
    const artifact: BackupArtifact = {
      id: policyResult.ruleId.slice(0, 8),
      timestamp: new Date().toISOString(),
      trigger: "rule",
      toolName: ctx.tool_name,
      description: policyResult.description,
      strategy: "policy_rewrite",
      artifactPath: trashDir,
      recoveryCommands: policyResult.recoveryCommands,
      policyRuleId: policyResult.ruleId,
      originalAction: describeToolAction(ctx.tool_name, ctx.tool_input),
      ...(policyResult.backupOnly ? { backupOnly: true } : {}),
      ...(policyResult.captures?.length ? { captures: policyResult.captures } : {}),
      ...(deferred.length ? { deferredCopies: deferred.map((c) => c.dest) } : {}),
    };
    result.artifacts.push(artifact);
    if (policyResult.updatedInput) result.updatedInput = policyResult.updatedInput;
    writeMetadata(dir, artifact);
    // A rewrite ends the pipeline unless the rule sets preserveLowerTiers (partial recovery).
    if (!policyResult.preserveLowerTiers) {
      return result;
    }
  }

  // A positive personalization decision escalates like a declaration. For a compound
  // command only the segments no rule captured escalate.
  const outsideWorkspace = personalizationDecision !== null || (compoundPlan?.compound
    ? compoundUncovered !== null
    : touchesOutsideWorkspace(ctx, config));
  // What tier 4 must capture; recorded as not captured when nothing below does.
  result.uncovered = compoundUncovered ?? (outsideWorkspace ? uncoveredForCall(ctx) : undefined);

  // ── Tier 3: snapshot (returns null when nothing changed) ──
  const gitSnapshot = gitSnapshotBackup(ctx, config);
  if (gitSnapshot) {
    const dir = materializeActionDir(config);
    result.actionDir = dir;
    if (_lastSnapshotMeta) {
      const metaFile = path.join(dir, `snapshot-meta-${gitSnapshot.id}.json`);
      if (writeTreeMeta(metaFile, _lastSnapshotMeta)) gitSnapshot.metaPath = metaFile;
      _lastSnapshotMeta = null;
    }
    result.artifacts.push(gitSnapshot);
    writeMetadata(dir, gitSnapshot);
    generalizeAfterNativeRule(ctx, dir, gitSnapshot, config);
  }

  // ── Tier 2: command pairing, for known command patterns ─
  const targetedFn = () => {
    const dir = materializeActionDir(config);
    result.actionDir = dir;
    return tryTargetedManifest(ctx, dir);
  };
  const command = String(ctx.tool_input.command ?? "");
  const hasTargetedPattern =
    /pip3?\s+(install|uninstall)/i.test(command) ||
    /npm\s+(install|uninstall|remove)/i.test(command) ||
    /\b(export|unset|source\s+\.env)/i.test(command) ||
    /git\s+(push|rebase|reset|commit\s+--amend)/i.test(command);

  let targetedSucceeded = false;
  if (hasTargetedPattern) {
    const targeted = targetedFn();
    if (targeted) {
      // Same memoized action dir as in targetedFn.
      const dir = materializeActionDir(config);
      result.artifacts.push(targeted);
      writeMetadata(dir, targeted);
      targetedSucceeded = true;
      result.uncoveredHandled = true;
      // Optional: generalize the built-in rule to sibling operations; does not alter this backup.
      generalizeAfterNativeRule(ctx, dir, targeted, config);
    }
  }

  // ── 2nd level (external): the one file an Edit/Write is about to change ──
  let externalFileSnapshot = false;
  if (outsideWorkspace && !targetedSucceeded) {
    const extArt = tryExternalFileSnapshot(ctx, config);
    if (extArt) {
      const dir = materializeActionDir(config);
      result.actionDir = dir;
      result.artifacts.push(extArt);
      writeMetadata(dir, extArt);
      generalizeAfterNativeRule(ctx, dir, extArt, config);
      externalFileSnapshot = true;
      result.uncoveredHandled = true;
    }
  }

  // ── Tier-4 gate ───────────────────────────────────────────────────
  // A declaration (or a positive personalization decision) opens the gate for the subagent.
  let tier4Gated = declaration === null && personalizationDecision === null;

  // ── Read-only checker ───────────────────────────────────
  // Without a declaration, the checker opens the gate when the action is not read-only and the
  // mechanical tiers did not capture it. Errors fail open (spawn).
  let checkerOutcome: { spawn: boolean; targets: string[]; reason: string } | null = null;
  // The checker only gates tier 4, so it is skipped when tier 4 is disabled.
  if (tier4Gated && outsideWorkspace && !targetedSucceeded && !externalFileSnapshot && config.subagentEnabled
      && isReadOnlyCheckerEnabled(config) && personalizationDecision === null) {
    try {
      const { runReadOnlyChecker } = require("./readonly_checker.js");
      checkerOutcome = runReadOnlyChecker(ctx, config);
      // Target resolution guides capture; it must not veto the checker verdict.
      if (checkerOutcome && checkerOutcome.spawn) tier4Gated = false;
      // The checker judged the call read-only: nothing outside needed capturing.
      if (checkerOutcome && !checkerOutcome.spawn) result.uncoveredHandled = true;
    } catch (e) {
      // Fail open: spawn the subagent.
      tier4Gated = false;
      if (config.verbose) process.stderr.write(`[BackUpper] read-only checker error: ${e}\n`);
    }
  }

  // ── 3rd level: subagent for outside-workspace state ────────────
  // Trigger when outside-workspace, no command-pairing backup succeeded, the mechanical
  // external copy did not already hold the file, and the tier-4 gate is open.
  if (outsideWorkspace && !targetedSucceeded && !externalFileSnapshot && !tier4Gated) {
    const cmdStr = String(ctx.tool_input.command ?? JSON.stringify(ctx.tool_input));

    // ── Tier-4 (free): the session's learned read-only store ──────
    // Skip the spawn if the line is one simple command, a stored pattern matches its argv, and
    // the program's hash is unchanged since the pattern was learned. A miss changes nothing.
    if (config.learnedReadOnlyEnabled !== false &&
        ctx.tool_name === "Bash" && ctx.session_id) {
      try {
        const argv = singleSimpleArgv(String(ctx.tool_input.command ?? ""));
        if (argv) {
          const sandboxDir = path.dirname(path.resolve(config.backupDir));
          const store = loadLearnedStore(sandboxDir, ctx.session_id);
          const hit = matchLearnedReadOnly(store, argv, process.cwd());
          if (hit) {
            // Audit trail: which pattern let which command through.
            recordLearnedHit(sandboxDir, store, cmdStr, hit);
            // Also log the skip to subagent.log.
            try {
              fs.appendFileSync(
                path.join(sandboxDir, "subagent.log"),
                `[${new Date().toISOString()}] LEARNED READ-ONLY SKIP: no subagent spawned for ` +
                `"${cmdStr.slice(0, 160)}" — matched pattern "${hit.pattern}" ` +
                `learned from "${hit.learnedFrom.slice(0, 80)}" (${hit.reason.slice(0, 160)})\n`,
              );
            } catch { /* best-effort */ }
            if (config.verbose) {
              process.stderr.write(
                `[BackUpper] learned read-only: skipping subagent for "${cmdStr.slice(0, 80)}" ` +
                `(pattern "${hit.pattern}" learned from "${hit.learnedFrom.slice(0, 60)}")\n`,
              );
            }
            result.uncoveredHandled = true;
            return result;
          }
        }
      } catch (e) {
        // Any failure here means "no hit" — we fall through and spawn.
        if (config.verbose) {
          process.stderr.write(`[BackUpper] learned read-only lookup error: ${e}\n`);
        }
      }
    }

    // ── Tier-4 (cheap): pattern-driven MCP create reverter ────────
    // Falls through to the capture subagent if the pinned identifier cannot be resolved.
    try {
      const rev = tryPatternCreateReverter(ctx, config);
      if (rev) {
        result.actionDir = rev.artifactPath;
        result.artifacts.push(rev);
        result.uncoveredHandled = true;
        return result;
      }
    } catch (e) {
      if (config.verbose) {
        process.stderr.write(`[BackUpper] pattern create reverter error: ${e}\n`);
      }
      // fall through to the capture subagent
    }

    // ── Tier-4 (deterministic): learned rules ──
    // Any miss or failure falls through to the backup subagent.
    {
      try {
        const dir = materializeActionDir(config);
        result.actionDir = dir;
        const learned = tryLearnedBackup(ctx, dir, config);
        if (learned) {
          result.artifacts.push(learned);
          writeMetadata(dir, learned);
          result.uncoveredHandled = true;
          return result;
        }
      } catch (e) {
        if (config.verbose) process.stderr.write(`[BackUpper] learned backup fallback: ${e}\n`);
      }
    }

    // Invoke the backup subagent synchronously inside the PreToolUse hook (loaded lazily).
    let subagentArtifact: BackupArtifact | null = null;
    let readOnlyVerdict = false;   // subagent judged the action read-only
    let attemptedDir: string | null = null;
    let attemptedCtx: HookContext = ctx;
    let reflectedAttempt = false;
    if (config.subagentEnabled) {
      try {
        // Materialize the folder so the subagent has somewhere to write
        const dir = materializeActionDir(config);
        attemptedDir = dir;
        result.actionDir = dir;
        // Restrict the subagent's MCP tools to those this capture needs.
        const toolAllow = minimalToolAllow(ctx, config);
        // Remove the declaration marker from `description` so it cannot steer the capture.
        const description = (ctx.tool_input as { description?: unknown }).description;
        const subCtx = typeof description === "string" && parseDeclaration(description)
          ? {
              ...ctx,
              tool_input: {
                ...ctx.tool_input,
                description: stripDeclaration(description),
              },
            }
          : ctx;
        attemptedCtx = subCtx;
        // Capture scope: the qualifying state under a preference, else the checker's targets.
        let spawnConfig: SandboxConfig = config;
        let checkerTargets: string[] | undefined;
        if (personalizationDecision) {
          const { captureScope } = require("./personalization.js");
          spawnConfig = {
            ...config,
            personalizationCaptureScope: captureScope(config.personalization!, personalizationDecision),
          };
          if (personalizationDecision.targets.length) checkerTargets = personalizationDecision.targets;
        } else if (checkerOutcome) {
          checkerTargets = checkerOutcome.targets;
        }
        const outcome = runSubagentBackup(subCtx, dir, spawnConfig, { toolAllow, checkerTargets });
        // Reflection sees the registered artifact, or a placeholder describing the attempt.
        const reflectionArtifact: BackupArtifact = outcome !== null && typeof outcome === "object"
          ? outcome
          : {
              id: `attempt-${Date.now()}`,
              timestamp: new Date().toISOString(),
              trigger: "rule",
              toolName: ctx.tool_name,
              description: outcome === "read_only"
                ? "backup subagent completed with read-only verdict"
                : "backup subagent completed without a registered artifact",
              strategy: "subagent",
              artifactPath: dir,
              originalAction: describeToolAction(ctx.tool_name, ctx.tool_input),
            };
        reflectAfterBackup(subCtx, dir, reflectionArtifact, config);
        reflectedAttempt = true;
        if (outcome === "read_only") {
          // The subagent judged the action read-only: a clean skip, not a failure.
          readOnlyVerdict = true;
          result.uncoveredHandled = true;
          // Remove the action dir only if it holds no registered or captured files.
          const hasRegistered = result.artifacts.length > 0;
          let hasCaptured = false;
          try {
            hasCaptured = findCapturedArtifacts(dir) !== null;
          } catch { /* treat as nothing captured */ }
          if (hasRegistered || hasCaptured) {
            if (hasCaptured && !hasRegistered) {
              // Captured files with a read-only verdict: keep them and report the inconsistency.
              reportUnregisteredCapture(
                dir,
                "subagent captured files but returned no_backup_needed=true",
                (m) => {
                  if (config.verbose) process.stderr.write(`[BackUpper] ${m}\n`);
                },
              );
            }
          } else {
            // Nothing captured: move the transcripts out, then remove the folder.
            const storeRoot = path.dirname(path.resolve(config.backupDir));
            const receipt = path.join(dir, "reflection.json");
            if (fs.existsSync(receipt)) {
              const receiptsDir = path.join(storeRoot, "reflection-receipts");
              fs.mkdirSync(receiptsDir, { recursive: true });
              fs.copyFileSync(receipt, path.join(receiptsDir, `${path.basename(dir)}.json`));
            }
            const kept = preserveTranscripts(dir, storeRoot);
            if (kept && config.verbose) {
              process.stderr.write(
                `[BackUpper] kept ${kept} subagent transcript file(s) from ${path.basename(dir)}\n`,
              );
            }
            removeDir(dir);
            result.actionDir = undefined;
          }
        } else if (outcome) {
          subagentArtifact = outcome;
          result.uncoveredHandled = true;
          // Record the modes/owners of the files its external-shadow commit holds: git keeps
          // only 0644/0755, so a restore reapplies them (0640 came back 0644 otherwise).
          try {
            const meta = recordExternalShadowMeta(outcome.subagentCommands);
            if (meta) {
              const metaFile = path.join(dir, `external-shadow-meta-${outcome.id}.json`);
              if (writeTreeMeta(metaFile, meta)) outcome.metaPath = metaFile;
            }
          } catch { /* the restore falls back to the modes the files have then */ }
          result.artifacts.push(outcome);
          writeMetadata(dir, outcome);
        }
      } catch (e) {
        if (attemptedDir && !reflectedAttempt) {
          reflectAfterBackup(attemptedCtx, attemptedDir, {
            id: `attempt-${Date.now()}`,
            timestamp: new Date().toISOString(),
            trigger: "rule",
            toolName: ctx.tool_name,
            description: `backup subagent failed: ${String(e).slice(0, 300)}`,
            strategy: "subagent",
            artifactPath: attemptedDir,
            originalAction: describeToolAction(ctx.tool_name, ctx.tool_input),
          }, config);
        }
        if (config.verbose) {
          process.stderr.write(
            `[BackUpper] subagent invocation error: ${e}\n`
          );
        }
      }
    }

    // Subagent failed or disabled without a read-only verdict: flag the state as at risk.
    if (!subagentArtifact && !readOnlyVerdict) {
      result.needsSubagent = true;
      // Explain why the action needed a backup.
      result.subagentReason =
        `Action "${ctx.tool_name}(${cmdStr.slice(0, 200)})" affects state outside the workspace (${process.cwd()}). ` +
        `No predefined backup strategy matched. ` +
        (gitSnapshot
          ? `Workspace files were captured via git snapshot. `
          : `No workspace changes detected. `) +
        `Subagent tier-4 backup was ${config.subagentEnabled ? "attempted but failed" : "disabled"}. ` +
        `Proceed with caution.`;
    }

    return result;
  }

  // No outside-workspace effect: the artifacts from tiers 1-3 (possibly none) are the backup.
  return result;
}

// ── Metadata ─────────────────────────────────────────────────────────

function writeMetadata(actionDir: string, artifact: BackupArtifact): void {
  const metaPath = path.join(actionDir, "metadata.json");
  let entries: BackupArtifact[] = [];

  if (fs.existsSync(metaPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      if (Array.isArray(parsed)) {
        entries = parsed as BackupArtifact[];
      } else if (parsed && typeof parsed === "object") {
        // Wrap a stray single-object metadata file into a one-element array.
        entries = [parsed as BackupArtifact];
      }
      // else: primitive/null — start fresh.
    } catch {
      entries = [];
    }
  }

  entries.push(artifact);
  fs.writeFileSync(metaPath, JSON.stringify(entries, null, 2) + "\n", "utf-8");
}
