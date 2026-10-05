/**
 * Tier-4 subagent backup: spawns a headless agent CLI with a constrained prompt,
 * parses its JSON result, and records it as a `subagent` artifact in the action folder.
 * BACKUPPER_NO_HOOK=1 prevents recursion; any failure falls back to tier-3 alone.
 */

import { SUBAGENT_BACKUP as P, render } from "../prompts.generated.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import type { BackupArtifact, HookContext, SandboxConfig, SubagentRunnerName } from "../types.js";
import { describeToolAction } from "../types.js";
import { extractJsonObject } from "../util/extract_json.js";
import { serverFromToolName } from "../explore/experiences.js";
import { mcpAvailableFor, mcpConfigSource, resolveRunner, subagentModelFor } from "./runner_caps.js";
import { learnReadOnlyPatterns } from "./learned_readonly.js";
import { captureTranscript, TRANSCRIPT_FILE_RE, type TranscriptCapture } from "./subagent_transcript.js";
import { storeRoot } from "../store/layout.js";
import { quote } from "../util/shell.js";

/** js-yaml, loaded lazily so a missing module never breaks the common backup path. */
function loadYaml(): { load: (s: string) => unknown; dump: (o: unknown) => string } | null {
  try {
    return require("js-yaml");
  } catch {
    return null;
  }
}

/** Shape of the JSON the subagent is instructed to return */
interface SubagentResponse {
  /** Short description of what was backed up */
  description: string;
  /** Commands the subagent ran to create the backup */
  backup_commands: string[];
  /** Commands to run for recovery (reverse the upcoming action) */
  recovery_commands: string[];
  /** Optional: paths to backup artifact files the subagent wrote */
  artifact_paths?: string[];
  /** True when restore should spawn a fresh subagent instead of replaying recovery_commands. */
  live_restore?: boolean;
  /** Exact MCP tool calls that reverse a remote action, replayed verbatim at restore. */
  recovery_mcp_calls?: Array<{ server?: string; tool: string; args: Record<string, unknown> }>;
  /** True when the subagent judged the action read-only; treated as a clean skip. */
  no_backup_needed?: boolean;
  /** Read-only patterns to record in the learned store (used only with no_backup_needed). */
  read_only_patterns?: Array<{ pattern: string; reason?: string }>;
}

export function isCommandAvailable(cmd: string): boolean {
  try {
    execSync(`command -v ${quote(cmd)}`, { stdio: "pipe", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Environment for spawned subagents: BACKUPPER_NO_HOOK=1 as a recursion guard,
 * and IS_SANDBOX=1 when running as root (required by --dangerously-skip-permissions).
 */
export function subagentEnv(): NodeJS.ProcessEnv {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  return {
    ...process.env,
    BACKUPPER_NO_HOOK: "1",
    ...(isRoot ? { IS_SANDBOX: "1" } : {}),
    // Allow slow-starting MCP servers time to connect.
    MCP_TIMEOUT: process.env.MCP_TIMEOUT || "60000",
  };
}

/**
 * Builds the subprocess invocation for the configured subagent runner
 * (claude, codex, hermes, ...). Returns null when the runner's CLI is unavailable.
 */
/** Temp files and directories created while building the current invocation. */
const pendingTemps: string[] = [];

/** Record a temp path so it is removed after the spawn that uses it. */
function trackTemp(p: string): string {
  if (!pendingTemps.includes(p)) pendingTemps.push(p);
  return p;
}

/** Remove paths recorded by trackTemp; best-effort, never throws. */
function removeTemps(paths: readonly string[]): void {
  for (const p of paths) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

/**
 * Remove the temp files an invocation created (filtered MCP configs, browser-profile copies,
 * a filtered Hermes home). Call it once the spawn has ended, on every exit path.
 */
export function cleanupSubagentInvocation(inv: { tempPaths?: string[] } | null | undefined): void {
  if (inv?.tempPaths?.length) removeTemps(inv.tempPaths);
}

type SubagentInvocationOpts = {
    withMcp?: boolean; isolateBrowserProfile?: boolean; neededServer?: string | null;
    maxTurns?: number; toolAllow?: string[];
    /** Read-only checker: ban every tool and wire no MCP. */
    noTools?: boolean;
    /** System prompt for a noTools spawn (prepended to the prompt where no flag exists). */
    systemPrompt?: string;
};

export interface SubagentInvocation {
  bin: string; args: string[];
  runner: "claude" | "hermes" | "codex";
  env?: Record<string, string>;
  /** Temp paths this invocation needs while it runs; removed by cleanupSubagentInvocation. */
  tempPaths?: string[];
}

/** Outcome of runInvocation: stdout/stderr are kept even when the process failed. */
export interface SpawnOutcome {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: Error;
}

/**
 * Run a subagent invocation synchronously with the shared subagent environment.
 * `viaWatcher` runs it under subagent_watch.js, which stops the process once the result
 * file is valid and enforces `timeoutMs` (the outer timeout gets a 10 s margin).
 * The caller still owns cleanupSubagentInvocation.
 */
export function runInvocation(
  inv: Pick<SubagentInvocation, "bin" | "args" | "env">,
  opts: { timeoutMs: number; maxBuffer: number; input?: string; viaWatcher?: { resultFile: string } },
): SpawnOutcome {
  const { execFileSync } = require("node:child_process");
  const [bin, args, timeout] = opts.viaWatcher
    ? [process.execPath, [path.join(__dirname, "subagent_watch.js"), opts.viaWatcher.resultFile,
        String(opts.timeoutMs), inv.bin, ...inv.args], opts.timeoutMs + 10_000]
    : [inv.bin, inv.args, opts.timeoutMs];
  try {
    const stdout: string = execFileSync(bin, args, {
      encoding: "utf-8",
      timeout,
      env: { ...subagentEnv(), ...(inv.env ?? {}) },
      // Some runners block on an open stdin pipe, so stdin is always given (empty by default).
      input: opts.input ?? "",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: opts.maxBuffer,
    });
    return { ok: true, stdout, stderr: "" };
  } catch (e: unknown) {
    const err = e as Error & { stdout?: unknown; stderr?: unknown };
    return {
      ok: false,
      stdout: err.stdout ? String(err.stdout) : "",
      stderr: err.stderr ? String(err.stderr) : "",
      error: err instanceof Error ? err : new Error(String(e)),
    };
  }
}

/** The `result` text of a runner's JSON wrapper (`{"result": "..."}`), or null. */
export function unwrapResultText(stdout: string): string | null {
  try {
    const wrapper = JSON.parse(stdout);
    const r = wrapper && typeof wrapper === "object" ? (wrapper as Record<string, unknown>).result : undefined;
    return typeof r === "string" ? r : null;
  } catch {
    return null;
  }
}

/**
 * Builds the subprocess invocation for the configured subagent runner. Temp files it
 * writes are listed in `tempPaths`; the caller removes them with cleanupSubagentInvocation
 * after the spawn. Returns null (and removes any temp files) when the runner's CLI is unavailable.
 */
export function buildSubagentInvocation(
  prompt: string,
  config: SandboxConfig,
  opts?: SubagentInvocationOpts,
): SubagentInvocation | null {
  const mark = pendingTemps.length;
  let inv: SubagentInvocation | null = null;
  try {
    inv = buildInvocationInner(prompt, config, opts);
  } finally {
    const temps = pendingTemps.splice(mark);
    if (!inv) removeTemps(temps);
    else if (temps.length) inv.tempPaths = temps;
  }
  return inv;
}

function buildInvocationInner(
  prompt: string,
  config: SandboxConfig,
  opts?: SubagentInvocationOpts,
): SubagentInvocation | null {
  const runner = resolveRunner(config);
  const model = subagentModelFor(config, runner);

  // Read-only checker arm: the spawn must be unable to execute anything. claude
  // bans tools by flag; other runners get their strongest restriction plus the prompt.
  const noTools = opts?.noTools === true;
  if (noTools && opts?.systemPrompt && runner !== "claude") {
    prompt = opts.systemPrompt + "\n\n" + prompt;
  }

  if (runner === "codex") {
    if (!isCommandAvailable("codex")) return null;
    // codex exec reads stdin when it is an open pipe; the spawn site closes it.
    const args = [
      "exec",
      "--skip-git-repo-check",
      // Checker spawns run with a read-only sandbox.
      "--sandbox", noTools ? "read-only" : "danger-full-access",
    ];
    if (model) {
      args.push("-m", model);
    }
    args.push(prompt);
    return { bin: "codex", args, runner };
  }

  if (runner === "hermes") {
    if (!isCommandAvailable("hermes")) return null;
    // For an MCP action, use a HOME whose config loads only that action's server.
    let env: Record<string, string> | undefined;
    if (opts?.neededServer) {
      const home = filteredHermesHome(opts.neededServer, opts.isolateBrowserProfile, opts.toolAllow);
      // Set both HOME and HERMES_HOME, since hermes checks HERMES_HOME first.
      if (home) env = { HOME: home, HERMES_HOME: path.join(home, ".hermes") };
    }
    // Optionally route the subagent to its own provider; applied only when both
    // base URL and token are set.
    const sgBase = process.env.BACKUPPER_SUBAGENT_BASE_URL;
    const sgToken = process.env.BACKUPPER_SUBAGENT_AUTH_TOKEN;
    if (sgBase && sgToken) {
      env = { ...env, OPENROUTER_BASE_URL: sgBase, OPENROUTER_API_KEY: sgToken };
    }
    // Minimal toolsets (shell/file plus the action's MCP server); none for a checker spawn.
    let toolsets = "";
    if (!noTools) {
      toolsets = "terminal,file" + (opts?.neededServer ? `,mcp-${opts.neededServer}` : "");
    }
    // Model and provider default to hermes's own configuration.
    const args = ["chat", "--toolsets", toolsets, "-q", prompt];
    if (model) args.push("-m", model);
    if (config.subagentProvider) args.push("--provider", config.subagentProvider);
    // -Q quiet, --yolo skip approvals; --max-turns bounds the loop.
    args.push("-Q", "--yolo", "--max-turns", String(opts?.maxTurns ?? 15));
    return { bin: "hermes", runner, env, args };
  }

  // Default: claude -p
  if (!isCommandAvailable("claude")) return null;
  const permissionMode = config.subagentPermissionMode ?? "bypassPermissions";
  const args = [
    "-p", prompt,
    "--output-format", "json",
    // Session persistence is off unless BACKUPPER_PERSIST_SUBAGENT_SESSIONS=1.
    ...(process.env.BACKUPPER_PERSIST_SUBAGENT_SESSIONS === "1"
      ? [] : ["--no-session-persistence"]),
    "--setting-sources", "user",
  ];
  // Replace the default system prompt with a backup-specific one and deny unneeded
  // native tools. Opt out with BACKUPPER_CLAUDE_FULL_PROMPT=1.
  const IRRELEVANT_NATIVE_TOOLS = [
    "WebSearch", "WebFetch", "Task", "NotebookEdit", "TodoWrite",
    "EnterPlanMode", "ExitPlanMode", "KillShell", "Skill",
  ];
  const deniedTools: string[] = [];
  // Checker spawn: our system prompt, and every tool hard-blocked via --disallowedTools.
  const BANNED_FOR_CHECKER = [
    // execution, filesystem, network
    "Bash", "BashOutput", "KillShell", "Read", "Write", "Edit", "MultiEdit",
    "NotebookEdit", "Glob", "Grep", "LS", "WebSearch", "WebFetch",
    // delegation: a subagent would have the tools this one does not
    "Task", "Agent", "SendMessage", "TaskStop", "Skill", "SlashCommand",
    // MCP discovery/plumbing (no server is wired, but do not rely on that)
    "ToolSearch", "ListMcpResources", "ReadMcpResource",
    // planning, bookkeeping, interaction
    "TodoWrite", "EnterPlanMode", "ExitPlanMode", "AskUserQuestion", "Artifact",
    // Additional tools present on some CLI builds; re-check this denylist on CLI upgrades.
    "EnterWorktree", "ExitWorktree", "Workflow", "ReportFindings",
    "ScheduleWakeup", "CronCreate", "CronDelete", "CronList",
    "TaskCreate", "TaskGet", "TaskList", "TaskUpdate",
  ];
  if (noTools) {
    if (opts?.systemPrompt) args.push("--system-prompt", opts.systemPrompt);
    // --strict-mcp-config with no --mcp-config loads zero MCP servers.
    args.push("--strict-mcp-config");
    deniedTools.push(...BANNED_FOR_CHECKER);
  } else if (process.env.BACKUPPER_CLAUDE_FULL_PROMPT !== "1") {
    args.push("--system-prompt",
      P.sections["system-prompt"]);
    deniedTools.push(...IRRELEVANT_NATIVE_TOOLS);
  }
  if (permissionMode === "bypassPermissions") {
    args.push("--dangerously-skip-permissions");
  } else {
    args.push("--permission-mode", permissionMode);
  }
  if (model && model !== "inherit") {
    args.push("--model", model);
  }
  // Give the subagent the agent's MCP servers so it can read pre-state and reverse
  // state through the real interface; checker spawns never get MCP.
  const mcpSource = (opts?.withMcp && !noTools) ? mcpConfigSource(config, opts?.neededServer) : null;
  if (mcpSource) {
    if (opts?.neededServer) {
      // Load only this action's server and ignore other MCP sources.
      args.push("--mcp-config",
        filteredClaudeMcpConfig(mcpSource, opts.neededServer, !!opts.isolateBrowserProfile));
      args.push("--strict-mcp-config");
      // Restrict to the learned capture tools by denying the rest of the server's
      // registered tools; skipped when the server has no registry entry.
      if (opts.toolAllow && opts.toolAllow.length) {
        try {
          const { loadToolRegistry } = require("../explore/tool_registry.js");
          const serverTools: string[] = (loadToolRegistry(config)[opts.neededServer] ?? []);
          // Match case-insensitively but emit the registry's own casing.
          const bare = (t: string) => (t.split("__").pop() || t);
          const allowed = new Set(opts.toolAllow.map((t) => bare(t).toLowerCase()));
          const denied = serverTools
            .filter((t) => !allowed.has(bare(t).toLowerCase()))
            .map((t) => `mcp__${opts.neededServer}__${bare(t)}`);
          // Merged with the native-tool denies into one flag below.
          deniedTools.push(...denied);
        } catch { /* registry unavailable: leave the server unfiltered */ }
      }
    } else {
      args.push("--mcp-config",
        opts?.isolateBrowserProfile ? isolatedMcpConfig(mcpSource) : mcpSource);
    }
  }
  // claude has no --max-turns flag; the result watcher and timeout bound the run.
  if (mcpSource && opts?.neededServer) {
    // MCP tool schemas are deferred behind ToolSearch, so tell the subagent to load them first.
    const server = opts.neededServer;
    args[1] =
      `Before your first MCP call: load the "${server}" server's tools with ToolSearch (query "${server}").\n\n` +
      args[1];
  }
  // A single --disallowedTools flag, since repeated flags may be last-wins.
  if (deniedTools.length) args.push("--disallowedTools", deniedTools.join(","));
  // Optionally route only this subagent to a third-party model through an
  // Anthropic-compatible gateway. Requires all of BACKUPPER_SUBAGENT_BASE_URL,
  // BACKUPPER_SUBAGENT_AUTH_TOKEN and BACKUPPER_SUBAGENT_MODEL_ID.
  const gwBase = process.env.BACKUPPER_SUBAGENT_BASE_URL;
  const gwToken = process.env.BACKUPPER_SUBAGENT_AUTH_TOKEN;
  const gwModel = process.env.BACKUPPER_SUBAGENT_MODEL_ID;
  if (gwBase && gwToken && gwModel) {
    const gwEnv: Record<string, string> = {
      ANTHROPIC_BASE_URL: gwBase,
      ANTHROPIC_AUTH_TOKEN: gwToken,
      // Explicitly empty so an inherited API key cannot override the token.
      ANTHROPIC_API_KEY: "",
      // Map every model tier to the gateway model.
      ANTHROPIC_DEFAULT_HAIKU_MODEL: gwModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: gwModel,
      ANTHROPIC_DEFAULT_OPUS_MODEL: gwModel,
      CLAUDE_CODE_SUBAGENT_MODEL: gwModel,
    };
    return { bin: "claude", args, runner, env: gwEnv };
  }
  return { bin: "claude", args, runner };
}

/**
 * Writes a temp MCP config in which each browser server uses its own copy of the
 * profile directory (separate lock, same login). Returns the original path on failure.
 */
export function isolatedMcpConfig(mcpPath: string): string {
  try {
    const raw = JSON.parse(fs.readFileSync(mcpPath, "utf-8")) as {
      mcpServers?: Record<string, { args?: unknown[] }>;
    };
    const servers = raw.mcpServers ?? {};
    let rewrote = false;
    for (const name of Object.keys(servers)) {
      const args = servers[name].args;
      if (!Array.isArray(args)) continue;
      const i = args.indexOf("--user-data-dir");
      if (i >= 0 && typeof args[i + 1] === "string") {
        const orig = String(args[i + 1]);
        const copy = trackTemp(path.join(os.tmpdir(), `backupper-sub-profile-${process.pid}-${name}`));
        try { fs.rmSync(copy, { recursive: true, force: true }); } catch { /* ignore */ }
        // Copy the live profile with a fault-tolerant `cp` that skips busy files.
        try {
          if (fs.existsSync(orig)) {
            const { execSync } = require("node:child_process");
            fs.mkdirSync(copy, { recursive: true });
            execSync(`cp -a -- ${quote(orig + "/.", { always: true })} ${quote(copy + "/", { always: true })} 2>/dev/null || true`,
              { timeout: 60_000 });
          }
        } catch { /* a partial copy is acceptable */ }
        // Remove Singleton* lock links; unlinkSync removes the link itself.
        try {
          for (const f of (fs.existsSync(copy) ? fs.readdirSync(copy) : [])) {
            if (f.startsWith("Singleton")) {
              try { fs.unlinkSync(path.join(copy, f)); } catch { /* ignore */ }
            }
          }
        } catch { /* ignore */ }
        args[i + 1] = copy;
        rewrote = true;
      }
    }
    if (!rewrote) return mcpPath;
    const out = trackTemp(path.join(os.tmpdir(), `backupper-sub-mcp-${process.pid}.json`));
    fs.writeFileSync(out, JSON.stringify(raw));
    return out;
  } catch {
    return mcpPath;
  }
}

/**
 * Writes a temp `--mcp-config` containing only the server this action uses
 * (optionally with an isolated browser profile). Returns the original path on failure.
 */
function filteredClaudeMcpConfig(mcpPath: string, neededServer: string, isolateBrowser: boolean): string {
  try {
    const raw = JSON.parse(fs.readFileSync(mcpPath, "utf-8")) as { mcpServers?: Record<string, unknown> };
    const all = raw.mcpServers ?? {};
    const kept: Record<string, unknown> = {};
    if (all[neededServer]) kept[neededServer] = all[neededServer];
    const outPath = trackTemp(path.join(os.tmpdir(), `backupper-sub-filtered-${process.pid}.json`));
    fs.writeFileSync(outPath, JSON.stringify({ mcpServers: kept }));
    return isolateBrowser ? isolatedMcpConfig(outPath) : outPath;
  } catch {
    return mcpPath;
  }
}

/**
 * Creates a per-call HOME holding a copy of `.hermes` whose `mcp_servers` is
 * filtered to the needed server. Returns the temp HOME, or null to keep the global config.
 */
function filteredHermesHome(neededServer: string, isolateBrowserProfile?: boolean, toolAllow?: string[]): string | null {
  try {
    // Prefer HERMES_HOME, matching hermes' own resolution order.
    const srcHomeDir = process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
    const srcCfg = path.join(srcHomeDir, "config.yaml");
    if (!fs.existsSync(srcCfg)) return null;
    // Pid-named and pre-wiped by default; BACKUPPER_KEEP_SUBAGENT_HOME=1 gives each
    // call a unique home that is kept.
    const keepHome = process.env.BACKUPPER_KEEP_SUBAGENT_HOME === "1";
    const suffix = keepHome
      ? `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      : String(process.pid);
    const tmpHome = path.join(os.tmpdir(), `backupper-sub-home-${suffix}`);
    if (!keepHome) {
      fs.rmSync(tmpHome, { recursive: true, force: true });
      // The copy holds the user's Hermes config and keys: removed after the spawn.
      trackTemp(tmpHome);
    }
    fs.cpSync(srcHomeDir, path.join(tmpHome, ".hermes"), { recursive: true });
    const yaml = loadYaml();
    if (!yaml) return null; // no js-yaml: skip filtering and use the global config
    const cfg = (yaml.load(fs.readFileSync(srcCfg, "utf-8")) ?? {}) as { mcp_servers?: Record<string, unknown> };
    const all = cfg.mcp_servers ?? {};
    cfg.mcp_servers = all[neededServer] ? { [neededServer]: all[neededServer] } : {};

    // Restrict the server to the caller's tool allowlist via `tools.include`;
    // without an allowlist the server is left unfiltered.
    const keptServer = cfg.mcp_servers[neededServer];
    if (toolAllow && keptServer && typeof keptServer === "object" && !Array.isArray(keptServer)) {
      const srv = keptServer as Record<string, unknown>;
      const existing = (srv.tools && typeof srv.tools === "object") ? srv.tools as Record<string, unknown> : {};
      srv.tools = { ...existing, include: toolAllow };
    }

    // Browser servers are shared over HTTP (`url:`), so no profile copy is made;
    // the parameter is accepted but unused here.
    void isolateBrowserProfile;
    fs.writeFileSync(path.join(tmpHome, ".hermes", "config.yaml"), yaml.dump(cfg));
    return tmpHome;
  } catch {
    return null;
  }
}

/**
 * Writes a status message to the controlling terminal (/dev/tty), falling back to stderr.
 */
function tellUser(message: string): void {
  try {
    fs.writeFileSync("/dev/tty", `${message}\n`);
  } catch {
    // /dev/tty unavailable: fall back to stderr
    try {
      process.stderr.write(`${message}\n`);
    } catch {
      // give up
    }
  }
}

/** The tier-4 subagent prompt. */
function buildSubagentPrompt(
  ctx: HookContext,
  actionDir: string,
  config?: SandboxConfig,
  mcpAvailable?: boolean,
  checkerTargets?: string[],
): string {
  return buildBackupGuidance({
    checkerTargets,
    toolName: ctx.tool_name,
    command: String(ctx.tool_input.command ?? ""),
    args: JSON.stringify(ctx.tool_input, null, 2),
    cwd: process.cwd(),
    actionDir,
    config,
    mcpAvailable,
  });
}

/** Options for {@link buildBackupGuidance}. */
export interface BackupGuidanceOpts {
  toolName?: string;
  command?: string;
  args?: string;
  cwd?: string;
  actionDir?: string;
  config?: SandboxConfig;
  /** Override the resolved MCP server. */
  server?: string | null;
  /** Explicit experience to inject (else derived from the server). */
  experienceName?: string;
  /** Whether the subagent will have the action's MCP server; false yields a
   *  no-MCP directive. Undefined means assume available. */
  mcpAvailable?: boolean;
  /** Write targets identified by the read-only checker, passed as advisory guidance. */
  checkerTargets?: string[];
}

/** Shell commands that reach a system outside the host (remote git, HTTP, containers, clusters, databases). */
const REMOTE_SHELL_COMMAND = new RegExp(
  "\\b(" +
    "git\\s+push|curl|wget|ssh|scp|rsync|docker|kubectl|helm|terraform|aws|gcloud|az|systemctl|" +
    "psql|mysql|mariadb|mongo|mongosh|redis-cli" +
  ")\\b",
);

/** Backup guidance prompt for the tier-4 subagent. */
export function buildBackupGuidance(opts: BackupGuidanceOpts): string {
  // Request learned read-only patterns only when the store is enabled.
  const learnedReadOnlyBlock = opts.config?.learnedReadOnlyEnabled === true
    ? "\n" + P.sections["learned-readonly-block"]
    : "";
  // Write targets established by the read-only checker (advisory).
  const checkerTargets = Array.isArray(opts.checkerTargets) ? opts.checkerTargets : [];
  let checkerTargetsBlock = "";
  if (checkerTargets.length) {
    const targetLines = checkerTargets.map((t) => `  - ${t}`).join("\n");
    checkerTargetsBlock = "\n" + render(P.sections["checker-targets-block"], { TARGET_LINES: targetLines }) + "\n";
  }
  const { config } = opts;
  const toolName = opts.toolName ?? "";
  const command = opts.command ?? "";
  const args = opts.args ?? "";
  const cwd = opts.cwd ?? process.cwd();
  const actionDir = opts.actionDir ?? "<backup-storage-dir>";

  // Resolve the action's MCP server via the tool registry, falling back to name parsing.
  let server: string | null = opts.server ?? null;
  if (!server && toolName) {
    try {
      const { serverFromToolName } = require("../explore/experiences.js");
      const { loadToolRegistry, serverForTool } = require("../explore/tool_registry.js");
      server = serverForTool(toolName, loadToolRegistry(config ?? ({} as SandboxConfig)))
        || serverFromToolName(toolName);
    } catch { /* ignore */ }
  }
  const isBrowser = server === "playwright";

  // Inject the learned backup experience for this MCP server.
  // BACKUPPER_NO_EXP_INJECT=1 suppresses only this prompt block.
  let experienceBlock = "";
  if (config && process.env.BACKUPPER_NO_EXP_INJECT !== "1") {
    try {
      const { loadExperiences, renderExperiencesForPrompt, serverToExperienceMap } =
        require("../explore/experiences.js");
      // Map server to experience by name, `appliesTo`, or experienceForServer.
      const map = serverToExperienceMap(config);
      const mappedName = server && (config.experienceForServer?.[server] || map[server]);
      const expName = opts.experienceName || mappedName || server;
      if (expName) {
        experienceBlock = renderExperiencesForPrompt(loadExperiences(config, expName));
      }
    } catch { /* experiences optional */ }
  }

  // Browser actions are pinned by content: pass the values the agent recently
  // typed so the recovery targets that exact entity.
  let recentInputBlock = "";
  if (isBrowser && config) {
    try {
      const { loadRecentBrowserInput } = require("./strategies.js");
      const recent: string[] = loadRecentBrowserInput(config);
      if (recent.length) {
        const values = recent.map((v) => JSON.stringify(v)).join(" , ");
        recentInputBlock = "\n" + render(P.sections["recent-input-block"], { VALUES: values });
      }
    } catch { /* optional */ }
  }
  // Pre-state: the agent's last page view for browser actions; otherwise a
  // directive to read the state itself and never fabricate it.
  let preStateBlock = "";
  if (config && (isBrowser || toolName.startsWith("mcp__"))) {
    try {
      const { loadRecentBrowserSnapshot } = require("./strategies.js");
      // The page snapshot applies only to browser actions.
      const snap = isBrowser ? loadRecentBrowserSnapshot(config) : null;
      if (snap && snap.text) {
        preStateBlock = "\n" + render(P.sections["prestate-page"], {
          URL: snap.url || "unknown",
          PAGE_TEXT: snap.text,
        });
      } else {
        const none = isBrowser ? P.sections["prestate-none-browser"] : P.sections["prestate-none-mcp"];
        preStateBlock = "\n" + none;
      }
    } catch { /* optional */ }
  }
  // Pin rules are static per server; only the typed values vary per action.
  const browserPinStatic = isBrowser ? "\n" + P.sections["browser-pin-static"] + "\n" : "";

  // Include only guidance that can apply to this action's surface.
  const isMcpSurface = isBrowser || toolName.startsWith("mcp__");
  // Shell commands that reach an external system get the live_restore explanation.
  const isShellRemote = !isMcpSurface && REMOTE_SHELL_COMMAND.test(command);

  // Directive for a fast capture/confirm/write backup.
  const directive = render(P.sections["directive"], {
    TARGET_SOURCE: experienceBlock ? P.sections["directive-source-skill"] : P.sections["directive-source-strategy"],
    PIN_TARGET: isBrowser ? "" : "\n" + P.sections["directive-pin-target"],
  });

  // Action-category dispatch: send only the strategy relevant to this action,
  // plus a short fallback for other and read-only actions. Category G covers a shell
  // command whose target cannot be classified from its verbs (e.g. a project program).
  const CAT_A = P.sections["category-a"];
  const CAT_B = P.sections["category-b"];
  const CAT_C = P.sections["category-c"];
  const CAT_D = P.sections["category-d"];
  const CAT_F = P.sections["category-f"];
  const CAT_G = P.sections["category-g"];

  // Classify the action and pick one strategy block.
  const pickCategory = (): string => {
    if (isBrowser || toolName.startsWith("mcp__")) return CAT_F;
    if (/\b(pip3?|npm|yarn|pnpm|apt|apt-get|brew|conda|gem|cargo)\b[^\n]*\binstall\b/.test(command)) {
      return CAT_C;
    }
    const isCurlWrite = /\bcurl\b/.test(command) &&
      (/-X\s*(POST|PUT|DELETE|PATCH)/i.test(command) || /(--data|\s-d\s|\s-F\s)/.test(command));
    if (/\bgit\s+push\b/.test(command) || isCurlWrite) return CAT_B;
    if (/(^|\s)(export|unset|source)\s/.test(command)) return CAT_D;
    const isFileWrite = /^(Write|Edit|MultiEdit|patch|str_replace)$/i.test(toolName) ||
      /(>|>>|\btee\b|\bcp\b|\bmv\b|\bdd\b|\btruncate\b|install\s+-)/.test(command);
    if (isFileWrite) return CAT_A;
    // Any other command still writes somewhere (CAT_G); only non-shell tools get the bare fallback.
    if (command.trim()) return CAT_G;
    return "";
  };
  const picked = pickCategory();
  // When the runner cannot wire the action's MCP server, replace the remote-capture
  // guidance with an explicit no-MCP directive.
  const noMcpDirective = picked === CAT_F && opts.mcpAvailable === false
    ? "\n\n" + P.sections["no-mcp-directive"]
    : "";
  const categoryGuidance = render(P.sections["category-guidance"], {
    PICKED_BLOCK: picked ? `\n${picked}\n` : "",
    NO_MCP_DIRECTIVE: noMcpDirective,
    // The declaration path offers no read-only exit: an agent declared a backup is needed.
    JUDGED: P.sections["judged-gate"],
  });

  // Output format: MCP/browser actions get recovery_mcp_calls and live_restore;
  // remote shell commands get live_restore; local actions get neither.
  const shapeLine = isMcpSurface ? P.sections["shape-line-mcp"] : P.sections["shape-line-shell"];
  const recoveryCommandsBullet = isMcpSurface
    ? P.sections["recovery-commands-bullet-mcp"]
    : P.sections["recovery-commands-bullet-shell"];
  let liveRestoreBullet = "";
  if (isMcpSurface) {
    liveRestoreBullet = "\n" + P.sections["live-restore-bullet-mcp"];
  } else if (isShellRemote) {
    liveRestoreBullet = "\n" + P.sections["live-restore-bullet-shell-remote"];
  }

  // Prompt order follows cache order: static blocks first, per-server experience
  // next, and per-action context last. <STORAGE_DIR> is bound in the dynamic tail.
  return render(P.body, {
    DIRECTIVE: directive,
    BROWSER_PIN_STATIC: browserPinStatic,
    CATEGORY_GUIDANCE: categoryGuidance,
    EXPERIENCE_BLOCK: experienceBlock,
    SHAPE_LINE: shapeLine,
    RECOVERY_COMMANDS_BULLET: recoveryCommandsBullet,
    LIVE_RESTORE_BULLET: liveRestoreBullet,
    LEARNED_READONLY_BLOCK: learnedReadOnlyBlock,
    RECENT_INPUT_BLOCK: recentInputBlock,
    TOOL_NAME: toolName,
    ARGS: args,
    COMMAND: command,
    CHECKER_TARGETS_BLOCK: checkerTargetsBlock,
    PRE_STATE_BLOCK: preStateBlock,
    CWD: cwd,
    ACTION_DIR: actionDir,
  });
}

/** Validates and normalizes a candidate object into SubagentResponse, or returns null. */
function extractOurShape(candidate: unknown): SubagentResponse | null {
  if (typeof candidate !== "object" || candidate === null) return null;
  const c = candidate as Record<string, unknown>;
  // Valid when it has a description and at least one recovery channel:
  // recovery_commands, recovery_mcp_calls, or a no-op verdict.
  const hasRecoveryChannel = Array.isArray(c.recovery_commands) ||
    Array.isArray(c.recovery_mcp_calls) ||
    c.no_backup_needed === true;
  if (typeof c.description !== "string" || !hasRecoveryChannel) return null;

  // Keep only well-formed MCP calls: string `tool`, object `args`, optional string `server`.
  let recoveryMcpCalls: Array<{ server?: string; tool: string; args: Record<string, unknown> }> | undefined;
  if (Array.isArray(c.recovery_mcp_calls)) {
    const cleaned = (c.recovery_mcp_calls as unknown[])
      .filter(isWellFormedMcpCall)
      .map((e) => ({
        tool: String(e.tool),
        args: e.args as Record<string, unknown>,
        ...(typeof e.server === "string" ? { server: e.server } : {}),
      }));
    if (cleaned.length) recoveryMcpCalls = cleaned;
  }
  const stringList = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? (v as unknown[]).map(String) : undefined;
  return {
    description: String(c.description),
    backup_commands: stringList(c.backup_commands) ?? [],
    recovery_commands: stringList(c.recovery_commands) ?? [],
    artifact_paths: stringList(c.artifact_paths),
    live_restore: typeof c.live_restore === "boolean" ? c.live_restore : undefined,
    recovery_mcp_calls: recoveryMcpCalls,
    no_backup_needed: c.no_backup_needed === true,
    read_only_patterns: Array.isArray(c.read_only_patterns)
      ? normalizeReadOnlyPatterns(c.read_only_patterns as unknown[])
      : undefined,
  };
}

/** An MCP call with a string `tool` and a plain-object `args`. */
function isWellFormedMcpCall(e: unknown): e is Record<string, unknown> {
  if (typeof e !== "object" || e === null) return false;
  const call = e as Record<string, unknown>;
  return typeof call.tool === "string" &&
    typeof call.args === "object" && call.args !== null && !Array.isArray(call.args);
}

/** Read-only pattern entries as `{ pattern, reason? }`, dropping any without a non-empty string pattern. */
function normalizeReadOnlyPatterns(entries: unknown[]): Array<{ pattern: string; reason?: string }> {
  return entries
    .map((e) => {
      if (typeof e === "string") return { pattern: e };
      if (typeof e === "object" && e !== null) {
        const r = e as Record<string, unknown>;
        if (typeof r.pattern === "string") {
          return {
            pattern: r.pattern,
            ...(typeof r.reason === "string" ? { reason: r.reason } : {}),
          };
        }
      }
      return null;
    })
    .filter((e): e is { pattern: string; reason?: string } => e !== null && !!e.pattern.trim());
}

/** Marker file written when captured bytes exist but no artifact could be registered. */
export const UNREGISTERED_MARKER = "UNREGISTERED_CAPTURE.txt";

/** Narrow repair for over-escaped quotes (`\\"` where `\"` was meant) in a
 *  result file that failed strict parsing. Returns null when the sequence is absent. */
export function repairOverEscapedQuotes(raw: string): string | null {
  if (!raw.includes('\\\\"')) return null;
  return raw.split('\\\\"').join('\\"');
}

/** Reads the subagent's result: the canonical subagent_result.json strictly,
 *  then after the over-escape repair, then any other JSON file in the action
 *  dir with the expected shape. Returns null if none is valid. */
export function readSubagentResultFile(
  actionDir: string,
  onNote?: (msg: string) => void,
): SubagentResponse | null {
  const canonicalName = "subagent_result.json";
  const f = path.join(actionDir, canonicalName);

  let canonicalRaw: string | null = null;
  try {
    if (fs.existsSync(f)) canonicalRaw = fs.readFileSync(f, "utf-8");
  } catch {
    canonicalRaw = null;
  }

  if (canonicalRaw !== null) {
    // 1. Strict parse of the canonical file.
    try {
      const shaped = extractOurShape(JSON.parse(canonicalRaw));
      if (shaped) return shaped;
    } catch {
      // malformed: fall through to the repair, then the scan
    }

    // 2. Retry the canonical file after the over-escape repair.
    const repaired = repairOverEscapedQuotes(canonicalRaw);
    if (repaired !== null) {
      try {
        const shaped = extractOurShape(JSON.parse(repaired));
        if (shaped) {
          onNote?.(
            `${canonicalName} was malformed (\\\\" over-escape) — recovered by narrow repair`,
          );
          return shaped;
        }
      } catch {
        // fall through to the scan
      }
    }
  }

  // 3. Scan the action dir for any other JSON file with our shape.
  try {
    for (const name of fs.readdirSync(actionDir)) {
      if (!name.endsWith(".json") || name === "metadata.json") continue;
      if (name === canonicalName) continue;
      try {
        const shaped = extractOurShape(
          JSON.parse(fs.readFileSync(path.join(actionDir, name), "utf-8")),
        );
        if (shaped) {
          onNote?.(`result recovered from non-canonical file ${name}`);
          return shaped;
        }
      } catch { /* not our shape; keep scanning */ }
    }
  } catch { /* unreadable dir */ }

  return null;
}

/** Our own bookkeeping files; everything else in an action dir is captured state. */
const BOOKKEEPING_FILES = new Set([
  "metadata.json",
  "instruction.txt",
  "subagent_result.json",
  "subagent_watch.json",
  UNREGISTERED_MARKER,
]);

/** Bounded walk that reports captured files in `actionDir`, excluding bookkeeping
 *  and per-spawn forensic records. Returns null when nothing was captured. */
export function findCapturedArtifacts(
  actionDir: string,
): { files: number; bytes: number; sample: string[] } | null {
  let files = 0;
  let bytes = 0;
  const sample: string[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > 8 || files > 5000) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (depth === 0 && BOOKKEEPING_FILES.has(e.name)) continue;
      // Skip our per-spawn forensic records (response copy, run envelope, output dumps).
      if (depth === 0 &&
          /^subagent_[a-z0-9]{8}\.(?:json|run\.json|stdout\.txt|stderr\.txt)$/.test(e.name)) continue;
      // Skip the transcript and its missing-transcript marker as well.
      if (depth === 0 && TRANSCRIPT_FILE_RE.test(e.name)) continue;
      if (e.isDirectory()) {
        walk(path.join(dir, e.name), relPath, depth + 1);
      } else if (e.isFile()) {
        files++;
        try { bytes += fs.statSync(path.join(dir, e.name)).size; } catch { /* ignore */ }
        if (sample.length < 5) sample.push(relPath);
      }
      if (files > 5000) return;
    }
  };
  walk(actionDir, "", 0);
  return files > 0 ? { files, bytes, sample } : null;
}

/**
 * Copies a spawn's forensic records out of an action dir about to be deleted,
 * into `<sandbox>/subagent-transcripts/<action name>/`. Returns the number copied.
 */
export function preserveTranscripts(actionDir: string, sandboxRoot: string): number {
  let moved = 0;
  try {
    const names = fs.readdirSync(actionDir)
      .filter((n) =>
        /^subagent_[a-z0-9]{8}\.(?:json|run\.json|stdout\.txt|stderr\.txt)$/.test(n) ||
        // the transcript and its missing-transcript marker
        TRANSCRIPT_FILE_RE.test(n));
    if (names.length === 0) return 0;
    const dest = path.join(sandboxRoot, "subagent-transcripts", path.basename(actionDir));
    fs.mkdirSync(dest, { recursive: true });
    for (const n of names) {
      try {
        fs.copyFileSync(path.join(actionDir, n), path.join(dest, n));
        moved++;
      } catch { /* best-effort, per file */ }
    }
  } catch { /* best-effort */ }
  return moved;
}

/**
 * Reports captured bytes that could not be registered in metadata.json (and are
 * therefore invisible to restore) via a marker file, the debug log, and the terminal.
 * No-op when nothing was captured.
 */
export function reportUnregisteredCapture(
  actionDir: string,
  reason: string,
  logDebug: (msg: string) => void,
): void {
  let cap: ReturnType<typeof findCapturedArtifacts> = null;
  try { cap = findCapturedArtifacts(actionDir); } catch { /* best-effort */ }
  if (!cap) return;

  const mb = (cap.bytes / 1048576).toFixed(2);
  const summary =
    `${cap.files} file(s), ${mb} MB captured in ${actionDir} but NO artifact ` +
    `was registered (${reason}). restore reads metadata.json only, so this ` +
    `capture is INVISIBLE to \`backupper restore\`.`;

  logDebug(`UNREGISTERED CAPTURE: ${summary} sample=${cap.sample.join(", ")}`);
  try {
    fs.mkdirSync(actionDir, { recursive: true });
    fs.writeFileSync(
      path.join(actionDir, UNREGISTERED_MARKER),
      `BackUpper: UNREGISTERED CAPTURE\n` +
        `timestamp: ${new Date().toISOString()}\n` +
        `reason:    ${reason}\n` +
        `files:     ${cap.files}\n` +
        `bytes:     ${cap.bytes}\n` +
        `sample:    ${cap.sample.join("\n           ")}\n\n` +
        `The backup subagent captured the state above, but its result could\n` +
        `not be registered in metadata.json. \`backupper restore\` locates\n` +
        `artifacts through metadata.json ONLY, so it will NOT find these files.\n` +
        `They are still on disk at the path above and can be restored by hand.\n`,
      "utf-8",
    );
  } catch { /* best-effort */ }

  tellUser(
    `[BackUpper] WARNING — captured backup NOT registered: ${cap.files} file(s), ` +
      `${mb} MB are on disk in ${actionDir} but restore cannot see them (${reason}). ` +
      `Recover them by hand if the action needs undoing.`,
  );
}

function parseSubagentOutput(raw: string): SubagentResponse | null {
  // Parse the `claude -p --output-format json` wrapper and its `result` text;
  // otherwise fall back to the first matching {...} block in the raw output.

  // Try 1: parse raw as claude -p JSON wrapper
  try {
    const wrapper = JSON.parse(raw);
    if (wrapper && typeof wrapper === "object") {
      const result = (wrapper as Record<string, unknown>).result;
      if (typeof result === "string") {
        // Pick the balanced {...} block that has our shape.
        const inner = extractJsonObject(result, (o) => !!extractOurShape(o));
        if (inner) {
          const shaped = extractOurShape(inner);
          if (shaped) return shaped;
        }
      }
      // Agent wrappers of the form { payloads: [{ text }] }: join the texts and extract our block.
      const payloads = (wrapper as Record<string, unknown>).payloads;
      if (Array.isArray(payloads)) {
        const text = payloads
          .map((p) => (p && typeof p === "object" ? String((p as Record<string, unknown>).text ?? "") : ""))
          .join("\n");
        const found = extractJsonObject(text, (o) => !!extractOurShape(o));
        if (found) {
          const shaped = extractOurShape(found);
          if (shaped) return shaped;
        }
      }
      // The wrapper itself may have our shape.
      const direct = extractOurShape(wrapper);
      if (direct) return direct;
    }
  } catch {
    // not JSON at the top level; fall through
  }

  // Find any balanced {...} block in the raw text that has our shape.
  const found = extractJsonObject(raw, (o) => !!extractOurShape(o));
  if (found) {
    const shaped = extractOurShape(found);
    if (shaped) return shaped;
  }

  return null;
}

/** Verbs of an action whose MCP inverse can be derived from its own arguments. */
const CONSTRUCTIVE_VERB =
  /\b(create|insert|post|add|new|upload|submit|send|append|publish|register|generate)\b/;
/** Verbs of an action that destroys or overwrites existing state. */
const DESTRUCTIVE_VERB =
  /\b(delete|update|drop|truncate|alter|remove|purge|replace|merge|upsert|revoke|wipe|erase|clear)\b/;

/** Model label shown in progress messages for the given runner. */
function runnerModelLabel(runner: string, config: SandboxConfig): string {
  const model = subagentModelFor(config, runner as SubagentRunnerName);
  return model ? `${runner}/${model}` : runner;
}

/** A backup artifact, a "read_only" verdict (clean skip), or null (no or failed backup). */
export type SubagentOutcome = BackupArtifact | "read_only" | null;

/**
 * Runs the tier-4 backup subagent synchronously for an out-of-workspace action
 * and returns its outcome. Every exit records a forensic envelope in the action dir.
 */
export function runSubagentBackup(
  ctx: HookContext,
  actionDir: string,
  config: SandboxConfig,
  opts?: {
    toolAllow?: string[];
    /** Write targets identified by the read-only checker, rendered into the prompt. */
    checkerTargets?: string[];
  },
): SubagentOutcome {
  if (!config.subagentEnabled) return null;

  // Diagnostic trace written to subagent.log.
  const debugLogPath = path.join(storeRoot(config), "subagent.log");
  const logDebug = (msg: string): void => {
    try {
      fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
      fs.appendFileSync(debugLogPath, `[${new Date().toISOString()}] ${msg}\n`);
    } catch {
      // best-effort
    }
  };

  // Raw runner output, readable by the forensic closure from any exit.
  let stdout = "";
  let stderr = "";
  /** The invocation actually run (runner, env overrides, minted session id). */
  let spawnInvocation: ReturnType<typeof buildSubagentInvocation> = null;
  /** The runner's session id, latched as soon as it appears in the output. */
  let runnerSessionId: string | null = null;
  const noteSessionId = (text: string): void => {
    if (runnerSessionId || !text) return;
    const m = text.match(/"session_id"\s*:\s*"([^"]+)"/);
    if (m) runnerSessionId = m[1];
  };

  // Forensic record, written by one closure that every post-spawn exit calls:
  //   subagent_<id>.json              the parsed response, or a no-result stub
  //   subagent_<id>.run.json          the envelope: outcome, timing, runner, output sizes, error
  //   subagent_<id>.std{out,err}.txt  raw output, on every non-success exit
  const transcriptId = Math.random().toString(36).slice(2, 10);
  const transcriptFile = path.join(actionDir, `subagent_${transcriptId}.json`);
  let spawnStartedAt: number | null = null;
  let transcriptWritten = false;
  /** Cap on each raw-output dump. */
  const RAW_CAP = 256 * 1024;

  /** Reads the watcher's deadline marker, distinguishing a timeout from a malformed result. */
  const watchMark = (): { timedOut: boolean; timeoutMs?: number } => {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(actionDir, "subagent_watch.json"), "utf-8"));
      return { timedOut: m?.timedOut === true, timeoutMs: m?.timeoutMs };
    } catch {
      return { timedOut: false };
    }
  };

  const persistTranscript = (
    outcome: "success" | "read_only" | "unverified" | "unparseable" | "timed_out" | "spawn_failed" | "not_spawned",
    detail: {
      parsed?: SubagentResponse | null;
      parsedFrom?: "result_file" | "stdout" | null;
      error?: string;
      note?: string;
    } = {},
  ): void => {
    if (transcriptWritten) return;   // first exit wins
    transcriptWritten = true;
    try {
      fs.mkdirSync(actionDir, { recursive: true });
      const parsed = detail.parsed ?? null;
      // (a) The parsed response, or a no-result stub.
      fs.writeFileSync(
        transcriptFile,
        parsed
          ? JSON.stringify(parsed, null, 2)
          : JSON.stringify({
              no_parsed_result: true,
              outcome,
              reason: detail.note ?? detail.error ?? outcome,
              see: `subagent_${transcriptId}.run.json`,
            }, null, 2),
        "utf-8",
      );

      // (b) Raw output, on every non-success exit.
      const dumps: Record<string, { bytes: number; path: string | null; truncated: boolean }> = {};
      for (const [name, text] of [["stdout", stdout], ["stderr", stderr]] as const) {
        const bytes = Buffer.byteLength(text ?? "");
        let written: string | null = null;
        let truncated = false;
        if (outcome !== "success" && bytes > 0) {
          truncated = bytes > RAW_CAP;
          const file = `subagent_${transcriptId}.${name}.txt`;
          try {
            fs.writeFileSync(
              path.join(actionDir, file),
              truncated ? `${text.slice(0, RAW_CAP)}\n…[truncated at ${RAW_CAP} bytes of ${bytes}]\n` : text,
              "utf-8",
            );
            written = file;
          } catch { /* best-effort */ }
        }
        dumps[name] = { bytes, path: written, truncated };
      }

      // (b2) The step-by-step transcript, on every exit (see subagent_transcript.ts).
      const runner = (spawnInvocation?.runner ?? resolveRunner(config)) as string;
      const transcript: TranscriptCapture = captureTranscript({
        actionDir,
        id: transcriptId,
        outcome,
        locate: {
          runner,
          // Session id parsed from the runner's output.
          sessionId: runnerSessionId,
          since: spawnStartedAt,
          env: { ...subagentEnv(), ...(spawnInvocation?.env ?? {}) },
          cwd: process.cwd(),
          // Exclude the main agent's session, which lives in the same directory.
          exclude: [ctx.session_id, process.env.CLAUDE_CODE_SESSION_ID],
        },
      });

      // (c) The envelope; `producedNoOutput` separates "wrote nothing" from "record lost".
      let resultFilePresent = false;
      try {
        resultFilePresent = fs.statSync(path.join(actionDir, "subagent_result.json")).size > 0;
      } catch { /* no result file */ }
      fs.writeFileSync(
        path.join(actionDir, `subagent_${transcriptId}.run.json`),
        JSON.stringify({
          id: transcriptId,
          outcome,
          recordedAt: new Date().toISOString(),
          elapsedSec: spawnStartedAt === null
            ? null : Number(((Date.now() - spawnStartedAt) / 1000).toFixed(1)),
          spawned: spawnStartedAt !== null,
          runner: resolveRunner(config),
          model: subagentModelFor(config, resolveRunner(config)),
          toolName: ctx.tool_name,
          action: String(
            (ctx.tool_input as { command?: unknown }).command ??
            (ctx.tool_input as { sql?: unknown }).sql ??
            JSON.stringify(ctx.tool_input ?? {}),
          ).slice(0, 400),
          actionDir,
          parsedFrom: detail.parsedFrom ?? (detail.parsed ? "unknown" : null),
          resultFilePresent,
          producedNoOutput:
            spawnStartedAt !== null && dumps.stdout.bytes === 0 &&
            dumps.stderr.bytes === 0 && !resultFilePresent,
          error: detail.error ?? null,
          note: detail.note ?? null,
          watch: watchMark(),
          stdout: dumps.stdout,
          stderr: dumps.stderr,
          // Transcript capture details, including any elision.
          transcript,
        }, null, 2) + "\n",
        "utf-8",
      );
      logDebug(
        `transcript persisted: subagent_${transcriptId}.json (outcome=${outcome}, ` +
        `stdout=${dumps.stdout.bytes}B${dumps.stdout.path ? " saved" : ""}, ` +
        `stderr=${dumps.stderr.bytes}B${dumps.stderr.path ? " saved" : ""})`,
      );
      if (transcript.captured) {
        const elision = transcript.truncated
          ? `, TRUNCATED at ${transcript.capBytes}B — ${transcript.droppedBytes}B/` +
            `${transcript.droppedLines} lines elided from the middle`
          : "";
        logDebug(
          `step transcript [${transcript.runner}]: ${transcript.path} ` +
          `(${transcript.bytes}B of ${transcript.sourceBytes}B${elision}) ` +
          `<- ${transcript.source ?? "written in place"}`,
        );
      } else {
        const marker = transcript.marker ? ` (marker: ${transcript.marker})` : "";
        logDebug(`step transcript [${transcript.runner}]: NONE — ${transcript.reason}${marker}`);
      }
    } catch (e) {
      // Recording failures never fail the backup.
      try {
        logDebug(`transcript persist FAILED: ${e}`);
      } catch { /* nothing left to do */ }
    }
  };

  // Resolve the action's server first, so the prompt reflects whether this runner
  // can wire its MCP server.
  const server = serverFromToolName(ctx.tool_name);
  // Browser actions get no browser: the subagent writes the recovery from the
  // cached pre-mutation snapshot (PAGE_STATE). Other MCP servers remain available.
  const isBrowser = server === "playwright";
  const mcpAvailable = isBrowser || mcpAvailableFor(resolveRunner(config), config, server);

  let prompt = buildSubagentPrompt(ctx, actionDir, config, mcpAvailable, opts?.checkerTargets);
  if (config.personalizationCaptureScope) {
    prompt += "\n\nPERSONALIZATION SCOPE (overrides generic capture-all guidance):\n" +
      config.personalizationCaptureScope;
  }
  const timeoutMs = Math.max(10_000, config.subagentTimeoutSeconds * 1000);

  // Build the runner invocation (null when the CLI is missing). The subagent gets
  // the action's MCP server so it can read pre-state before the action runs.
  const invocation = buildSubagentInvocation(prompt, config, {
    withMcp: !isBrowser,
    isolateBrowserProfile: true,
    // Load only the server this action uses; none for a browser action.
    neededServer: isBrowser ? null : server,
    // Restrict the MCP tools to the capture-relevant ones; undefined leaves the server unfiltered.
    toolAllow: opts?.toolAllow,
    // Turn cap matching the prompt's call budget; enforced only by runners with a turn flag.
    maxTurns: 8,
  });
  spawnInvocation = invocation;
  if (!invocation) {
    const runner = resolveRunner(config);
    logDebug(`skipped: ${runner} CLI not found in PATH`);
    if (config.verbose) {
      process.stderr.write(`[BackUpper] subagent skipped: ${runner} CLI not found\n`);
    }
    persistTranscript("not_spawned", { note: `${runner} CLI not found in PATH — no subagent ran` });
    return null;
  }
  const { bin, args } = invocation;

  // Filter by containment so the (possibly prefixed) prompt is not logged.
  const loggedArgs = args.filter((a) => !a.includes(prompt)).join(" ");
  logDebug(
    `invoking: ${bin} [runner=${invocation.runner}] [prompt=${prompt.length} chars] ${loggedArgs} ` +
    `(timeout=${timeoutMs}ms)`,
  );

  // Progress message for the user.
  const cmdPreview = String(ctx.tool_input.command ?? "")
    || String(ctx.tool_input.path ?? ctx.tool_input.file_path ?? "");
  const modelLabel = runnerModelLabel(invocation.runner, config);
  tellUser(
    `[BackUpper] Out-of-workspace action detected. Invoking ${modelLabel} subagent to back up... ` +
    `(${ctx.tool_name}${cmdPreview ? `: ${cmdPreview.slice(0, 60)}` : ""})`
  );

  const startTime = Date.now();
  spawnStartedAt = startTime;   // from here on, the transcript describes a real spawn
  try {
    // Run through the watcher, which stops the subagent once a valid result file
    // exists and enforces the timeout.
    const run = runInvocation({ bin, args, env: invocation.env }, {
      timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      viaWatcher: { resultFile: path.join(actionDir, "subagent_result.json") },
    });
    if (!run.ok) throw Object.assign(run.error ?? new Error("subagent failed"), { stdout: run.stdout, stderr: run.stderr });
    stdout = run.stdout;
    noteSessionId(stdout);
    logDebug(`stdout (${stdout.length} chars): ${stdout.slice(0, 500)}`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const errWithOutput = e as { stdout?: string; stderr?: string };
    if (errWithOutput.stdout) stdout = String(errWithOutput.stdout);
    if (errWithOutput.stderr) stderr = String(errWithOutput.stderr);
    // Latch the session id before stdout may be cleared below.
    noteSessionId(stdout);
    logDebug(`FAILED: ${msg.slice(0, 500)}`);
    if (stderr) logDebug(`stderr: ${stderr.slice(0, 500)}`);
    if (stdout) logDebug(`partial stdout: ${stdout.slice(0, 500)}`);

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);

    // A watcher kill surfaces as a throw; if a valid result file exists, the backup
    // succeeded and is promoted.
    const killedButHasResult = readSubagentResultFile(actionDir, logDebug);
    if (killedButHasResult) {
      logDebug("subagent killed by watcher AFTER writing its result — proceeding to promote it");
      stdout = ""; // the result file is authoritative
    } else {
      // Detect a common authentication failure.
      if (stdout.includes("Not logged in") || stderr.includes("Not logged in")) {
        logDebug("DIAGNOSIS: claude CLI is not logged in. Run `claude` interactively once to authenticate.");
        tellUser(
          "[BackUpper] Subagent skipped: claude CLI not logged in. " +
          "Run `claude` interactively once to authenticate, or disable the subagent with " +
          "`backupper config set subagentEnabled false`."
        );
      } else {
        tellUser(`[BackUpper] Subagent failed after ${elapsedSec}s: ${msg.slice(0, 120)}`);
      }
      // Report any captured bytes that could not be registered.
      reportUnregisteredCapture(actionDir, `subagent failed: ${msg.slice(0, 80)}`, logDebug);
      // Record whether the watcher stopped the run on its deadline.
      const watch = watchMark();
      if (watch.timedOut) {
        logDebug(`watcher deadline mark present (${watch.timeoutMs}ms) — the run was stopped on its deadline`);
      }
      persistTranscript(watch.timedOut ? "timed_out" : "spawn_failed", {
        error: msg.slice(0, 2000),
        note: watch.timedOut
          ? "watcher stopped the subagent on its deadline; the subprocess then ended without a usable result file"
          : "subprocess ended without a usable result file",
      });
      return null;
    }
  } finally {
    // The spawn has ended (success, error or timeout): drop its temp configs.
    cleanupSubagentInvocation(invocation);
  }

  // Prefer the result file the subagent was told to write; fall back to parsing stdout.
  const fileResult = readSubagentResultFile(actionDir, logDebug);
  if (fileResult) logDebug("result read from subagent_result.json");
  const parsed = fileResult ?? parseSubagentOutput(stdout);
  if (!parsed) {
    // A deadline kill arrives here, since the watcher exits 0; distinguish it first.
    const timedOut = watchMark().timedOut;
    logDebug(
      `${timedOut ? "TIMED OUT" : "parse failed"} (no subagent_result.json, ` +
      `stdout unparseable). Raw stdout was: ${stdout.slice(0, 2000)}`,
    );

    // Detect tool-permission denial; the JSON wrapper always has a
    // "permission_denials" key, so require a non-empty list.
    const deniedPermissions = /"permission_denials"\s*:\s*\[\s*[^\]\s]/.test(stdout);
    if (deniedPermissions || stdout.includes("permission denied") ||
        stdout.includes("approval is needed") || stdout.includes("cannot proceed")) {
      logDebug("DIAGNOSIS: subagent was denied tool permissions despite bypass flag. " +
        "This usually means a stale `claude` CLI version — upgrade and retry.");
      tellUser(
        "[BackUpper] Subagent could not run backup commands (tool permission denied). " +
        "Upgrade the `claude` CLI (npm i -g @anthropic-ai/claude-code) or set " +
        "subagentPermissionMode=acceptEdits for filesystem-only backups."
      );
    } else if (timedOut) {
      logDebug(`DIAGNOSIS: the watcher killed the subagent on its ${timeoutMs}ms deadline — ` +
        "this is a TIMEOUT, not malformed output.");
      tellUser(
        `[BackUpper] Subagent hit its ${Math.round(timeoutMs / 1000)}s deadline and was stopped ` +
        "before it wrote a result — backup skipped.",
      );
    } else {
      tellUser("[BackUpper] Subagent returned unparseable output — backup skipped.");
    }
    // The capture may have succeeded even though the handoff was malformed; surface it.
    reportUnregisteredCapture(
      actionDir,
      "subagent result file malformed and stdout unparseable",
      logDebug,
    );
    // Record the failed handoff.
    persistTranscript(timedOut ? "timed_out" : "unparseable", {
      note: timedOut
        ? `watcher stopped the subagent on its ${timeoutMs}ms deadline before it wrote a result`
        : "no parseable subagent_result.json and stdout could not be parsed",
    });
    return null;
  }

  // Persist a result parsed from stdout to the canonical path.
  if (!fileResult) {
    try {
      fs.writeFileSync(path.join(actionDir, "subagent_result.json"), JSON.stringify(parsed));
      logDebug("saved parsed stdout JSON to subagent_result.json");
    } catch { /* best-effort */ }
  }

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
  logDebug(`parse success: ${parsed.description}`);

  // Read-only verdict: honored as a clean skip (no artifact, no warning) and
  // resolved before the UNVERIFIED check, since it has empty recovery arrays.
  // Tiers 1-3 still cover the workspace independently.
  if (parsed.no_backup_needed === true) {
    logDebug(`subagent verdict: read-only, no backup needed (${parsed.description.slice(0, 80)})`);

    // Record any read-only patterns the subagent supplied in the session's learned store.
    const readOnlyPatterns = parsed.read_only_patterns ?? [];
    if (config.learnedReadOnlyEnabled !== false && readOnlyPatterns.length && ctx.session_id) {
      try {
        const added = learnReadOnlyPatterns(
          storeRoot(config),
          ctx.session_id,
          {
            patterns: readOnlyPatterns,
            command: String(ctx.tool_input.command ?? ""),
            cwd: process.cwd(),
            reason: parsed.description,
            actionDir,
          },
        );
        if (added) {
          logDebug(
            `learned ${added} read-only pattern(s) from "${String(ctx.tool_input.command ?? "").slice(0, 80)}": ` +
            readOnlyPatterns.map((p) => p.pattern).join(" | "),
          );
        }
      } catch (e) {
        logDebug(`learned read-only store write failed: ${e}`);
      }
    }
    persistTranscript("read_only", { parsed, parsedFrom: fileResult ? "result_file" : "stdout" });
    return "read_only";
  }

  // Flag a backup as UNVERIFIED when the subagent says so (the needed pre-state
  // value was unavailable) or it produced no recovery at all.
  const descUpper = (parsed.description || "").trimStart().toUpperCase();
  // Structured recovery_mcp_calls count as recovery, so flag only when both forms are empty.
  const noRecovery = (parsed.recovery_commands ?? []).length === 0 &&
    (parsed.recovery_mcp_calls ?? []).length === 0;
  // Carried onto the artifact so the PreToolUse hook can surface it to the agent.
  const backupUnverified = descUpper.startsWith("UNVERIFIED") || noRecovery;
  if (backupUnverified) {
    logDebug(
      `[BackUpper] BACKUP UNVERIFIED: pre-state value not captured for ${ctx.tool_name} — ` +
      `${(parsed.description || "").slice(0, 120)}`,
    );
    tellUser(`[BackUpper] BACKUP UNVERIFIED: pre-state value not captured for ${ctx.tool_name}`);
  }

  // The result is recorded as-is; no rule-based verdict is applied to the backup.
  // durableArtifact is used only by the no-MCP distrust check below.
  const declaredPaths = (parsed.artifact_paths ?? [])
    .map((p) => (path.isAbsolute(p) ? p : path.join(actionDir, p)));
  const durableArtifact = declaredPaths.some((p) => {
    try {
      return fs.statSync(p).size > 0;
    } catch {
      return false;
    }
  });
  const modelLiveRestore = parsed.live_restore ?? false;
  // The subagent chooses the restore mechanism: false replays recovery_commands;
  // true spawns a fresh agent that re-reads live state.
  let liveRestore = modelLiveRestore;

  // No-MCP distrust: when the runner could not wire the action's MCP server, a
  // recovery for a destructive or mutating action cannot rest on real pre-state.
  // Force live_restore and mark it UNVERIFIED. MCP inverses of a constructive
  // action (derivable from its arguments) are exempt. The action verb is the tool
  // name's action segment plus the payload's leading keyword; a destructive word
  // anywhere in the payload vetoes the exemption.
  const input = ctx.tool_input as { command?: unknown; sql?: unknown; query?: unknown };
  const payload =
    `${String(input.command ?? "")} ${String(input.sql ?? "")} ${String(input.query ?? "")}`.toLowerCase();
  const toolSegment = (ctx.tool_name.split("__").pop() || "").toLowerCase().replace(/_/g, " ");
  const leadingVerb = payload.match(/[a-z]+/)?.[0] ?? ""; // first alpha token of the statement
  const actionVerb = `${toolSegment} ${leadingVerb}`;
  const isConstructive = CONSTRUCTIVE_VERB.test(actionVerb)
    && !DESTRUCTIVE_VERB.test(actionVerb) && !DESTRUCTIVE_VERB.test(payload);
  const trustworthyMcpCalls = isConstructive && (parsed.recovery_mcp_calls ?? []).length > 0;
  if (!mcpAvailable && ctx.tool_name.startsWith("mcp__") && !durableArtifact
      && !trustworthyMcpCalls) {
    logDebug(
      `no-MCP distrust: runner=${resolveRunner(config)} had no MCP for ` +
      `${server ?? "?"}, no durable artifact, prose-only recovery — forcing live_restore + UNVERIFIED.`,
    );
    liveRestore = true;
    if (!/^UNVERIFIED/i.test(parsed.description)) {
      parsed.description = `UNVERIFIED: no MCP access — ${parsed.description}`;
    }
    tellUser(
      "[BackUpper] Backup recorded WITHOUT MCP access (runner cannot load " +
      "the action's MCP server) — marked UNVERIFIED; restore will re-derive " +
      "against live state instead of trusting it.",
    );
  }

  // Persist the parsed subagent response alongside the artifact.
  const id = transcriptId;
  const artifactFile = transcriptFile;
  persistTranscript("success", { parsed, parsedFrom: fileResult ? "result_file" : "stdout" });

  // Report success to the user.
  tellUser(`[BackUpper] Subagent backup done in ${elapsedSec}s: ${parsed.description.slice(0, 100)}`);

  return {
    id,
    timestamp: new Date().toISOString(),
    trigger: "rule",
    toolName: ctx.tool_name,
    description: `Subagent backup: ${parsed.description}`,
    strategy: "subagent",
    artifactPath: artifactFile,
    subagentCommands: parsed.recovery_commands,
    recoveryMcpCalls: parsed.recovery_mcp_calls,
    liveRestore,
    unverified: backupUnverified || undefined,
    originalAction: describeToolAction(ctx.tool_name, ctx.tool_input),
  };
}

/**
 * Spawns a fresh subagent to perform a live restore (artifacts tagged
 * `liveRestore: true`). Returns { success, detail } with the result text or error.
 */
export function invokeRestoreSubagent(
  prompt: string,
  config: SandboxConfig,
  neededServer?: string | null,
): { success: boolean; detail: string } {
  // Optionally use a stronger model for restore via subagentRestoreModel.
  if (config.subagentRestoreModel) {
    config = {
      ...config,
      subagentModel: config.subagentRestoreModel,
    };
  }
  const timeoutMs = Math.max(10_000, config.subagentTimeoutSeconds * 1000);

  // Same runner selection as backup, with only the action's own MCP server loaded.
  const invocation = buildSubagentInvocation(prompt, config, { withMcp: true, neededServer });
  if (!invocation) {
    const runner = resolveRunner(config);
    return { success: false, detail: `${runner} CLI not found in PATH` };
  }
  const { bin, args } = invocation;

  const modelLabel = runnerModelLabel(invocation.runner, config);
  tellUser(
    `[BackUpper] Live-restore: invoking ${modelLabel} subagent to reverse remote/dynamic state...`,
  );

  try {
    const run = runInvocation({ bin, args, env: invocation.env }, { timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    if (!run.ok) return { success: false, detail: (run.error?.message ?? "").slice(0, 500) };
    // Show the wrapper's result text when present, else the raw stdout.
    return { success: true, detail: (unwrapResultText(run.stdout) ?? run.stdout).slice(0, 500) };
  } finally {
    cleanupSubagentInvocation(invocation);
  }
}

/**
 * Runs the configured runner on a text-only prompt and returns its text result,
 * or null on failure. Used by the read-only checker and personalization.
 */
export function runRunnerForText(
  prompt: string,
  config: SandboxConfig,
  timeoutSeconds = 180,
  opts?: {
    neededServer?: string | null; toolAllow?: string[];
    /** Read-only checker: ban every tool and wire no MCP. */
    noTools?: boolean;
    /** System prompt for a noTools spawn. */
    systemPrompt?: string;
  },
): string | null {
  // With a server, load that server's MCP tools; the checker options are passed through.
  let invocationOpts: Parameters<typeof buildSubagentInvocation>[2];
  if (opts?.neededServer) {
    invocationOpts = {
      neededServer: opts.neededServer,
      withMcp: true,
      toolAllow: opts.toolAllow,
      noTools: opts.noTools,
      systemPrompt: opts.systemPrompt,
    };
  } else if (opts?.noTools || opts?.systemPrompt) {
    invocationOpts = { noTools: opts.noTools, systemPrompt: opts.systemPrompt };
  }
  const invocation = buildSubagentInvocation(prompt, config, invocationOpts);
  if (!invocation) return null;
  const { bin, args } = invocation;
  try {
    const run = runInvocation({ bin, args, env: invocation.env }, {
      timeoutMs: Math.max(10_000, timeoutSeconds * 1000),
      maxBuffer: 8 * 1024 * 1024,
    });
    if (!run.ok) return null;
    // The wrapper's result text when present, else raw stdout.
    return unwrapResultText(run.stdout) ?? run.stdout;
  } finally {
    cleanupSubagentInvocation(invocation);
  }
}
