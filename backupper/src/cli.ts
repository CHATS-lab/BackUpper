#!/usr/bin/env node
/**
 * CHATS-Sandbox CLI
 *
 * Commands:
 *   install     Wire hooks into .claude/settings.json
 *   uninstall   Remove hooks from .claude/settings.json
 *   config      Show / edit sandbox configuration
 *   status      Show current sandbox state (enabled, backup count, etc.)
 *   backups     List recent backup artifacts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, saveConfig, getConfigDir } from "./config/load.js";
import { buildBackupGuidance } from "./backup/subagent.js";
import { loadManifest } from "./backup/manifest.js";
import { ALL_ADAPTERS, findAdapter, detectAdapters } from "./agents/index.js";

const CLAUDE_SETTINGS_PATH = ".claude/settings.json";

// ── Helpers ──────────────────────────────────────────────────────────

function getPackageRoot(): string {
  // Resolve to the installed package's dist/ directory
  return path.resolve(__dirname);
}

function loadClaudeSettings(projectRoot: string): Record<string, unknown> {
  const p = path.join(projectRoot, CLAUDE_SETTINGS_PATH);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return {};
  }
}

function saveClaudeSettings(
  projectRoot: string,
  settings: Record<string, unknown>
): void {
  const dir = path.join(projectRoot, ".claude");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(
    path.join(projectRoot, CLAUDE_SETTINGS_PATH),
    JSON.stringify(settings, null, 2) + "\n",
    "utf-8"
  );
}

// ── Install ──────────────────────────────────────────────────────────

function install(projectRoot: string, agentName: string | undefined): void {
  const pkgRoot = getPackageRoot();

  let adapter;
  if (agentName) {
    adapter = findAdapter(agentName);
    if (!adapter) {
      console.error(`Unknown agent: ${agentName}`);
      console.error(`Available agents: ${ALL_ADAPTERS.map((a) => a.name).join(", ")}`);
      process.exit(1);
    }
  } else {
    // No agent specified: default to claude-code (the original behavior).
    // If multiple agents are detected, hint at --auto so the user picks.
    const detected = detectAdapters(projectRoot);
    if (detected.length > 1) {
      console.log(`Multiple agents detected: ${detected.map((a) => a.name).join(", ")}`);
      console.log("Specify one explicitly: chats-sandbox install <agent>");
      console.log(`Defaulting to claude-code.`);
    }
    adapter = findAdapter("claude-code");
  }
  if (!adapter) {
    console.error("No adapter available — repo build is broken.");
    process.exit(1);
  }

  const result = adapter.install(projectRoot, pkgRoot);
  for (const line of result.log) console.log(line);
  // Universal across ALL agents: keep the local backup dir out of the user's
  // git (and out of any agent's own git operations).
  ensureGitignored(projectRoot);
}

/** Ensure `.chats-sandbox/` is in the project's .gitignore (idempotent). */
function ensureGitignored(projectRoot: string): void {
  try {
    const gi = path.join(projectRoot, ".gitignore");
    let content = "";
    try { content = fs.readFileSync(gi, "utf-8"); } catch { /* no .gitignore yet */ }
    if (/^\s*\.chats-sandbox\/?\s*$/m.test(content)) return; // already ignored
    const prefix = content && !content.endsWith("\n") ? "\n" : "";
    fs.appendFileSync(gi, `${prefix}\n# CHATS-Sandbox local backups (never commit)\n.chats-sandbox/\n`);
    console.log("  [OK] Added .chats-sandbox/ to .gitignore");
  } catch { /* best-effort — never fail install over this */ }
}

// ── Uninstall ────────────────────────────────────────────────────────

function uninstall(projectRoot: string, agentName: string | undefined): void {
  let adapters;
  if (agentName) {
    const a = findAdapter(agentName);
    if (!a) {
      console.error(`Unknown agent: ${agentName}`);
      console.error(`Available agents: ${ALL_ADAPTERS.map((x) => x.name).join(", ")}`);
      process.exit(1);
    }
    adapters = [a];
  } else {
    // No agent specified: uninstall from every agent we detect, so a
    // bare `chats-sandbox uninstall` continues to "just work" even
    // in mixed-agent projects.
    adapters = detectAdapters(projectRoot);
    if (adapters.length === 0) adapters = [findAdapter("claude-code")!];
  }

  for (const adapter of adapters) {
    const result = adapter.uninstall(projectRoot);
    for (const line of result.log) console.log(line);
  }
}

// ── Config ───────────────────────────────────────────────────────────

function showConfig(projectRoot: string): void {
  const config = loadConfig(projectRoot);
  console.log("CHATS-Sandbox Configuration:");
  console.log(JSON.stringify(config, null, 2));
  // The two agent-messaging knobs decide how loud the plugin is in the
  // agent's context, which is the setting users most often want to change
  // and the least discoverable inside a 40-key JSON dump.
  console.log("");
  console.log("Agent messaging:");
  console.log(
    `  notifyOnSuccess: ${config.notifyOnSuccess}` +
    `   (${config.notifyOnSuccess
      ? "a line in the agent's context on EVERY successful backup"
      : "successful backups are silent; only failures, BACKUP UNVERIFIED, subagent-needed and denies are messaged"})`
  );
  console.log(
    `  announceOnce:    ${config.announceOnce}` +
    `   (${config.announceOnce
      ? "one briefing on the first user prompt of each session"
      : "no session briefing"})`
  );
  console.log("");
  console.log("  chats-sandbox config set notifyOnSuccess true    # restore per-call backup narration");
  console.log("  chats-sandbox config set announceOnce false      # suppress the session briefing");
}

function setConfigValue(
  projectRoot: string,
  key: string,
  value: string
): void {
  const config = loadConfig(projectRoot);
  const k = key as keyof typeof config;

  // Type coercion
  if (k === "enabled" || k === "effectManifest" || k === "verbose" ||
      k === "subagentEnabled" || k === "notifyOnSuccess" || k === "announceOnce") {
    (config as unknown as Record<string, unknown>)[k] = value === "true";
  } else if (k === "maxActions" || k === "subagentTimeoutSeconds" ||
             k === "maxTotalSizeMB" || k === "maxAgeHours") {
    const n = parseInt(value, 10);
    if (isNaN(n) || n < 0) {
      console.error(`Invalid ${k}: ${value}. Must be a non-negative integer (0 = disabled).`);
      process.exit(1);
    }
    (config as unknown as Record<string, unknown>)[k] = n;
  } else if (k === "mode") {
    if (!["checker", "off"].includes(value)) {
      console.error(`Invalid mode: ${value}. Use: checker | off`);
      process.exit(1);
    }
    (config as unknown as Record<string, unknown>)[k] = value;
  } else if (k === "subagentModel") {
    if (!["haiku", "sonnet", "opus", "inherit"].includes(value)) {
      console.error(`Invalid subagentModel: ${value}. Use: haiku | sonnet | opus | inherit`);
      process.exit(1);
    }
    (config as unknown as Record<string, unknown>)[k] = value;
  } else if (k === "subagentPermissionMode") {
    if (!["bypassPermissions", "acceptEdits"].includes(value)) {
      console.error(`Invalid subagentPermissionMode: ${value}. Use: bypassPermissions | acceptEdits`);
      process.exit(1);
    }
    (config as unknown as Record<string, unknown>)[k] = value;
  } else if (k === "subagentRunner") {
    if (!["claude", "hermes", "openclaw", "codex", "openhands"].includes(value)) {
      console.error(`Invalid subagentRunner: ${value}. Use: claude | hermes | openclaw | codex | openhands`);
      process.exit(1);
    }
    (config as unknown as Record<string, unknown>)[k] = value;
  } else if (k === "subagentRestoreModel") {
    (config as unknown as Record<string, unknown>)[k] = value;
  } else if (k === "experienceForServer") {
    try {
      const obj = JSON.parse(value);
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("not an object");
      (config as unknown as Record<string, unknown>)[k] = obj;
    } catch {
      console.error(`Invalid experienceForServer: must be a JSON object, e.g. '{"playwright":"reddit"}'`);
      process.exit(1);
    }
  } else {
    (config as unknown as Record<string, unknown>)[k] = value;
  }

  saveConfig(config, projectRoot);
  console.log(`Set ${key} = ${value}`);
}

// ── Status ───────────────────────────────────────────────────────────

function showStatus(projectRoot: string): void {
  const config = loadConfig(projectRoot);
  const manifest = loadManifest(config);
  const { listActions } = require("./backup/manifest.js");
  const actions = listActions(config) as string[];

  console.log("CHATS-Sandbox Status:");
  console.log(`  Enabled:       ${config.enabled}`);
  console.log(`  Mode:          ${config.mode}`);
  const maxActionsStr = config.maxActions > 0 ? `${config.maxActions}` : "∞";
  console.log(`  Actions:       ${actions.length} / ${maxActionsStr} folders`);
  // Retention summary — show only the enabled knobs
  const retention: string[] = [];
  if (config.maxActions > 0) retention.push(`count=${config.maxActions}`);
  if (config.maxTotalSizeMB > 0) retention.push(`size=${config.maxTotalSizeMB}MB`);
  if (config.maxAgeHours > 0) retention.push(`age=${config.maxAgeHours}h`);
  console.log(`  Retention:     ${retention.length ? retention.join(", ") : "unlimited (no caps)"}`);
  console.log(`  Artifacts:     ${manifest.length} total`);
  console.log(`  Effect log:    ${config.effectManifest ? config.effectLogPath : "disabled"}`);
  console.log(`  Subagent:      ${config.subagentEnabled ? `enabled (${config.subagentModel}, ${config.subagentPermissionMode ?? "bypassPermissions"})` : "disabled"}`);
  console.log(`  Verbose:       ${config.verbose}`);

  // Check if hooks are installed
  const settings = loadClaudeSettings(projectRoot);
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const hooked = Boolean(hooks.PreToolUse);
  console.log(`  Hooks active:  ${hooked}`);
}

// ── Backups ──────────────────────────────────────────────────────────

function listBackups(projectRoot: string): void {
  const config = loadConfig(projectRoot);
  const manifest = loadManifest(config);

  if (manifest.length === 0) {
    console.log("No backups yet.");
    return;
  }

  console.log(`Recent backups (${manifest.length} total):\n`);
  const recent = manifest.slice(-10);
  for (const b of recent) {
    const size = b.sizeBytes ? ` (${b.sizeBytes} bytes)` : "";
    console.log(
      `  ${b.id}  ${b.timestamp}  ${b.strategy.padEnd(14)} ${b.description}${size}`
    );
  }
}

// ── Restore ──────────────────────────────────────────────────────────

function listActionsForRestore(projectRoot: string): Array<{
  name: string;
  artifacts: Array<{ strategy: string; description: string; timestamp: string }>;
}> {
  const { listRestorableActions } = require("./restore/restore.js");
  const config = loadConfig(projectRoot);
  return listRestorableActions(config) as Array<{
    name: string;
    artifacts: Array<{ strategy: string; description: string; timestamp: string }>;
  }>;
}

function printRestoreResults(results: Array<{
  success: boolean;
  description: string;
  subagentPrompt?: string;
}>): void {
  for (const r of results) {
    const icon = r.success ? "OK" : "FAIL";
    console.log(`  [${icon}] ${r.description}`);

    // Surface the UNVERIFIED caveat prominently: these artifacts were recorded
    // WITHOUT the MCP access needed to verify them (a runner that couldn't
    // load the action's server), so the recovery was re-derived live rather
    // than trusted — the user should confirm the reversal actually landed.
    if (/UNVERIFIED/i.test(r.description)) {
      console.log("       ^ UNVERIFIED backup — recovery re-derived from live state, not a captured snapshot. Verify the result.");
    }

    if (r.subagentPrompt) {
      console.log("\n  --- Subagent restore needed ---");
      console.log("  The following prompt should be sent to a subagent:\n");
      console.log(r.subagentPrompt.split("\n").map((l: string) => `    ${l}`).join("\n"));
      console.log();
    }
  }
}

/**
 * restore <N> — Reverse-loop restore. Undoes actions one by one from
 * latest back to N+1, then restores N's state. Safer for non-workspace state.
 */
async function restoreCommand(projectRoot: string, actionArg?: string, fileArg?: string): Promise<void> {
  const config = loadConfig(projectRoot);
  const actions = listActionsForRestore(projectRoot);

  if (actions.length === 0) {
    console.log("No actions to restore.");
    return;
  }

  // No argument = LIST (matching `--help`: "restore  List restorable
  // actions"). The previous no-arg behavior silently REWOUND the workspace —
  // a destructive default that contradicted the help. To undo, name the
  // target: `restore <N>` or `restore last`.
  let idx: number;
  if (!actionArg) {
    console.log(`Restorable actions (newest last) — run 'chats-sandbox restore <N>' to reverse-loop to one, or 'restore last' to undo the last step:\n`);
    actions.forEach((a, i) => console.log(`  ${String(i + 1).padStart(3)}  ${a.name}`));
    console.log(`\nNothing was changed. This command only lists; pass an action number to restore.`);
    return;
  }
  if (actionArg === "last") {
    if (actions.length < 2) {
      console.log("Only one action exists — nothing to undo. Use 'history' to list.");
      return;
    }
    idx = actions.length - 2; // second-to-last (0-indexed) = undo the last step
    console.log(`Undoing the last step (reverse-loop to ${actions[idx].name}).\n`);
  } else {
    idx = parseInt(actionArg, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= actions.length) {
      console.error(`Invalid action number: ${actionArg}. Use 1-${actions.length}.`);
      process.exit(1);
    }
  }

  const target = actions[idx];

  // --file flag uses direct restore for single file
  if (fileArg) {
    const { restoreActionDirect } = require("./restore/restore.js");
    console.log(`Restoring file ${fileArg} from ${target.name}\n`);
    const results = await restoreActionDirect(target.name, config, { fileOnly: fileArg });
    printRestoreResults(results);
    return;
  }

  // Reverse-loop restore
  const { restoreActionLoop } = require("./restore/restore.js");
  console.log(`Reverse-loop restore to: ${target.name}\n`);
  const results = await restoreActionLoop(target.name, config);
  printRestoreResults(results);
}

/**
 * restore_direct <N> — Direct jump to action N's snapshot.
 * Fast, but only covers what that single action backed up.
 * No-arg default: jump to the action before the latest (undo last).
 */
async function restoreDirectCommand(projectRoot: string, actionArg?: string): Promise<void> {
  const config = loadConfig(projectRoot);
  const actions = listActionsForRestore(projectRoot);

  if (actions.length === 0) {
    console.log("No actions to restore.");
    return;
  }

  let idx: number;
  if (!actionArg) {
    if (actions.length < 2) {
      console.log("Only one action exists — nothing to undo.");
      return;
    }
    idx = actions.length - 2;
    console.log(`No argument — defaulting to previous action.\n`);
  } else {
    idx = parseInt(actionArg, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= actions.length) {
      console.error(`Invalid action number: ${actionArg}. Use 1-${actions.length}.`);
      process.exit(1);
    }
  }

  const target = actions[idx];
  const { restoreActionDirect } = require("./restore/restore.js");
  console.log(`Direct restore from: ${target.name}\n`);
  const results = await restoreActionDirect(target.name, config);
  printRestoreResults(results);
}

// ── Diff ─────────────────────────────────────────────────────────────

function diffCommand(projectRoot: string, actionArg?: string): void {
  const config = loadConfig(projectRoot);
  const { listRestorableActions } = require("./restore/restore.js");
  const actions = listRestorableActions(config) as Array<{
    name: string;
    artifacts: Array<{ strategy: string; artifactPath: string; commitHash?: string; id: string }>;
  }>;

  if (actions.length === 0) {
    console.log("No actions to diff against.");
    return;
  }

  // Default: diff against the action BEFORE the latest
  // ("what did the last step change?"). Requires at least 2 actions.
  let idx: number;
  if (!actionArg) {
    if (actions.length < 2) {
      console.log("Only one action exists — nothing to diff against.");
      return;
    }
    idx = actions.length - 2;
    console.log(`No argument — showing changes since previous action.\n`);
  } else {
    idx = parseInt(actionArg, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= actions.length) {
      console.error(`Invalid action number: ${actionArg}. Use 1-${actions.length}.`);
      return;
    }
  }

  const target = actions[idx];
  const snapshot = target.artifacts.find((a) => a.strategy === "git_snapshot");

  if (!snapshot) {
    console.log(`No git snapshot in ${target.name} — cannot diff.`);
    return;
  }

  // Use the specific commit hash for this action (NOT HEAD, which is
  // the latest snapshot in the shared shadow repo).
  const commit = snapshot.commitHash ?? snapshot.id;
  if (!commit) {
    console.error(`Snapshot in ${target.name} is missing commit hash.`);
    return;
  }

  const shadowDir = snapshot.artifactPath;
  if (!fs.existsSync(shadowDir)) {
    console.error(`Shadow repo not found: ${shadowDir}`);
    return;
  }

  const { execSync } = require("node:child_process");
  const cwd = process.cwd();

  try {
    const env = { ...process.env, GIT_DIR: shadowDir, GIT_WORK_TREE: cwd };
    const opts = { encoding: "utf-8" as const, timeout: 30_000, env, cwd, stdio: "pipe" as const };

    // Stage current state, diff against the target commit, then unstage.
    execSync("git add -A", opts);
    const diff = execSync(`git diff --cached --stat ${commit}`, opts).trim();
    const fullDiff = execSync(`git diff --cached ${commit} --no-color`, opts).trim();
    execSync("git reset --quiet", opts);

    if (!diff) {
      console.log(`No changes between ${target.name} and current state.`);
      return;
    }

    console.log(`Changes since ${target.name} (${commit.slice(0, 8)}):\n`);
    console.log(diff);
    console.log("\n--- Full diff ---\n");
    console.log(fullDiff);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Diff failed: ${msg.slice(0, 200)}`);
  }
}

// ── History ──────────────────────────────────────────────────────────

function historyCommand(projectRoot: string, countArg?: string): void {
  const config = loadConfig(projectRoot);
  const { listRestorableActions } = require("./restore/restore.js");
  const actions = listRestorableActions(config) as Array<{
    name: string;
    artifacts: Array<{
      strategy: string;
      artifactPath: string;
      commitHash?: string;
      id: string;
      toolName: string;
      description: string;
      timestamp: string;
    }>;
  }>;

  if (actions.length === 0) {
    console.log("No actions recorded yet.");
    return;
  }

  // Parse count (default 10)
  let count = 10;
  if (countArg !== undefined) {
    const n = parseInt(countArg, 10);
    if (isNaN(n) || n < 1) {
      console.error(`Invalid count: ${countArg}. Must be a positive integer.`);
      return;
    }
    count = n;
  }

  // Show the most recent `count` actions
  const shown = actions.slice(-count);
  const startIdx = actions.length - shown.length + 1;

  console.log(`Showing last ${shown.length} of ${actions.length} actions:\n`);

  const { execSync } = require("node:child_process");
  const cwd = process.cwd();

  const MAX_FILES_SHOWN = 5;

  for (let i = 0; i < shown.length; i++) {
    const inter = shown[i];
    const displayNum = startIdx + i;
    const time = inter.name.split("_").slice(2).join("_"); // e.g. 20260410221532
    const timeFormatted =
      time.length >= 14
        ? `${time.slice(8, 10)}:${time.slice(10, 12)}`  // HH:MM only
        : "?";

    const snapshot = inter.artifacts.find((a) => a.strategy === "git_snapshot");
    const strategies = inter.artifacts.map((a) => a.strategy).join("+");

    // Get file list and stats from the shared shadow repo
    let files: string[] = [];
    let stat = "";
    if (snapshot && (snapshot.commitHash || snapshot.id) && fs.existsSync(snapshot.artifactPath)) {
      const commit = snapshot.commitHash ?? snapshot.id;
      try {
        const env = { ...process.env, GIT_DIR: snapshot.artifactPath, GIT_WORK_TREE: cwd };
        const opts = { encoding: "utf-8" as const, timeout: 10_000, env, cwd, stdio: "pipe" as const };
        // Get the list of files changed in this commit
        const fileOutput = execSync(`git show --name-only --format= ${commit}`, opts).trim();
        files = fileOutput.split("\n").filter((f: string) => f.trim().length > 0);
        // Get the shortstat
        stat = execSync(`git diff --shortstat ${commit}~1 ${commit}`, opts).trim();
      } catch {
        // First commit or other error — try listing the tree of the first commit
        try {
          const env = { ...process.env, GIT_DIR: snapshot.artifactPath, GIT_WORK_TREE: cwd };
          const opts = { encoding: "utf-8" as const, timeout: 10_000, env, cwd, stdio: "pipe" as const };
          const fileOutput = execSync(`git ls-tree -r --name-only ${commit}`, opts).trim();
          files = fileOutput.split("\n").filter((f: string) => f.trim().length > 0).slice(0, MAX_FILES_SHOWN);
          stat = `baseline snapshot (${files.length} files)`;
        } catch {
          // give up
        }
      }
    }

    // Read instruction.txt for this action (set by UserPromptSubmit hook)
    let instruction = "";
    try {
      const backupRoot = path.resolve(config.backupDir);
      const instructionPath = path.join(backupRoot, inter.name, "instruction.txt");
      if (fs.existsSync(instructionPath)) {
        instruction = fs.readFileSync(instructionPath, "utf-8").trim();
      }
    } catch {
      // best-effort
    }

    // Display line 1: number, time, strategies
    console.log(`  ${displayNum}. ${timeFormatted}  [${strategies}]`);

    // Display line 2: instruction (if available)
    if (instruction) {
      const shortInstr = instruction.length > 80
        ? instruction.slice(0, 80) + "..."
        : instruction;
      console.log(`     "${shortInstr}"`);
    }

    // Display line 3: files (truncated to top 5)
    if (files.length > 0) {
      const shownFiles = files.slice(0, MAX_FILES_SHOWN);
      const extra = files.length - shownFiles.length;
      const fileStr = shownFiles.join(", ") + (extra > 0 ? `, +${extra} more` : "");
      console.log(`     Files: ${fileStr}`);
    }

    // Display line 3: stats
    if (stat) {
      console.log(`     Stats: ${stat}`);
    }

    // Display targeted-manifest supplements (pip freeze, npm list, etc.)
    const nonGitArtifacts = inter.artifacts.filter((a) => a.strategy !== "git_snapshot");
    for (const a of nonGitArtifacts) {
      console.log(`     + ${a.description}`);
    }

    console.log();
  }

  if (actions.length > shown.length) {
    console.log(`(${actions.length - shown.length} older actions hidden — use 'chats-sandbox history <N>' to see more)`);
  }
}

// ── Clear ────────────────────────────────────────────────────────────

function clearCommand(projectRoot: string, args: string[]): void {
  const config = loadConfig(projectRoot);
  const backupRoot = path.resolve(config.backupDir);
  const shadowRoot = path.join(path.dirname(backupRoot), "shadow-repo");
  const effectsLog = path.resolve(config.effectLogPath);

  // Check existing state
  const hasBackups = fs.existsSync(backupRoot) &&
    fs.readdirSync(backupRoot).some((d: string) => d.startsWith("action_"));
  const hasShadow = fs.existsSync(shadowRoot);
  const hasEffects = fs.existsSync(effectsLog);

  if (!hasBackups && !hasShadow && !hasEffects) {
    console.log("Nothing to clear — no backups, shadow repo, or effect log found.");
    return;
  }

  // Destructive + irreversible (deletes every backup, the shadow repo, and the
  // effect log) — require an explicit --yes, matching the `--help` contract
  // ("clear [--yes]"). Without it, show what WOULD be deleted and stop.
  if (!args.includes("--yes") && !args.includes("-y")) {
    console.log("This will PERMANENTLY delete all recorded backups and history:");
    if (hasBackups) console.log(`  - action backups under ${backupRoot}`);
    if (hasShadow)  console.log(`  - the shadow git repo at ${shadowRoot}`);
    if (hasEffects) console.log(`  - the effect log at ${effectsLog}`);
    console.log("\nNothing was deleted. Re-run with --yes to confirm:  chats-sandbox clear --yes");
    return;
  }

  // Delete action folders
  if (hasBackups) {
    const dirs = fs.readdirSync(backupRoot).filter((d: string) => d.startsWith("action_"));
    for (const d of dirs) {
      try {
        fs.rmSync(path.join(backupRoot, d), { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
    console.log(`Removed ${dirs.length} action folder(s)`);
  }

  // Delete shadow repo
  if (hasShadow) {
    try {
      fs.rmSync(shadowRoot, { recursive: true, force: true });
      console.log(`Removed shared shadow repo at ${shadowRoot}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Failed to remove shadow repo: ${msg}`);
    }
  }

  // Delete effect log
  if (hasEffects) {
    try {
      fs.unlinkSync(effectsLog);
      console.log(`Removed effect log at ${effectsLog}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Failed to remove effect log: ${msg}`);
    }
  }

  // Delete current-instruction.txt and subagent.log if present
  const sandboxDir = path.dirname(backupRoot);
  for (const f of ["current-instruction.txt", "subagent.log"]) {
    const p = path.join(sandboxDir, f);
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch {
        // best-effort
      }
    }
  }

  console.log("\nCleared. Hooks and config are untouched. Run 'chats-sandbox uninstall' to remove those.");
}

// ── Dashboard ────────────────────────────────────────────────────────

async function buildRegistryCommand(projectRoot: string, args: string[]): Promise<void> {
  const rcfg = loadConfig(projectRoot);
  const mi = args.indexOf("--mcp-config");
  const mcpPath = (mi !== -1 ? args[mi + 1] : undefined) ?? rcfg.subagentMcpConfig;
  if (!mcpPath || !fs.existsSync(mcpPath)) {
    console.error("No MCP config — pass --mcp-config <path> or set subagentMcpConfig.");
    process.exit(1);
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { buildToolRegistry, saveToolRegistry } = require("./explore/tool_registry.js");
  console.log(`Listing MCP tools from ${mcpPath} …`);
  const registry = await buildToolRegistry(mcpPath);
  const p = saveToolRegistry(rcfg, registry);
  for (const [s, tools] of Object.entries(registry)) console.log(`  ${s}: ${(tools as string[]).length} tools`);
  console.log(`Saved registry → ${p}`);
}

// ── Main ─────────────────────────────────────────────────────────────

/** Emit the shared backup guidance (subagent or inline framing) to stdout.
 *  Used by the benchmark inline-backup condition so the main agent gets the
 *  SAME backup knowledge the tier-3 subagent does. */
function backupGuidanceCommand(root: string, a: string[]): void {
  const get = (flag: string): string | undefined => {
    const i = a.indexOf(flag);
    return i !== -1 ? a[i + 1] : undefined;
  };
  const mode = (get("--mode") === "subagent" ? "subagent" : "inline") as "subagent" | "inline";
  const experienceName = get("--experience");
  const server = get("--server") ?? (mode === "inline" ? "playwright" : null);
  const cwd = get("--cwd") || root;
  // experiencesDir() resolves a relative backupDir against process.cwd(); pin
  // it to --cwd so the experience skill loads no matter where the CLI ran from.
  const config = loadConfig(cwd);
  config.backupDir = path.resolve(cwd, config.backupDir);
  process.stdout.write(buildBackupGuidance({ mode, experienceName, server, config, cwd }) + "\n");
}

const args = process.argv.slice(2);
const command = args[0] ?? "status";
const projectRoot = process.cwd();

switch (command) {
  case "install":
    install(projectRoot, args[1]);
    break;
  case "uninstall":
    uninstall(projectRoot, args[1]);
    break;
  case "config":
    if (args[1] === "set" && args[2] && args[3]) {
      setConfigValue(projectRoot, args[2], args[3]);
    } else {
      showConfig(projectRoot);
    }
    break;
  case "status":
    showStatus(projectRoot);
    break;
  case "backups":
    listBackups(projectRoot);
    break;
  case "build-registry":
    buildRegistryCommand(projectRoot, args).then(() => process.exit(0))
      .catch((e: unknown) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
    break;
  case "restore": {
    const fileIdx = args.indexOf("--file");
    const fileArg = fileIdx !== -1 ? args[fileIdx + 1] : undefined;
    restoreCommand(projectRoot, args[1], fileArg)
      .catch((e: unknown) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
    break;
  }
  case "restore_direct":
    restoreDirectCommand(projectRoot, args[1])
      .catch((e: unknown) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
    break;
  case "diff":
    diffCommand(projectRoot, args[1]);
    break;
  case "history":
    historyCommand(projectRoot, args[1]);
    break;
  case "clear":
    clearCommand(projectRoot, args.slice(1));
    break;
  case "backup-guidance":
    backupGuidanceCommand(projectRoot, args.slice(1));
    break;
  default:
    console.log("CHATS-Sandbox — General-purpose sandbox for coding agents\n");
    console.log("Usage: chats-sandbox <command> [args]\n");
    console.log("Commands:");
    console.log("  install [agent]                 Install hooks for an agent (default: claude-code)");
    console.log(`                                    Available: ${ALL_ADAPTERS.map((a) => a.name).join(", ")}`);
    console.log("  uninstall [agent]               Remove hooks for an agent (defaults to all detected)");
    console.log("  config                          Show configuration");
    console.log("  config set <key> <value>        Set a config value");
    console.log("  status                          Show sandbox state");
    console.log("  backups                         List recent backup artifacts");
    console.log("  history [N]                     Timeline of last N actions (default 10)");
    console.log("  restore                         List restorable actions");
    console.log("  restore <N>                     Reverse-loop restore to action N");
    console.log("  restore <N> --file <path>       Restore single file from action N");
    console.log("  restore_direct <N>              Direct jump to action N's snapshot");
    console.log("  diff <N>                        Diff action N vs current state");
    console.log("  clear [--yes]                   Delete all backups, shadow repo, and effect log");
    break;
}
