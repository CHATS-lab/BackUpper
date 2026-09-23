/**
 * Backup strategies — tiered approach for minimal recovery artifacts.
 *
 * Priority (cheapest first):
 *   1st: Targeted manifest — pip freeze, npm list, env snapshot, git tag
 *        Saves a recipe/pointer, not the actual files. Tiny storage.
 *   2nd: git add -A in shadow repo — full workspace snapshot.
 *        Git compression + deduplication makes this space-efficient.
 *   3rd: Subagent (configured in hooks as "type": "agent") —
 *        Only when 1st and 2nd both failed or don't apply (e.g. remote actions).
 *        Handled outside this module by the hook layer.
 *
 * Folder structure:
 *   .chats-sandbox/backups/
 *     action_001_20260410_1906/
 *       pip_freeze_abc123.txt        ← 1st level
 *       git_snapshot/                ← 2nd level (shadow repo)
 *       metadata.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync, spawnSync } from "node:child_process";

/** Expand a leading `~`/`~/` to the home directory before resolving, so
 *  a Write/Edit to `~/.bashrc` resolves to the real (outside-workspace)
 *  path instead of `<cwd>/~/.bashrc` (which looked in-workspace). */
function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}
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

// ── Action folder management (LAZY) ─────────────────────────────

// _pendingActionId holds the name of the NEXT action to create
// if a backup actually happens. _currentActionDir is only populated
// AFTER we create a real artifact (lazy creation).
let _pendingActionName: string | null = null;
let _currentActionDir: string | null = null;
let _currentActionId: string | null = null;

/**
 * Prepare a pending action name. The folder is NOT created yet —
 * it will only be created if a backup artifact is actually produced.
 */
function preparePendingAction(config: SandboxConfig): string {
  if (_pendingActionName) return _pendingActionName;

  const backupRoot = path.resolve(config.backupDir);
  const existing = listActionDirs(backupRoot);
  // Use (max existing seq) + 1 rather than existing.length + 1 so that
  // after pruning we don't reuse a seq number that still exists on disk
  // (e.g. 5 actions pruned to 3 would have picked seq=4 while an action_004
  // already survived). Seq is display-only and it's fine for it to skip
  // numbers after pruning — what matters is uniqueness and monotonic
  // growth so users can reason about "newer" vs "older".
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

/**
 * Actually create the action folder on disk. Called only when we
 * know we have something to back up. Idempotent.
 */
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

  // Copy the user's current instruction (if any) into the action folder.
  // The instruction is set by the UserPromptSubmit hook into a sidecar
  // file at .chats-sandbox/current-instruction.txt — multiple actions
  // from the same user prompt all read the same instruction.
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
  // Sort by NUMERIC seq, not lexically: a plain .sort() puts
  // action_1000 before action_999, so "oldest first" inverts at seq
  // ≥ 1000 and count/size pruning would evict the NEWEST action (incl.
  // the one just created). Tie-break on the timestamp suffix.
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
 * Prune old action folders according to the three retention knobs:
 *   1. maxAgeHours    — drop anything older than this (if > 0)
 *   2. maxActions     — keep newest N folders (if > 0)
 *   3. maxTotalSizeMB — drop oldest until total size ≤ cap (if > 0)
 *
 * A knob set to 0 is disabled. Folders are listed chronologically
 * (oldest first) because names start with `action_NNN_<timestamp>`.
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

  // 3. Size-based pruning (most expensive — do it last, and only on what survived)
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
  // ts is like 20260418103022 (local time). Parse as UTC-ish; the exact
  // zone doesn't matter for relative age checks.
  const y = parseInt(ts.slice(0, 4), 10);
  const mo = parseInt(ts.slice(4, 6), 10) - 1;
  const d = parseInt(ts.slice(6, 8), 10);
  const h = parseInt(ts.slice(8, 10), 10);
  const mi = parseInt(ts.slice(10, 12), 10);
  const s = parseInt(ts.slice(12, 14), 10);
  if ([y, mo, d, h, mi, s].some(Number.isNaN)) return null;
  return new Date(y, mo, d, h, mi, s).getTime();
}

/** Recursively sum file sizes under a directory. Exported for the
 *  dashboard and CLI status reporting. */
export function dirSize(p: string): number {
  let total = 0;
  const walk = (q: string): void => {
    try {
      const entries = fs.readdirSync(q, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(q, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile()) {
          try { total += fs.statSync(full).size; } catch { /* */ }
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

/**
 * Single shared shadow git repo for the whole project. All snapshots
 * are commits in this one repo, which means:
 *   - Git deduplication across all actions (space-efficient)
 *   - A snapshot is only created if there are actual changes
 *   - Diffing between any two actions is a native git diff
 */
function getSharedShadowRepo(config: SandboxConfig): string {
  const backupRoot = path.resolve(config.backupDir);
  return path.join(path.dirname(backupRoot), "shadow-repo");
}

function ensureSharedShadowRepo(config: SandboxConfig): string {
  const shadowDir = getSharedShadowRepo(config);
  if (fs.existsSync(path.join(shadowDir, "HEAD"))) {
    return shadowDir;
  }

  fs.mkdirSync(shadowDir, { recursive: true });
  const cwd = process.cwd();
  const env = { ...process.env, GIT_DIR: shadowDir, GIT_WORK_TREE: cwd };
  const execOpts = { encoding: "utf-8" as const, timeout: 30_000, env, cwd };

  try {
    execSync("git init", { ...execOpts, stdio: "pipe" });
    execSync('git config user.email "chats-sandbox@local"', { ...execOpts, stdio: "pipe" });
    execSync('git config user.name "CHATS-Sandbox"', { ...execOpts, stdio: "pipe" });

    const infoDir = path.join(shadowDir, "info");
    fs.mkdirSync(infoDir, { recursive: true });
    fs.writeFileSync(
      path.join(infoDir, "exclude"),
      [
        // NOTE: .env / .env.* are intentionally NOT excluded — they are
        // the file class users most want recoverable, an Edit/Write of
        // .env is in-workspace (no tier-3) with no Bash command (no
        // tier-1 manifest), so the shadow snapshot is the ONLY tier that
        // can capture their pre-state. The shadow repo is local under
        // .chats-sandbox and never pushed, so capturing secrets there is
        // no more exposed than the working file itself.
        "node_modules/", ".git/", "dist/", "build/", "__pycache__/",
        "*.pyc", ".venv/", "venv/", ".cache/",
        ".chats-sandbox/",
        // Agent/harness infra dirs — never part of the user's project, and
        // (for the multi-method comparison harness) the OTHER methods' stores.
        ".hermes/", ".baseline/", ".native/", ".cpall/", // overfit-ok: exclusion LIST of every harness's infra dir, not a pinned runner
        // Playwright-MCP transient scratch (page-*.yml / console-*.log) — the
        // browser tool writes these into cwd on almost EVERY browser action, so
        // without this exclude tier-2 git-snapshot commits them on every step
        // and manufactures a spurious "backup" per browser call (not the user's
        // state, and not a logical backup).
        ".playwright-mcp/", "page-*.yml", "console-*.log", "traces/",
        ".DS_Store", "Thumbs.db",  // macOS/Windows filesystem noise
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
// 1st Level: Targeted manifests (cheapest — saves recipes, not files)
// =====================================================================

function pipFreezeBackup(
  actionDir: string,
  ctx: HookContext
): BackupArtifact | null {
  const id = makeId();
  const dest = path.join(actionDir, `pip_freeze_${id}.txt`);

  // Try multiple pip invocations. Environments vary: some have `pip` only,
  // some `pip3` only, some only `python3 -m pip`. Previously we used a
  // shell one-liner with `|| pip3 freeze` which doesn't trigger if pip
  // is present but fails for another reason (e.g. missing packages).
  // This explicit ladder is more reliable and produces an empty file
  // (still an artifact!) when no pip is available — the action folder
  // gets materialized, tier-3 is skipped, and restore can no-op.
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

  // If nothing produced output, still materialize an empty manifest. This
  // is deliberate: the pattern matched (pip install) so tier-1 owns the
  // action, and producing an empty manifest signals "we tried but there
  // was no pre-existing package set to record." Prevents tier-3 subagent
  // from firing redundantly on pip install in a fresh Python env.
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
  const tagName = `chats-sandbox/pre-${ctx.tool_name.toLowerCase()}-${id}`;

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

/**
 * Try the cheapest targeted manifest for the given command.
 * Returns the artifact if a targeted strategy matched, null otherwise.
 */
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
// 2nd Level: git add -A snapshot in SHARED shadow repo
// =====================================================================

/**
 * Commit to the shared shadow repo only if there are actual changes
 * since the last commit. Returns null if the workspace is unchanged
 * (this is how we skip snapshots for read-only actions automatically).
 */
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

    // Check if there are staged changes vs the previous commit.
    // If the repo has no commits yet, there's always "changes" to commit.
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

    // REMOTE actions (MCP / browser) never need a WORKSPACE snapshot — their
    // effect lives in a remote system (captured by the subagent tier, or
    // nothing for a read), and any workspace "drift" they leave is just the
    // browser tool's transient scratch (.playwright-mcp/, console/page logs).
    // Skip tier-2 ENTIRELY for them — regardless of drift — so we don't
    // manufacture a git_snapshot folder per browser call (the dominant "storm"
    // cause). If the action is backup-worthy the subagent materializes its own
    // folder. (Previously this only fired when there was no drift, so scratch
    // files slipped a spurious snapshot through on nearly every browser call.)
    if (ctx.tool_name.startsWith("mcp__") || /(^|_)browser_[a-z]/.test(ctx.tool_name)) {
      return null;
    }

    if (!hasChanges) {
      // Workspace hasn't drifted since the last snapshot. But the
      // UPCOMING tool call may still be a write, so we need an artifact
      // that records "this action's pre-state" — otherwise the action
      // folder never gets materialized and the action is silently
      // untracked (no way to restore). Return a pointer artifact that
      // references the current HEAD; all the pre-state this action
      // would need is already stored there from the previous action.
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
        // Same wording contract as the commit branch below: name the SEPARATE
        // store explicitly. "git add -A snapshot" reads as an operation on the
        // user's own repo, which in a non-git workspace is an impossible claim
        // and got the whole message called fabricated -- measured.
        description: `workspace snapshot → .chats-sandbox/shadow-repo (pointer → ${head.slice(0, 8)}, unchanged since previous action)`,
        strategy: "git_snapshot",
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

    // How much this commit actually captured. The message goes into the agent's
    // context, and an IDENTICAL line on every tool call is exactly what a prompt
    // injection looks like -- an agent under test said so in as many words
    // ("a real hook wouldn't loop identical text regardless of command") and
    // then disregarded the warning on the destructive call too. Varying the
    // line with real per-action content is what makes it read as genuine.
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
      // Name the SEPARATE store explicitly. "git add -A snapshot" reads as an
      // operation on the user's own repo, so in a workspace that is not a git
      // repo at all the message looks impossible and gets called fabricated --
      // measured. The shadow repo is ours and independent of the workspace.
      description: `workspace snapshot → .chats-sandbox/shadow-repo (${hash.slice(0, 8)}${scope})`,
      strategy: "git_snapshot",
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
 * MCP tool names that are known to be read-only. Inverted denylist:
 * any `mcp__*` tool that DOESN'T match these patterns is assumed to
 * mutate state we can't capture locally and triggers tier-3 backup.
 *
 * Rationale: hardcoding a write-allowlist is unbounded (every new MCP
 * server invents verbs). Hardcoding a read-only-denylist is bounded
 * because MCP tools generally follow consistent naming conventions for
 * read-style ops: get_*, list_*, search_*, fetch_*, read_*, view_*,
 * describe_*, inspect_*, show_*, *_navigate, *_snapshot, *_screenshot,
 * etc.
 *
 * False positive (read flagged as write): user pays a few cents for a
 *   subagent fire that captures nothing useful.
 * False negative (write flagged as read): user loses remote state
 *   silently. Strictly worse — that's why we bias toward "treat
 *   unknown MCP verbs as writes."
 */
/**
 * True for a browser-automation tool surfaced under a BARE name —
 * `browser_click`, `browser_navigate`, etc. OpenHands registers
 * Playwright-MCP tools this way (no `mcp__` prefix), as does Hermes's
 * built-in browser toolset. These mutate remote page state and must be
 * treated like `mcp__*` browser tools for tier-3 detection.
 */
function isBareBrowserTool(toolName: string): boolean {
  return /^browser_/.test(toolName);
}

// A mutating verb in an MCP tool's action segment → NOT read-only. Module-
// scoped so the per-server Non-Backup-ToolList guard in isBackupWorthyRemote
// can reuse the exact same vocabulary as the hardcoded isReadOnlyMcpTool check.
const MUTATING_VERB = /(^|_)(create|delete|update|remove|insert|drop|truncate|purge|ack|acknowledge|replace|write|set|post|put|send|publish|destroy|kill|cancel|revoke|grant|upsert|patch|rename|merge|install|uninstall|close|submit|clear|reset|flush|move|edit|modify)(_|$)/i;

export function isReadOnlyMcpTool(toolName: string): boolean {
  // Accept both `mcp__*` tools and bare `browser_*` tools (OpenHands /
  // Hermes name Playwright-MCP browser tools without the prefix).
  if (!toolName.startsWith("mcp__") && !isBareBrowserTool(toolName)) return false;

  // The verb lives in the FINAL `__` segment (`mcp__server__get_foo` →
  // `get_foo`; bare `browser_click` → `browser_click`). Anchoring here
  // stops a read word in the server name from masking a mutating action.
  const action = toolName.split("__").pop() || toolName;

  // A mutating verb ANYWHERE in the action overrides a leading read verb.
  // Without this, compound names like `get_and_delete`, `read_and_ack`,
  // `list_and_purge`, `update_status`, `find_and_replace` were classified
  // read-only and silently skipped backup (the unsafe failure direction).
  // (MUTATING_VERB is module-scoped — see above.)
  if (MUTATING_VERB.test(action)) return false;

  // Read-style verbs in the action segment.
  const READ_VERB = /(^|_)(get|list|search|fetch|read|view|describe|inspect|show|status|count|find|query|history|info|head|peek)(_|$)/i;
  if (READ_VERB.test(action)) return true;

  // Browser verbs that don't mutate page state (Playwright-MCP / Hermes's
  // `browser` toolset). NOTE: `install` and `close` were removed — they
  // mutate (install a browser / change tab state) and are now caught above.
  // `fill`/`fill_form`/`type`/`select_option` ENTER data but don't COMMIT
  // it — the commit is a later Submit/Save *click*. Treating form input as
  // read-only stops every login/search box from firing a browser subagent;
  // the mutating click that follows is what gets backed up (see
  // isMutatingBrowserClick / touchesOutsideWorkspace).
  const BROWSER_READ = /(^|_)(navigate|navigate_back|snapshot|screenshot|take_screenshot|console_messages|network_requests|wait_for|resize|tabs|scroll|hover|fill|fill_form|type|select_option|drag)(_|$)/i;
  if (BROWSER_READ.test(action)) return true;

  return false;
}

/** Browser actuation tools whose mutating-ness depends on WHAT is clicked,
 *  not the tool name (the same `browser_click` clicks a nav link or a
 *  "Submit" button). */
function isBrowserActuationTool(toolName: string): boolean {
  const action = (toolName.split("__").pop() || toolName).toLowerCase();
  return action === "browser_click" || action === "click";
}

// Affordances that COMMIT state — a click on one of these is worth a backup.
const MUTATING_AFFORDANCE =
  /\b(submit|create|post|publish|save|delete|remove|discard|subscribe|unsubscribe|join|leave|follow|unfollow|vote|upvote|downvote|reply|comment|edit|update|send|confirm|apply|add|upload|sticky|lock|ban|message|sign\s?up|register|checkout|buy|order|pay|reserve|accept|approve|reject|merge|deploy)\b/i;
// IRREVERSIBLE verbs — the backup-worthy floor for REMOTE actions under the
// principle "back up iff, without a backup, the action becomes irreversible".
// Includes data destruction, state overwrite, and resource creation (you need
// the new entity's identity to undo it) + irreversible commits. EXCLUDES
// reversible toggles (vote/subscribe/follow/like/star/pin/save-bookmark/join/
// close/enable…) — those have an always-available live inverse, so they cost
// no backup (and, per the chosen policy, are simply not undone on restore).
// NOTE: nouns that double as verbs ("comment", "message") are deliberately
// EXCLUDED — they collide with reversible toggles on the same object ("like
// comment", "flag message"). Comment/message CREATION is caught by the verbs
// add/reply/post/submit/send instead.
const IRREVERSIBLE_VERB =
  /\b(delete|remove|destroy|drop|truncate|erase|wipe|purge|clear|edit|update|overwrite|replace|modify|rename|save|create|add|insert|post|submit|publish|upload|send|write|append|import|reply|buy|order|pay|checkout|purchase|charge|transfer|deploy|release|push)\b/i;
// DESTRUCTIVE verbs — always back up, even rendered as a link (some apps
// delete via an <a>). These override the link-is-navigation rule below.
const STRONG_MUTATING =
  /\b(delete|remove|destroy|ban|purge|drop|truncate|wipe|erase|deactivate|revoke)\b/i;
// Affordances that only NAVIGATE / read — a click here changes nothing
// persistent (login, links, pagination, sort/filter, expand/collapse,
// dropdown options…).
const READ_AFFORDANCE =
  /\b(log\s?in|sign\s?in|log\s?out|sign\s?out|back|forward|next|prev|previous|home|page|pagination|tab|sort|filter|search|browse|view|expand|collapse|show\s?more|load\s?more|read\s?more|see\s?more|menu|breadcrumb|scroll|hover|open|close|dismiss|cancel|option|combobox|dropdown|listbox|checkbox|radio|spinbutton|slider)\b/i;

/** Classify a browser CLICK by the affordance described in its args.
 *  destructive → back up; a LINK navigates (skip); other mutating verb →
 *  back up; navigation/login/read → skip; unknown → back up (safe). */
export function isMutatingBrowserClick(input: Record<string, unknown>): boolean {
  const desc = String(
    input.element ?? input.text ?? input.selector ?? input.ref ?? input.name ?? ""
  ).toLowerCase();
  if (STRONG_MUTATING.test(desc)) return true;
  // A LINK navigates — it does not commit state. Postmill's top-nav
  // "Submit" is a <a> to the compose form, NOT the post commit (that's a
  // "Create submission" <button>). So skip links unless destructive above.
  if (/\blink\b/.test(desc)) return false;
  if (MUTATING_AFFORDANCE.test(desc)) return true;
  if (READ_AFFORDANCE.test(desc)) return false;
  return true; // unknown affordance → escalate (don't silently skip a mutation)
}

/**
 * REMOTE actions (MCP + browser tools) use a backup-worthy ALLOWLIST: only
 * actions that look consequential are backed up; navigation, reads, and
 * unknown UI are ignored. This is the inverse of the local default (which
 * stays "escalate unless known-safe"). Local actions never reach here.
 *
 * Order matters — most reliable signal first:
 *   read-verb name     → MCP get/list/view → ignore
 *   destructive verb   → back up (floor; no learned entry may suppress it;
 *                        scans tool name + UI fields AND the executable
 *                        payloads — sql/command/query — so a DELETE/DROP on
 *                        a never-explored server is still covered)
 *   PER-SERVER learned → judge against THIS server's lists only:
 *                        Non-Backup-ToolList (read-only tool NAMES) → ignore;
 *                        Backup-patterns (triggers over the payload) → back up
 *   FALLBACK (no profile / no match): LINK → ignore; mutating verb → back up;
 *                        otherwise → ignore (allowlist default)
 */
function isBackupWorthyRemote(ctx: HookContext, config?: SandboxConfig): boolean {
  const toolName = ctx.tool_name;
  const input = (ctx.tool_input ?? {}) as Record<string, unknown>;

  // A SQL/query arg is NOT special-cased — its text is part of rawDesc below,
  // scanned by the destructive floor (STRONG_MUTATING) and by that server's
  // learned Backup-patterns.

  // Arbitrary-code browser tools (browser_run_code_unsafe, browser_evaluate,
  // *_evaluate) carry their real action in a `code`/`function` arg, NOT the
  // tool name — and the name has no mutating verb, so the allowlist default
  // below would wrongly IGNORE them and skip backup. Inspect the code: if it
  // performs a mutating page action it's backup-worthy; if we can't see the
  // code, ESCALATE (arbitrary JS can mutate anything — a missed mutation is
  // unrecoverable, a wasted spawn on a pure read is cheap).
  const _action = (toolName.split("__").pop() || toolName).toLowerCase();
  if (/run_code|evaluate/.test(_action)) {
    const code = String(input.code ?? input.function ?? input.expression ?? "");
    if (!code) return true;
    return /\.(fill|click|type|press|check|uncheck|select_?option|set_?input_?files|tap|drag_?to|set_?checked|clear)\s*\(|\.submit\s*\(|get_?by\w*\([^)]*\)\s*\.\s*(click|fill|check|press|type|select)/i.test(code);
  }

  // Hardcoded read-verb tool-name skip (applies to any tool, learned or not).
  if (toolName.startsWith("mcp__") && isReadOnlyMcpTool(toolName)) return false;

  // Normalize `_` → ` ` so verbs in tool names match word-boundary regexes
  // (`create_page` → `create page`; `\bcreate\b` matches only after this).
  const desc = [
    toolName, input.element, input.text, input.selector, input.name,
  ].filter(Boolean).map(String).join(" ").toLowerCase().replace(/_/g, " ");
  // Raw text (incl. command/sql/query) for the learned keyword matchers.
  const rawDesc = [
    toolName, input.element, input.text, input.selector, input.name,
    input.command, input.sql, input.query,
  ].filter(Boolean).map(String).join(" ").toLowerCase();

  // Destructive floor: a clearly destructive op ALWAYS backs up — no learned
  // entry may suppress it (learned data is attacker-influenceable). Tested
  // against BOTH strings: `desc` catches verbs in tool names / UI fields
  // (underscores normalized, so `delete_file` matches), `rawDesc` catches
  // verbs inside executable payloads (sql/command/query) so a DELETE / DROP /
  // TRUNCATE on a never-explored server is still covered. rawDesc is NOT
  // underscore-normalized, so identifiers like `dropped_items` cannot trip
  // the \b-bounded verbs; a bare floor verb in a read-only query's string
  // literal is the accepted (backup-only-direction) false positive.
  if (STRONG_MUTATING.test(desc) || STRONG_MUTATING.test(rawDesc)) return true;

  // ── PER-SERVER learned judgment (primary path): map the action to its server
  //    and judge ONLY against THAT server's lists, in this fixed order:
  //      1. Non-Backup-ToolList (read-only tools) → skip
  //      2. Reverter check (a creation-only pattern with a deterministic
  //         reverter) → back up via the cheap no-agent path
  //      3. Backup-patterns → back up
  //    (There is deliberately NO keyword-level suppress step: the only learned
  //    negative signal is the read-only TOOL list above, which is validated
  //    against the live tool surface. A learned keyword that silently skipped
  //    backups was the poisoning-prone direction and nothing emits it anymore.)
  //    Anything matching none falls through to the fallback, whose default for
  //    remote actions is NON-backup. ──
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { serverFromToolName, experienceNameForServer, serverMatchers, matchPattern } =
      require("../explore/experiences.js");
    const server = config ? serverFromToolName(toolName) : null;
    const expName = server ? experienceNameForServer(config, server) : null;
    if (expName) {
      const m = serverMatchers(config, expName);
      const lc = toolName.toLowerCase();
      const seg = lc.split("__").pop() || lc;
      // 1. Non-Backup-ToolList — guarded so a mutating-named tool is never cleared.
      if ((m.readOnlyTools.has(lc) || m.readOnlyTools.has(seg)) && !MUTATING_VERB.test(seg)) return false;
      // 2. Learned-pattern match — exploration VERIFIED this tool mutates
      //    state, so a match is backup-worthy whether or not it carries a
      //    deterministic reverter (the reverter only selects the cheap
      //    no-agent path downstream). This must not depend on the trigger
      //    regex below: \b cannot cross an underscore, so triggers like
      //    "move" can NEVER match inside "mcp__filesystem__move_file" —
      //    93 move_file mutations ran unprotected across the fs3way /
      //    oc-fs-si-b runs before this identity path carried them.
      //    Browser actuation is EXCLUDED: type/press/select enter data but
      //    don't COMMIT it (the click does, and clicks gate via their
      //    element-label triggers) — identity-matching every keystroke
      //    would re-create the naive arm's spawn-per-input cost.
      const pat = matchPattern(config, expName, toolName, rawDesc);
      if (pat && !isBrowserActuationTool(toolName)) return true;
      if (pat?.reverter) return true;
      if (m.triggerRegex && m.triggerRegex.test(rawDesc)) return true;   // 3. Backup-patterns
    }
  } catch { /* fall through to the generic verb-list fallback */ }

  // ── FALLBACK (no server / no experience profile / matched none of the
  //    three): the generic verb-list heuristic. ──
  if (/\blink\b/.test(desc)) return false;
  // `desc` (underscore-normalized) catches verbs in the tool name / UI fields.
  if (IRREVERSIBLE_VERB.test(desc)) return true;
  // The executable PAYLOAD (sql / query) also carries the verb — WITHOUT this,
  // an UPDATE / INSERT / REPLACE through an unknown-verb MCP tool on an
  // unexplored server escaped backup entirely. But scan it with QUOTED STRING
  // LITERALS BLANKED: a SQL verb is always a keyword OUTSIDE quotes, so
  // stripping literals loses no real mutation while dropping the broad-verb
  // false positives IRREVERSIBLE_VERB would otherwise hit inside read-query
  // literals (`SELECT 'please add later'`, `SELECT 'call center'`). The narrow
  // destructive FLOOR above deliberately keeps its literal FP (safety net);
  // this softer fallback is made precise. sql/query only (never desc/element)
  // so a browser nav click's label can't fire it.
  const sqlPayload = [input.sql, input.query].filter(Boolean).map(String).join(" ").toLowerCase();
  // `ORDER BY` / `GROUP BY` are CLAUSES, not mutations, but IRREVERSIBLE_VERB
  // carries `order` for e-commerce ("place an order") and `group` is a noun
  // elsewhere -- and both sit OUTSIDE quotes, so blanking literals does not
  // reach them. Measured 2026-08-23 on task 2019: five plain
  // `SELECT ... ORDER BY` reads per run each spawned a full tier-3 subagent
  // (7-22 s apiece) only to conclude "read-only, no backup needed". Strip the
  // clause keywords on the SQL path only; the shared verb list is untouched so
  // a browser "Place order" button still fires.
  const sqlNoLiterals = sqlPayload
    .replace(/'[^']*'/g, "' '").replace(/"[^"]*"/g, '" "')
    .replace(/\border\s+by\b/gi, " ").replace(/\bgroup\s+by\b/gi, " ");
  if (sqlNoLiterals && (IRREVERSIBLE_VERB.test(sqlNoLiterals) ||
      // SQL-specific mutations absent from IRREVERSIBLE_VERB (MERGE / UPSERT /
      // GRANT / VACUUM / REINDEX / CLUSTER / REFRESH / CALL / LOAD / COMMENT ON).
      /\b(merge|upsert|grant|vacuum|reindex|cluster|refresh|call|load|comment\s+on)\b/.test(sqlNoLiterals))) {
    return true;
  }
  return false; // reversible toggle / unknown / read → ignore (allowlist default)
}

/**
 * THE definition of "outside the workspace", for an ALREADY-RESOLVED absolute
 * path. Two independent consumers ask it — the legacy absolute-path scan
 * inside touchesOutsideWorkspace, and the effect-bounded carve-out's
 * per-argument check — and they must never drift about what the word means.
 *
 * `/dev`, `/proc` and `/tmp` are excluded because they are not durable state:
 * a device, a synthetic filesystem, and the scratch directory every tool on
 * the box already treats as disposable. This carries the exemption the
 * absolute-path scan has always had, verbatim, rather than inventing a second
 * (and inevitably different) opinion for the new code.
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
 * Inspect the tool call arguments to determine if the action might
 * affect state outside the current workspace.
 *
 * Returns true if:
 *   - Any explicit file path in the args is outside cwd
 *   - The command pattern is known to affect system/global state
 *     (pip install, apt install, npm -g, git push, export, etc.)
 *   - The tool is an MCP tool that isn't recognized as read-only
 */
export function touchesOutsideWorkspace(ctx: HookContext, config?: SandboxConfig): boolean {
  const workspace = path.resolve(process.cwd());
  const toolName = ctx.tool_name;
  const input = ctx.tool_input;

  // MCP tools: unless we recognize the verb as read-only, assume the
  // action mutates remote state we can't capture locally. This fires
  // the tier-3 subagent, which can use the same MCP to scrape the
  // pre-state and record recovery instructions.
  // ── REMOTE actions (MCP + browser tools): backup-worthy ALLOWLIST ──
  // Only consequential actions (learned triggers, or a generic mutating
  // verb) are backed up; navigation, reads, and unknown UI are ignored —
  // no wasted subagent spawn. The LOCAL out-of-workspace branches below
  // (file paths, Bash) are UNCHANGED: they keep the "escalate unless
  // known-safe" default. The allowlist is scoped to the MCP/browser surface
  // the exploration actually learned.
  if (isBrowserActuationTool(toolName) || toolName.startsWith("mcp__")) {
    // ABLATION KNOB: CHATS_SANDBOX_NAIVE_GATE=1 models the NO-KNOWLEDGE
    // baseline — no learned triggers, no floor, no verb heuristics. Escalate
    // every remote action the hardcoded read-only NAME filter can't clear and
    // let the backup subagent judge (its prompt already allows returning
    // no_backup_needed:true, handled as a clean read-only skip). Fail-safe but
    // expensive: unknown-verb tools (execute_sql) spawn on every call incl.
    // reads — the cost the learned gate exists to remove.
    if (process.env.CHATS_SANDBOX_NAIVE_GATE === "1") {
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
        return true; // Path is outside workspace
      }
    } catch {
      // ignore unresolvable paths
    }
  }

  // ── LOCAL actions (Bash): escalate UNLESS KNOWN SAFE ──────────────
  //
  // Bash is an OPEN SET. New destructive forms appear faster than rules for
  // them can be written, and one that nobody wrote a rule for used to fall
  // through here as "does not touch outside" — silently, with no artifact and
  // no subagent. `python3 bin/capctl allot release --apply` is the shape of
  // that failure: no absolute path anywhere on the command line, no listed
  // verb, and it writes /var/lib/capline.
  //
  // So the default is inverted: unknown ⇒ escalate. Only two things clear a
  // command, and both are positive statements about it —
  //   1. isReadOnlyBash — it writes nothing at all;
  //   2. bashIsEffectBounded — every effect it can have is spelled out in its
  //      own arguments and lands inside the workspace, which the tier-2
  //      snapshot has already captured.
  // Everything else takes a subagent.
  //
  // NOTE the shapes differ by branch on purpose. The MCP/browser branch above
  // keeps its ALLOWLIST because its surface is CLOSED: the tools are named,
  // finite, and enumerated by self-exploration, so that allowlist can actually
  // be finished. Bash cannot be. Matching the rule shape to whether the
  // surface is enumerable is the point; neither branch is the odd one out.
  if (toolName === "Bash") {
    const cmd = String(input.command ?? "");

    // (1) Writes nothing → nothing to protect. The dispatcher already
    // short-circuits on this before calling us, so this is a no-op there; it
    // matters for direct callers, and it must come FIRST now that the tail of
    // this branch escalates by default.
    if (isReadOnlyBash(cmd)) return false;

    // The positive tests below (outsidePatterns, the DB-client pair, the
    // absolute-path scan) are now SUBSUMED: under the inverted default every
    // command they catch would escalate anyway by falling through. They are
    // kept because they are cheap, because each documents a specific measured
    // escape, and because deleting them would be a behaviour change nothing
    // here measures. Do not read their presence as the gate's mechanism —
    // the mechanism is the default at the bottom.
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
      // (DB-client MUTATION is handled separately below as TWO independent
      // linear tests — a single `client[\s\S]*verb` regex backtracks
      // quadratically on a large no-verb command, freezing this synchronous
      // gate.)
      /\bkubectl\s+(apply|delete|create|patch|replace|scale|edit|drain|cordon|rollout|set|annotate|label|taint)\b/i, // k8s state
      /\bsystemctl\s+(start|stop|restart|enable|disable)/i, // services
      /\bexport\s+\w+=/i,                       // env vars
      /\bunset\s+\w+/i,                         // env vars
      /\bsource\s+/i,                           // shell config
      // Cloud / IaC CLIs — remote infra state git cannot capture. These
      // previously fell through the allowlist entirely (fail-open).
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

    // DB-client MUTATION (direct or via `docker exec`/`ssh`): the remote DB is
    // outside-workspace state git can't capture. TWO independent tests (a DB
    // client token AND a mutating verb, anywhere in the command) instead of
    // one `client[\s\S]*verb` regex — the combined form backtracks O(n²) on a
    // large no-verb command (e.g. a 100KB `psql -c "SELECT …"`) and this gate
    // runs synchronously on every tool call. Both halves are linear. Verb list
    // is a SUPERSET (a missed mutation is unrecoverable; a wasted spawn on a
    // read-shaped `COPY (SELECT…) TO` is cheap). A read-only SELECT/\dt/SHOW
    // has a client token but no verb → does not escalate.
    if (/\b(psql|mysql|mariadb|mongo|mongosh|redis-cli|sqlite3)\b/i.test(cmd) &&
        (/\b(delete|update|drop|truncate|insert|alter|replace|upsert|merge|grant|revoke|call|load|reindex|cluster|vacuum|refresh|rename|create|comment\s+on|flushall|flushdb|hset|hdel|lpush|rpush|sadd|zadd|expire|copy)\b/i.test(cmd) ||
         /\\copy/i.test(cmd))) {
      return true;
    }

    // Scan for absolute paths outside the workspace. The one token we
    // must NOT count is the interpreter/executable being RUN: its
    // install path (e.g. /opt/conda/bin/python) is a read, not a
    // mutation, and counting it fired a tier-3 subagent on every
    // conda/venv command (the SWE-bench pytest 774s pathology).
    //
    // We exclude only that single token, and only when it is an
    // absolute path whose basename is a known language runtime. We do
    // this per command segment, splitting on &&/||/|/;/&/newline and
    // skipping any leading NAME=value env-assignments to find the real
    // argv[0]. EVERYTHING ELSE is still scanned — redirection targets
    // (`>/etc/x`), env-assignment values (`DEST=/etc/x …`), script
    // args, paths inside quotes (`python -c "open('/etc/x','w')"`),
    // and bare non-interpreter executables (`/usr/local/bin/reset.sh`)
    // — so genuine outside writes still fire. The heuristic keeps its
    // bias toward over-firing (slow but safe) over under-firing
    // (silent unrecoverable state): only a recognized interpreter at
    // argv[0] is ever skipped.
    const INTERPRETER = /^(?:python[0-9.]*|node|nodejs|ts-node|tsx|deno|bun|ruby|perl|php|bash|sh|dash|zsh|fish|java|Rscript|pytest)$/;
    const isOutside = (token: string): boolean => {
      // Require ≥2 path segments: single-segment tokens like "/retries"
      // are almost always sed/awk substitution fragments, not paths.
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

    // (2) The carve-out, and then the new default. Reaching this line means
    // no positive test fired — which under the old gate meant "safe" and now
    // means only "unrecognised". A command is cleared only if we can say
    // something positive about it: every segment bounded by its arguments,
    // every argument inside the workspace. Otherwise it escalates.
    return !bashIsEffectBounded(cmd, workspace);
  }

  return false;
}

// =====================================================================
// Main dispatcher
// =====================================================================

export interface BackupResult {
  /** Artifacts created (may be multiple) */
  artifacts: BackupArtifact[];
  /** Whether a subagent should be called as 3rd level */
  needsSubagent: boolean;
  /** Reason the subagent is needed */
  subagentReason?: string;
  /** When a tier-0 policy rule rewrote the command, this is the new
   *  tool_input the hook should return as updatedInput. Undefined when
   *  no rewrite happened. */
  updatedInput?: Record<string, unknown>;
  /** Folder of the action recorded for this backup (when one was
   *  created) — lets the hook attach action-level records such as the
   *  added-latency timing. */
  actionDir?: string;
}

/**
 * Run backup strategies in priority order:
 *   1st: Targeted manifest (pip freeze, npm list, git tag, env snapshot)
 *   2nd: git add -A in SHARED shadow repo (only commits if workspace changed)
 *   3rd: Subagent needed — when action touches outside workspace AND
 *        no targeted manifest covered it.
 *
 * Action folders are created LAZILY — only if a real artifact is produced.
 * Read-only actions produce no artifact → no folder → no noise.
 */
/** Tools that never modify state — they don't need backup at all. */
const READ_ONLY_TOOLS = new Set([
  "Read", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite",
  // Harness-internal tools that don't touch the user's project state.
  // ToolSearch is the deferred-tool fetcher in Claude Code; it never
  // modifies anything in /app or on disk.
  "ToolSearch",
]);

/**
 * Pure-introspection Bash patterns: commands that read state and print it,
 * but never mutate. We recognize a conservative set — all common and
 * unambiguously safe. If any pattern matches, the hook short-circuits
 * the same way a READ_ONLY_TOOLS entry does: no backup attempted, no
 * tier-3 subagent, no action folder.
 *
 * Designed to prevent false positives on commands like:
 *   which python3        (looks at PATH, modifies nothing)
 *   ls /usr/bin          (reads a directory)
 *   cat file.txt         (reads file contents)
 *   stat -c %a file      (reads metadata)
 *   command -v git       (shell builtin introspection)
 *
 * The pattern is anchored at the START of the command after optional
 * whitespace, so `echo foo > bar` (redirection = write) won't match.
 * Compound commands (pipes, `&&`, `;`, subshells) skip this check and
 * fall through to the full backup pipeline — safer default.
 */
const READ_ONLY_BASH_PATTERN = new RegExp(
  "^\\s*(?:" +
    "which|command\\s+-v|type(?:\\s+-[aPpt]+)?|" +       // what-is
    "ls(?:\\s+-[a-zA-Z]*)?|stat|file|readlink|realpath|dirname|basename|" +  // fs introspection
    "cat|head|tail|wc|grep|egrep|fgrep|zcat|zgrep|rg|" +  // read contents (rg gets a layer-2 flag allowlist: --pre/--hostname-bin EXECUTE a binary)
    // Pure formatters/parsers reading stdin. `python3 -m json.tool` is the
    // idiomatic tail of an API read (`curl ... | python3 -m json.tool`) and was
    // dragging the whole pipeline out of the read-only class. Only the -m form
    // of a known stdin filter is allowed; a bare `python3` or `-c` can do
    // anything, so it is NOT listed here. It is ALSO only read-only with zero
    // positional args -- json.tool's second positional is an OUTFILE that
    // truncates a real file (pyModuleIsReadOnly, layer 2).
    "python3?\\s+-m\\s+(?:json\\.tool|base64)|" +
    // ── Verbs added 2026-08-23 from a 24,551-Bash-call corpus scan ──
    // These are reads that the closed verb list simply had never been told
    // about; 5.5% of all real Bash traffic was paying for a backup because
    // nobody had written `cut` or `git rev-parse` down. That was tolerable
    // when the Bash branch defaulted to "does not touch outside"; now that it
    // defaults to ESCALATE, every one of them is a subagent spawn.
    //
    // Three of these — sort, uniq, crontab — write or delete through their
    // own options and are USELESS here without their layer-2 classifiers
    // (`sort -o FILE`, `uniq IN OUT`, `crontab -r`). Layer 2 only ever
    // RESTRICTS what layer 1 admits, so the two halves must be added
    // together: a classifier with no verb entry does nothing at all, and a
    // verb entry with no classifier is a live write misread as a read.
    "cut|tr|paste|comm|cmp|nl|od|strings|column|diff|sleep|test|\\[|" +
    "(?:md5|sha1|sha224|sha256|sha384|sha512)sum|cksum|b2sum|" +
    "getent|pgrep|pidof|findmnt|lsblk|netstat|pg_isready|nproc|lscpu|tac|rev|seq|" +
    "du|sort|uniq|crontab|" +
    "systemctl(?:\\s+(?:--user|--system|--no-pager|--all|-a))*\\s+(?:status|show|cat|is-active|is-enabled|is-failed|list-units|list-timers|list-sockets|list-unit-files|list-dependencies)|" +
    "docker\\s+(?:volume|network|container|image|node|secret|config)\\s+(?:ls|inspect)|docker\\s+system\\s+df|docker\\s+builder\\s+du|" +
    "kubectl\\s+config\\s+(?:current-context|get-contexts|get-clusters)|kubectl\\s+(?:api-resources|api-versions)|" +
    // git read subcommands. NOTE the shape: each name is followed by the
    // pattern's own trailing group, which requires whitespace or end-of-
    // string. A `\\b` here instead would let `cherry` match `git cherry-pick`
    // — a mutation classified as a read. Do not "simplify" this to \\b.
    // `git -c key=val` is deliberately NOT in the repo-selector prefix:
    // `git -c core.fsmonitor=CMD status` EXECUTES CMD.
    "git\\s+(?:-C\\s+\\S+\\s+|--git-dir=\\S+\\s+|--work-tree=\\S+\\s+|--no-pager\\s+)*(?:status|log|show|diff|rev-parse|ls-(?:files|tree|remote)|describe|blame|cat-file|rev-list|count-objects|for-each-ref|check-ignore|check-attr|merge-base|diff-tree|diff-index|diff-files|show-ref|show-branch|name-rev|shortlog|whatchanged|verify-pack|verify-commit|verify-tag|var|grep|stash\\s+(?:list|show)|worktree\\s+list|submodule\\s+status|bundle\\s+(?:verify|list-heads)|remote\\s+(?:-v|--verbose|show|get-url)|config\\s+(?:--local\\s+|--global\\s+|--system\\s+|--worktree\\s+)*(?:--list|-l|--get|--get-all|--get-regexp|--get-urlmatch)|tag\\s+(?:-l|--list|--contains|--points-at|--merged|--no-merged|--sort)|reflog(?:\\s+show|\\s+--[a-z]))|" +
    // Bare/listing forms only — anchored to end-of-segment, because
    // `git branch` lists but `git branch newbr` CREATES.
    "git\\s+(?:-C\\s+\\S+\\s+|--git-dir=\\S+\\s+|--work-tree=\\S+\\s+|--no-pager\\s+)*(?:branch(?:\\s+(?:-[arv]+|--all|--list|--verbose|--show-current))*|remote|tag|reflog|fsck(?:\\s+(?:--unreachable|--dangling|--no-dangling|--no-reflogs?|--full|--strict|--no-progress|--progress|--connectivity-only|--name-objects|--cache|--root|--tags|--verbose))*|version|--version)\\s*$|" +
    // `find` WITHOUT a writing/executing action only prints paths. Which
    // actions those are is decided by findIsReadOnly (layer 2) as a positive
    // allowlist of walk/test/print flags -- NOT by listing -delete/-exec.
    // Measured 2026-08-18: `find / -iname nav.conf 2>/dev/null` created a full
    // tier-2 snapshot on every call.
    "find|" +
    // A `curl` whose every option is on the output-free allowlist prints to
    // stdout and touches no file (curlIsReadOnly, layer 2). Same measurement:
    // read-only authenticated GETs produced 20+ identical snapshots in one run,
    // and the agent under test concluded the resulting stream of identical hook
    // messages was a prompt injection and disregarded all of them -- including
    // the one on the destructive call.
    "curl|" +
    // NB: sed and awk are deliberately NOT here. Both are general-purpose
    // interpreters that can WRITE files (sed `w`/`W`/`s///w`, awk
    // `print > f`) or EXECUTE shell (sed `e`/`s///e`, awk `system()`)
    // from inside their quoted script — invisible to a top-level
    // redirect/operator check. Treat every sed/awk as back-up (the only
    // cost is an occasional unnecessary snapshot for a read-only one).
    "pwd|id|whoami|groups|uname|date|echo|printf|true|false|" +  // environmental (date mutating forms bailed below; hostname removed — `hostname NAME` sets it)
    "cd|pushd|popd|" +                                   // directory nav — changes cwd only, no file mutation
    "printenv|locale|" +                                 // env vars (read). NB: `env` removed — `env <prog>` launches an arbitrary command (env rm -rf …) that the trailing-args group would swallow.
    "ps|top|df|du(?:\\s+-[a-zA-Z]+)*\\s*$|free|uptime|" + // sysinfo (du without target is no-op)
    "git\\s+(?:status|log|show|diff|branch\\s*$|remote\\s*$|config\\s+--get|rev-parse|ls-(?:files|tree|remote)|describe|blame|cat-file)|" +  // git read-only
    "pip(?:3)?\\s+(?:list|show|freeze|check)|" +         // pip introspection (list/show/freeze/check)
    "npm\\s+(?:list|ls|view|show|search|outdated|root|config\\s+get)|" +  // npm read-only
    "docker\\s+(?:ps|images|inspect|logs|version|info|stats|top|events|history|port)|" +  // docker read-only
    "kubectl\\s+(?:get|describe|logs|version|config\\s+view|cluster-info|explain)" +  // kubectl read-only
    // `python -c "import X"` and `node -e "require(x)"` were allowlisted
    // as import-checks but both EXECUTE arbitrary code: `import
    // sitecustomize` runs module top-level, `require('/repo/x')` runs that
    // module, and the quoted body can construct a writer with no quote/
    // operator the pre-checks see (require('fs').writeFileSync(
    // String.fromCharCode(...))). Removed — interpreters always back up,
    // like sed/awk/env.
  ")" +
  // Trailing args. This group used to stop at | ; & > because the pattern
  // was doing its own crude segmentation. It no longer has to: by the time
  // a segment reaches this regex the caller has already split the command
  // on UNQUOTED operators and resolved every redirection, so an operator
  // character still present here is quoted or escaped — literal text, not
  // syntax. Keeping the old class made `grep -E "a|b" .` unclassifiable.
  "(?:\\s+[^\\n\\r]*)?" +
  "\\s*$"
);

// ── curl / find argument classifiers ─────────────────────────────────
//
// DIRECTION MATTERS. The first version of these guards enumerated the
// MUTATING forms (`-o`, `-X POST`, `-delete`, `-exec`) and called
// everything else read-only. That is an allowlist built backwards: every
// flag the author didn't think of becomes a silent false-negative, and
// this file's own doctrine says a write misread as a read is STRICTLY
// WORSE than a read misread as a write. Measured gaps in that version:
// `--dump-header h.txt`, `-c cookies.txt`, `--cookie-jar jar.txt`,
// `--trace t.log`, `--trace-ascii t.log`, `--stderr err.log` all write
// files and all passed, and `--config evil.conf` feeds curl an arbitrary
// further option set from a file — an unbounded hole no denylist closes.
//
// Both classifiers below are therefore POSITIVE allowlists: an
// invocation is read-only only when EVERY flag in it is known to produce
// no file, no upload and no state change. Anything unrecognized — a flag
// we forgot, a flag a newer curl/find added, a typo — falls through to
// "not read-only" and takes a snapshot. The cost of that failure is one
// unnecessary snapshot; the cost of the other direction is lost data.

/**
 * THE NULL DEVICE. It is the one destination that accepts bytes and keeps
 * nothing: writing to it creates no file, truncates no file, and changes no
 * state. Every place that has to answer "is this destination real state?"
 * asks THIS function, so the shell-redirect path (`>/dev/null`,
 * `2>>/dev/null`, `&>/dev/null`) and a tool's own output option
 * (`curl -o /dev/null`, `--output /dev/null`) can never drift apart.
 *
 * Only the literal device qualifies. `/dev/nullx`, `/dev/null.bak` and
 * `/dev/nullish` are ordinary files whose names merely start the same way,
 * and writing to them IS a write.
 */
function isNullDevice(target: string): boolean {
  return target === "/dev/null";
}

/** Split a single command segment into shell words, honoring quotes and
 *  backslash escapes. Returns null on an unbalanced quote (unparseable →
 *  caller must treat the segment as NOT read-only). */
function shellWords(seg: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      if (c === "\\" && quote === '"' && i + 1 < seg.length) { cur += seg[++i]; started = true; continue; }
      cur += c; started = true; continue;
    }
    if (c === '"' || c === "'") { quote = c; started = true; continue; }
    if (c === "\\" && i + 1 < seg.length) { cur += seg[++i]; started = true; continue; }
    if (/\s/.test(c)) { if (started) { out.push(cur); cur = ""; started = false; } continue; }
    cur += c; started = true;
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

/** curl long options that take ONE argument, none of which can name an
 *  output file or carry a request body. `request` is special-cased: only
 *  GET/HEAD keep the call read-only. */
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
  // Options whose ARGUMENT decides the verdict — see curlArgIsReadOnly.
  "request", "output", "write-out",
]);

/** curl short options taking no argument (bundle-safe: `-sSL`). */
const CURL_SAFE_SHORT_NOARG = "sSLkiIvfGgjNh46V";
/** curl short options taking one argument (value may be glued or next word). */
const CURL_SAFE_SHORT_ARG = "HAeuxmbrXtzow";

/** Short spellings of the options whose argument is checked below. Written
 *  as a mapping so the check lives in ONE place for both spellings. */
const CURL_SHORT_TO_LONG: Readonly<Record<string, string>> = {
  X: "request", o: "output", w: "write-out",
};

/**
 * The three curl options that are read-only only for SOME arguments.
 *
 *  --request  the method must not ask the server to change anything.
 *  --output   a destination that keeps the bytes is a write; the null
 *             device keeps nothing (isNullDevice — same predicate the
 *             shell-redirect path uses).
 *  --write-out  emits a format string on stdout. It is a report, not a
 *             file — EXCEPT that curl's format language has directives
 *             that open files (`%output{...}` redirects the rest of the
 *             format into a file, and a leading `@` reads the format from
 *             a file). So accept only the plain shape: every `%` starts a
 *             `%{variable}` or an escaped `%%`. Any other directive —
 *             including one a future curl invents — is unrecognised and
 *             backs up, which is why this is a shape test and not a list
 *             of forbidden directive names.
 */
function curlArgIsReadOnly(name: string, val: string): boolean {
  switch (name) {
    case "request": return /^(?:GET|HEAD)$/i.test(val);
    case "output": return isNullDevice(val);
    case "write-out": return !val.startsWith("@") && !/%(?![{%])/.test(val);
    default: return true;
  }
}

/**
 * A `curl` invocation is read-only IFF every option in it is on the
 * allowlists above (and `-X`/`--request` names GET or HEAD). Anything
 * else — an unknown flag, a body, an upload, any of the seven distinct
 * ways curl can be told to write a file — returns false and the caller
 * takes a snapshot.
 *
 * This does NOT and cannot decide whether the REMOTE endpoint mutates
 * on a GET. Nothing in the command text can. What it does guarantee is
 * that the local filesystem is untouched and no request body/method
 * asked the server to change anything.
 */
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
    // Short cluster: every char must be a no-arg option, except the last
    // recognized one may take an argument (glued remainder or next word).
    let ok = true;
    for (let c = 1; c < w.length; c++) {
      const ch = w[c];
      if (CURL_SAFE_SHORT_NOARG.includes(ch)) continue;
      if (CURL_SAFE_SHORT_ARG.includes(ch)) {
        const glued = w.slice(c + 1);
        const val = glued.length > 0 ? glued : words[++i];
        if (val === undefined) { ok = false; break; }
        const long = CURL_SHORT_TO_LONG[ch];
        if (long !== undefined && !curlArgIsReadOnly(long, val)) { ok = false; break; }
        c = w.length;                                      // rest consumed as the value
        break;
      }
      ok = false; break;                                   // unknown short option
    }
    if (!ok) return false;
  }
  return true;
}

/** find predicates/options that only walk, test and PRINT TO STDOUT.
 *  Deliberately excludes every action that writes or executes:
 *  -delete, -exec, -execdir, -ok, -okdir, -fprint, -fprint0, -fprintf,
 *  -fls. Because this is an allowlist, a NEW writing action in a future
 *  find is safe by default — it is simply not on the list. */
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

/**
 * A `find` invocation is read-only IFF every dash-token in it is a known
 * walk/test/print flag. `find` is often assumed to have a small closed
 * set of dangerous actions, but that assumption is exactly the trap the
 * curl guard fell into: -delete/-exec/-ok are the GNU set today, and a
 * denylist silently mis-classifies anything added later or anything from
 * a different find implementation. Allowlist instead — an unrecognized
 * flag just costs one snapshot.
 */
/** Allowlisted `find` predicates that CONSUME the next word as a value.
 *  Needed because a value can start with `-` (`-size -1k`, `-mmin -10080`)
 *  and would otherwise be judged as an unknown flag. */
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
    // A VALUE that merely looks like a flag: `-size -1k`, `-mmin -10080`,
    // `-newermt '-5 minutes'`. It is the operand of the PRECEDING predicate,
    // not a predicate of its own, so it must not be judged as one. Only
    // predicates already on the allowlist can grant this, so it cannot
    // launder an unknown flag.
    if (i > 1 && FIND_VALUE_FLAGS.has(words[i - 1])) continue;
    if (i > 1 && /^-newer[aBcm][aBcmt]$/.test(words[i - 1])) continue;
    return false;                                          // -delete, -exec, unknown
  }
  return true;
}

// ── `file` ───────────────────────────────────────────────────────────
// `file` reads and prints — except for `-C`/`--compile`, which COMPILES a
// magic file and writes `NAME.mgc` into the cwd (measured: 864 bytes produced
// by `file -C -m NAME`). It was on the layer-1 verb list with no layer-2
// classifier, so that write was invisible. Same allowlist shape as curl/find:
// `-C` is rejected by being absent, not by being named, so a future writing
// option is safe without anyone noticing it exists.

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
/** `file` short options: no-arg, then arg-taking. `C` is on NEITHER. */
const FILE_SAFE_SHORT_NOARG = "bhLiklnNprszZ0v";
const FILE_SAFE_SHORT_ARG = "meFfP";

/**
 * A `file` invocation is read-only IFF every option is a known read/print
 * option. `-C`, `-d`, and anything unrecognized fall through to "back it up".
 */
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
    let ok = true;
    for (let c = 1; c < w.length; c++) {
      const ch = w[c];
      if (FILE_SAFE_SHORT_NOARG.includes(ch)) continue;
      if (FILE_SAFE_SHORT_ARG.includes(ch)) {
        const glued = w.slice(c + 1);
        if (glued.length === 0 && words[++i] === undefined) { ok = false; break; }
        c = w.length;                                       // rest is the value
        break;
      }
      ok = false; break;                                    // -C, unknown short
    }
    if (!ok) return false;
  }
  return true;
}

// ── `date` ───────────────────────────────────────────────────────────
// The guard this replaces was a NEGATIVE one: it matched `-s`, `--set` and a
// bare numeric operand and called everything else a read. GNU getopt_long
// accepts any UNAMBIGUOUS PREFIX of a long option, and `--set` is the only
// GNU date long option beginning with `s`, so `date --se 2030-01-01` and
// `date --s 2030-01-01` both set the system clock and both slipped past a
// guard looking for the literal `--set`. There is no way to finish a denylist
// against prefix matching — every proper prefix of every dangerous option
// would have to be enumerated. An allowlist has no such problem: `--se` is
// simply not a recognized read option, so it backs up, and so does any
// abbreviation of anything else. (Abbreviations of SAFE options, `--dat` for
// `--date`, also back up. That is one unnecessary snapshot, the cheap side.)

/** `date` long options that take no argument and only print. */
const DATE_SAFE_LONG_NOARG = new Set([
  "utc", "universal", "rfc-email", "rfc-822", "rfc-2822", "debug",
  "help", "version", "resolution",
]);
/** `date` long options that take one argument and only print. */
const DATE_SAFE_LONG_ARG = new Set(["date", "file", "reference", "rfc-3339"]);
/** `date` long options whose argument is optional (`--iso-8601[=FMT]`). */
const DATE_SAFE_LONG_OPTARG = new Set(["iso-8601"]);

/**
 * A `date` invocation is read-only IFF every option is a known print/format
 * option and every operand is a `+FORMAT`. A bare operand (`date 010100002020`)
 * SETS THE CLOCK, so an operand that is not a format is rejected.
 */
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
    // Short cluster. `-u`/`-R` take nothing; `-I` takes an OPTIONAL glued
    // value (`-Iseconds`); `-d`/`-f`/`-r` take one, glued or next word.
    let ok = true;
    for (let c = 1; c < w.length; c++) {
      const ch = w[c];
      if (ch === "u" || ch === "R") continue;
      if (ch === "I") { c = w.length; break; }              // -I / -Iseconds
      if ("dfr".includes(ch)) {
        const glued = w.slice(c + 1);
        if (glued.length === 0 && words[++i] === undefined) { ok = false; break; }
        c = w.length;
        break;
      }
      ok = false; break;                                    // -s, unknown short
    }
    if (!ok) return false;
  }
  return true;
}

/** ripgrep flags that only search and print. ripgrep's full option set is
 *  ~100 flags and includes at least two that EXECUTE an arbitrary binary
 *  (`--pre CMD` runs a preprocessor per file, `--hostname-bin CMD`), so it
 *  gets the same treatment as curl: a small allowlist, everything else
 *  backs up. Long forms only need listing when they are actually used;
 *  an unlisted long form is simply not read-only. */
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

/** `rg` is read-only IFF every option present is on the search/print
 *  allowlist. `--pre`, `--pre-glob`, `--hostname-bin` and `--generate`
 *  are absent from it, so they fall through to a snapshot without being
 *  named — which is the point: an exec-capable flag added by a future
 *  ripgrep is unsafe-by-default, not safe-by-omission. */
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
      if (RG_SAFE_LONG_NOARG.has(name)) { if (eq !== -1) return false; continue; }
      if (RG_SAFE_LONG_ARG.has(name)) {
        if (eq === -1 && words[++i] === undefined) return false;
        continue;
      }
      return false;
    }
    let ok = true;
    for (let c = 1; c < w.length; c++) {
      const ch = w[c];
      if (RG_SAFE_SHORT_NOARG.includes(ch)) continue;
      if (RG_SAFE_SHORT_ARG.includes(ch)) {
        if (w.length === c + 1 && words[++i] === undefined) { ok = false; }
        c = w.length; break;
      }
      ok = false; break;
    }
    if (!ok) return false;
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
 * `python3 -m json.tool` / `-m base64` are read-only ONLY as pure stdin
 * filters — with NO positional argument at all.
 *
 * Verified against the interpreter in the test image (Python 3, GNU
 * findutils 4.10.0 container): `usage: python -m json.tool [-h]
 * [--sort-keys] … [infile] [outfile]` — the SECOND positional
 * "write the output of infile to outfile" TRUNCATES AND OVERWRITES a file
 * with no shell redirect anywhere in the command. `python3 -m json.tool
 * a.json b.json` therefore destroys b.json while looking, to every
 * redirect/operator check in this file, exactly like the read tail of an
 * API pipeline. Requiring zero positionals keeps the real-world form
 * (`curl … | python3 -m json.tool`) fast and sends every other form to a
 * snapshot.
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
    if (PY_MODULE_SAFE_NOARG.has(name)) { if (eq !== -1) return false; continue; }
    if (PY_MODULE_SAFE_ARG.has(name)) { if (eq === -1) i++; continue; }
    return false;
  }
  return true;
}

/**
 * Per-verb argument classifiers.
 *
 * SHAPE OF THE WHOLE GATE, in two layers, both allowlists:
 *
 *   Layer 1 — READ_ONLY_BASH_PATTERN is a closed list of VERBS. A verb it
 *     does not name is not read-only, full stop. `wget`, `aria2c`, `http`,
 *     `psql`, `jq`, `awk`, `sed`, `tee` and everything not yet invented
 *     get the safe answer (take a snapshot) with no rule written for them.
 *     Adding a verb is a deliberate act; forgetting one is harmless.
 *
 *   Layer 2 — this table. A verb that CAN write or execute through its own
 *     options, with no shell redirect for the top-level check to catch,
 *     must additionally pass a classifier that allowlists every option it
 *     accepts. A verb with no entry here is one that cannot write or exec
 *     at all (`ls`, `stat`, `wc`, `pwd`, `uname`); `grep` was checked
 *     against its own --help in the test image and has no output-file or
 *     exec option, only `-f FILE` which READS.
 *
 * Both layers fail toward "back it up". Nothing here needs to enumerate a
 * dangerous flag to be safe from it.
 */
// ── sort / uniq / crontab ────────────────────────────────────────────
// Three verbs the corpus scan added to layer 1, each of which can write or
// delete through its OWN options with no shell redirect for the top-level
// check to see. They are only safe to admit together with these classifiers.

/** `sort` long options taking no argument. `--parallel` is NOT here: it takes
 *  one (a corrected miscoding — the wrong form failed safe, but wrongly). */
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
/** `sort` short options. `m` is here (it takes NO argument — corrected); the
 *  ones that consume a value are in SORT_SAFE_SHORT_ARG. */
const SORT_SAFE_SHORT_NOARG = "bdfgiMhnRrsuzVcm";
const SORT_SAFE_SHORT_ARG = "ktS";

/**
 * `sort` writes with `-o FILE` / `--output=FILE` and EXECUTES with
 * `--compress-program=PROG`. Neither appears in the sets above, so both fall
 * through to a snapshot WITHOUT being named — the allowlist direction again.
 *
 * The generic `--output|-O` guard in segmentIsReadOnly does not save us here:
 * it does not match lowercase `-o`, which is exactly sort's spelling.
 */
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
      if (SORT_SAFE_LONG_NOARG.has(name)) { if (eq !== -1) return false; continue; }
      if (SORT_SAFE_LONG_ARG.has(name)) {
        if (eq === -1 && words[++i] === undefined) return false;
        continue;
      }
      return false;                                        // --output, --compress-program
    }
    let ok = true;
    for (let c = 1; c < w.length; c++) {
      const ch = w[c];
      if (SORT_SAFE_SHORT_NOARG.includes(ch)) continue;
      if (SORT_SAFE_SHORT_ARG.includes(ch)) {
        if (w.length === c + 1 && words[++i] === undefined) { ok = false; }
        c = w.length; break;
      }
      ok = false; break;                                   // -o, unknown short
    }
    if (!ok) return false;
  }
  return true;
}

/**
 * Verbs whose SECOND positional is an OUTFILE that is created or truncated
 * with no shell redirect anywhere: `uniq IN OUT` truncates OUT. This is the
 * same trap pyModuleIsReadOnly already guards for `python3 -m json.tool`, and
 * it is invisible to every redirect and operator check in this file. Such a
 * verb is read-only only with AT MOST ONE positional.
 */
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
    if (w === "-") { positionals++; continue; }
    if (!w.startsWith("-")) { positionals++; continue; }
    if (w === "--") return false;
    const eq = w.indexOf("=");
    const name = eq === -1 ? w : w.slice(0, eq);
    if (spec.noarg.has(name)) { if (eq !== -1) return false; continue; }
    if (spec.arg.has(name)) { if (eq === -1) i++; continue; }
    if (/^-[fsw][0-9]+$/.test(w)) continue;                // glued value: -w4
    return false;
  }
  return positionals <= 1;
}

/**
 * `crontab` is read-only ONLY as `-l` (optionally `-u USER`). `-r` DELETES the
 * user's whole crontab, `-e` opens an editor, and a bare FILE positional
 * INSTALLS that file as the crontab. Requiring `-l` to be PRESENT — rather
 * than rejecting the dangerous spellings — means a bare `crontab` and every
 * future subcommand back up by default.
 */
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
//
// Everything below decides WHICH COMMANDS a shell line actually runs. It
// never decides whether a command is safe — that is the closed verb list
// plus the layer-2 classifiers above. The split matters: a construct
// (`cd X && …`, a `for` loop, a `$( … )`, a `VAR=… ` prefix) is handled
// once, structurally, and then every verb — the ones named here, the ones
// named nowhere, and the ones that do not exist yet — is judged by the
// same allowlist. Nothing here adds a verb, so nothing here can make an
// unknown verb read-only.

/** Opaque stand-in for a resolved command substitution. Deliberately not a
 *  shell verb, so it can never satisfy the allowlist by accident. */
const SUBST_PLACEHOLDER = "__rb_subst__";

/**
 * Replace every command substitution — `$( … )` and back-quotes — with an
 * opaque literal, having first classified WHAT IS INSIDE IT by these same
 * rules.
 *
 * A substitution runs a command, so the outer line is read-only only if
 * the inner one is. `TOKEN=$(cat /etc/token)` reads; `X=$(rm -rf /tmp/y)`
 * destroys. The previous code bailed at the sight of `$(`, which meant
 * every credential-loading or timestamped command paid for a snapshot.
 * Recursion is the general answer: the inner command gets exactly the
 * same verdict machinery as the outer one, so no verb needs a second
 * opinion and nothing has to be re-enumerated here.
 *
 * The substitution is replaced by a WORD, not by the inner text, because
 * that is what the shell does: the output becomes data, never syntax.
 * `$(echo rm) -rf x` therefore becomes `__rb_subst__ -rf x`, whose verb is
 * not on the allowlist — unclassifiable, so it backs up.
 *
 * Single-quoted regions are skipped: the shell does not expand there.
 * Returns null (→ not read-only) on an unterminated substitution, on an
 * inner command that is not read-only, or on pathological nesting.
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
      if (c === "\\" && i + 1 < out.length) { i++; continue; }
      if (quote) { if (c === quote) quote = null; continue; }
      if (c === "'" || c === '"') { quote = c as '"' | "'"; continue; }
      if (c === "`") { start = i; kind = "tick"; break; }
      if (c === "$" && out[i + 1] === "(") { start = i; kind = "paren"; break; }
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
        if (c === "\\" && i + 1 < out.length) { i++; continue; }
        if (q) { if (c === q) q = null; continue; }
        if (c === "'" || c === '"') { q = c; continue; }
        if (c === "(") depthParen++;
        else if (c === ")") { depthParen--; if (depthParen === 0) { close = i; break; } }
      }
      if (close === -1) return null;
      inner = out.slice(start + 2, close);
      end = close + 1;
    }
    // The inner command is judged by the SAME function, so nested
    // substitutions, loops and pipes inside it are handled too. An
    // arithmetic expansion `$(( … ))` arrives here as `( … )`, which is
    // not a command and is therefore not read-only: conservative.
    if (!isReadOnlyBashInner(inner, depth + 1)) return null;
    out = out.slice(0, start) + SUBST_PLACEHOLDER + out.slice(end);
  }
  return null;                               // absurd nesting → bail
}

/**
 * Split a command line into the segments the shell would run, quote-aware,
 * resolving redirections on the way. Returns null when the line cannot be
 * parsed or contains a construct whose effect is not decidable here —
 * null always means "not read-only".
 *
 * Quote-awareness is not cosmetic. The previous splitter was
 * `cmd.split(/&&|\|\||[;|]/)`, which cuts inside quotes: `grep -E "a|b" .`
 * became `grep -E "a` and `b" .`, and the second fragment has no known
 * verb, so an ordinary grep was treated as a possible write. An operator
 * separates commands only when UNQUOTED, so the splitter has to track
 * quoting to agree with the shell.
 *
 * Redirections are resolved HERE, by their target, rather than by a regex
 * over the whole line, because `>` is the one operator that creates or
 * truncates a file with no verb involved:
 *   `> f`, `>> f`, `&> f`, `>| f`   real destination → bail
 *   `>/dev/null` in any of those forms → isNullDevice → drop, it is noise
 *   `2>&1`, `>&2`  duplicate a descriptor; no file is named → drop
 *   `< f`   input redirection READS → drop
 *   `<<`, `<(`  heredoc / process substitution → bail
 * A leading file-descriptor number (`2>`) belongs to the operator, so it
 * is removed from the segment rather than left behind as an argument.
 *
 * `(` and `)` (subshell, grouping) bail: the segments inside them are
 * still commands, but their nesting is not modelled here.
 *
 * `redirectTargets` is an OPT-IN out-parameter. Callers that omit it get the
 * behaviour described above unchanged (a real destination → null → "not
 * read-only"). Callers that pass an array get the destination pushed into it
 * and the parse continues, so they can judge the target themselves — the
 * effect-bounded gate needs `echo x > build/out.txt` (in-workspace, covered by
 * the tier-2 snapshot) to be distinguishable from `echo x > /etc/hosts`, and
 * the only place that knows the target is here. Nothing else about the parse
 * changes; heredocs, process substitutions and subshells still bail for both
 * kinds of caller.
 */
function splitTopLevel(command: string, redirectTargets?: string[]): string[] | null {
  const segs: string[] = [];
  let buf = "";
  const push = (): void => { const t = buf.trim(); if (t) segs.push(t); buf = ""; };

  /** Read one shell word starting at `from` (skipping blanks). Returns the
   *  unquoted word and the index just past it, or null if there is none. */
  const readWord = (from: number): [string, number] | null => {
    let j = from;
    while (j < command.length && (command[j] === " " || command[j] === "\t")) j++;
    let w = "";
    let q: string | null = null;
    for (; j < command.length; j++) {
      const c = command[j];
      if (q) { if (c === q) { q = null; continue; } w += c; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === "\\" && j + 1 < command.length) { w += command[++j]; continue; }
      if (/[\s;|&<>()]/.test(c)) break;
      w += c;
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
    if (c === "\\" && i + 1 < command.length) { buf += c + command[++i]; continue; }
    // Substitutions were resolved before this call; anything left is
    // unterminated or otherwise unparseable.
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
      let dup = false;
      if (command[j] === "&") { dup = true; j++; }
      const r = readWord(j);
      if (!r) return null;
      const [target, next] = r;
      if (dup) { if (!/^\d+$/.test(target) && target !== "-") return null; }
      else if (!isNullDevice(target)) {
        // A real destination. Read-only callers bail (a write is a write);
        // effect-bounded callers collect it and decide by where it points.
        if (!redirectTargets) return null;
        redirectTargets.push(target);
      }
      i = next - 1;
      continue;
    }
    // A newline separates commands exactly as `;` does. isReadOnlyBash never
    // reaches here with one (it bails on newlines by design), so this is
    // inert for that caller and load-bearing only for the effect-bounded gate,
    // which classifies every line rather than refusing to look.
    if (c === "\n" || c === "\r") { push(); continue; }
    if (c === "&") { push(); if (command[i + 1] === "&") i++; continue; }
    if (c === "|") { push(); if (command[i + 1] === "|") i++; continue; }
    if (c === ";") { push(); if (command[i + 1] === ";") i++; continue; }
    buf += c;
  }
  push();
  return segs;
}

/** Shell keywords that INTRODUCE a command (`do rm x`, `if grep …`). They
 *  run nothing themselves, so they are stripped and whatever follows is
 *  judged as an ordinary command. */
const KEYWORD_PREFIX = /^(?:!|do|then|else|elif|if|while|until)\s+/;
/** Shell keywords that are a whole segment and run nothing at all. */
const KEYWORD_ONLY = /^(?:done|fi|esac|do|then|else|;;)$/;
/** `for NAME in WORD…` — the header of a loop. It expands words and binds a
 *  variable; it executes no command (a `$( … )` in the word list was
 *  already resolved, and a redirect there was already judged). The loop
 *  BODY arrives as its own segments and is classified on its own merits. */
const FOR_HEADER = /^for\s+[A-Za-z_][A-Za-z0-9_]*(?:\s+in(?:\s[^\n\r]*)?)?$/;
/** A `NAME=VALUE` prefix. The shell assigns and then runs whatever follows
 *  — so strip the assignments and judge the rest. Nothing is exempted by
 *  being an assignment: `FOO=bar rm -rf /` still resolves to `rm`. */
const ASSIGN_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;|&<>]*)\s*/;

/**
 * Environment variables that cannot change WHAT CODE RUNS.
 *
 * THIS IS A RULE-SHAPE FIX, NOT A RESPONSE TO AN INCIDENT. Measured across
 * 1,193 recorded trajectories, the dangerous prefixes below appear in ZERO
 * runs; the only behaviour-changing ones agents actually write are `PATH=`
 * (104 runs) and `PYTHONPATH=` (39, nearly all `PYTHONPATH=. pytest …`, and
 * pytest is not on the read-only allowlist anyway). So the exposure today is
 * nil, and that is exactly the point: the old code peeled EVERY assignment and
 * judged only the trailing verb, which silently assumes every variable is
 * inert. Nothing enforced that assumption — it merely happened to hold in the
 * traffic we had. That is the same defect as a gate that treats "no rule
 * matched" as "safe": the variable nobody anticipated must land on the safe
 * side BY CONSTRUCTION, not by luck.
 *
 * What the old shape allows, once someone does write one of these, is an
 * assignment that makes an ALLOWLISTED READ VERB execute someone else's code.
 * The verb stays `cat`, the allowlist passes, and NO BACKUP IS TAKEN.
 * Demonstrated on this build:
 *
 *   LD_PRELOAD=./pre.so cat pre.c            .so constructor ran, wrote a file
 *   GIT_EXTERNAL_DIFF=./ext.sh git diff      the diff program ran, wrote a file
 *   PATH=/tmp/evil ls                        resolves `ls` to an attacker's binary
 *   KUBECONFIG=/tmp/evil.yaml kubectl get    redirects the cluster/exec-plugin
 *   BASH_ENV=/tmp/x.sh cat /etc/hostname     sourced by any non-interactive bash
 *
 * LD_PRELOAD alone defeats EVERY verb on the read-only list, since all of them
 * are dynamically linked — so a command that deletes a directory tree could be
 * classified read-only and snapshotted zero times.
 *
 * This is an ALLOWLIST, and it has to be. A denylist of the LD_ family, the
 * GIT_ family and PATH would be a list of the ones two people happened to
 * think of; the loader, libc, git, every CLI with its own _CONFIG variable,
 * and every tool not yet written keep adding more. Naming the SAFE ones instead means a variable nobody
 * anticipated lands on the safe side by construction — it is simply not here,
 * so its command backs up.
 *
 * The bar for entry is: it changes rendering or wording, and nothing else. It
 * must not name a path that is loaded, must not select a program, and must not
 * alter the parsing of anything downstream.
 *
 * KEEP IT STRICT. Widening it to spare real traffic is not worth doing,
 * because there is almost no real traffic to spare: of 24,551 recorded Bash
 * calls, 142 carry an assignment prefix and only 17 were classified read-only.
 * Their names are TOK (8), F, f (2 each), L, TOKEN, B, TAG, LOG — plain
 * data-carrying variables that no principled safe-list would admit. Those 17
 * now take a snapshot. A `TOK*` wildcard or a "looks harmless" heuristic would
 * buy back 17 commands out of 24,551 and reintroduce exactly the
 * judge-by-appearance rule this replaces.
 *
 * IFS is NOT here, though it was proposed as harmless. It is not a loader
 * variable, but it changes how a shell splits words, and it is EXPORTED to the
 * command — so any allowlisted verb that itself invokes a shell (git runs
 * hooks, aliases and a pager; kubectl runs exec credential plugins) has its
 * downstream parsing altered by it. "Cannot change what code runs" is the
 * test, and IFS cannot be shown to pass it. Off the list, it costs one
 * snapshot; on the list, it is an unbounded hole.
 *
 * Note what is NOT caught by the LC_ prefix and must never be added: LOCPATH
 * and GCONV_PATH name directories glibc LOADS FROM. They are locale-adjacent
 * in spelling only.
 */
const INERT_ENV_ASSIGNMENT =
  /^(?:LC_[A-Z]+|LANG|LANGUAGE|TZ|COLUMNS|LINES|TERM)=/;
/**
 * Programs whose whole job is to run ANOTHER program. The verb that would
 * be classified is their argument, not them, so they can never be
 * read-only. None of them is on the allowlist either — this set is
 * defence in depth, not the guarantee.
 */
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
  // Peel `NAME=VALUE` prefixes; a segment that is ONLY assignments runs no
  // command (and its values were classified during substitution
  // resolution, so `X=$(rm -rf y)` never reaches here).
  //
  // An assignment whose NAME is not known inert is itself the mutation vector
  // — LD_PRELOAD, BASH_ENV, PATH and friends make the trailing read verb
  // execute arbitrary code — so the segment is not read-only no matter what
  // verb follows. See INERT_ENV_ASSIGNMENT.
  //
  // It matters ONLY when a command follows. `FOO=bar` on its own runs nothing
  // and, without `export`, does not even enter the environment of a later
  // command — so an assignment-only segment stays read-only whatever its name.
  // (`export FOO=bar` is a different verb and is not on the read-only list.)
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
  // Layer 2: if this verb has an argument classifier, its verdict is
  // final — the classifier allowlists every option, so the generic
  // guards below are subsumed by it.
  for (const [verbPattern, classify] of BASH_ARG_CLASSIFIERS) {
    if (verbPattern.test(seg)) return classify(seg);
  }
  // Per-segment guard for allowlisted verbs that read in their bare form but
  // WRITE with a flag: `--output=FILE` / `-O FILE` (e.g. `git diff
  // --output=x`) writes a file with no shell redirect for the top-level check
  // to catch. (`date` used to be guarded here by a negative test; it now has
  // a positive layer-2 classifier above, which is why this is one line
  // shorter — see dateIsReadOnly for why the negative form was unfixable.)
  if (/(?:^|\s)(?:--output(?:[=\s]|$)|-O\b)/.test(seg)) return false;
  return true;
}

/**
 * Is this Bash invocation known to write nothing?
 *
 * The question is deliberately one-sided. A write misread as a read loses
 * user state silently; a read misread as a write costs one snapshot. So
 * this returns true only when EVERY command the line runs is on the
 * closed verb allowlist AND passes that verb's argument classifier.
 * Everything else — an unknown verb, an unknown flag, an unparseable
 * quote, a construct not modelled here — returns false.
 *
 * Two layers do the work, and they are separate on purpose:
 *   structure   which commands does this line run? (substitutions,
 *               operators, redirections, loop keywords, assignments)
 *   vocabulary  is that command, with those arguments, a known read?
 * Structure never adds a verb. That is why `wget`, `psql`, `dd`, `nc`,
 * `rsync` and everything not yet written get the safe answer without a
 * rule naming any of them: they are simply absent from the allowlist,
 * wherever in the line they appear.
 */
export function isReadOnlyBash(command: string): boolean {
  return isReadOnlyBashInner(command, 0);
}

/**
 * The argv of a command line that is ONE simple command, or null.
 *
 * This is the shell-shape gate in front of the learned read-only store.
 * A learned pattern describes what a PROGRAM does with a given argv; it
 * says nothing about what the shell does around that program. So
 * `capctl allot --json` may match a pattern, while
 * `capctl allot --json > /etc/passwd`, `capctl allot --json | sh` and
 * `capctl allot --json && rm -rf /var` must not — the destructive part is
 * not the program at all.
 *
 * Reuses the audited parser: resolveSubstitutions bails on `$(…)` and
 * backticks, splitTopLevel bails on redirections to a real file, heredocs,
 * process substitutions and subshells, and we additionally require exactly
 * ONE segment. On top of that we reject anything whose argv the shell would
 * still rewrite before exec — surviving `$` expansions, globs, `~`, brace
 * expansion, keyword prefixes and `NAME=VALUE` assignments — because the
 * tokens we would match are then not the tokens that run.
 *
 * Conservative in one direction only: null merely means "the learned store
 * cannot answer", which escalates, exactly as before.
 */
export function singleSimpleArgv(command: string): string[] | null {
  if (!command || /[\n\r]/.test(command)) return null;
  const resolved = resolveSubstitutions(command, 0);
  if (resolved === null) return null;
  // Reject ANY redirection, in or out. splitTopLevel deliberately DROPS an
  // input redirection (`< f` reads, so it cannot make a read-only line
  // write) — correct for that caller, wrong for this one: a learned pattern
  // is a claim about a program run with a given argv, and `tool apply < x`
  // hands the program a payload that argv does not describe. Scan before
  // the split, because the split has already thrown the operator away.
  {
    let q: string | null = null;
    for (let i = 0; i < resolved.length; i++) {
      const c = resolved[i];
      if (q) { if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === "\\") { i++; continue; }
      if (c === "<" || c === ">") return null;
    }
  }
  const segments = splitTopLevel(resolved);
  if (segments === null || segments.length !== 1) return null;

  const seg = segments[0].trim();
  if (!seg) return null;
  // A keyword prefix (`if`, `while`, `do`, …) means the segment is not a
  // plain command invocation.
  if (KEYWORD_ONLY.test(seg) || FOR_HEADER.test(seg) || KEYWORD_PREFIX.test(seg)) return null;
  // `NAME=VALUE cmd` changes the environment the program runs in.
  if (ASSIGN_PREFIX.test(seg)) return null;

  // Quote-aware split into words, rejecting anything the shell would still
  // expand. Note splitTopLevel has already removed operators, so a survivor
  // here is a genuine expansion character.
  const argv: string[] = [];
  let word = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      // A `$` inside double quotes still expands.
      if (quote === '"' && c === "$") return null;
      word += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; started = true; continue; }
    if (c === "\\") { if (i + 1 >= seg.length) return null; word += seg[++i]; started = true; continue; }
    if (c === " " || c === "\t") {
      if (started) { argv.push(word); word = ""; started = false; }
      continue;
    }
    // Expansion / globbing characters: the argv we would match is not the
    // argv that runs.
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

  // AN ARGUMENT THAT IS ITSELF CODE VOIDS THE CLAIM.
  //
  // A learned pattern says "this PROGRAM, with arguments of this shape,
  // only reads". That claim is meaningless when one of the arguments is a
  // program fragment rather than a datum: `/bin/bash -lc '<any script>'`
  // is one simple command syntactically, yet its argv describes nothing
  // about what runs. Measured on the corpus, this is not a corner case —
  // 994 of 1,482 potentially-skippable commands were shell-wrapped this
  // way, so a single pattern learned from a read-only `rg` would have
  // authorised every `bash -lc` for the rest of the session.
  //
  // The test is by SHAPE, not by naming interpreters: a payload argument
  // carries whitespace or shell syntax, a datum does not. That catches
  // `sh -c`, `python -c`, `perl -e`, `node -e`, `awk`, `ssh host '…'`,
  // `xargs`, `find -exec` and everything nobody has thought of yet,
  // without a list for any of them. Quoted DATA (`--month "2026-07"`)
  // survives, because stripping its quotes leaves a plain word.
  for (let i = 1; i < argv.length; i++) {
    if (/[\s;|&<>()$`{}[\]*?!#'"\\]/.test(argv[i])) return null;
  }
  return argv;
}

function isReadOnlyBashInner(command: string, depth: number): boolean {
  if (!command) return false;
  if (depth > 4) return false;                    // runaway nesting → bail
  // Newline / carriage return separate commands too, but a second line can
  // hold anything (`ls\nrm -rf /`) including heredoc bodies, so they are
  // not split — they bail.
  if (/[\n\r]/.test(command)) return false;
  const resolved = resolveSubstitutions(command, depth);
  if (resolved === null) return false;
  const segments = splitTopLevel(resolved);
  if (segments === null || segments.length === 0) return false;
  return segments.every(segmentIsReadOnly);
}

// ── EFFECT-BOUNDED BASH ───────────────────────────────────────────────
//
// WHY THIS EXISTS, AND WHY IT IS NOT A DENYLIST.
//
// The Bash branch of touchesOutsideWorkspace defaults to ESCALATE: Bash is an
// open set, the forms of destruction in it cannot be enumerated, so a command
// nobody has written a rule for must be assumed to reach outside. (The MCP /
// browser branch is the opposite shape — a finite, named, already-explored
// tool set — and keeps its allowlist. Both mechanisms coexist, one per branch;
// neither is the "real" one.)
//
// A blanket escalate-everything default would fire a tier-3 subagent for
// `mkdir foo`, which is absurd: tier-2 already snapshots the workspace before
// the call, so an action whose entire effect lands inside the workspace is
// ALREADY fully recoverable. This carve-out names that class exactly:
//
//   every segment's effect is bounded by its arguments
//   AND every path those arguments name resolves inside the workspace
//
// "Bounded by its arguments" is the whole test, and it is why this is an
// allowlist of UTILITIES rather than a list of safe-looking commands.
// `mkdir foo`, `cp a b`, `rm -rf build/` are completely described by their
// argv: read the words and you know every byte they can touch. Anything that
// EXECUTES A PROGRAM is not — its effects come from that program's source,
// which argv does not show. `python3 bin/capctl allot release --apply` names
// no absolute path anywhere on the command line and writes /var/lib/capline.
// So interpreter+script, a bare executable (`./bin/x`, `bin/x`,
// `/usr/local/bin/x`), `bash -c`, a heredoc fed to an interpreter, `xargs`,
// `env prog`, `sudo prog` and `find -exec` are all excluded BY SHAPE, not by
// being individually listed. A verb that is not in the table below gets the
// escalating answer with no rule written for it — including verbs that do not
// exist yet.

/**
 * Core utilities whose complete effect is spelled out by their arguments.
 *
 * Entry requirements, all three:
 *   1. It cannot execute another program (no -exec, no `system()`, no
 *      `--use-compress-program`, not an interpreter).
 *   2. It cannot write to, read from or mutate anything it was not handed as
 *      an argument (no config file that adds options, no network, no system
 *      state such as the clock, services or process table).
 *   3. Its options cannot smuggle in a destination the argument scan below
 *      would not see as a word.
 *
 * Deliberately ABSENT, and each for a reason that generalises:
 *   sed, awk, perl   — write (`s///w`, `print > f`) and execute (`e`,
 *                      `system()`) from inside a quoted script.
 *   tar, zip, unzip  — the destinations come from the ARCHIVE, not argv, and
 *                      the compress-program options run a binary.
 *   dd, jq, git      — respectively a raw device writer, a full language, and
 *                      a network client. None is bounded by its path args.
 *   date, kill, mount, systemctl — mutate system state no path argument names.
 *   make, npm, pytest, and every bare executable — they RUN something.
 *
 * Read-only verbs are not repeated here: a segment that isReadOnlyBash's own
 * closed verb list already clears is bounded by definition, and
 * segmentIsEffectBounded defers to it. This table is only the verbs that
 * WRITE (or that read without being on that list) and are still bounded.
 */
const EFFECT_BOUNDED_UTILS: ReadonlySet<string> = new Set([
  // Filesystem mutation, fully described by the paths in argv.
  "mkdir", "rmdir", "rm", "unlink", "cp", "mv", "ln", "touch", "truncate",
  "chmod", "chown", "chgrp", "tee", "split", "mktemp",
  // Text / hash utilities that neither execute nor write anywhere except a
  // path they were handed (`sort -o f`, `xxd -r > f`). They are not on the
  // read-only verb list — that list is deliberately tiny — but they are
  // bounded, which is the question this table answers.
  "sort", "uniq", "cut", "tr", "comm", "join", "paste", "nl", "rev", "tac",
  "fold", "expand", "unexpand", "column", "diff", "cmp", "cksum", "sum",
  "md5sum", "sha1sum", "sha224sum", "sha256sum", "sha384sum", "sha512sum",
  "b2sum", "base64", "base32", "od", "hexdump", "xxd", "strings", "shuf",
  "seq", "sleep",
]);

/**
 * Does this word name a location outside the workspace?
 *
 * Resolution is per-WORD (path.resolve on the whole word), which is the
 * correct question for an argument: `cp a ./sub/b` names two in-workspace
 * files. It is deliberately NOT the `token.match(/\/[\w./-]+/g)` scrape used
 * by the legacy absolute-path scan further up — that scrape reads `./sub/b`
 * as the absolute path `/sub/b`. The two are kept separate on purpose; only
 * the OUT-OF-WORKSPACE VERDICT is shared, via outsideWorkspaceResolved, so
 * the two halves cannot drift about what "outside" means.
 */
function wordEscapesWorkspace(word: string, workspace: string): boolean {
  try {
    return outsideWorkspaceResolved(path.resolve(expandHome(word)), workspace);
  } catch {
    return true;                                  // unresolvable → assume out
  }
}

/**
 * Is this segment's effect bounded by its own arguments?
 *
 * Argument scanning is separate from the verb question and both must pass:
 * a bounded verb pointed at /etc is not bounded in the sense that matters
 * (the tier-2 workspace snapshot would not capture what it destroyed).
 */
function segmentIsEffectBounded(segment: string, workspace: string): boolean {
  let seg = segment.trim();
  // Same structural peeling as segmentIsReadOnly: keywords introduce a
  // command, they are not one.
  for (let n = 0; n < 8; n++) {
    if (KEYWORD_ONLY.test(seg)) return true;      // `done`, `fi` — runs nothing
    if (FOR_HEADER.test(seg)) return true;        // loop header — runs nothing
    const stripped = seg.replace(KEYWORD_PREFIX, "");
    if (stripped === seg) break;
    seg = stripped.trim();
  }
  if (seg === "") return true;
  // `NAME=VALUE` prefixes assign and then run whatever follows. The same rule
  // as segmentIsReadOnly applies and for the same reason: an assignment whose
  // NAME is not known inert is itself the mutation vector, because it can make
  // the following command execute code that is nowhere in its arguments.
  // `LD_PRELOAD=./p.so rm -rf build/` has a bounded-looking verb and bounded-
  // looking paths, and runs an arbitrary constructor. Bounded-by-arguments is
  // exactly the claim such an assignment falsifies.
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

  // ── The verb must not RUN a program. ──
  // A launcher's real verb is its argument, not itself.
  if (COMMAND_LAUNCHERS.has(verb)) return false;
  // Any verb carrying a path component is an executable being invoked by
  // path — `./bin/pmark`, `bin/scenectl`, `/usr/local/bin/x`. What it does
  // is in its source, not in argv.
  if (verb.includes("/")) return false;
  // A verb on neither list is unknown, and unknown means escalate. Note the
  // read-only check is asked of the WHOLE segment so its layer-2 argument
  // classifiers (curl/find/rg/python -m) get to apply their own allowlists —
  // `find … -exec` and `curl -o` fail there and therefore fail here.
  if (!EFFECT_BOUNDED_UTILS.has(verb) && !segmentIsReadOnly(seg)) return false;

  // ── Every word must name something inside the workspace. ──
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    // An unexpanded variable or leftover substitution hides its own value;
    // `rm -rf "$DEST"` is not bounded by anything visible here.
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
 * Is every effect of this Bash line confined to the workspace, and visible in
 * its own arguments?
 *
 * True is the ONLY answer that skips the tier-3 subagent under the inverted
 * gate, so every uncertainty returns false: an unbalanced quote, a subshell,
 * a process substitution, a heredoc, a command substitution whose inner
 * command is not itself a read, or any segment that fails the test above.
 *
 * NEWLINES, unlike in isReadOnlyBash, are not an automatic bail. There they
 * are, because that function's job is to say a line writes NOTHING and a
 * second line can hold anything. Here every line is classified on its own
 * merits by the same rules — `ls\nrm -rf /` fails on its second segment, as
 * it should — so the shell's own reading (newline separates commands) is the
 * accurate one. The single construct that would make that reading wrong is a
 * HEREDOC, whose body is data rather than commands and is the standard way to
 * feed an interpreter (`python3 << 'EOF' … EOF`). splitTopLevel already bails
 * on `<<`; the explicit check below states the requirement at the level of
 * this function rather than leaving it as a property of the parser.
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

/**
 * Record the text the agent types into the browser (browser_type /
 * fill_form / fill / select_option). These actions don't back up, but the
 * VALUES they carry — a post title, a comment body — are exactly what a
 * later create/submit needs to PIN its recovery. The hook sees them; we
 * persist the last few so the backup subagent can read "what was just typed"
 * instead of re-deriving it from a live browser snapshot. Best-effort.
 */
export function recordBrowserInput(ctx: HookContext, config: SandboxConfig): void {
  try {
    const action = (ctx.tool_name.split("__").pop() || ctx.tool_name).toLowerCase();
    if (!/^browser_(type|fill_form|fill|select_option)$/.test(action)) return;
    const input = (ctx.tool_input ?? {}) as Record<string, unknown>;
    const vals: string[] = [];
    const push = (v: unknown) => { if (typeof v === "string" && v.trim() && v.length < 2000) vals.push(v.trim()); };
    push(input.text); push(input.value);
    if (Array.isArray(input.fields)) for (const f of input.fields) push((f as { value?: unknown })?.value);
    if (Array.isArray(input.values)) for (const v of input.values) push(v);
    if (!vals.length) return;
    const p = recentInputPath(config);
    let arr: { t: string; values: string[] }[] = [];
    try { arr = JSON.parse(fs.readFileSync(p, "utf-8")); } catch { /* fresh */ }
    arr.push({ t: new Date().toISOString(), values: vals });
    arr = arr.slice(-12);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(arr));
  } catch { /* best-effort — never block the action */ }
}

/** The recent typed values, newest last, deduped — for the subagent prompt. */
export function loadRecentBrowserInput(config: SandboxConfig): string[] {
  try {
    const arr = JSON.parse(fs.readFileSync(recentInputPath(config), "utf-8")) as { values: string[] }[];
    const out: string[] = [];
    for (const e of arr.slice(-8)) for (const v of (e.values ?? [])) out.push(v);
    return [...new Set(out)].slice(-10);
  } catch { return []; }
}

function recentSnapshotPath(config: SandboxConfig): string {
  return path.join(path.dirname(path.resolve(config.backupDir)), "recent-snapshot.json");
}

/**
 * Cache the agent's most recent browser PAGE VIEW (browser_snapshot/navigate).
 * Its tool_output IS the page as the agent saw it, which for an about-to-be
 * edited/deleted entity holds the PRE-state (the current field value, the post
 * body+comments). The backup subagent is then handed "WHERE THE CHANGE HAPPENS"
 * — the URL + this page state — so it (a) can't misclassify the action and
 * (b) has the original WITHOUT re-reading via its own lock-prone, costly
 * browser. TOOL-AGNOSTIC: works whether the main agent mutates via click+fill
 * or browser_run_code_unsafe — the source is the last page VIEW, not the typed
 * args (which run_code hides). Caches ONLY read-style views, NOT fill/type/
 * click (those reflect the page AFTER the edit → the new value, not the
 * original). Called from the post-tool hook (it has the tool_output). */
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
    // No truncation (owner's call): capture the FULL page so a delete's whole
    // entity (long body + comments) survives into PAGE_STATE. Prompt-token cost
    // grows with page size — revisit if it becomes a problem.
    // A page view whose snapshot the MCP wrote to a FILE (a `[Snapshot](….yml)`
    // link instead of an inline ```yaml block) has its content inlined HERE, at
    // the moment it is produced — see inlineSnapshotFiles. A view that already
    // carries its page inline has no such link and passes through unchanged.
    const snippet = inlineSnapshotFiles(text, config, ctx.cwd);
    const p = recentSnapshotPath(config);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ t: new Date().toISOString(), url, action, text: snippet }));
  } catch { /* best-effort — never block the action */ }
}

/**
 * PAGE SNAPSHOTS DELIVERED AS FILE LINKS.
 *
 * @playwright/mcp started with `--output-dir` (the browser-band task images
 * run it with `--output-dir /tmp/pwmcp-out --output-max-size 1024`) returns
 * the implicit page snapshot of browser_navigate / navigate_back — and of
 * browser_snapshot when asked for a filename — as a markdown LINK,
 * `- [Snapshot](../../tmp/pwmcp-out/page-<ts>.yml)`, relative to the MCP
 * server's own cwd. recordBrowserSnapshot cached that text verbatim, so the
 * backup subagent received a dead link as its PAGE_STATE while being told it
 * has no browser and must not fetch anything: every value the page held was
 * out of its reach, and it (correctly) reported UNVERIFIED.
 *
 * Fix: read the linked file now and inline it into the cached text. NOW is the
 * only safe moment. The MCP's output budget (`Context._enforceOutputBudget`)
 * runs on EVERY tool response and unlinks files in the output dir oldest-first,
 * sparing only the files that response itself wrote — so this page's .yml is
 * gone as soon as the NEXT tool call (any tool, any session sharing the dir)
 * answers. The post-tool hook of the call that produced it runs before that.
 *
 * Failure is LOUD, never silent: a link whose file cannot be read (already
 * evicted by a concurrent call, or on a filesystem this hook cannot see) or
 * reads empty gets an explicit NOT CAPTURED marker, so the subagent sees that
 * the page content is absent rather than a PAGE_STATE that looks complete.
 * A file too large to inline without pushing the subagent prompt (a single
 * argv string, capped by the kernel at 128 KiB) past its limit is COPIED into
 * the backup store in full and the link rewritten to that local path —
 * never truncated.
 *
 * Text without a snapshot file link is returned unchanged (byte-identical).
 */
const SNAPSHOT_FILE_LINK_RE = /\[Snapshot\]\(([^()\s]+?\.ya?ml)\)/g;
const SNAPSHOT_INLINE_MAX_BYTES = 80_000;

function resolveSnapshotFile(ref: string, cwd: string | undefined): string | null {
  const base = path.basename(ref);
  const cands: string[] = [];
  if (path.isAbsolute(ref)) cands.push(ref);
  for (const d of [process.env.RB_PWMCP_OUT, process.env.PLAYWRIGHT_MCP_OUTPUT_DIR]) {
    if (d) cands.push(path.join(d, base));
  }
  if (cwd) cands.push(path.resolve(cwd, ref));
  cands.push(path.resolve("/", ref));          // `../../tmp/x` from any depth-2 cwd
  cands.push(path.join("/tmp/pwmcp-out", base));  // the task images' --output-dir
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
    try { if (file) body = fs.readFileSync(file, "utf-8"); } catch { body = ""; }
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

/**
 * PRE-STATE pre-capture for opaque-code browser mutations
 * (browser_run_code_unsafe / browser_evaluate).
 *
 * The agent's JS may navigate to a value-bearing page that is loaded ONLY
 * inside the code (e.g. `await page.goto('.../account/edit_biography')`),
 * mutate it, and save. The cached snapshot is then of the page the agent was
 * ON before (e.g. /account) — which does NOT contain the about-to-change
 * value — so the backup subagent can only emit "UNVERIFIED".
 *
 * This function runs in the PRE-tool path: it parses literal URLs/paths out of
 * the code arg, fetches each page's HTML AUTHENTICATED (curl + the seeded
 * cookie jar persisted by seed_login.sh), and merges that text into the
 * recent-snapshot cache so the existing loadRecentBrowserSnapshot → PAGE_STATE
 * path surfaces the concrete original value (e.g.
 * `<textarea name="biography">t2_5adwlxvn</textarea>`).
 *
 * Best-effort: any failure (no code, no parseable URL, no cookie jar, fetch
 * error) leaves the cache untouched so the existing UNVERIFIED fallback stays
 * intact — no regression.
 */
/** Proposal B: extract a compact digest of editable form controls from fetched
 *  HTML so the subagent gets the ORIGINAL values without the multi-KB page.
 *  Node has no built-in HTML parser → robust best-effort regex extraction.
 *  Returns a compact JSON array string, or "" if no editable controls found
 *  (caller then falls back to the raw-HTML slice). */
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
  } catch { return ""; }
}

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
    // string-literal absolute paths (/user/.../account, /edit_biography, ...)
    for (const m of code.matchAll(/['"`](\/[A-Za-z0-9][^'"`\s]*)['"`]/g)) urls.add(m[1]);
    if (urls.size === 0) return;

    // Determine the base origin: prefer the first absolute URL seen, else the
    // origin of the currently cached snapshot's URL.
    let base = "";
    for (const u of urls) {
      const mm = u.match(/^(https?:\/\/[^/]+)/);
      if (mm) { base = mm[1]; break; }
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

    // Authenticated cookie jar persisted by seed_login.sh.
    const jar = process.env.SEED_COOKIE_JAR || "/tmp/wa-pw-profile/seed-cookies.txt";
    if (!fs.existsSync(jar)) return;    // no creds available → leave UNVERIFIED intact

    // Fetch each page (bounded count + size) and build a tagged blob.
    const parts: string[] = [];
    const MAX_URLS = 6;
    const MAX_BYTES = 200_000;          // per page cap to keep prompt bounded
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
            // Proposal B: compact editable-form-control digest (old values),
            // bounded ≤~1.5 KB, instead of the raw HTML.
            const blob = digest.length > 1500 ? digest.slice(0, 1500) : digest;
            parts.push(`\nPRE-CAPTURED FORM CONTROLS (authenticated GET) ${url} = ${blob}`);
            captured = true;
          } else {
            // FALLBACK: no editable controls (e.g. a delete-confirm page) →
            // keep today's length-capped raw-HTML slice so non-form pages still
            // get a usable pre-state.
            const body = out.length > MAX_BYTES ? out.slice(0, MAX_BYTES) : out;
            parts.push(`\n===== PRE-CAPTURED PAGE (authenticated GET) ${url} =====\n${body}`);
            captured = true;
          }
        }
      } catch { /* skip this URL */ }
    }
    if (!captured) return;

    // Merge into the recent-snapshot cache that feeds PAGE_STATE. Augment the
    // existing snapshot's text (keep what the agent saw) and tag the action so
    // the subagent treats this as a real pre-state page view.
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

/** The agent's last page view, if fresh — the subagent's PRE-state source.
 *  Returns null when none/stale so the caller fails to UNVERIFIED, not to a
 *  fabricated recovery. */
export function loadRecentBrowserSnapshot(
  config: SandboxConfig, maxAgeMs = 10 * 60_000,
): { url: string; text: string; t: string } | null {
  try {
    const s = JSON.parse(fs.readFileSync(recentSnapshotPath(config), "utf-8")) as { t: string; url: string; text: string };
    if (!s || !s.text) return null;
    const age = Date.now() - new Date(s.t).getTime();
    if (Number.isFinite(age) && age > maxAgeMs) return null;  // stale → not trustworthy pre-state
    return s;
  } catch { return null; }
}

// =====================================================================
// Tier-3 (cheap): pattern-driven MCP create reverter — a create whose learned
// pattern carries a deterministic `reverter` replays its native MCP inverse
// (e.g. create_directory -> delete_directory) at backup time, NO subagent.
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
 * Derive the MINIMAL MCP tool allowlist a capture subagent actually needs for
 * THIS action, from the learned experience — so hermes registers ~2-3 tool
 * schemas instead of the server's full list (the dominant per-call token cost).
 * Prefers the explorer's learned `capture_tools` for the matched pattern; if
 * absent, falls back to the action's own tool + a few read/snapshot tools (to
 * capture pre-state), capped at 5. Returns undefined when there's no
 * experience/match — the caller then
 * leaves the server UNFILTERED (today's safe default), so a backup never breaks.
 * GENERAL: derived from observed data, never a hardcoded per-server map.
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

  // PREFERRED: the LEARNED minimal toolset the explorer recorded for THIS op
  // (the exact read + restore tools Stage-2 verify actually used). This list
  // IS the allowlist — used VERBATIM (already deduped + capped at parse time),
  // never re-derived and never padded with the action's own tool (the explorer
  // already chose the minimal set, e.g. [read_text_file, write_file] for an
  // edit, deliberately WITHOUT edit_file). Intersect with observed tools so a
  // hallucinated name can't poison the include set; if nothing survives, fall
  // through to the heuristic below.
  if (pat?.capture_tools && pat.capture_tools.length) {
    const observed = new Set((exp.observed_tools ?? []).map(seg));
    const learned = pat.capture_tools.filter((t) => observed.has(seg(t)));
    if (learned.length) return learned;
  }

  // FALLBACK (no learned capture_tools — e.g. an experience from before this
  // field existed): derive heuristically from the action + read tools.
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
 * Pattern-driven CREATE reverter — the "T1/T2 for remote" cheap path. When the
 * matched learned pattern for an outside-workspace action is a CREATE that
 * carries a deterministic `reverter` (the explorer fills it ONLY for
 * create/insert/post/add/upload/new patterns), replay that fixed inverse
 * deterministically instead of paying for the capture subagent. Everything is
 * done over MCP: the inverse is a native tool call on the SAME server (e.g.
 * create_directory → delete_directory), never a local shell command.
 *
 * A create's inverse is unconditional: delete EXACTLY the entity this action
 * created, pinned by a STABLE identifier (the reverter's `pin` — an id, or a
 * unique input attribute like an exact title/key). We resolve that pinned value
 * from the already-captured typed input (the tool_input here, plus the recent
 * browser-typed values the hook persisted). If we CANNOT confidently resolve the
 * pinned value, return null and fall through to the capture subagent — we NEVER
 * guess, and NEVER target by position/recency.
 *
 * Returns a deterministic artifact (no subagent) on success, else null.
 */
export function tryPatternCreateReverter(
  ctx: HookContext,
  config: SandboxConfig,
): BackupArtifact | null {
  const server = serverFromToolName(ctx.tool_name);
  if (!server) return null;                          // not a remote/MCP action
  const expName = experienceNameForServer(config, server);
  if (!expName) return null;
  const pat = matchPattern(config, expName, ctx.tool_name, rawDescForMatch(ctx));
  const rev = pat?.reverter;
  if (!rev || !rev.pin) return null;                 // no deterministic create-inverse
  if (!(rev.commands?.length) && !(rev.mcp_calls?.length)) return null;

  // Resolve the PINNED stable identifier from already-captured typed input —
  // NEVER by position/recency. Look it up by the pin's name in the action's own
  // args first (exact key, then case-insensitive), e.g. pin "title" → input.title.
  const input = (ctx.tool_input ?? {}) as Record<string, unknown>;
  const pin = rev.pin.trim();
  const pinLc = pin.toLowerCase();
  const stringify = (v: unknown): string | null =>
    (typeof v === "string" && v.trim()) ? v.trim()
      : (typeof v === "number" || typeof v === "boolean") ? String(v) : null;
  let pinned: string | null = stringify(input[pin]);
  if (pinned === null) {
    for (const [k, v] of Object.entries(input)) {
      if (k.toLowerCase() === pinLc) { pinned = stringify(v); break; }
    }
  }
  // Browser creates carry no structured id arg — the value lives in the recently
  // typed text. Only adopt it when there is exactly ONE candidate, so we never
  // guess which typed string is the pinned identifier.
  if (pinned === null) {
    try {
      const recent = loadRecentBrowserInput(config);
      if (recent.length === 1) pinned = recent[0];
    } catch { /* optional */ }
  }
  if (pinned === null) return null;                  // unresolved → fall through to subagent

  // INJECTION GUARD: the pinned value comes from live tool_input (agent- and,
  // via prompt-injection from remote content, attacker-influenceable). It is
  // spliced verbatim into the recorded args below — for a SQL reverter that
  // means into a query STRING. A value like `x'; DROP TABLE posts; --` would
  // turn a one-row DELETE reverter into a DROP at restore. A legitimate pin is
  // a stable identifier (id, uuid, plain title) with no string-breaking chars;
  // anything with a quote / statement separator / comment marker / backslash /
  // newline is refused here and falls through to the subagent, which reverses
  // through the live MCP safely. Conservative (a title with an apostrophe also
  // falls through) but never guesses an escaping context we cannot know.
  if (/['"`;\\\n\r\x00]|--|\/\*|\*\//.test(pinned)) {
    if (config.verbose) process.stderr.write("[CHATS-Sandbox] create reverter: pin has injection-prone chars — deferring to subagent\n");
    return null;
  }

  // MCP-call inverse (preferred): substitute the pinned value into the recorded
  // args wherever the explorer left a "<...>" placeholder, then replay verbatim
  // through the SAME server via tools/call (restore.ts handles this).
  if (rev.mcp_calls?.length) {
    const fill = (v: unknown): unknown =>
      (typeof v === "string" && /<[^>]*>/.test(v)) ? v.replace(/<[^>]*>/g, pinned!) : v;
    const calls = rev.mcp_calls.map((c) => ({
      server,
      tool: c.tool,
      args: Object.fromEntries(Object.entries(c.args ?? {}).map(([k, v]) => [k, fill(v)])),
    }));
    return recordDeterministicArtifact(ctx, config, {
      recoveryMcpCalls: calls,
      description: `Deterministic create reverter (${server}): delete the created entity pinned by ${pin}=${pinned.slice(0, 80)}`,
    });
  }

  // Prose/CLI inverse: substitute the pinned value, then guard every command
  // through isDangerousRecoveryCommand.
  const cmds = rev.commands!.map((c) => c.replace(/<[^>]*>/g, pinned!));
  for (const cmd of cmds) {
    if (isDangerousRecoveryCommand(cmd)) return null; // refuse → fall through to subagent
  }
  return recordDeterministicArtifact(ctx, config, {
    recoveryCommands: cmds,
    description: `Deterministic create reverter (${server}): delete the created entity pinned by ${pin}=${pinned.slice(0, 80)}`,
  });
}

/** Materialize the action dir and write a tier-3 "subagent"-strategy artifact
 *  carrying a deterministic (no-LLM) reversal, so the existing restore path
 *  replays it WITHOUT a subagent: liveRestore:false with either recoveryCommands
 *  (local shell inverse, run via execSync) OR recoveryMcpCalls (a fixed MCP call
 *  replayed verbatim via tools/call). Exactly one is supplied. */
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
 * Record an agent-written declaration, append-only, next to the timing ledger
 * (`.chats-sandbox/declarations.jsonl`, one level above backupDir so it never
 * counts toward backup storage).
 *
 * This is the ONLY consumer of the declaration's TEXT. Nothing reads this file
 * back: it exists so that a later investigation can see what the agent believed
 * was at risk and compare it against what the subagent actually captured — the
 * exact comparison needed to test the assumption that agents declare
 * correctly. Best-effort; a failure here never affects the backup.
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
        // What the agent was about to do. command/sql when the tool has one,
        // else the whole input — a browser click's identity lives in `element`,
        // and an empty field here made those records unreadable.
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

/** The container the agent's commands actually run in, when they run elsewhere.
 *  Mirrors exec_target.ts's precedence inline rather than importing it: strategies.js
 *  does not require that module today, and adding a require to the compiled file is a
 *  larger edit than repeating six lines of env reading. Null on a local topology, which
 *  is every claude-lane run and changes nothing there. */
/** Flatten an absolute path into one filename. Lives here rather than being imported
 *  so that src/ and dist/ hold the same helper: dist/ has had it since the first
 *  version of this tier and src/ never did, which is precisely the ts/js divergence
 *  that produced a ReferenceError at runtime while `node --check` stayed clean. */
function snapName(abs: string): string {
  return abs.replace(/^\//, "").replace(/[^A-Za-z0-9._-]/g, "_").slice(-160);
}

const LOCAL_TARGETS = new Set(["", "local", "host", "self", "same"]);

/** True when the agent's tool calls execute on a filesystem that is NOT this
 *  process's -- the hermes lane, where the hook runs on the host and every command
 *  is docker-exec'd into the task container.
 *
 *  Split out of foreignContainer because "local" and "foreign but unreachable" are
 *  different answers and only one of them permits touching a host path. Collapsing
 *  them is how a snapshot of /usr/local/bin/sbls ends up holding the HOST's sbls:
 *  right name, wrong bytes, and nothing downstream can tell. */
function isForeignExec(): boolean {
  const explicit = (process.env.CHATS_SANDBOX_EXEC_TARGET ?? "").trim().toLowerCase();
  const te = (process.env.TERMINAL_ENV ?? "").trim().toLowerCase();
  return (explicit !== "" && !LOCAL_TARGETS.has(explicit)) ||
    (explicit === "" && te !== "" && !LOCAL_TARGETS.has(te)) ||
    process.env.CHATS_SANDBOX_REMOTE_EXEC === "1";
}

function foreignContainer(): string | null {
  if (!isForeignExec()) return null;
  const cid = (process.env.HERMES_TERMINAL_DOCKER_ADOPT
            ?? process.env.CHATS_SANDBOX_CONTAINER ?? "").trim();
  return cid !== "" ? cid : null;
}

/** The directory the agent's shell starts in INSIDE that container. A relative
 *  file_path has to be resolved against this; path.resolve() would join it to the
 *  host run directory, which is a different tree entirely. */
function containerCwd(): string {
  return (process.env.TERMINAL_CWD ?? process.env.RB_SHADOW_WORK_TREE ?? "").trim();
}

/** Copy a file OUT of the container onto a host path. `docker cp` rather than
 *  `exec cat`: the bytes never pass through this process, so no encoding can mangle
 *  a binary, and there is again no shell to quote against. */
function containerCopyOut(cid: string, abs: string, dest: string): boolean {
  try {
    const r = spawnSync("docker", ["cp", cid + ":" + abs, dest],
      { encoding: "utf-8", timeout: 120000 });
    return !!r && r.status === 0 && fs.existsSync(dest);
  } catch {
    return false;
  }
}

/** CONTAINER_STAT_V2 -- [size, mode] of a path inside the container, or null when it
 *  is not a regular file there. %F is asked for as well as %s and %a because the
 *  answer "this is a directory" and the answer "docker is not reachable" must not
 *  both arrive as an empty string; a non-zero exit and a non-regular type are now
 *  distinguishable from each other in the log even though both decline. */
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

/** Largest file worth copying inline. Above this the copy costs more than the
 *  tier-3 spawn it replaces, so the action falls through to the subagent. */
const EXTERNAL_COPY_MAX_BYTES = 64 * 1024 * 1024;

/** abs path -> the artifact holding its PRE-AGENT state. On disk because the hook
 *  is a new process per tool call and in-memory state never survives to the next. */
function _extLedgerPath(config: SandboxConfig): string {
  return path.join(path.dirname(path.resolve(config.backupDir)), "external-copies.json");
}
function _extLedgerRead(config: SandboxConfig): Record<string, string> {
  try {
    const v = JSON.parse(fs.readFileSync(_extLedgerPath(config), "utf-8"));
    return v && typeof v === "object" ? v : {};
  } catch { return {}; }
}
function _extLedgerWrite(config: SandboxConfig, abs: string, dest: string): void {
  try {
    const led = _extLedgerRead(config);
    led[abs] = dest;
    const p = _extLedgerPath(config);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(led, null, 1), "utf-8");
  } catch { /* non-fatal: worst case is one redundant copy */ }
}

/**
 * Copy the single out-of-workspace file an Edit/Write is about to change.
 * Returns null whenever the case is not mechanically decidable, which leaves the
 * action to tier 3 exactly as before.
 */
function tryExternalFileSnapshot(
  ctx: HookContext,
  config: SandboxConfig,
): BackupArtifact | null {
  const MUTATORS = new Set(["Edit", "Write", "write_file", "patch", "NotebookEdit"]);

  // Bash names its targets in the command string rather than a field. Measured on the
  // corpus, 53% of at-risk Bash actions name at least one absolute path -- nearly four
  // times what the 22 tier-0 rewrite rules can reach (14% before the compound-command
  // bail, 4.6% after), and unlike a rewrite this neither parses nor executes the
  // command, so `cd /srv/x && sqlite3 /srv/etl/pipeline.db "VACUUM;"` is handled by
  // reading the path out of it and leaving the command completely untouched. The
  // remaining 47% name nothing and are tier 3's, which is the same line the briefing
  // draws for the agent.
  // NOT WIRED: `bashSnapshot` was never written -- it exists in neither src/ nor
  // dist/, and dist/ has no Bash arm at all, so the paragraph above describes an
  // intention rather than the code. Bash goes to tier 3, as it always has.
  if (!MUTATORS.has(ctx.tool_name)) return null;

  const input = ctx.tool_input as { file_path?: unknown; path?: unknown };
  const raw = typeof input.file_path === "string" ? input.file_path
            : typeof input.path === "string" ? input.path : null;
  if (!raw) return null;

  // ── CONTAINER_AWARE_SNAPSHOT ───────────────────────────────────────────────
  // Which filesystem the target lives on is decided ONCE, here; below this point the
  // function knows only cid (null = this machine), abs, size and mode.
  //
  // Three cases, and the middle one is the one that was losing the data:
  //
  //   local                 fs.statSync / fs.copyFileSync, byte for byte as before.
  //                         Every claude-lane and codex-lane run takes this branch
  //                         and nothing about it moved.
  //   foreign + container   stat and copy THROUGH that container, so
  //                         /usr/local/bin/sbls means the sbls the agent is about to
  //                         overwrite rather than a same-named file on the host.
  //   foreign, no container return null. Blind, which is the standdown exec_target.ts
  //                         already chose for tier 0. A host path here is not the
  //                         target, and copying it would file the wrong bytes under
  //                         the right name -- worse than no artifact, because a
  //                         restore would then confidently write them back.
  const cid = foreignContainer();
  if (isForeignExec() && !cid) return null;

  let abs: string;
  let size: number;
  let mode: number;
  if (cid) {
    const ccwd = containerCwd();
    // A relative file_path means "relative to the shell inside the container".
    // 159 of the 657 file-mutating calls in the corpus are relative, and
    // path.resolve() would have joined every one of them to the host run directory.
    if (!raw.startsWith("/")) {
      if (!ccwd) return null;
      abs = path.posix.normalize(path.posix.join(ccwd, raw));
    } else {
      abs = path.posix.normalize(raw);
    }
    // The container's own working directory is tier 2's, the same rule as below.
    if (ccwd && (abs === ccwd || abs.startsWith(ccwd + "/"))) return null;
    // ... and so is the host run directory, which is bind-mounted into the container
    // on this lane and so is reachable under the SAME absolute path from both sides.
    // Without this the tier files copies of the plugin's own action folders: the
    // tier-3 subagent writes subagent_result.json into the store, the agent then
    // edits it, and the store starts snapshotting itself.
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
    // Inside the workspace is tier 2's job and is already snapshotted; copying it
    // again would be the same redundancy this tier exists to remove.
    if (abs === ws || abs.startsWith(ws + path.sep)) return null;
    let st: { isFile(): boolean; size: number; mode: number };
    try { st = fs.statSync(abs); } catch { return null; }
    if (!st.isFile() || st.size > EXTERNAL_COPY_MAX_BYTES) return null;
    size = st.size;
    mode = st.mode & 0o7777;
  }

  const dir = materializeActionDir(config);
  const prior = _extLedgerRead(config)[abs];
  const reused = !!(prior && fs.existsSync(prior));
  // S5: name the copy after the WHOLE path, not the basename. Two external files
  // called settings.json edited in the same action folder used to write to the same
  // <basename>.pre-action, so one backup was silently lost and the ledger pointed both
  // sources at the survivor -- restoring one would have written the other's content.
  const dest = path.join(dir, snapName(abs) + ".pre-action");
  try {
    if (reused) {
      fs.writeFileSync(
        path.join(dir, snapName(abs) + ".pre-action.reused"),
        `The state of ${abs} as it stood before this agent touched it is held at\n` +
        `${prior}, copied before the first edit of this session. A copy taken now\n` +
        `would hold this agent's own intermediate work, which a restore does not want.\n`,
        "utf-8",
      );
    } else {
      // CONTAINER_AWARE_COPY. The same two steps on either filesystem: fetch the
      // bytes, then put the mode back on top of them. fs.copyFileSync drops it and
      // so does `docker cp`, and nearly every target this tier has been observed on
      // is /usr/local/bin/<something> -- a copy without the exec bit restores a file
      // that cannot run. The mode is recorded in the description as well, so a
      // restore done by hand with a plain `cp` still has the number to put back.
      if (cid) {
        if (!containerCopyOut(cid, abs, dest)) return null;
      } else {
        fs.copyFileSync(abs, dest);
      }
      try { fs.chmodSync(dest, mode & 0o7777); } catch { /* best effort */ }
      _extLedgerWrite(config, abs, dest);
    }
  } catch {
    return null;
  }

  return {
    id: makeId(),
    timestamp: new Date().toISOString(),
    trigger: "rule",
    toolName: ctx.tool_name,
    description: reused
      ? `external file snapshot \u2014 reusing the pre-agent copy of ${abs} at ${prior}`
      : `external file snapshot \u2192 ${path.basename(dest)} (${abs}, ${size} bytes,`
        + ` mode 0${(mode & 0o7777).toString(8)}`
        + `${cid ? ", from container " + cid : ""})`,
    strategy: "file_copy",
    artifactPath: reused ? (prior as string) : dest,
  };
}

export function runBackup(
  ctx: HookContext,
  config: SandboxConfig
): BackupResult {
  // The agent's own declaration, if it wrote one — looked up ONCE per call,
  // from ANY string in the tool_input. Pure function.
  const declaration = findDeclaration(ctx);

  // Capture any typed input BEFORE the read-only short-circuit below — those
  // fill/type actions don't back up, but their values pin a later create.
  // Deliberately NOT gated: a `fill` is almost never declared, and the value
  // it types is what makes the DECLARED create/submit that follows
  // recoverable. It writes only to the input cache, never an action folder.
  recordBrowserInput(ctx, config);

  // PRE-STATE pre-capture for opaque-code browser mutations: if this is a
  // browser_run_code_unsafe / browser_evaluate call, parse the URLs out of
  // the code and authenticated-GET each value-bearing page NOW (pre-mutation),
  // merging the result into the snapshot cache that feeds PAGE_STATE. Without
  // this the only cached view is the page the agent was ON before, which does
  // not hold the value the in-code navigation is about to change. Best-effort.
  try {
    const _act = (ctx.tool_name.split("__").pop() || ctx.tool_name).toLowerCase();
    if (/run_code|evaluate/.test(_act)) presnapshotCodeUrls(ctx, config);
  } catch { /* never block the action */ }

  // Read-only tools (Read/Glob/Grep/etc.) can't mutate anything, so
  // there's nothing to back up. Short-circuit cleanly so they don't
  // pay the git-ls-tree cost and don't create folders when nothing
  // actually happened.
  if (READ_ONLY_TOOLS.has(ctx.tool_name)) {
    return { artifacts: [], needsSubagent: false };
  }

  // The declaration (found at the top of this function) is used for exactly
  // two things: the tier-3 gate verdict below and the forensic record here. It
  // is never handed to the backup subagent — see backup/declaration.ts for why.
  if (declaration) recordDeclaration(ctx, config, declaration);
  // A DECLARED call outranks our own read-only INFERENCE — in the protect
  // direction only. `isReadOnlyBash` reads a command line and `isReadOnlyMcpTool`
  // reads a tool NAME; the agent read the program. It does NOT outrank
  // READ_ONLY_TOOLS above (Read/Grep/Glob/WebFetch…), which cannot mutate
  // anything whatever the agent believes.
  const declaredOverride = declaration !== null;

  // MCP tools whose verb is recognized as read-only (browser_navigate,
  // browser_snapshot, *_get, *_list, etc.) also short-circuit. Without
  // this every Playwright snapshot/navigate in a remote-services run
  // creates a noisy action folder + git_snapshot for state that didn't
  // change.
  if (isReadOnlyMcpTool(ctx.tool_name) && !declaredOverride) {
    return { artifacts: [], needsSubagent: false };
  }

  // Bash commands that are pure introspection (which/ls/stat/git status/
  // pip list/etc.) also never mutate — same short-circuit. Without this
  // the `touchesOutsideWorkspace` heuristic can flag e.g. `which node` as
  // outside-workspace and fire a ~25 s tier-3 subagent for a command that
  // did literally nothing.
  if (ctx.tool_name === "Bash") {
    const cmd = String((ctx.tool_input as { command?: unknown }).command ?? "");
    if (isReadOnlyBash(cmd) && !declaredOverride) {
      return { artifacts: [], needsSubagent: false };
    }
  }

  // Reserve a pending action name but don't create the folder yet.
  preparePendingAction(config);
  const result: BackupResult = { artifacts: [], needsSubagent: false };

  // ── Tier 0: policy rewrite ────────────────────────────────────────
  // Destructive ops (rm, etc.) are rewritten into reversible equivalents
  // (mv to per-action trash) before the original command ever runs. Huge
  // files stay O(1) because we're just renaming inodes; no copy into the
  // shadow repo. If any rule fires, it REPLACES the rest of the pipeline
  // for this action — we don't also want tier-2 to snapshot the workspace
  // (the file is already safe in trash, and snapshot would just record
  // the trashed state).
  // CHATS_SANDBOX_NO_REWRITE=1: the host agent's hook system cannot
  // apply updatedInput (e.g. the OpenHands SDK's PreToolUse is
  // allow/deny only). Tier-0 run-and-rewrite would then execute the
  // destructive command here AND the agent would run the original a
  // second time — so skip tier-0 entirely and let tiers 1-3 cover the
  // action instead.
  //
  // A SECOND, independent stand-down lives inside applyPolicyRules(): when
  // the agent executes through a container/ssh backend (hermes
  // TERMINAL_ENV != local) the rewrite would run against THIS filesystem
  // instead of the agent's, so tier 0 refuses and logs. See
  // backup/exec_target.ts.
  const noRewrite = process.env.CHATS_SANDBOX_NO_REWRITE === "1";
  const { applyPolicyRules } = require("./policy_rules.js");
  const pendingDir = path.join(path.resolve(config.backupDir), _pendingActionName ?? "");
  const trashDir = path.join(pendingDir, "trash");
  // The sandbox store root, from the CONFIGURED backupDir (same
  // derivation as pre-tool.ts's timing ledger). Rules that move or delete
  // a caller-supplied path set filter it out of their victim set — the
  // store lives inside the workspace, so a `git clean -fdx` / `find …
  // -delete` / `rm -rf .chats-sandbox` enumerates it as a victim, and
  // moving it into its own trash fails and used to disable tier 0.
  const sandboxStoreRoot = path.dirname(path.resolve(config.backupDir));
  const policyResult = noRewrite
    ? null
    : applyPolicyRules(ctx, trashDir, sandboxStoreRoot);
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
    };
    result.artifacts.push(artifact);
    result.updatedInput = policyResult.updatedInput;
    writeMetadata(dir, artifact);
    // Most tier-0 rewrites are self-sufficient (the file is safe in
    // trash) and terminate the pipeline. A rule may opt out via
    // preserveLowerTiers when its own recovery is partial — e.g.
    // `git reset --hard` saves the HEAD sha but the tier-2 snapshot
    // below is what captures the dirty worktree it destroys.
    if (!policyResult.preserveLowerTiers) {
      return result;
    }
  }

  const outsideWorkspace = touchesOutsideWorkspace(ctx, config);

  // ── 2nd level: git add -A (runs first because it's the cheap check) ──
  // If the workspace hasn't changed, this returns null and no folder is made.
  const gitSnapshot = gitSnapshotBackup(ctx, config);
  if (gitSnapshot) {
    const dir = materializeActionDir(config);
    result.actionDir = dir;
    result.artifacts.push(gitSnapshot);
    writeMetadata(dir, gitSnapshot);
  }

  // ── 1st level: targeted manifest (runs second, supplements git snapshot) ─
  // Only relevant for known patterns. Materializes folder only if it fires.
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
      // targetedFn already materialized the dir and set result.actionDir;
      // materializeActionDir is memoized per action so this is the same
      // path, fetched here only to write the artifact's metadata.
      const dir = materializeActionDir(config);
      result.artifacts.push(targeted);
      writeMetadata(dir, targeted);
      targetedSucceeded = true;
    }
  }


  // \u2500\u2500 2nd level (external): the one file an Edit/Write is about to change \u2500\u2500
  // Mechanical. On success the action is fully captured and the tier-3 condition
  // below skips it -- see tryExternalFileSnapshot for what it deliberately
  // declines to handle.
  let externalFileSnapshot = false;
  if (outsideWorkspace && !targetedSucceeded) {
    const extArt = tryExternalFileSnapshot(ctx, config);
    if (extArt) {
      const dir = materializeActionDir(config);
      result.actionDir = dir;
      result.artifacts.push(extArt);
      writeMetadata(dir, extArt);
      externalFileSnapshot = true;
    }
  }

  // ── THE TIER-3 GATE ───────────────────────────────────────────────
  // The marker gates only the subagent, which is the only part that costs
  // anything: a model call at a median 21.7 s against milliseconds for
  // everything above.
  //
  // The consequence is that marking wrongly is cheap in both directions. Marking
  // something the mechanical tiers already had costs one spawn. NOT marking
  // something they had costs nothing at all -- which is why the briefing can
  // afford to tell the agent to skip Edit and Write entirely.
  let tier3Gated = declaration === null;

  // ── THE READ-ONLY CHECKER ───────────────────────────────────
  // The marker stays SUFFICIENT and stops being NECESSARY:
  //   spawn when outsideWorkspace && !targetedSucceeded && !externalFileSnapshot
  //              && ( declaration !== null || checker says NOT read-only )
  // Asked only when the marker is missing -- a declared call already spawns and
  // must not pay the latency -- and only when the mechanical tiers above did
  // NOT already capture the action, so it costs nothing on the common path.
  // Serial, by decision. Fail open, by decision: every error path inside
  // runReadOnlyChecker returns spawn:true, so the checker can only ever ADD
  // spawns relative to a missing marker. Wrapped anyway: a checker that throws
  // must not take the hook down with it.
  //
  // THE ENABLE TEST COMES FROM types AND IS EVALUATED BEFORE THE require().
  // With the checker off there is no module load, so there is no load error to
  // fail open on -- see isReadOnlyCheckerEnabled for the failure this ordering
  // fixes. Fail-open below therefore applies only to a checker that was ASKED.
  let checkerOutcome: { spawn: boolean; targets: string[]; reason: string } | null = null;
  if (tier3Gated && outsideWorkspace && !targetedSucceeded && !externalFileSnapshot
      && isReadOnlyCheckerEnabled(config)) {
    try {
      const { runReadOnlyChecker } = require("./readonly_checker.js");
      checkerOutcome = runReadOnlyChecker(ctx, config);
      // Target resolution guides capture; it must not veto the checker verdict.
      if (checkerOutcome && checkerOutcome.spawn) tier3Gated = false;
    } catch (e) {
      // Fail open here: the checker is ON, so the run has asked for its widened
      // gate, and silently reverting to the narrow one is worse than an extra spawn.
      tier3Gated = false;
      if (config.verbose) process.stderr.write(`[CHATS-Sandbox] read-only checker error: ${e}\n`);
    }
  }

  // ── 3rd level: subagent for outside-workspace state ────────────
  // Trigger when outside-workspace, no targeted manifest succeeded, the mechanical
  // external copy did not already hold the file, and the tier-3 gate is open.
  if (outsideWorkspace && !targetedSucceeded && !externalFileSnapshot && !tier3Gated) {
    const cmdStr = String(ctx.tool_input.command ?? JSON.stringify(ctx.tool_input));

    // ── Tier-3 (free): the session's LEARNED read-only store ──────
    // Earlier in THIS session the subagent read this program, judged an
    // invocation of it read-only, and recorded pattern(s) covering forms
    // it considered equally read-only. If one matches, skip the spawn.
    //
    // POSITIVE ONLY: a miss changes nothing — we fall straight through to
    // the normal subagent path. This can never suppress a backup another
    // tier would have made; tiers 0-2 have already run above.
    //
    // Three independent conditions, all required:
    //   - the line is ONE simple command (no pipeline / redirect / chain),
    //   - a stored pattern matches its argv token by token,
    //   - the program's bytes still hash to what they did when learned.
    if (config.learnedReadOnlyEnabled !== false &&
        ctx.tool_name === "Bash" && ctx.session_id) {
      try {
        const argv = singleSimpleArgv(String(ctx.tool_input.command ?? ""));
        if (argv) {
          const sandboxDir = path.dirname(path.resolve(config.backupDir));
          const store = loadLearnedStore(sandboxDir, ctx.session_id);
          const hit = matchLearnedReadOnly(store, argv, process.cwd());
          if (hit) {
            // Audit trail: which pattern let which command through. Without
            // this, a bad learned pattern is unattributable after the fact.
            recordLearnedHit(sandboxDir, store, cmdStr, hit);
            // Also into subagent.log, UNCONDITIONALLY. That file is where
            // anyone investigating a run actually looks, and a spawn that
            // silently did not happen leaves no other trace there. Not
            // gated on verbose: this is the forensic record for "which
            // learned pattern waved this through".
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
                `[CHATS-Sandbox] learned read-only: skipping subagent for "${cmdStr.slice(0, 80)}" ` +
                `(pattern "${hit.pattern}" learned from "${hit.learnedFrom.slice(0, 60)}")\n`,
              );
            }
            return result;
          }
        }
      } catch (e) {
        // Any failure here means "no hit" — we fall through and spawn.
        if (config.verbose) {
          process.stderr.write(`[CHATS-Sandbox] learned read-only lookup error: ${e}\n`);
        }
      }
    }

    // ── Tier-3 (cheap): pattern-driven MCP create reverter ────────
    // An MCP CREATE whose learned pattern carries a deterministic `reverter`
    // (delete the just-created entity, pinned by a captured stable identifier)
    // replays that fixed inverse with NO subagent — the "T1/T2 for remote" path.
    // If the pinned value can't be resolved, this returns null and we fall
    // through to the capture subagent (never a guess).
    try {
      const rev = tryPatternCreateReverter(ctx, config);
      if (rev) {
        result.actionDir = rev.artifactPath;
        result.artifacts.push(rev);
        return result;
      }
    } catch (e) {
      if (config.verbose) {
        process.stderr.write(`[CHATS-Sandbox] pattern create reverter error: ${e}\n`);
      }
      // fall through to the capture subagent
    }

    // Try to invoke the real subagent via `claude -p` subprocess.
    // The subagent is SYNCHRONOUS — blocks until it produces an artifact
    // or hits the timeout. Safe to run here because we're already inside
    // the PreToolUse hook, which blocks the parent tool call.
    //
    // Import lazily to avoid loading child_process for the common path.
    let subagentArtifact: BackupArtifact | null = null;
    let readOnlyVerdict = false;   // subagent judged the action read-only
    if (config.subagentEnabled) {
      try {
        // Materialize the folder so the subagent has somewhere to write
        const dir = materializeActionDir(config);
        result.actionDir = dir;
        // Narrow the subagent's MCP tool schema to the few tools this capture
        // needs (read pre-state + inverse), derived from the experience.
        const toolAllow = minimalToolAllow(ctx, config);
        // THE SUBAGENT NEVER SEES THE DECLARATION. Its prompt renders the whole
        // tool_input verbatim, so the marker is removed from the free-text
        // `description` before the spawn: the agent decides WHETHER to back up,
        // the subagent decides WHAT to capture, and a declaration that turns out
        // to be wrong must not steer the capture. A no-op when nothing was
        // declared — undeclared calls are handed byte-identical input.
        const _desc = (ctx.tool_input as { description?: unknown }).description;
        const subCtx = typeof _desc === "string" && parseDeclaration(_desc)
          ? {
              ...ctx,
              tool_input: {
                ...ctx.tool_input,
                description: stripDeclaration(_desc),
              },
            }
          : ctx;
        // checkerTargets: what the checker read out of the program. See
        // BackupGuidanceOpts.checkerTargets -- this is the fix for the
        // "adjacent object" capture, and it is why the list is collected.
        const outcome = runSubagentBackup(subCtx, dir, config, {
          toolAllow,
          checkerTargets: checkerOutcome ? checkerOutcome.targets : undefined,
        });
        if (outcome === "read_only") {
          // Subagent inspected the action and found it changes nothing
          // outside the workspace — a clean skip, NOT a failure. Drop
          // the empty action dir and don't raise the "unprotected"
          // warning. Tiers 0–2 already covered any workspace changes.
          readOnlyVerdict = true;
          // Drop the action dir ONLY when it is genuinely empty of value.
          // It is the SAME memoized dir the tier-2 git snapshot wrote its
          // metadata.json into a few lines above, and the subagent may have
          // captured files before deciding the action was read-only —
          // rm -rf on either is a silent loss of bookkeeping (or of bytes).
          const _hasRegistered = result.artifacts.length > 0;
          const _hasCaptured = (() => {
            try { return findCapturedArtifacts(dir) !== null; } catch { return false; }
          })();
          if (_hasRegistered || _hasCaptured) {
            if (_hasCaptured && !_hasRegistered) {
              // Captured bytes + a "nothing to back up" verdict is a
              // contradiction. Keep the bytes and make the contradiction
              // visible rather than deleting evidence.
              reportUnregisteredCapture(
                dir,
                "subagent captured files but returned no_backup_needed=true",
                (m) => { if (config.verbose) process.stderr.write(`[CHATS-Sandbox] ${m}\n`); },
              );
            }
          } else {
            // Nothing captured and nothing registered: the read-only verdict
            // leaves no action folder, as it always has. But the spawn's
            // transcripts live in that folder, so lift them out first —
            // "the subagent ran and said it was a read" must stay on the
            // record even when the folder does not.
            const _storeRoot = path.dirname(path.resolve(config.backupDir));
            const _kept = preserveTranscripts(dir, _storeRoot);
            if (_kept && config.verbose) {
              process.stderr.write(
                `[CHATS-Sandbox] kept ${_kept} subagent transcript file(s) from ${path.basename(dir)}\n`,
              );
            }
            removeDir(dir);
            result.actionDir = undefined;
          }
        } else if (outcome) {
          subagentArtifact = outcome;
          result.artifacts.push(outcome);
          writeMetadata(dir, outcome);
        }
      } catch (e) {
        if (config.verbose) {
          process.stderr.write(
            `[CHATS-Sandbox] subagent invocation error: ${e}\n`
          );
        }
      }
    }

    // If the subagent failed or is disabled — and it did NOT explicitly
    // judge the action read-only — signal that out-of-workspace state is
    // at risk. A read-only verdict is a legitimate "nothing to back up".
    if (!subagentArtifact && !readOnlyVerdict) {
      result.needsSubagent = true;
      // Say why WE think this needed a backup. The agent reasons from this
      // string; a message it can see is wrong is worse than terse.
      result.subagentReason =
        `Action "${ctx.tool_name}(${cmdStr.slice(0, 200)})" affects state outside the workspace (${process.cwd()}). ` +
        `No predefined backup strategy matched. ` +
        (gitSnapshot
          ? `Workspace files were captured via git snapshot. `
          : `No workspace changes detected. `) +
        `Subagent tier-3 backup was ${config.subagentEnabled ? "attempted but failed" : "disabled"}. ` +
        `Proceed with caution.`;
    }

    return result;
  }

  // If we have any artifact, we're done — no subagent needed.
  if (result.artifacts.length > 0) {
    return result;
  }

  // No artifact produced and no outside-workspace effect detected →
  // this was a read-only action. Return empty result silently —
  // no folder, no noise, no subagent.
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
        // Salvage: wrap a stray single-object metadata into a one-element
        // array rather than nuke it. Next write will normalize it.
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
