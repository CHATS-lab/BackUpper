/**
 * Restore engine: reverses a backup artifact to recover the prior state.
 * Tiers 2-3 restore deterministically; tier 4 replays recorded recovery
 * calls or delegates to a restore subagent. Backups are never deleted by a restore.
 */

import { SUBAGENT_RESTORE, render } from "../prompts.generated.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync, execSync } from "node:child_process";
import type { BackupArtifact, SandboxConfig } from "../types.js";
import { listActions } from "../backup/manifest.js";
import { invokeRestoreSubagent } from "../backup/subagent.js";
import { serverFromToolName } from "../explore/experiences.js";
import { callMcpTool, callMcpToolHttp } from "../explore/list_mcp_tools.js";

// ── Types ────────────────────────────────────────────────────────────

export interface RestoreResult {
  success: boolean;
  /** What was restored. */
  description: string;
  /** Prompt for a subagent, when one is needed. */
  subagentPrompt?: string;
  /** Restore ran but its outcome cannot be verified (e.g. remote state);
   *  such a result blocks pruning of the backup. */
  unverified?: boolean;
}

// ── Shell helper ─────────────────────────────────────────────────────

function exec(cmd: string, cwd?: string): { ok: boolean; stdout: string } {
  try {
    const out = execSync(cmd, {
      encoding: "utf-8",
      timeout: 30_000,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return { ok: true, stdout: out };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, stdout: msg };
  }
}

/** Run a binary with an argument vector and no shell, so saved values
 *  cannot be interpreted as shell syntax. */
function execFileArgs(bin: string, args: string[], cwd?: string): { ok: boolean; stdout: string } {
  try {
    const { execFileSync } = require("node:child_process");
    const out = execFileSync(bin, args, {
      encoding: "utf-8",
      timeout: 60_000,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return { ok: true, stdout: out };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, stdout: msg };
  }
}

/**
 * Denylist check for catastrophic or injection-shaped recovery commands
 * (recursive root deletion, pipe-to-shell, disk wipes) before they reach a shell.
 */
export function isDangerousRecoveryCommand(cmd: string, depth = 0): boolean {
  const c = cmd.toLowerCase();
  // Unwrap one quoted interpreter level (`bash -c "..."`) and judge the
  // inner command; recursion depth is capped.
  if (depth < 6) {
    const wrapped = c.match(/\b(?:sh|bash|zsh|dash|ksh|env)\b[^'"]*(['"])([\s\S]*)\1/);
    const inner = wrapped?.[2];
    if (inner && inner !== c && isDangerousRecoveryCommand(inner, depth + 1)) return true;
  }

  // rm of a root-like path with recursive/force flags in any order or spelling.
  const rmMatch = c.match(/\brm\b((?:\s+-[a-z]+|\s+--[a-z-]+)*)\s+(\S+)/);
  if (rmMatch) {
    const flags = rmMatch[1];
    const recursive = /(-[a-z]*r|--recursive)/.test(flags);
    const target = rmMatch[2];
    const rootish = /^(\/(\s|$|\*)?|~(\/|$)?|\$\{?home\}?|\/\*)$/.test(target) ||
                    /^\/(etc|usr|bin|boot|lib|var|root|home|opt|sys|dev)(\/|$)/.test(target);
    if (recursive && rootish) return true;
    if (/--no-preserve-root/.test(flags)) return true; // only ever used to force a root wipe
  }

  return (
    /\|\s*(sh|bash|zsh|dash|python[0-9.]*|perl|ruby|node)\b/.test(c) ||        // pipe into an interpreter
    /\b(curl|wget|fetch)\b[\s\S]*\|\s*(sh|bash|zsh)\b/.test(c) ||              // curl … | sh
    /:\s*\(\s*\)\s*\{/.test(cmd) ||                                            // fork bomb :(){ …
    /\bmkfs\b|\bdd\s+[\s\S]*of=\/dev\//.test(c) ||                             // disk wipe
    />\s*\/dev\/sd[a-z]/.test(c) ||                                            // overwrite a raw disk
    /\bfind\b[\s\S]*\s-delete\b/.test(c) ||                                    // find … -delete
    /\bfind\b[\s\S]*-exec\s+rm\b/.test(c) ||                                   // find … -exec rm
    /\bshred\b/.test(c) ||                                                     // secure-erase a file
    /\btruncate\b\s+(-s\s*0|--size[= ]0)/.test(c)                             // truncate -s0 (zero a file)
  );
}

/** MCP server definition: stdio ({command, args}) or HTTP ({url}). */
interface ServerDef { command?: string; args?: string[]; url?: string }

/** Resolve an MCP server's launch definition so a recorded call can be
 *  replayed through the same server. Looks in the configured --mcp-config
 *  JSON, then the hermes config.yaml; returns null if not found. */
function resolveServerDef(server: string | null, config: SandboxConfig | undefined): ServerDef | null {
  if (!config || !server) return null;
  const shape = (raw: unknown): ServerDef | null => {
    if (!raw || typeof raw !== "object") return null;
    const s = raw as Record<string, unknown>;
    const def: ServerDef = {};
    if (typeof s.command === "string") def.command = s.command;
    if (Array.isArray(s.args)) def.args = s.args.map(String);
    if (typeof s.url === "string") def.url = s.url;
    return (def.command || def.url) ? def : null;
  };
  // 1. --mcp-config JSON.
  try {
    if (config.subagentMcpConfig && fs.existsSync(config.subagentMcpConfig)) {
      const raw = JSON.parse(fs.readFileSync(config.subagentMcpConfig, "utf-8")) as
        { mcpServers?: Record<string, unknown> };
      const def = shape(raw.mcpServers?.[server]);
      if (def) return def;
    }
  } catch { /* fall through */ }
  // 2. hermes config.yaml (mcp_servers.<name>).
  try {
    const p = path.join(process.env.HERMES_HOME || path.join(os.homedir(), ".hermes"), "config.yaml");
    if (fs.existsSync(p)) {
      const yaml = require("js-yaml") as { load: (s: string) => unknown };
      const cfg = (yaml.load(fs.readFileSync(p, "utf-8")) ?? {}) as { mcp_servers?: Record<string, unknown> };
      const def = shape(cfg.mcp_servers?.[server]);
      if (def) return def;
    }
  } catch { /* fall through */ }
  return null;
}

// ── Deterministic restore strategies ─────────────────────────────────

function restorePipFreeze(artifact: BackupArtifact): RestoreResult {
  const freezePath = artifact.artifactPath;
  if (!fs.existsSync(freezePath)) {
    return { success: false, description: `Backup file not found: ${freezePath}` };
  }

  const result = exec(`pip install -r "${freezePath}"`);
  if (result.ok) {
    return { success: true, description: `Restored packages from ${freezePath}` };
  }
  return { success: false, description: `pip install failed: ${result.stdout.slice(0, 200)}` };
}

function restoreNpmList(artifact: BackupArtifact): RestoreResult {
  const listPath = artifact.artifactPath;
  if (!fs.existsSync(listPath)) {
    return { success: false, description: `Backup file not found: ${listPath}` };
  }

  // Read the saved package list and install from it.
  try {
    const data = JSON.parse(fs.readFileSync(listPath, "utf-8"));
    const deps = data.dependencies ?? {};
    // Build an argument vector and drop specs containing shell
    // metacharacters or whitespace.
    const SAFE_SPEC = /^[@\w][\w@.\/^~>=<.* -]*$/;
    const packages = Object.entries(deps)
      .map(([name, info]: [string, unknown]) => {
        const version = (info as Record<string, string>)?.version;
        return version ? `${name}@${version}` : name;
      })
      .filter((p) => SAFE_SPEC.test(p) && !/[;|&$`()\n]/.test(p));

    if (!packages.length) {
      return { success: true, description: "No packages to restore" };
    }

    const result = execFileArgs("npm", ["install", ...packages]);
    if (result.ok) {
      return { success: true, description: `Restored ${packages.length} npm package(s) from ${listPath}` };
    }
    return { success: false, description: `npm install failed: ${result.stdout.slice(0, 200)}` };
  } catch {
    return { success: false, description: `Failed to parse ${listPath}` };
  }
}

function restoreEnvSnapshot(artifact: BackupArtifact): RestoreResult {
  const envPath = artifact.artifactPath;
  if (!fs.existsSync(envPath)) {
    return { success: false, description: `Backup file not found: ${envPath}` };
  }

  // Environment variables cannot be re-exported into the parent process;
  // return the restore command instead.
  return {
    success: true,
    description: `Environment snapshot at ${envPath}. To restore: source <(grep '=' "${envPath}" | sed 's/^/export /')`,
  };
}

function restoreGitTag(artifact: BackupArtifact): RestoreResult {
  const tagName = artifact.artifactPath;
  const result = exec(`git rev-parse "${tagName}"`);
  if (!result.ok) {
    return { success: false, description: `Git tag not found: ${tagName}` };
  }

  const resetResult = exec(`git reset --hard "${tagName}"`);
  if (resetResult.ok) {
    return { success: true, description: `Restored to git tag ${tagName} (${result.stdout.slice(0, 8)})` };
  }
  return { success: false, description: `git reset failed: ${resetResult.stdout.slice(0, 200)}` };
}

function restoreGitSnapshot(artifact: BackupArtifact): RestoreResult {
  const shadowDir = artifact.artifactPath;
  if (!fs.existsSync(shadowDir)) {
    return { success: false, description: `Shadow repo not found: ${shadowDir}` };
  }

  // Use the commit stored with the artifact, not HEAD of the shared shadow repo.
  const commit = artifact.commitHash ?? artifact.id;
  if (!commit) {
    return { success: false, description: "Artifact is missing commit hash" };
  }

  // Verify the commit exists; the shadow repo has no working tree, so it
  // is addressed via GIT_DIR.
  try {
    execSync(`git rev-parse ${commit}`, {
      encoding: "utf-8",
      timeout: 30_000,
      env: { ...process.env, GIT_DIR: shadowDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return {
      success: false,
      description: `Commit ${commit.slice(0, 8)} not found in shadow repo`,
    };
  }

  const cwd = process.cwd();
  const env = {
    ...process.env,
    GIT_DIR: shadowDir,
    GIT_WORK_TREE: cwd,
  };

  const opts = { encoding: "utf-8" as const, timeout: 30_000, env, cwd, stdio: "pipe" as const };

  try {
    // read-tree + checkout-index + clean makes the workspace match the
    // commit exactly, including removing files added after it.
    execSync(`git read-tree ${commit}`, opts);
    execSync("git checkout-index -f -a", opts);
    execSync("git clean -fd", opts);

    return {
      success: true,
      description: `Restored workspace from git snapshot (${commit.slice(0, 8)})`,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, description: `git restore failed: ${msg.slice(0, 200)}` };
  }
}

// ── Tier 4: subagent restore ─────────────────────────────────────────

/**
 * Restore a subagent artifact through one of three paths, reaching remote
 * systems only through MCP:
 *   1. liveRestore: spawn a restore subagent that reads live state.
 *   2. recoveryMcpCalls: replay each recorded {server, tool, args} via tools/call.
 *   3. Raw recovery commands: run locally, or delegate to the restore
 *      subagent when the tool belongs to an MCP server.
 */
async function restoreSubagent(
  artifact: BackupArtifact,
  config?: SandboxConfig,
): Promise<RestoreResult> {
  // Live restore: delegate to a subagent that reads current state.
  if (artifact.liveRestore) {
    return runRestoreSubagentPath(artifact, config,
      "Live-restore subagent needed (config unavailable in this call path)");
  }

  // Deterministic replay of the recorded MCP calls.
  const mcpCalls = artifact.recoveryMcpCalls ?? [];
  if (mcpCalls.length > 0) {
    const fallbackServer = serverFromToolName(artifact.toolName);
    const replayed: string[] = [];
    for (const call of mcpCalls) {
      const server = call.server ?? fallbackServer;
      const def = resolveServerDef(server, config);
      // Unresolved server: delegate to the restore subagent.
      if (!def) {
        return runRestoreSubagentPath(artifact, config,
          `Deterministic MCP replay needs the restore subagent ` +
          `(server "${server ?? "?"}" unresolved), but config is unavailable in this call path`);
      }
      // HTTP server: dispatch tools/call in-process over Streamable HTTP.
      const r = def.url
        ? await callMcpToolHttp(def.url, call.tool, call.args)
        : await callMcpTool(def.command!, def.args ?? [], call.tool, call.args);
      if (!r.ok) {
        return {
          success: false,
          description:
            `MCP replay partially executed (${replayed.length}/${mcpCalls.length}): ` +
            `tool "${call.tool}" on "${server}" failed: ${(r.error ?? "unknown error").slice(0, 200)}`,
        };
      }
      replayed.push(call.tool);
    }
    return {
      success: true,
      description: `Subagent restore: replayed ${replayed.length} MCP call(s) — ${artifact.description}`,
    };
  }

  // Deterministic shell reverter compiled by the backup tier; run locally
  // with the dangerous-command guard.
  const recoveryCommands = artifact.recoveryCommands ?? [];
  if (recoveryCommands.length > 0) {
    const cwd = process.cwd();
    const ran: string[] = [];
    for (const cmd of recoveryCommands) {
      if (isDangerousRecoveryCommand(cmd)) {
        return {
          success: false,
          description:
            `Refused a dangerous recovery command (possible injection) — backup kept for manual review: "${cmd.slice(0, 120)}"`,
        };
      }
      try {
        execSync(cmd, { encoding: "utf-8", timeout: 60_000, cwd, stdio: ["pipe", "pipe", "pipe"] });
        ran.push(cmd);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          success: false,
          description:
            `Deterministic shell reverter partially executed (${ran.length}/${recoveryCommands.length}): ` +
            `failed on "${cmd.slice(0, 80)}": ${msg.slice(0, 200)}`,
        };
      }
    }
    return {
      success: true,
      description: `Subagent restore: ran ${ran.length} deterministic shell reverter command(s) — ${artifact.description}`,
    };
  }

  // Raw recovery command strings (no structured MCP calls).
  const commands = artifact.subagentCommands ?? [];

  if (commands.length === 0) {
    // Nothing executable: report failure so pruning is blocked.
    return {
      success: false,
      description: "Subagent restore needed (no commands recorded)",
      subagentPrompt: buildSubagentRestorePrompt(artifact),
    };
  }

  // Remote recovery (tool resolves to an MCP server): delegate to the
  // restore subagent rather than a shell.
  if (serverFromToolName(artifact.toolName)) {
    return runRestoreSubagentPath(artifact, config,
      "Remote recovery needs the restore subagent (config unavailable in this call path)");
  }

  // Local reversal: run each command in order, stopping on the first failure.
  const cwd = process.cwd();
  const executed: string[] = [];
  for (const cmd of commands) {
    if (isDangerousRecoveryCommand(cmd)) {
      return {
        success: false,
        description:
          `Refused a dangerous recovery command (possible injection) — backup kept for manual review: "${cmd.slice(0, 120)}"`,
      };
    }
    try {
      execSync(cmd, {
        encoding: "utf-8",
        timeout: 60_000,
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
      executed.push(cmd);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        success: false,
        description:
          `Subagent restore partially executed (${executed.length}/${commands.length}): ` +
          `failed on "${cmd.slice(0, 80)}": ${msg.slice(0, 200)}`,
      };
    }
  }

  return {
    success: true,
    description: `Subagent restore: executed ${executed.length} recovery command(s) — ${artifact.description}`,
  };
}

/** Spawn a restore subagent that reverses the artifact through the MCP
 *  server the action used. Returns success:false with the prompt when no
 *  config is available. */
function runRestoreSubagentPath(
  artifact: BackupArtifact,
  config: SandboxConfig | undefined,
  noConfigReason: string,
): RestoreResult {
  const prompt = buildSubagentRestorePrompt(artifact);
  if (!config) {
    return { success: false, description: noConfigReason, subagentPrompt: prompt };
  }
  // Load the MCP server the action used.
  const result = invokeRestoreSubagent(prompt, config, serverFromToolName(artifact.toolName));
  return {
    success: result.success,
    description: result.success
      ? `Restore subagent completed (unverified): ${result.detail.slice(0, 200)}`
      : `Restore subagent failed: ${result.detail.slice(0, 200)}`,
    // Remote state cannot be re-read to confirm the restore.
    unverified: true,
  };
}

/** Render the restore-subagent prompt for an artifact. */
export function buildSubagentRestorePrompt(artifact: BackupArtifact): string {
  const commands = artifact.subagentCommands?.length
    ? artifact.subagentCommands.map((c, i) => `  ${i + 1}. ${c}`).join("\n")
    : SUBAGENT_RESTORE.sections["no-commands-line"];

  const action = artifact.originalAction ?? artifact.toolName;

  // Inline the entity locators captured in remote-state.json.
  let capturedBlock = "";
  try {
    const dir = path.dirname(artifact.artifactPath);
    for (const name of ["remote-state.json", "remote_state.json"]) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) {
        const json = fs.readFileSync(p, "utf-8").slice(0, 4000);
        capturedBlock = render(SUBAGENT_RESTORE.sections["captured-state-block"], { JSON: json }) + "\n\n";
        break;
      }
    }
  } catch { /* best-effort */ }

  return render(SUBAGENT_RESTORE.body, {
    ACTION: action, DESCRIPTION: artifact.description, COMMANDS: commands,
    ARTIFACT_PATH: artifact.artifactPath, CAPTURED_BLOCK: capturedBlock,
  });
}

// ── Main restore dispatcher ──────────────────────────────────────────

/**
 * Restore a single backup artifact: deterministically for tiers 2-3, or via
 * the subagent path for tier 4.
 */
export async function restoreArtifact(
  artifact: BackupArtifact,
  config?: SandboxConfig,
): Promise<RestoreResult> {
  switch (artifact.strategy) {
    case "pip_freeze":
      return restorePipFreeze(artifact);
    case "npm_list":
      return restoreNpmList(artifact);
    case "env_snapshot":
      return restoreEnvSnapshot(artifact);
    case "git_tag":
      return restoreGitTag(artifact);
    case "git_snapshot":
      return restoreGitSnapshot(artifact);
    case "subagent":
      return restoreSubagent(artifact, config);
    case "policy_rewrite":
      return restorePolicyRewrite(artifact);
    case "file_copy":
      return restoreFileCopy(artifact);
    default:
      return { success: false, description: `Unknown strategy: ${artifact.strategy}` };
  }
}

/**
 * The absolute path a file_copy artifact was taken from. Older metadata has no targetPath;
 * the path is then read back from the description the capture wrote.
 */
export function fileCopyTarget(artifact: BackupArtifact): string | null {
  if (typeof artifact.targetPath === "string" && path.isAbsolute(artifact.targetPath)) {
    return artifact.targetPath;
  }
  const d = artifact.description ?? "";
  const m = /\((\/.+?), \d+ bytes,/.exec(d) ?? /pre-agent copy of (\/.+?) at \//.exec(d);
  return m ? m[1] : null;
}

/**
 * Put back the exact pre-image copy of one file edited outside the workspace (tier 3
 * `file_copy`), with its recorded mode. A copy taken out of a container goes back in with
 * `docker cp`.
 */
function restoreFileCopy(artifact: BackupArtifact): RestoreResult {
  const target = fileCopyTarget(artifact);
  if (!target) {
    return { success: false, description: `file_copy artifact ${artifact.id} does not name the file it copied` };
  }
  const src = artifact.artifactPath;
  if (!src || !fs.existsSync(src)) {
    return { success: false, description: `Pre-image copy of ${target} not found: ${src}` };
  }
  try {
    if (artifact.containerId) {
      const r = execFileArgs("docker", ["cp", src, `${artifact.containerId}:${target}`]);
      if (!r.ok) {
        return { success: false, description: `docker cp into ${artifact.containerId} failed: ${r.stdout.slice(0, 200)}` };
      }
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(src, target);
      try { fs.chmodSync(target, fs.statSync(src).mode & 0o7777); } catch { /* best effort */ }
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, description: `Restoring ${target} failed: ${msg.slice(0, 200)}` };
  }
  return {
    success: true,
    description: `Restored ${target} from its pre-action copy (${path.basename(src)})`,
  };
}

/**
 * Reverse a tier-1 command rewrite (e.g. rm → move-to-trash) by running its
 * recorded recovery commands.
 */
function restorePolicyRewrite(artifact: BackupArtifact): RestoreResult {
  const commands = artifact.recoveryCommands ?? [];
  if (commands.length === 0) {
    return {
      success: false,
      description: `policy_rewrite artifact ${artifact.id} has no recovery commands`,
    };
  }
  const cwd = process.cwd();
  const executed: string[] = [];
  for (const cmd of commands) {
    try {
      execSync(cmd, { encoding: "utf-8", timeout: 30_000, cwd, stdio: ["pipe", "pipe", "pipe"] });
      executed.push(cmd);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        success: false,
        description:
          `Policy restore partially ran (${executed.length}/${commands.length}): ` +
          `failed on "${cmd.slice(0, 80)}": ${msg.slice(0, 200)}`,
      };
    }
  }
  return {
    success: true,
    description: `Policy restore (${artifact.policyRuleId}): ran ${executed.length} recovery command(s) — ${artifact.description}`,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Delete action folders from the target onwards (inclusive), since restoring
 * to action N undoes N. Returns the number of folders deleted.
 */
function pruneIntermediateFolders(
  targetActionName: string,
  config: SandboxConfig
): number {
  const backupRoot = path.resolve(config.backupDir);
  const actions = listRestorableActions(config);
  const targetIdx = actions.findIndex((i) => i.name === targetActionName);

  if (targetIdx === -1) {
    return 0;
  }

  let deleted = 0;
  // Delete from targetIdx onwards (inclusive).
  for (let i = targetIdx; i < actions.length; i++) {
    const folder = path.join(backupRoot, actions[i].name);
    try {
      fs.rmSync(folder, { recursive: true, force: true });
      deleted++;
    } catch {
      // best-effort; skip on failure
    }
  }
  return deleted;
}

/**
 * True when every result executed successfully; a result that only carries
 * a pending subagent prompt does not count.
 */
function allSucceeded(results: RestoreResult[]): boolean {
  return results.every((r) => r.success && r.subagentPrompt === undefined);
}

/**
 * Keep only the oldest git_snapshot artifact of an action, since each
 * snapshot restore overwrites the whole tree. Other artifacts are unchanged.
 */
function collapseGitSnapshots(artifacts: BackupArtifact[]): BackupArtifact[] {
  let keptSnapshot = false;
  return artifacts.filter((a) => {
    if (a.strategy !== "git_snapshot") return true;
    if (keptSnapshot) return false; // drop newer snapshots in the same action
    keptSnapshot = true;
    return true;
  });
}

/**
 * Direct restore: apply action N's artifacts in one step, then prune later
 * folders after a successful full (non --file) restore.
 */
async function restoreActionDirectInner(
  actionName: string,
  config: SandboxConfig,
  options?: { fileOnly?: string }
): Promise<RestoreResult[]> {
  const backupRoot = path.resolve(config.backupDir);
  const actionDir = path.join(backupRoot, actionName);
  const metaPath = path.join(actionDir, "metadata.json");

  if (!fs.existsSync(metaPath)) {
    return [{ success: false, description: `No metadata found in ${actionName}` }];
  }

  let artifacts: BackupArtifact[];
  try {
    artifacts = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  } catch {
    return [{ success: false, description: `Corrupt metadata in ${actionName}` }];
  }

  if (options?.fileOnly) {
    const cwd = process.cwd();
    const wanted = path.resolve(cwd, options.fileOnly);
    // A file outside the workspace comes back from its exact pre-image copy (tier 3 file_copy).
    const copy = artifacts.find((a) => a.strategy === "file_copy" && fileCopyTarget(a) === wanted);
    if (copy) return [restoreFileCopy(copy)];
    const rel = path.relative(cwd, wanted);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      const copied = artifacts
        .filter((a) => a.strategy === "file_copy")
        .map((a) => fileCopyTarget(a))
        .filter((t): t is string => !!t);
      return [{
        success: false,
        description: `${wanted} is outside the workspace and ${actionName} holds no copy of it` +
          (copied.length ? ` (it copied: ${copied.join(", ")})` : ""),
      }];
    }
    const snapshot = artifacts.find((a) => a.strategy === "git_snapshot");
    if (!snapshot) {
      return [{ success: false, description: `No git snapshot found in ${actionName}` }];
    }

    const shadowDir = snapshot.artifactPath;
    // Use this action's commit, not HEAD.
    const commit = snapshot.commitHash ?? snapshot.id;
    if (!commit) {
      return [{ success: false, description: "Snapshot is missing commit hash" }];
    }

    try {
      execFileSync("git", ["checkout", commit, "--", rel], {
        encoding: "utf-8",
        timeout: 30_000,
        env: { ...process.env, GIT_DIR: shadowDir, GIT_WORK_TREE: cwd },
        cwd,
        stdio: "pipe",
      });
      // Single-file restore does not prune.
      return [{
        success: true,
        description: `Restored ${options.fileOnly} from ${actionName} snapshot`,
      }];
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return [{ success: false, description: `File restore failed: ${msg.slice(0, 200)}` }];
    }
  }

  // Full restore: apply artifacts, then prune intermediate folders.
  const results: RestoreResult[] = [];
  for (const a of collapseGitSnapshots(artifacts)) {
    results.push(await restoreArtifact(a, config));
  }

  if (allSucceeded(results)) {
    const deleted = pruneIntermediateFolders(actionName, config);
    if (deleted > 0) {
      results.push({
        success: true,
        description: `Pruned ${deleted} intermediate action folder${deleted === 1 ? "" : "s"}`,
      });
    }
  }

  return results;
}

/**
 * Reverse-loop restore: undo actions one at a time from the latest back to
 * the target, then prune the intermediate folders on success.
 */
async function restoreActionLoopInner(
  targetActionName: string,
  config: SandboxConfig
): Promise<RestoreResult[]> {
  const actions = listRestorableActions(config);
  const targetIdx = actions.findIndex((i) => i.name === targetActionName);

  if (targetIdx === -1) {
    return [{ success: false, description: `Action not found: ${targetActionName}` }];
  }

  // No short-circuit for the latest action: its snapshot is the pre-action state.

  const results: RestoreResult[] = [];
  let anyFailed = false;
  // Set when any step restored unverifiable remote state; blocks pruning.
  let anyUnverified = false;

  // Undo actions from the latest down to targetIdx + 1.
  for (let i = actions.length - 1; i > targetIdx; i--) {
    const inter = actions[i];
    results.push({
      success: true,
      description: `--- Undoing ${inter.name} ---`,
    });

    for (const artifact of collapseGitSnapshots(inter.artifacts)) {
      const r = await restoreArtifact(artifact, config);
      results.push(r);
      if (r.unverified) anyUnverified = true;

      if (!r.success && !r.subagentPrompt) {
        anyFailed = true;
        // Non-fatal: record and continue.
        results.push({
          success: false,
          description: `Warning: failed to restore ${artifact.strategy} in ${inter.name}, continuing...`,
        });
      }
    }
  }

  // Restore the target action's artifacts directly; pruning is coordinated here.
  results.push({
    success: true,
    description: `--- Restoring target: ${targetActionName} ---`,
  });
  const targetAction = actions[targetIdx];
  for (const artifact of collapseGitSnapshots(targetAction.artifacts)) {
    // Config is required for the liveRestore branch to spawn a subagent.
    const r = await restoreArtifact(artifact, config);
    results.push(r);
    if (r.unverified) anyUnverified = true;
    if (!r.success && !r.subagentPrompt) {
      anyFailed = true;
    }
  }

  // Prune only if every step succeeded and was verifiable.
  if (!anyFailed && !anyUnverified) {
    const deleted = pruneIntermediateFolders(targetActionName, config);
    if (deleted > 0) {
      results.push({
        success: true,
        description: `Pruned ${deleted} intermediate action folder${deleted === 1 ? "" : "s"}`,
      });
    }
  } else if (anyUnverified) {
    results.push({
      success: true,
      description: "Backups KEPT (a live-restore reversed unverifiable remote state — re-check it, restore again if needed).",
    });
  } else {
    results.push({
      success: false,
      description: "Intermediate folders NOT pruned (some restore steps failed). Inspect and retry.",
    });
  }

  return results;
}

// ── Restore history ledger ───────────────────────────────────────────
// Each restore attempt is appended to .backupper/restore-history.jsonl;
// ledger failures never block a restore.

export interface RestoreLogEntry {
  ts: string;
  mode: "direct" | "loop" | "file";
  action: string;
  seq: number | null;
  fileOnly?: string;
  steps: number;
  ok: number;
  failed: number;
}

function restoreHistoryPath(config: SandboxConfig): string {
  return path.join(path.dirname(path.resolve(config.backupDir)), "restore-history.jsonl");
}

function logRestoreOp(
  config: SandboxConfig,
  mode: "direct" | "loop" | "file",
  actionName: string,
  results: RestoreResult[],
  fileOnly?: string,
): void {
  try {
    const m = actionName.match(/^action_(\d+)_/);
    const entry: RestoreLogEntry = {
      ts: new Date().toISOString(),
      mode,
      action: actionName,
      seq: m ? parseInt(m[1], 10) : null,
      ...(fileOnly ? { fileOnly } : {}),
      steps: results.length,
      ok: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
    };
    const file = restoreHistoryPath(config);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // ledger is best-effort
  }
}

/** Read the restore ledger, newest first. */
export function readRestoreHistory(config: SandboxConfig, limit = 100): RestoreLogEntry[] {
  try {
    const file = restoreHistoryPath(config);
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, "utf-8").split("\n").filter((l: string) => l.trim());
    const out: RestoreLogEntry[] = [];
    for (const l of lines) {
      try { out.push(JSON.parse(l) as RestoreLogEntry); } catch { /* skip bad line */ }
    }
    return out.reverse().slice(0, limit);
  } catch {
    return [];
  }
}

export async function restoreActionDirect(
  actionName: string,
  config: SandboxConfig,
  options?: { fileOnly?: string }
): Promise<RestoreResult[]> {
  const results = await restoreActionDirectInner(actionName, config, options);
  logRestoreOp(config, options?.fileOnly ? "file" : "direct", actionName, results, options?.fileOnly);
  return results;
}

export async function restoreActionLoop(
  targetActionName: string,
  config: SandboxConfig
): Promise<RestoreResult[]> {
  const results = await restoreActionLoopInner(targetActionName, config);
  logRestoreOp(config, "loop", targetActionName, results);
  return results;
}

/**
 * List all actions with their artifact summaries for the restore CLI.
 */
export function listRestorableActions(config: SandboxConfig): Array<{
  name: string;
  artifacts: BackupArtifact[];
}> {
  const backupRoot = path.resolve(config.backupDir);
  const dirs = listActions(config);

  return dirs.map((name) => {
    const metaPath = path.join(backupRoot, name, "metadata.json");
    let artifacts: BackupArtifact[] = [];
    if (fs.existsSync(metaPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        // Guard against metadata.json that is not an array.
        if (Array.isArray(parsed)) {
          artifacts = parsed as BackupArtifact[];
        } else if (parsed && typeof parsed === "object") {
          // Wrap a single-object metadata as a one-element array.
          artifacts = [parsed as BackupArtifact];
        }
        // Anything else (primitive, null) → leave as [].
      } catch {
        // corrupt JSON — leave as []
      }
    }
    return { name, artifacts };
  });
}
