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
import type { BackupArtifact, IncompleteCapture, SandboxConfig } from "../types.js";
import { listActions } from "../backup/manifest.js";
import { readActionArtifacts, storeRoot, quote, appendJsonl } from "../util.js";
import { invokeRestoreSubagent } from "../backup/subagent.js";
import { serverFromToolName, callMcpTool, callMcpToolHttp } from "../explore.js";
import { applyTreeMeta, currentExternalShadowMeta, externalShadowFiles, externalShadowSpecs, readTreeMeta, type TreeMeta } from "../backup/fsmeta.js";
import { wordsAndRedirects } from "../backup/compound.js";

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
  /** Not a failure of a step, but something the user must know (e.g. state never captured). */
  warning?: boolean;
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

  const result = exec(`pip install -r ${quote(freezePath)}`);
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
  const result = exec(`git rev-parse ${quote(tagName)}`);
  if (!result.ok) {
    return { success: false, description: `Git tag not found: ${tagName}` };
  }

  const resetResult = exec(`git reset --hard ${quote(tagName)}`);
  if (resetResult.ok) {
    return { success: true, description: `Restored to git tag ${tagName} (${result.stdout.slice(0, 8)})` };
  }
  return { success: false, description: `git reset failed: ${resetResult.stdout.slice(0, 200)}` };
}

/** Options for a snapshot restore. */
interface SnapshotRestoreOptions {
  /**
   * Restore only these workspace paths (relative): the ones the action changed, for
   * `restore N --direct`. Undefined restores the whole tree.
   */
  scope?: { paths: string[]; nextMeta: TreeMeta | null };
}

/** `git` in the real project (never the shadow repo). */
function projectGit(args: string[], cwd: string): { ok: boolean; out: string } {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  try {
    return { ok: true, out: execFileSync("git", args, { cwd, env, encoding: "utf-8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }).trim() };
  } catch (e: unknown) {
    return { ok: false, out: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Drop stash entries that are not in `keep` (they were created after the snapshot). Returns
 * the number dropped. Entries are dropped highest index first so indexes stay valid.
 */
function dropStashesNotIn(cwd: string, keep: Set<string>, only?: Set<string>): number {
  if (!fs.existsSync(path.join(cwd, ".git"))) return 0;
  const list = projectGit(["stash", "list", "--format=%H"], cwd);
  if (!list.ok) return 0;
  const shas = list.out.split("\n").filter(Boolean);
  let dropped = 0;
  for (let i = shas.length - 1; i >= 0; i--) {
    if (keep.has(shas[i])) continue;
    if (only && !only.has(shas[i])) continue;
    if (projectGit(["stash", "drop", "-q", `stash@{${i}}`], cwd).ok) dropped++;
  }
  return dropped;
}

/** Reapply a snapshot's recorded modes/owners/empty dirs; returns a note for the result. */
function applySnapshotMeta(meta: TreeMeta | null, only?: (rel: string) => boolean): string {
  if (!meta) return "";
  const r = applyTreeMeta(meta, only);
  return r.failed.length
    ? `; could not reapply mode/owner of ${r.failed.length} path(s): ${r.failed.slice(0, 5).join(", ")}`
    : "";
}

function restoreGitSnapshot(artifact: BackupArtifact, sopts: SnapshotRestoreOptions = {}): RestoreResult {
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

  const meta = readTreeMeta(artifact.metaPath);
  try {
    if (sopts.scope) {
      // Only the paths this action changed: each is checked out from the commit, or removed
      // when the commit did not have it.
      const restored: string[] = [];
      for (const rel of sopts.scope.paths) {
        const inCommit = (() => {
          try { execFileSync("git", ["cat-file", "-e", `${commit}:${rel}`], { ...opts, stdio: "pipe" } as never); return true; }
          catch { return false; }
        })();
        if (inCommit) {
          execFileSync("git", ["checkout", commit, "--", rel], { ...opts, stdio: "pipe" } as never);
        } else {
          fs.rmSync(path.join(cwd, rel), { recursive: true, force: true });
          // Directories the action's file was the last entry of go with it.
          let d = path.dirname(path.join(cwd, rel));
          while (d.startsWith(cwd + path.sep)) {
            try { if (fs.readdirSync(d).length) break; fs.rmdirSync(d); } catch { break; }
            d = path.dirname(d);
          }
        }
        restored.push(rel);
      }
      // Modes the action changed, and empty directories it removed.
      const next = sopts.scope.nextMeta;
      let note = "";
      if (meta) {
        const nextBy = new Map((next?.entries ?? []).map((e) => [e.p, e]));
        const changedMode = new Set(meta.entries
          .filter((e) => { const n = nextBy.get(e.p); return !n || n.mode !== e.mode || n.uid !== e.uid || n.gid !== e.gid; })
          .map((e) => e.p));
        const nextEmpty = new Set(next?.emptyDirs ?? []);
        const scopeSet = new Set(restored);
        note = applySnapshotMeta(meta, (rel) =>
          scopeSet.has(rel) || [...scopeSet].some((p) => rel.startsWith(p + "/")) ||
          (next ? changedMode.has(rel) || (meta.emptyDirs.includes(rel) && !nextEmpty.has(rel)) : false));
        if (next) {
          const created = new Set((next.stash ?? []).filter((h) => !(meta.stash ?? []).includes(h)));
          if (created.size) dropStashesNotIn(cwd, new Set(meta.stash ?? []), created);
        }
      }
      return {
        success: true,
        description: `Restored the ${restored.length} path(s) this action changed from git snapshot (${commit.slice(0, 8)})${note}`,
      };
    }
    // read-tree + checkout-index + clean makes the workspace match the
    // commit exactly, including removing files added after it.
    execSync(`git read-tree ${commit}`, opts);
    execSync("git checkout-index -f -a", opts);
    execSync("git clean -fd", opts);
    // git keeps neither modes beyond the executable bit, nor owners, nor empty directories.
    let note = applySnapshotMeta(meta);
    if (meta?.stash) {
      const n = dropStashesNotIn(cwd, new Set(meta.stash));
      if (n) note += `; dropped ${n} stash entr${n === 1 ? "y" : "ies"} created after the snapshot`;
    }

    return {
      success: true,
      description: `Restored workspace from git snapshot (${commit.slice(0, 8)})${note}`,
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
    const modesBefore = readTreeMeta(artifact.metaPath) ?? currentExternalShadowMeta(recoveryCommands);
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
    if (modesBefore) applyTreeMeta(modesBefore);
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
  // An external-shadow checkout writes files back as 0644/0755: reapply the modes recorded at
  // capture time, or else the ones the files have right now (an edit keeps a file's mode).
  const modesBefore = readTreeMeta(artifact.metaPath) ?? currentExternalShadowMeta(commands);
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

  if (modesBefore) applyTreeMeta(modesBefore);
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
  snapshotOpts?: SnapshotRestoreOptions,
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
      return restoreGitSnapshot(artifact, snapshotOpts);
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
 * recorded recovery commands. The shapes tier 1 records (`mkdir -p`, `mv TRASH PATH`,
 * `cp -a TRASH PATH`) are carried out here rather than by a shell, so a path that now exists
 * as a directory is merged into instead of having the trashed item nested inside it.
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
  const notes: string[] = [];
  for (const cmd of commands) {
    const steps = parseRecoverySteps(cmd);
    if (steps) {
      const r = runRecoverySteps(steps, cwd);
      notes.push(...r.notes);
      if (!r.ok) {
        return {
          success: false,
          description:
            `Policy restore partially ran (${executed.length}/${commands.length}): ${r.error}`,
        };
      }
      executed.push(cmd);
      continue;
    }
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
    description: `Policy restore (${artifact.policyRuleId}): ran ${executed.length} recovery command(s) — ${artifact.description}` +
      (notes.length ? `; ${notes.join("; ")}` : ""),
  };
}

type RecoveryStep =
  | { op: "mkdir"; path: string }
  | { op: "mv"; from: string; to: string }
  | { op: "cp"; from: string; to: string; contents: boolean };

/** Parse a recovery command built only of `mkdir -p X`, `mv A B` and `cp -a A B` joined by `&&`. */
export function parseRecoverySteps(cmd: string): RecoveryStep[] | null {
  const parsed = wordsAndRedirects(cmd);
  if (!parsed || parsed.redirects.length) return null;
  const parts: string[][] = [[]];
  for (const w of parsed.words) {
    if (w === "&&") parts.push([]);
    else parts[parts.length - 1].push(w);
  }
  const steps: RecoveryStep[] = [];
  for (const p of parts) {
    if (p.length === 3 && p[0] === "mkdir" && p[1] === "-p") steps.push({ op: "mkdir", path: p[2] });
    else if (p.length === 3 && p[0] === "mv" && !p[1].startsWith("-") && !p[2].startsWith("-")) steps.push({ op: "mv", from: p[1], to: p[2] });
    else if (p.length === 4 && p[0] === "cp" && p[1] === "-a" && !p[2].startsWith("-") && !p[3].startsWith("-")) {
      const contents = p[2].endsWith("/.") && p[3].endsWith("/");
      steps.push({
        op: "cp",
        from: contents ? p[2].slice(0, -2) : p[2],
        to: contents ? p[3].replace(/\/+$/, "") : p[3],
        contents,
      });
    } else return null;
  }
  return steps.length ? steps : null;
}

function lstatOrNull(p: string): fs.Stats | null {
  try { return fs.lstatSync(p); } catch { return null; }
}

/** rename, falling back to copy + remove across filesystems. */
function moveEntry(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    execFileSync("cp", ["-a", from, to], { stdio: "pipe" });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

/**
 * Move the contents of directory `from` into the existing directory `to`. An entry present on
 * both sides takes the captured version; the newer one it displaces is kept inside `from`
 * (which then stays in the trash) so nothing is lost. Returns the number of displaced entries.
 */
function mergeDirInto(from: string, to: string, stamp: string): number {
  let displaced = 0;
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    const ss = lstatOrNull(src);
    const ds = lstatOrNull(dst);
    if (!ss) continue;
    if (!ds) { moveEntry(src, dst); continue; }
    if (ss.isDirectory() && ds.isDirectory()) { displaced += mergeDirInto(src, dst, stamp); continue; }
    moveEntry(dst, `${src}.newer-${stamp}`);
    moveEntry(src, dst);
    displaced++;
  }
  // Remove what is now empty; keep anything displaced.
  try { if (fs.readdirSync(from).length === 0) fs.rmdirSync(from); } catch { /* kept */ }
  return displaced;
}

/** Copy the contents of `from` into the existing directory `to` (cp -a semantics, merged). */
function copyDirInto(from: string, to: string): void {
  execFileSync("cp", ["-a", `${from}/.`, `${to}/`], { stdio: "pipe" });
}

function runRecoverySteps(steps: RecoveryStep[], cwd: string): { ok: boolean; notes: string[]; error?: string } {
  const notes: string[] = [];
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const abs = (p: string) => path.resolve(cwd, p);
  try {
    for (const st of steps) {
      if (st.op === "mkdir") {
        const p = abs(st.path);
        const s = lstatOrNull(p);
        if (s && !s.isDirectory()) {
          return { ok: false, notes, error: `${p} now exists as a file, so its directory cannot be re-created; nothing was moved` };
        }
        fs.mkdirSync(p, { recursive: true });
        continue;
      }
      const from = abs(st.from);
      const to = abs(st.to);
      const fs0 = lstatOrNull(from);
      if (!fs0) return { ok: false, notes, error: `the captured copy ${from} is missing` };
      const ts = lstatOrNull(to);
      const fromDir = fs0.isDirectory();
      const toDir = !!ts && ts.isDirectory();
      if (st.op === "mv") {
        if (!ts) { moveEntry(from, to); continue; }
        if (fromDir && toDir) {
          const displaced = mergeDirInto(from, to, stamp);
          notes.push(`${to} existed again as a directory: merged the captured contents into it` +
            (displaced ? ` (${displaced} newer entr${displaced === 1 ? "y" : "ies"} it replaced kept at ${from})` : ""));
          continue;
        }
        if (toDir) {
          return { ok: false, notes, error: `${to} is now a directory, so the captured file was NOT moved into it; it is still at ${from}` };
        }
        if (fromDir) {
          return { ok: false, notes, error: `${to} now exists as a file, so the captured directory was NOT moved over it; it is still at ${from}` };
        }
        // A file over a file (or a link): the captured version replaces it.
        moveEntry(from, to);
        continue;
      }
      // cp -a
      if (fromDir) {
        if (ts && !toDir) return { ok: false, notes, error: `${to} now exists as a file, so the captured directory was NOT copied over it; it is still at ${from}` };
        if (!ts) fs.mkdirSync(to, { recursive: true });
        else if (!st.contents) notes.push(`${to} existed again as a directory: merged the captured contents into it`);
        copyDirInto(from, to);
        continue;
      }
      if (toDir) {
        return { ok: false, notes, error: `${to} is now a directory, so the captured file was NOT copied into it; it is still at ${from}` };
      }
      execFileSync("cp", ["-a", "--remove-destination", from, to], { stdio: "pipe" });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, notes, error: msg.slice(0, 200) };
  }
  return { ok: true, notes };
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

/** Artifacts that move the project's branch (`git reset --hard` to a saved sha or tag). */
function movesBranch(a: BackupArtifact): boolean {
  return a.strategy === "git_tag" || (a.strategy === "policy_rewrite" && a.policyRuleId === "git-reset-hard");
}

/**
 * The order an action's artifacts are applied in: branch moves first (a `git reset --hard`
 * resets the worktree), then the snapshot (which puts saved uncommitted changes back on top),
 * then everything else in recorded order.
 */
function restoreOrder(artifacts: BackupArtifact[]): BackupArtifact[] {
  const list = collapseGitSnapshots(artifacts);
  return [...list.filter(movesBranch), ...list.filter((a) => !movesBranch(a))];
}

/** After an action's artifacts all restored, delete the git tags it created (backupper/pre-*). */
function removeActionTags(artifacts: BackupArtifact[]): void {
  for (const a of artifacts) {
    if (a.strategy !== "git_tag") continue;
    const tag = String(a.artifactPath ?? "");
    if (!/^backupper\/pre-[A-Za-z0-9._-]+$/.test(tag)) continue;
    projectGit(["tag", "-d", tag], process.cwd());
  }
}

/** Restore every artifact of one action in restoreOrder; removes its tags when all succeeded. */
async function restoreOneAction(
  artifacts: BackupArtifact[],
  config: SandboxConfig,
  snapshotOpts?: SnapshotRestoreOptions,
): Promise<RestoreResult[]> {
  const results: RestoreResult[] = [];
  for (const a of restoreOrder(artifacts)) {
    results.push(await restoreArtifact(a, config, a.strategy === "git_snapshot" ? snapshotOpts : undefined));
  }
  if (allSucceeded(results)) removeActionTags(artifacts);
  return results;
}

/** Warnings for an action recorded as incompletely captured (incomplete.json). */
function incompleteWarnings(actionName: string, config: SandboxConfig): RestoreResult[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(path.resolve(config.backupDir), actionName, "incomplete.json"), "utf-8")) as IncompleteCapture;
    const what = raw.paths?.length ? raw.paths.join(", ") : (raw.segments ?? []).join(" | ");
    return [{
      success: true,
      warning: true,
      description:
        `${actionName} was INCOMPLETELY captured (${raw.reason}). NOT restored, because no backup of it exists: ` +
        `${what.slice(0, 600)}` + (raw.paths?.length && raw.segments?.length ? ` (from: ${raw.segments.join(" | ").slice(0, 300)})` : ""),
    }];
  } catch {
    return [];
  }
}

/** The first git_snapshot taken after `actionName` (by a later action), with its manifest. */
function nextSnapshotAfter(actionName: string, config: SandboxConfig): BackupArtifact | null {
  const actions = listRestorableActions(config);
  const idx = actions.findIndex((a) => a.name === actionName);
  for (let i = idx + 1; i >= 1 && i < actions.length; i++) {
    const snap = actions[i].artifacts.find((a) => a.strategy === "git_snapshot");
    if (snap) return snap;
  }
  return null;
}

/** Paths that differ between two shadow commits (what the actions between them changed). */
function changedBetween(shadowDir: string, from: string, to: string): string[] | null {
  try {
    return execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", from, to], {
      encoding: "utf-8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_DIR: shadowDir },
    }).split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

const RESTORE_HINT = (seq: string) =>
  `To bring it back anyway, undo the whole action: \`backupper restore ${seq} --direct\` (only this action) or \`backupper restore ${seq}\` (this and every later action).`;

/** Recovery pairs (captured copy → original path) recorded by tier-1 rules that copy or trash. */
function trashPairs(a: BackupArtifact, actionDir: string): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  for (const c of a.captures ?? []) out.push({ from: c.copy, to: c.target });
  for (const cmd of a.recoveryCommands ?? []) {
    for (const st of parseRecoverySteps(cmd) ?? []) {
      if (st.op === "mkdir") continue;
      const from = path.resolve(st.from);
      // Only copies held in this action's store, never the inverse `mv` of a rename.
      if (!from.startsWith(actionDir + path.sep)) continue;
      out.push({ from, to: path.resolve(st.to) });
    }
  }
  return out;
}

/**
 * `restore N --file PATH`: put back one path as it was right before action N, from whichever
 * capture of action N holds it: an outside-workspace copy, a tier-1 trash copy, a tier-4
 * external-shadow commit, or the workspace snapshot.
 */
function restoreOneFile(actionName: string, artifacts: BackupArtifact[], wanted: string, config: SandboxConfig): RestoreResult {
  const cwd = process.cwd();
  const seq = String(parseInt(actionName.split("_")[1] ?? "0", 10));
  const actionDir = path.join(path.resolve(config.backupDir), actionName);

  // 1. Exact pre-image copy of a file outside the workspace.
  const copy = artifacts.find((a) => a.strategy === "file_copy" && fileCopyTarget(a) === wanted);
  if (copy) return restoreFileCopy(copy);

  // 2. A tier-1 trash or copy that holds the path (or a directory containing it).
  for (const a of artifacts.filter((x) => x.strategy === "policy_rewrite")) {
    for (const { from, to } of trashPairs(a, actionDir)) {
      let src: string | null = null;
      if (wanted === to) src = from;
      else if (wanted.startsWith(to + path.sep)) {
        const inner = path.join(from, path.relative(to, wanted));
        if (lstatOrNull(inner)) src = inner;
      }
      if (!src || !lstatOrNull(src)) continue;
      const r = runRecoverySteps([
        { op: "mkdir", path: path.dirname(wanted) },
        { op: "cp", from: src, to: wanted, contents: false },
      ], cwd);
      return r.ok
        ? { success: true, description: `Restored ${wanted} from the copy action ${seq} captured (${path.basename(src)})${r.notes.length ? "; " + r.notes.join("; ") : ""}` }
        : { success: false, description: `Restoring ${wanted} from ${src} failed: ${r.error}. ${RESTORE_HINT(seq)}` };
    }
  }

  // 3. A tier-4 external-shadow commit that holds the file.
  for (const a of artifacts.filter((x) => x.strategy === "subagent")) {
    const cmds = [...(a.subagentCommands ?? []), ...(a.recoveryCommands ?? [])];
    for (const spec of externalShadowSpecs(cmds)) {
      const root = path.resolve(spec.workTree);
      if (!(wanted === root || wanted.startsWith(root + path.sep))) continue;
      const rel = path.relative(root, wanted);
      if (!externalShadowFiles(spec).some((f) => f === rel || f.startsWith(rel + "/"))) continue;
      const before = readTreeMeta(a.metaPath) ?? currentExternalShadowMeta(cmds);
      try {
        execFileSync("git", ["checkout", spec.commit, "--", rel], {
          cwd: root, encoding: "utf-8", timeout: 30_000, stdio: "pipe",
          env: { ...process.env, GIT_DIR: spec.gitDir, GIT_WORK_TREE: root },
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { success: false, description: `Restoring ${wanted} from the external snapshot failed: ${msg.slice(0, 200)}. ${RESTORE_HINT(seq)}` };
      }
      if (before) applyTreeMeta({ ...before, entries: before.entries.filter((e) => e.p === wanted || e.p.startsWith(wanted + "/")) });
      return { success: true, description: `Restored ${wanted} from action ${seq}'s external snapshot (${spec.commit.slice(0, 8)})` };
    }
  }

  // 4. The workspace snapshot.
  const rel = path.relative(cwd, wanted);
  const inside = !(rel.startsWith("..") || path.isAbsolute(rel));
  const snapshot = artifacts.find((a) => a.strategy === "git_snapshot");
  if (!inside || !snapshot) {
    const held = [
      ...artifacts.filter((a) => a.strategy === "file_copy").map((a) => fileCopyTarget(a)).filter((t): t is string => !!t),
      ...artifacts.filter((a) => a.strategy === "policy_rewrite").flatMap((a) => trashPairs(a, actionDir).map((p) => p.to)),
    ];
    return {
      success: false,
      description: `${actionName} holds no copy of ${wanted}` +
        (held.length ? ` (it captured: ${[...new Set(held)].slice(0, 10).join(", ")})` : "") +
        `. ${RESTORE_HINT(seq)}`,
    };
  }
  const shadowDir = snapshot.artifactPath;
  const commit = snapshot.commitHash ?? snapshot.id;
  const env = { ...process.env, GIT_DIR: shadowDir, GIT_WORK_TREE: cwd };
  try {
    execFileSync("git", ["cat-file", "-e", `${commit}:${rel.split(path.sep).join("/")}`], { env, cwd, stdio: "pipe" });
  } catch {
    return {
      success: false,
      description: `${wanted} was not in the workspace snapshot taken before ${actionName} (it did not exist then, or is excluded from snapshots). ${RESTORE_HINT(seq)}`,
    };
  }
  try {
    execFileSync("git", ["checkout", commit, "--", rel], { encoding: "utf-8", timeout: 30_000, env, cwd, stdio: "pipe" });
    const relPosix = rel.split(path.sep).join("/");
    const note = applySnapshotMeta(readTreeMeta(snapshot.metaPath), (p) => p === relPosix || p.startsWith(relPosix + "/"));
    return { success: true, description: `Restored ${rel} from ${actionName} snapshot${note}` };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, description: `File restore failed: ${msg.slice(0, 200)}. ${RESTORE_HINT(seq)}` };
  }
}

/**
 * Direct restore: apply only action N's own artifacts. Its workspace snapshot is limited to the
 * paths action N changed (the difference to the next snapshot), and no action folder is pruned,
 * since later actions were not undone and their backups are still needed.
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
    // Relative paths are resolved by the caller (the CLI uses the directory it was run from).
    const wanted = path.resolve(process.cwd(), options.fileOnly);
    return [restoreOneFile(actionName, artifacts, wanted, config)];
  }

  // Only this action: its snapshot covers just what it changed when a later snapshot exists.
  let snapshotOpts: SnapshotRestoreOptions | undefined;
  const snap = artifacts.find((a) => a.strategy === "git_snapshot");
  const next = snap ? nextSnapshotAfter(actionName, config) : null;
  if (snap && next && next.artifactPath === snap.artifactPath) {
    const paths = changedBetween(snap.artifactPath, snap.commitHash ?? snap.id, next.commitHash ?? next.id);
    if (paths) snapshotOpts = { scope: { paths, nextMeta: readTreeMeta(next.metaPath) } };
  }
  const results = await restoreOneAction(artifacts, config, snapshotOpts);
  results.push(...incompleteWarnings(actionName, config));
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
  const warnings: RestoreResult[] = [];

  // Undo actions from the latest down to targetIdx + 1.
  for (let i = actions.length - 1; i > targetIdx; i--) {
    const inter = actions[i];
    results.push({
      success: true,
      description: `--- Undoing ${inter.name} ---`,
    });

    for (const r of await restoreOneAction(inter.artifacts, config)) {
      results.push(r);
      if (r.unverified) anyUnverified = true;

      if (!r.success && !r.subagentPrompt) {
        anyFailed = true;
        // Non-fatal: record and continue.
        results.push({
          success: false,
          description: `Warning: a restore step failed in ${inter.name}, continuing...`,
        });
      }
    }
    warnings.push(...incompleteWarnings(inter.name, config));
  }

  // Restore the target action's artifacts directly; pruning is coordinated here.
  results.push({
    success: true,
    description: `--- Restoring target: ${targetActionName} ---`,
  });
  const targetAction = actions[targetIdx];
  for (const r of await restoreOneAction(targetAction.artifacts, config)) {
    results.push(r);
    if (r.unverified) anyUnverified = true;
    if (!r.success && !r.subagentPrompt) {
      anyFailed = true;
    }
  }
  warnings.push(...incompleteWarnings(targetActionName, config));

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

  return [...results, ...warnings];
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
  return path.join(storeRoot(config), "restore-history.jsonl");
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
    appendJsonl(restoreHistoryPath(config), entry);
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
  const root = path.resolve(config.backupDir);
  return listActions(config).map((name) => ({ name, artifacts: readActionArtifacts(path.join(root, name)) }));
}
