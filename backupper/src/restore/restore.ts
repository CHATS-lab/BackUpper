/**
 * Restore engine — reverse a backup artifact to recover prior state.
 *
 * Tiers 1-2: deterministic restore (known inverse for each strategy).
 * Tier 3 (subagent): returns a prompt for the subagent to execute.
 *
 * Restore never deletes the backup — it stays in the action folder
 * so you can restore again or inspect what was there.
 */

import { SUBAGENT_RESTORE, render } from "../prompts.generated.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import type { BackupArtifact, SandboxConfig } from "../types.js";
import { listActions } from "../backup/manifest.js";
import { invokeRestoreSubagent } from "../backup/subagent.js";
import { serverFromToolName } from "../explore/experiences.js";
import { callMcpTool, callMcpToolHttp } from "../explore/list_mcp_tools.js";

// ── Types ────────────────────────────────────────────────────────────

export interface RestoreResult {
  success: boolean;
  /** What was restored */
  description: string;
  /** If subagent is needed, this contains the prompt */
  subagentPrompt?: string;
  /** True when the restore ran but its outcome could NOT be verified
   *  (e.g. a live-restore subagent reversed remote/dynamic state we
   *  can't re-read). Such an action must NOT trigger pruning — pruning
   *  the only backup of unverified remote state is unrecoverable. */
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

/** Run a binary with an argument vector — NO shell. Used for recovery
 *  built from saved data (package names/versions) so values can never be
 *  interpreted as shell syntax. */
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
 * Reject catastrophic / injection-shaped recovery commands before they
 * reach a shell. `recovery_commands` are authored by an LLM whose input
 * includes untrusted remote content (post titles, issue bodies), so a
 * crafted string can carry shell injection. This is a denylist backstop
 * for the worst forms — not a substitute for a typed recovery plan, but
 * it blocks the commands that turn a restore into a wipe/exfil.
 */
export function isDangerousRecoveryCommand(cmd: string, _depth = 0): boolean {
  const c = cmd.toLowerCase();
  // Recurse into interpreter wrappers so `bash -c "rm -rf /"` is judged by its
  // INNER command, not the harmless-looking `bash -c` shell (the old denylist
  // matched the outer form only). Unwrap one quoted level — enough for the
  // realistic single-wrap case without a full shell parser. Depth-capped so a
  // pathologically nested string can't overflow the stack (this runs at
  // restore time, not on the gate — but cheap insurance).
  if (_depth < 6) {
    const wrapped = c.match(/\b(?:sh|bash|zsh|dash|ksh|env)\b[^'"]*(['"])([\s\S]*)\1/);
    if (wrapped && wrapped[2] && wrapped[2] !== c && isDangerousRecoveryCommand(wrapped[2], _depth + 1)) return true;
  }

  // Flag order/spelling-independent rm of a root-ish path: gather ALL flags
  // (short clusters -rf AND long --recursive/--force/--no-preserve-root, in
  // any order/position) up to the first non-flag token, then require a
  // catastrophic target. The old regex demanded one short cluster immediately
  // before the path, so `rm --recursive --force /` and `rm -rf --no-preserve-root /`
  // both slipped through.
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

/** MCP server definition needed to dispatch a structured tools/call:
 *  either a STDIO server ({command, args}) or an HTTP server ({url}). */
interface ServerDef { command?: string; args?: string[]; url?: string }

/** Resolve an MCP server's launch definition from the configured MCP
 *  sources, so a deterministic remote reversal can be REPLAYED through the
 *  same server the action used — via the MCP (tools/call), never a binary.
 *  Reads, in order:
 *    1. claude's --mcp-config JSON (config.subagentMcpConfig):
 *       mcpServers[server] → {command,args} (stdio) or {url} (http).
 *    2. the hermes ~/.hermes/config.yaml: mcp_servers[server] (same shape).
 *  Returns null if the server isn't found in either source (caller then
 *  fails safe — it must NOT fall back to a direct binary). General: no
 *  server-name or tool-name is special-cased here. */
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
  // 1. claude --mcp-config JSON.
  try {
    if (config.subagentMcpConfig && fs.existsSync(config.subagentMcpConfig)) {
      const raw = JSON.parse(fs.readFileSync(config.subagentMcpConfig, "utf-8")) as
        { mcpServers?: Record<string, unknown> };
      const def = shape(raw.mcpServers?.[server]);
      if (def) return def;
    }
  } catch { /* fall through */ }
  // 2. hermes ~/.hermes/config.yaml (mcp_servers.<name>) — the hermes-runner
  //    source in this multi-source fallback chain (1. explicit knob, 2. hermes
  //    config, 3. none). overfit-ok: hermes-shaped source, tried only after
  //    the runner-agnostic knob.
  try {
    const p = path.join(process.env.HERMES_HOME || path.join(os.homedir(), ".hermes"), "config.yaml"); // overfit-ok: hermes source branch
    if (fs.existsSync(p)) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
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

  // Read the saved package list and install from it
  try {
    const data = JSON.parse(fs.readFileSync(listPath, "utf-8"));
    const deps = data.dependencies ?? {};
    // Build an argument VECTOR (no shell), and drop any spec carrying
    // shell metacharacters/whitespace — a corrupted or crafted package
    // name can't inject a command when passed via execFileSync.
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

  // We can't actually re-export env vars into the parent process from here.
  // Instead, provide the restore command for the user/agent to run.
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

  // Use the specific commit hash stored with the artifact — NOT HEAD.
  // With the shared shadow repo, HEAD points to the LATEST snapshot,
  // which may be a later action than the one we want to restore.
  const commit = artifact.commitHash ?? artifact.id;
  if (!commit) {
    return { success: false, description: "Artifact is missing commit hash" };
  }

  // Verify the commit exists in the shadow repo. The shadow repo is
  // a bare-style git dir (contents live directly in shadowDir, no
  // working tree), so we must use GIT_DIR — not cwd — to query it.
  // (Earlier versions passed cwd=shadowDir which silently failed
  // because `git rev-parse` couldn't find HEAD in cwd.)
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
    // Use read-tree + checkout-index + clean instead of plain checkout.
    // `git checkout <hash> -- .` only overwrites files present in the commit
    // but does NOT delete files that were added after it. The three-step
    // approach makes the workspace exactly match the commit:
    //   read-tree: set the index to the target commit's tree
    //   checkout-index: overwrite workspace files from the index
    //   clean -fd: remove workspace files not in the index
    // The shadow repo's info/exclude protects node_modules, .env, etc.
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

// ── Tier 3: subagent restore ─────────────────────────────────────────

/**
 * Restore a subagent artifact. Three mutually-exclusive paths, all of
 * which reach a remote system ONLY through the MCP (never psql/curl/binary):
 *
 *   1. liveRestore=true → spawn a fresh restore subagent that reads live
 *      state and reverses it through the same MCP server (unchanged).
 *   2. liveRestore=false WITH recoveryMcpCalls → deterministic replay: for
 *      each recorded {server, tool, args}, resolve the server def and
 *      replay the call via tools/call. STDIO servers are dispatched from
 *      this process (callMcpTool); HTTP / unresolved servers route to the
 *      restore subagent (still MCP, via the runner). No binary fallback.
 *   3. liveRestore=false with only legacy raw-string subagentCommands → a
 *      LOCAL shell reversal runs via execSync; a REMOTE one (its toolName
 *      resolves to an MCP server) routes to the restore subagent — we
 *      never guess a binary for it.
 */
async function restoreSubagent(
  artifact: BackupArtifact,
  config?: SandboxConfig,
): Promise<RestoreResult> {
  // Live-restore path: the backup subagent flagged this artifact as
  // remote/dynamic — canned commands can't be trusted. Spawn a fresh
  // subagent that reads live state and decides what to do.
  if (artifact.liveRestore) {
    return runRestoreSubagentPath(artifact, config,
      "Live-restore subagent needed (config unavailable in this call path)");
  }

  // Deterministic MCP replay: the backup agent recorded the EXACT MCP
  // tool call(s) that reverse the action. Replay them verbatim through
  // the MCP — never a binary.
  const mcpCalls = artifact.recoveryMcpCalls ?? [];
  if (mcpCalls.length > 0) {
    const fallbackServer = serverFromToolName(artifact.toolName);
    const replayed: string[] = [];
    for (const call of mcpCalls) {
      const server = call.server ?? fallbackServer;
      const def = resolveServerDef(server, config);
      // No def at all → route to the restore subagent (it reverses through
      // the same MCP via the runner). Fail safe: never a direct binary/shell
      // for a remote action.
      if (!def) {
        return runRestoreSubagentPath(artifact, config,
          `Deterministic MCP replay needs the restore subagent ` +
          `(server "${server ?? "?"}" unresolved), but config is unavailable in this call path`);
      }
      // HTTP server: dispatch the tools/call in-process via the HTTP MCP
      // transport (Streamable HTTP), same as a STDIO replay — no subagent.
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

  // Deterministic SHELL reverter (e.g. `rmdir` for an MCP create_directory).
  // The backup tier compiled this from a verified pattern and validated it
  // structurally (non-empty, passes isDangerousRecoveryCommand, minimal
  // inverse). Run it locally via execSync — do NOT route an MCP-named action
  // here to the restore subagent just because its tool resolves to a server.
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

  // Legacy raw-string recovery (no structured calls).
  const commands = artifact.subagentCommands ?? [];

  if (commands.length === 0) {
    // Nothing to execute — only a prompt is produced, so the artifact
    // is not actually restored. Report as failure (not success) so
    // pruning is blocked and the dashboard doesn't show a false "✓".
    return {
      success: false,
      description: "Subagent restore needed (no commands recorded)",
      subagentPrompt: buildSubagentRestorePrompt(artifact),
    };
  }

  // A REMOTE legacy recovery (the action's tool resolves to an MCP server)
  // must NOT be run through /bin/sh — its recovery_commands are prose for
  // an agent, and we never guess a binary. Route it to the restore subagent.
  if (serverFromToolName(artifact.toolName)) {
    return runRestoreSubagentPath(artifact, config,
      "Remote recovery needs the restore subagent (config unavailable in this call path)");
  }

  // LOCAL shell reversal: execute each recovery command in sequence,
  // stopping on the first failure, with the dangerous-command guard.
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

/** Spawn a fresh restore subagent to reverse this artifact through the
 *  SAME MCP server the action used. Shared by the liveRestore path, the
 *  HTTP/unresolved deterministic-replay fallback, and legacy remote
 *  recoveries. Returns success:false (with the prompt) when config is
 *  unavailable so callers keep the backup and never prune unrecovered
 *  remote state. */
function runRestoreSubagentPath(
  artifact: BackupArtifact,
  config: SandboxConfig | undefined,
  noConfigReason: string,
): RestoreResult {
  const prompt = buildSubagentRestorePrompt(artifact);
  if (!config) {
    return { success: false, description: noConfigReason, subagentPrompt: prompt };
  }
  // Dynamic MCP loading: reverse through the SAME server the action used.
  const result = invokeRestoreSubagent(prompt, config, serverFromToolName(artifact.toolName));
  return {
    success: result.success,
    description: result.success
      ? `Restore subagent completed (unverified): ${result.detail.slice(0, 200)}`
      : `Restore subagent failed: ${result.detail.slice(0, 200)}`,
    // The subagent reversed remote/dynamic state through its own tools;
    // we cannot re-read that state to confirm it actually returned. Mark
    // unverified so the loop keeps the backup instead of pruning it.
    unverified: true,
  };
}

/** Text: prompts/subagent-restore.md. Exported so tests/prompts_render_equal.mjs can render it. */
export function buildSubagentRestorePrompt(artifact: BackupArtifact): string {
  const commands = artifact.subagentCommands?.length
    ? artifact.subagentCommands.map((c, i) => `  ${i + 1}. ${c}`).join("\n")
    : SUBAGENT_RESTORE.sections["no-commands-line"];

  const action = artifact.originalAction ?? artifact.toolName;

  // The backup subagent captured the affected entity's locators (title,
  // id, URL, parent id, prior body) into remote-state.json alongside the
  // result file. The restore subagent NEEDS those to find the entity to
  // recreate/delete — inline them rather than just naming the result file.
  let capturedBlock = "";
  try {
    const dir = path.dirname(artifact.artifactPath);
    for (const name of ["remote-state.json", "remote_state.json"]) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) {
        capturedBlock = render(SUBAGENT_RESTORE.sections["captured-state-block"], { JSON: fs.readFileSync(p, "utf-8").slice(0, 4000) }) + "\n\n";
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
 * Restore a single backup artifact.
 *
 * For tiers 1-2: executes restore deterministically.
 * For tier 3 (subagent): returns a prompt in result.subagentPrompt.
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
    default:
      return { success: false, description: `Unknown strategy: ${artifact.strategy}` };
  }
}

/**
 * Reverse a tier-0 policy rewrite (e.g. rm → mv-to-trash). The pre-recorded
 * recoveryCommands are run verbatim via execSync, same contract as the
 * subagent path's replay mode.
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
 * Delete action folders from the target onwards (inclusive).
 *
 * Since each snapshot captures the state BEFORE the action ran,
 * restoring to action N means "undo N." So folder N itself should
 * also be deleted — the workspace is now in the pre-N state, and
 * folder N's snapshot has been applied.
 *
 * Commits in the shared shadow repo remain as dangling objects
 * (git will garbage-collect them eventually).
 *
 * Returns the number of folders deleted.
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
  // Delete from targetIdx onwards (inclusive — target folder is also removed)
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
 * Check if all results in a restore operation succeeded.
 *
 * A result that only carries a `subagentPrompt` did NOT actually
 * restore anything — it deferred the work to a prompt nobody has run
 * yet. Counting that as success let the system prune intermediate
 * folders and report "✓ restored" while remote/dynamic state was
 * still unrecovered. We now require an executed success with no
 * pending prompt.
 */
function allSucceeded(results: RestoreResult[]): boolean {
  return results.every((r) => r.success && r.subagentPrompt === undefined);
}

/**
 * Collapse duplicate git_snapshot artifacts within a single action to the
 * OLDEST one (first in metadata = earliest backup).
 *
 * Rapid/concurrent tool calls (e.g. an agent that batches edits in one turn)
 * fire several backups before the action boundary closes, so one action folder
 * can accumulate multiple git_snapshots. Each git_snapshot restore does
 * read-tree + checkout-index, which OVERWRITES the whole tree — so replaying
 * them in metadata order (oldest→newest) lets the NEWEST (already-edited)
 * snapshot win, leaving the agent's edits un-reverted. The oldest snapshot is
 * the true "state before this group of actions", so we keep only that one and
 * drop the later intermediates. Non-snapshot artifacts (pip_freeze, subagent,
 * policy_rewrite, …) are untouched.
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
 * Direct restore — jump straight to action N's snapshot.
 * Fast for workspace files (git_snapshot), but only covers what that
 * single action backed up. Use for quick workspace rollback.
 *
 * After a successful full-state restore (not --file mode), intermediate
 * folders (actions AFTER the target) are deleted.
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
    const snapshot = artifacts.find((a) => a.strategy === "git_snapshot");
    if (!snapshot) {
      return [{ success: false, description: `No git snapshot found in ${actionName}` }];
    }

    const shadowDir = snapshot.artifactPath;
    // Use the specific commit hash for this action, not HEAD.
    const commit = snapshot.commitHash ?? snapshot.id;
    if (!commit) {
      return [{ success: false, description: "Snapshot is missing commit hash" }];
    }

    const cwd = process.cwd();
    try {
      execSync(`git checkout ${commit} -- "${options.fileOnly}"`, {
        encoding: "utf-8",
        timeout: 30_000,
        env: { ...process.env, GIT_DIR: shadowDir, GIT_WORK_TREE: cwd },
        cwd,
        stdio: "pipe",
      });
      // Single-file restore does NOT prune intermediate folders —
      // the other files in later actions may still be wanted.
      return [{
        success: true,
        description: `Restored ${options.fileOnly} from ${actionName} snapshot`,
      }];
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return [{ success: false, description: `File restore failed: ${msg.slice(0, 200)}` }];
    }
  }

  // Full restore — apply artifacts, then prune intermediate folders.
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
 * Reverse-loop restore — undo actions one by one from latest back to N+1.
 *
 * For each action being undone (in reverse order):
 *   - git_snapshot: restore workspace from that action's snapshot
 *   - pip_freeze / npm_list / env_snapshot: restore from that action's manifest
 *   - subagent: generate prompt for subagent
 *
 * This is safer than direct jump because each step is a small, well-defined
 * reversal. If one step fails, you know exactly where it stopped.
 *
 * After a successful restore, intermediate folders (those we walked through)
 * are deleted — they're off the main timeline now.
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

  // NOTE: we do NOT short-circuit when targetIdx is the latest action.
  // Each snapshot captures the state BEFORE the action ran, so
  // "restore 1" when there's only 1 action means: apply that
  // snapshot, reverting the single change the user made. The loop below
  // simply skips the "walk backwards" phase (since i > targetIdx is
  // immediately false) and proceeds directly to the target restore.

  const results: RestoreResult[] = [];
  let anyFailed = false;
  // True if any restored artifact reversed remote/dynamic state we can't
  // re-read (live-restore). We keep ALL backups in that case — pruning the
  // only copy of unverified remote state would be unrecoverable.
  let anyUnverified = false;

  // Walk backwards: undo actions from latest down to targetIdx + 1
  // Each step restores the state that existed BEFORE that action.
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
        // Non-fatal: log and continue to next artifact
        results.push({
          success: false,
          description: `Warning: failed to restore ${artifact.strategy} in ${inter.name}, continuing...`,
        });
      }
    }
  }

  // Finally, restore the target action's state directly.
  // IMPORTANT: call restoreArtifact on each artifact of the target rather than
  // restoreActionDirect — the latter would itself try to prune folders
  // and we want to coordinate pruning at this level.
  results.push({
    success: true,
    description: `--- Restoring target: ${targetActionName} ---`,
  });
  const targetAction = actions[targetIdx];
  for (const artifact of collapseGitSnapshots(targetAction.artifacts)) {
    // Pass config — without it the liveRestore branch in
    // restoreSubagent can't spawn the restore subagent and silently
    // degrades to a prompt-only no-op for the most important action
    // in the whole operation (the state we're restoring TO).
    const r = await restoreArtifact(artifact, config);
    results.push(r);
    if (r.unverified) anyUnverified = true;
    if (!r.success && !r.subagentPrompt) {
      anyFailed = true;
    }
  }

  // Prune intermediate folders only if everything succeeded AND every step
  // was verifiable. A live-restore reversed remote state we can't re-read,
  // so pruning its backup would destroy the only copy on an unconfirmed
  // outcome — keep the folders in that case too.
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
// Every restore attempt (CLI or dashboard, success or failure) is
// appended to .chats-sandbox/restore-history.jsonl so there is an audit
// trail of when the workspace was rewound and how it went. The ledger
// must never block a restore — all failures are swallowed.

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
        // Guard against metadata.json that's a non-array (bad write, manual
        // edit, legacy single-object format). restoreActionLoop's
        // `for (const artifact of inter.artifacts)` would otherwise blow up
        // with "not iterable" on a plain object.
        if (Array.isArray(parsed)) {
          artifacts = parsed as BackupArtifact[];
        } else if (parsed && typeof parsed === "object") {
          // Best-effort: wrap a single-object metadata as a one-element array.
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
