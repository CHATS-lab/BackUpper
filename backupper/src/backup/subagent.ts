/**
 * Tier-3 subagent backup via `claude -p` subprocess.
 *
 * When the hook detects an outside-workspace action that no targeted
 * manifest can cover, it shells out to Claude Code in headless mode
 * with a constrained prompt. The subagent runs synchronously, its
 * output is captured, parsed, and persisted to the action folder's
 * metadata.json as a `subagent` strategy artifact.
 *
 * Key safety properties:
 *   - CHATS_SANDBOX_NO_HOOK=1 is set in the subprocess environment,
 *     so the subagent's own tool calls won't re-trigger this hook
 *     (prevents infinite recursion).
 *   - Subprocess timeout is hard-limited via config.subagentTimeoutSeconds.
 *   - Any failure (claude CLI missing, timeout, parse error) falls back
 *     silently to just the tier-2 git snapshot.
 */

import { SUBAGENT_BACKUP as P, render } from "../prompts.generated.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
// js-yaml is LAZY-loaded (see loadYaml) — it's an external dep that may be
// absent in trimmed deployments (e.g. a benchmark container that ships only
// dist/). It's used solely by filteredHermesHome (hermes MCP filtering); the
// common backup path must never crash on a missing module at import time.
function loadYaml(): { load: (s: string) => unknown; dump: (o: unknown) => string } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("js-yaml");
  } catch {
    return null;
  }
}
import type { BackupArtifact, HookContext, SandboxConfig } from "../types.js";
import { describeToolAction } from "../types.js";
import { extractJsonObject } from "../util/extract_json.js";
import { serverFromToolName } from "../explore/experiences.js";
import { mcpAvailableFor, mcpConfigSource } from "./runner_caps.js";
import { learnReadOnlyPatterns } from "./learned_readonly.js";
import { captureTranscript, TRANSCRIPT_FILE_RE, type TranscriptCapture } from "./subagent_transcript.js";

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
  /** True when the canned recovery_commands can't be trusted later
   *  (remote/dynamic state) and restore should spawn a fresh subagent
   *  instead of replaying the commands. */
  live_restore?: boolean;
  /** live_restore=false ONLY: the exact MCP tool call(s) that reverse a
   *  remote/MCP action, to be replayed verbatim at restore via tools/call.
   *  Each is {tool, args} (+ optional server). Empty/absent for live_restore
   *  reversals (those use recovery_commands prose) and local shell reversals. */
  recovery_mcp_calls?: Array<{ server?: string; tool: string; args: Record<string, unknown> }>;
  /** True when the subagent inspected the upcoming action and determined
   *  it is READ-ONLY — it changes nothing outside the workspace, so no
   *  backup is needed. Honored as a clean skip (no artifact, no warning),
   *  NOT a failure. Safe because tiers 0–2 still cover the workspace
   *  independently; this only suppresses the generic tier-3 backup. */
  no_backup_needed?: boolean;
  /** READ-ONLY VERDICT ONLY. Patterns the subagent chose to record into
   *  the session's learned read-only store, so later matching invocations
   *  skip the spawn. The subagent has just read the program, so it decides
   *  what generalizes; the text is stored as written. Ignored entirely
   *  unless no_backup_needed is true. See backup/learned_readonly.ts. */
  read_only_patterns?: Array<{ pattern: string; reason?: string }>;
}

export function isCommandAvailable(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "pipe", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Environment for spawned subagent processes.
 *   - CHATS_SANDBOX_NO_HOOK=1: recursion guard — the subagent's own tool
 *     calls fire our hooks; this makes them exit early in the subprocess.
 *   - IS_SANDBOX=1 (root only): `claude --dangerously-skip-permissions`
 *     refuses to run as root unless this is set. Sandboxed containers —
 *     this tool's primary deployment — routinely run as root, and without
 *     it every tier-3 backup fails instantly.
 */
function subagentEnv(): NodeJS.ProcessEnv {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  return {
    ...process.env,
    CHATS_SANDBOX_NO_HOOK: "1",
    ...(isRoot ? { IS_SANDBOX: "1" } : {}),
    // Browser MCP servers (playwright via npx) cold-start slowly — give
    // claude time to connect before the subagent's first tool call,
    // otherwise it reports "MCP still connecting" and skips the reversal.
    MCP_TIMEOUT: process.env.MCP_TIMEOUT || "60000",
  };
}

/**
 * Build the subprocess invocation for the tier-3 subagent, branching on
 * config.subagentRunner.
 *
 *   claude   — `claude -p <prompt> --output-format json …` (Claude Code).
 *   hermes   — `hermes chat -q <prompt> -m <model> --provider <p> -Q --yolo`
 *              (Hermes deployments). The provider API key is read from
 *              the environment (OPENROUTER_API_KEY etc.) inherited from
 *              the parent process — never stored in config.
 *   openclaw — `openclaw agent --local --json --session-id <fresh> -m
 *              <prompt>` (OpenClaw deployments). Same env-key contract.
 *
 * Returns null when the configured runner's CLI isn't on PATH, so the
 * caller degrades gracefully (skip backup / report restore failure)
 * exactly as it did for the missing-claude case.
 */
export function buildSubagentInvocation(
  prompt: string,
  config: SandboxConfig,
  opts?: {
    withMcp?: boolean; isolateBrowserProfile?: boolean; neededServer?: string | null;
    maxTurns?: number; toolAllow?: string[];
    /** READ-ONLY CHECKER: ban every tool and wire no MCP. See
     *  backup/readonly_checker.ts -- the checker is this same invocation with
     *  nothing it can execute. */
    noTools?: boolean;
    /** The system prompt for a noTools spawn. Passed as --system-prompt on
     *  claude; prepended to the user prompt on runners that have no such flag. */
    systemPrompt?: string;
    /** openhands ONLY: absolute path the shipped python runner should dump its
     *  own event stream to. That runner has no session store to copy out of
     *  (see subagent_transcript.ts), so it writes the transcript itself. */
    transcriptFile?: string;
  },
): {
  bin: string; args: string[];
  runner: "claude" | "hermes" | "openclaw" | "codex" | "openhands";
  env?: Record<string, string>;
  /** The runner's own session id, when WE minted it (openclaw). Lets the
   *  transcript capture find that spawn's record by name instead of by
   *  newest-mtime guesswork. */
  sessionId?: string;
} | null {
  const runner = config.subagentRunner ?? "claude";

  // ── THE READ-ONLY CHECKER ARM (opts.noTools) ──────────────────────
  // This spawn must not be able to run ANYTHING. That is a safety property,
  // not a limitation: the backup subagent's most common failure is wandering
  // off and capturing an adjacent object it discovered itself, and a checker
  // with no tools cannot. Only `claude` can hard-ban tools by flag
  // (--disallowedTools returns "No such tool available"); for the others the
  // strongest available restriction is applied -- codex gets --sandbox
  // read-only, hermes gets an empty toolset list -- and the ban is also
  // stated in the prompt, which is where those runners' system prompt has to
  // go because they have no flag for one.
  const noTools = opts?.noTools === true;
  if (noTools && opts?.systemPrompt && runner !== "claude") {
    prompt = opts.systemPrompt + "\n\n" + prompt;
  }

  if (runner === "codex") {
    if (!isCommandAvailable("codex")) return null;
    // Headless one-shot turn. IMPORTANT: codex exec waits on stdin when
    // it's an open pipe ("Reading additional input from stdin…"), so
    // the spawn site passes input: "" to close it immediately.
    const args = [
      "exec",
      "--skip-git-repo-check",
      // codex has no flag that removes the shell tool, so the strongest
      // available guarantee for a checker spawn is that nothing it runs
      // can write. See opts.noTools.
      "--sandbox", noTools ? "read-only" : "danger-full-access",
    ];
    if (config.subagentCodexModel) {
      args.push("-m", config.subagentCodexModel);
    }
    args.push(prompt);
    return { bin: "codex", args, runner };
  }

  if (runner === "openhands") {
    // The SDK has no headless CLI — spawn the shipped runner script with an
    // interpreter that can import openhands.sdk. The prompt travels via a
    // temp file (heredoc-sized prompts are fragile as argv), MCP via a
    // filtered config file so a DB action doesn't boot the browser server.
    const py = config.subagentOpenhandsPython
      || process.env.CHATS_SANDBOX_OH_PY || "python3";
    if (!(py.includes("/") ? fs.existsSync(py) : isCommandAvailable(py))) return null;
    const model = config.subagentOpenhandsModel
      || (config.subagentHermesModel
        ? (config.subagentHermesModel.startsWith("openrouter/")
          ? config.subagentHermesModel : `openrouter/${config.subagentHermesModel}`)
        : "");
    if (!model) return null;
    const script = path.join(__dirname, "openhands_subagent_runner.py");
    const promptFile = path.join(os.tmpdir(), `chats-oh-sub-${process.pid}-${Date.now().toString(36)}.txt`);
    try { fs.writeFileSync(promptFile, prompt); } catch { return null; }
    const args = [script, promptFile, model];
    const mcpSrc = opts?.withMcp ? mcpConfigSource(config, opts?.neededServer) : null;
    if (mcpSrc && opts?.neededServer) {
      args.push(filteredClaudeMcpConfig(mcpSrc, opts.neededServer, !!opts.isolateBrowserProfile));
    } else if (mcpSrc) {
      args.push(opts?.isolateBrowserProfile ? isolatedMcpConfig(mcpSrc) : mcpSrc);
    }
    const env: Record<string, string> = {};
    // maxTurns means FULL AGENTIC TURNS (hermes semantics: one LLM call +
    // its whole tool loop). SDK max_iteration_per_run counts single event
    // steps — a 1:1 mapping cut the spawn off after ~2 LLM calls, before it
    // could query pre-state AND write the result file. Scale generously;
    // the result watcher still ends the run the moment the file appears.
    if (opts?.maxTurns) {
      env.CHATS_SANDBOX_OH_SUB_MAX_ITER = String(Math.max(12, opts.maxTurns * 4));
    }
    // No session store exists for this runner — the SDK Conversation lives and
    // dies in the python process. So the runner script dumps its OWN events to
    // this path (in its `finally`, which the SIGTERM->SystemExit handler keeps
    // reachable when the result watcher stops the spawn).
    if (opts?.transcriptFile) env.CHATS_SANDBOX_OH_SUB_TRANSCRIPT = opts.transcriptFile;
    return { bin: py, args, runner, env };
  }

  if (runner === "openclaw") {
    if (!isCommandAvailable("openclaw")) return null;
    // Headless one-shot turn on the embedded agent. A fresh session id
    // keeps the backup turn out of the user's conversation history.
    // The plugin's CHATS_SANDBOX_NO_HOOK guard (set via subagentEnv)
    // stops the subagent's own tool calls from re-entering our hooks.
    // Minted HERE and returned to the caller: it is both the "keep this out of
    // the user's history" fresh id and the handle the transcript capture uses
    // to identify this spawn's record under the openclaw home.
    const sessionId = `chats-sandbox-${Date.now().toString(36)}`;
    const args = [
      "agent", "--local", "--json",
      "--session-id", sessionId,
      "-m", prompt,
    ];
    // COST: a named lean agent (agents.list entry with a minimal
    // systemPromptOverride + tool-group denies) cuts OpenClaw's fixed
    // prefix from ~17.4k to ~5.8k per call (-67%). The entry must exist
    // in the OpenClaw config — the bench provisions "backup" per run.
    if (config.subagentOpenclawAgent) {
      args.push("--agent", config.subagentOpenclawAgent);
    }
    if (config.subagentOpenclawModel) {
      args.push("--model", config.subagentOpenclawModel);
    }
    return { bin: "openclaw", args, runner, sessionId };
  }

  if (runner === "hermes") {
    if (!isCommandAvailable("hermes")) return null;
    const model = config.subagentHermesModel || "anthropic/claude-haiku-4.5";
    const provider = config.subagentHermesProvider || "openrouter";
    // Dynamic MCP loading: for an MCP/browser action, hand hermes a HOME
    // whose config loads ONLY that action's server (skip booting chromium
    // for a DB action, etc.). null/undefined server → keep the global config.
    let env: Record<string, string> | undefined;
    if (opts?.neededServer) {
      const home = filteredHermesHome(opts.neededServer, opts.isolateBrowserProfile, opts.toolAllow);
      // Point hermes at the filtered home via BOTH HOME and HERMES_HOME. hermes
      // resolves its config dir as getenv("HERMES_HOME", ~/.hermes) — it checks
      // HERMES_HOME FIRST, so relying on HOME alone is unreliable (an inherited
      // HERMES_HOME, or a hermes launcher that resets HOME, sends it back to the
      // GLOBAL config — which still pins the agent's live /tmp browser profile,
      // causing the subagent's playwright to collide on the locked profile).
      if (home) env = { HOME: home, HERMES_HOME: path.join(home, ".hermes") };
    }
    // Route THIS subagent at its own provider, the way the claude runner below
    // already can. Without it the spawn inherits the MAIN agent's
    // OPENROUTER_BASE_URL/OPENROUTER_API_KEY -- which on the hermes lane point at
    // whatever upstream the main model needs (Together for deepseek, Google for
    // gemini, or the per-run relay sidecar). Asking those for a tier-3 model they
    // do not serve fails, and the checker is fail-open: the spawn still happens,
    // so the symptom is a log full of `invoking:` with zero captures rather than
    // an error. All three must be present; a partial set is ignored rather than
    // half-applied, because a base URL without a key fails as an opaque auth
    // error at run time.
    const sgBase = process.env.CHATS_SANDBOX_SUBAGENT_BASE_URL;
    const sgToken = process.env.CHATS_SANDBOX_SUBAGENT_AUTH_TOKEN;
    if (sgBase && sgToken) {
      env = { ...env, OPENROUTER_BASE_URL: sgBase, OPENROUTER_API_KEY: sgToken };
    }
    // Lean toolset: a backup subagent only needs to run shell/file commands
    // (and the action's MCP for remote backups). Restricting to these strips
    // the skills catalog + persistent-memory boilerplate from hermes's system
    // prompt — ~2.3k tokens of dead weight per call. The main agent already
    // does this; the subagent now matches.
    // A checker spawn gets NO toolsets at all -- not terminal, not file.
    const toolsets = noTools ? "" : ("terminal,file" + (opts?.neededServer ? `,mcp-${opts.neededServer}` : ""));
    return {
      bin: "hermes",
      runner,
      env,
      // -Q quiet (programmatic), --yolo skip approval prompts so the
      // headless subagent can run git/bash without blocking. --max-turns
      // hard-bounds the loop (strict pass passes a tight 6; the default 90
      // let qwen burn ~80s "still thinking").
      args: ["chat", "--toolsets", toolsets, "-q", prompt, "-m", model, "--provider", provider, "-Q", "--yolo", "--max-turns", String(opts?.maxTurns ?? 15)],
    };
  }

  // Default: claude -p
  if (!isCommandAvailable("claude")) return null;
  const permissionMode = config.subagentPermissionMode ?? "bypassPermissions";
  const args = [
    "-p", prompt,
    "--output-format", "json",
    // Bench knob: CHATS_SANDBOX_PERSIST_SUBAGENT_SESSIONS=1 keeps the
    // subagent's session transcript — the tok_sub accounting source; safe
    // only under a per-run HOME. Default: suppressed, so real installs
    // never pollute the user's /resume picker with tier-3 spawns.
    ...(process.env.CHATS_SANDBOX_PERSIST_SUBAGENT_SESSIONS === "1"
      ? [] : ["--no-session-persistence"]),
    "--setting-sources", "user",
  ];
  // COST: replace Claude Code's default system prompt (its generic coding
  // identity, ~6-7k tokens re-sent EVERY call) with a purpose-built backup
  // one, and deny the native tools a backup/restore spawn never needs
  // (~4-5k more). Measured on 2.1.211: 24.5k -> 13.6k fixed prefix per
  // call (-45%). The full task contract lives in the USER prompt, so no
  // behavior is lost. Opt out with CHATS_SANDBOX_CLAUDE_FULL_PROMPT=1.
  const IRRELEVANT_NATIVE_TOOLS = [
    "WebSearch", "WebFetch", "Task", "NotebookEdit", "TodoWrite",
    "EnterPlanMode", "ExitPlanMode", "KillShell", "Skill",
  ];
  const deniedTools: string[] = [];
    // ── CHECKER SPAWN: our system prompt, and every tool denied ───────
  // --disallowedTools HARD-BLOCKS a call (verbatim "No such tool available")
  // rather than merely leaving it unpermitted, so this is a ban and not a
  // prompt the model can talk its way past. Listed explicitly rather than
  // derived: a tool added by a future CLI version should show up as a name
  // missing from this list, not be silently allowed by a clever complement.
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
    // build-specific surfaces seen on some CLI builds. THIS IS A DENYLIST:
    // it must be re-checked when the CLI is upgraded. Probe with
    // `claude -p "list your tools" --disallowedTools <this list>` and add
    // whatever comes back.
    "EnterWorktree", "ExitWorktree", "Workflow", "ReportFindings",
    "ScheduleWakeup", "CronCreate", "CronDelete", "CronList",
    "TaskCreate", "TaskGet", "TaskList", "TaskUpdate",
  ];
  if (noTools) {
    if (opts?.systemPrompt) args.push("--system-prompt", opts.systemPrompt);
    // --strict-mcp-config with NO --mcp-config = zero MCP servers. Measured:
    // without it the spawn still inherited the host's user-level MCP config
    // (a code-search server showed up in a live probe). --disallowedTools
    // cannot cover that, because we do not know those servers' tool names.
    args.push("--strict-mcp-config");
    deniedTools.push(...BANNED_FOR_CHECKER);
  } else if (process.env.CHATS_SANDBOX_CLAUDE_FULL_PROMPT !== "1") {
    args.push("--system-prompt",
      P.sections["system-prompt"]);
    deniedTools.push(...IRRELEVANT_NATIVE_TOOLS);
  }
  if (permissionMode === "bypassPermissions") {
    args.push("--dangerously-skip-permissions");
  } else {
    args.push("--permission-mode", permissionMode);
  }
  if (config.subagentModel && config.subagentModel !== "inherit") {
    args.push("--model", config.subagentModel);
  }
  // Hand the subagent the same MCP tools the agent used (e.g. a postgres
  // server, or a playwright browser) so it can READ pre-state at backup
  // time and REVERSE state at restore time through the real interface —
  // no privileged DB backdoor assumed. At BACKUP time the agent's browser
  // is still live, so a shared browser profile would collide on the
  // single-instance lock; isolateBrowserProfile gives the subagent its own
  // (auth-seeded) copy. Non-browser MCP servers have no such collision.
  // Config SOURCE comes from runner_caps.mcpConfigSource: the explicit
  // subagentMcpConfig knob, else the workspace's own .mcp.json — so a
  // claude-code user gets MCP-wired backups out of the box (the knob is
  // unset in DEFAULT_CONFIG, which used to leave subagents silently MCP-less).
  // A checker spawn never gets an MCP server, whatever the caller asked for:
  // an MCP tool is still a tool, and several of them write.
  const mcpSource = (opts?.withMcp && !noTools) ? mcpConfigSource(config, opts?.neededServer) : null;
  if (mcpSource) {
    if (opts?.neededServer) {
      // Dynamic MCP loading: only this action's server, and ignore every
      // other MCP source (--strict-mcp-config).
      args.push("--mcp-config",
        filteredClaudeMcpConfig(mcpSource, opts.neededServer, !!opts.isolateBrowserProfile));
      args.push("--strict-mcp-config");
      // Tool narrowing to the learned capture_tools, as the COMPLEMENT of the
      // server's registered tool list: --disallowedTools hard-blocks a call
      // (verbatim "No such tool available", verified live on 2.1.199) and
      // removes the tool from ToolSearch discovery. This is the claude analog
      // of hermes' tools.include — permission narrowing, not token savings
      // (schemas are ToolSearch-deferred in this claude version regardless).
      // No registry entry for the server → skip narrowing (never guess a
      // complement; an over-broad deny list could block the capture itself).
      if (opts.toolAllow && opts.toolAllow.length) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { loadToolRegistry } = require("../explore/tool_registry.js");
          const serverTools: string[] = (loadToolRegistry(config)[opts.neededServer] ?? []);
          // Compare case-insensitively, but EMIT the registry's own casing —
          // a lowercased name would not match a camelCase tool and the deny
          // would silently fail open.
          const bare = (t: string) => (t.split("__").pop() || t);
          const allowed = new Set(opts.toolAllow.map((t) => bare(t).toLowerCase()));
          const denied = serverTools
            .filter((t) => !allowed.has(bare(t).toLowerCase()))
            .map((t) => `mcp__${opts.neededServer}__${bare(t)}`);
          // merged with the native-tool denies into ONE flag at the end
          deniedTools.push(...denied);
        } catch { /* registry unavailable → unfiltered server, the safe default */ }
      }
    } else {
      args.push("--mcp-config",
        opts?.isolateBrowserProfile ? isolatedMcpConfig(mcpSource) : mcpSource);
    }
  }
  // NOTE claude 2.1.199 has no --max-turns flag; the result watcher + timeout
  // bound the run instead (runner_caps.maxTurns=false).
  if (mcpSource && opts?.neededServer) {
    // This claude version DEFERS MCP tool schemas behind ToolSearch: a direct
    // call before loading fails with "No such tool available". One static
    // preamble line teaches the subagent to load the server's tools first.
    args[1] = `Before your first MCP call: load the "${opts.neededServer}" server's tools with ToolSearch (query "${opts.neededServer}").\n\n` + args[1];
  }
  // ONE --disallowedTools flag: repeated flags are last-wins on some CLI
  // versions, which would silently drop the MCP narrowing or the native
  // denies — merge both lists.
  if (deniedTools.length) args.push("--disallowedTools", deniedTools.join(","));
  // Optional: route THIS subagent (and only this subagent) at a third-party model
  // through an Anthropic-compatible gateway, while the MAIN agent keeps whatever
  // auth it already has — a Claude subscription, typically. The spawn sites merge
  // `{ ...subagentEnv(), ...invocation.env }`, so anything set here is scoped to
  // the child process and never touches the parent's environment.
  //
  //   CHATS_SANDBOX_SUBAGENT_BASE_URL=https://openrouter.ai/api   (NOT /api/v1 —
  //       claude appends /v1/messages itself; /api/v1 yields 400s)
  //   CHATS_SANDBOX_SUBAGENT_AUTH_TOKEN=<gateway key>
  //   CHATS_SANDBOX_SUBAGENT_MODEL_ID=deepseek/deepseek-v4-flash-0731
  //
  // All three must be present; a partial set is ignored rather than half-applied,
  // because a base URL without a token fails as an opaque auth error at run time.
  const gwBase = process.env.CHATS_SANDBOX_SUBAGENT_BASE_URL;
  const gwToken = process.env.CHATS_SANDBOX_SUBAGENT_AUTH_TOKEN;
  const gwModel = process.env.CHATS_SANDBOX_SUBAGENT_MODEL_ID;
  if (gwBase && gwToken && gwModel) {
    const gwEnv: Record<string, string> = {
      ANTHROPIC_BASE_URL: gwBase,
      ANTHROPIC_AUTH_TOKEN: gwToken,
      // Must be an EXPLICIT empty string: a real key left in the environment
      // wins over the token and surfaces as a bogus "model not found".
      ANTHROPIC_API_KEY: "",
      // config.subagentModel is a TIER name (haiku/sonnet/opus) and that is what
      // the --model arg above carries; map every tier to the gateway model so
      // whichever tier is configured lands in the same place.
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
 * Produce a temp MCP-config whose browser server (if any) uses its OWN
 * `--user-data-dir` — a copy of the agent's profile, so it inherits the
 * logged-in session but holds a SEPARATE lock. This lets the backup
 * subagent open a browser to read pre-action state while the agent's
 * browser is still live. Non-browser servers pass through unchanged.
 * Best-effort: on any failure, returns the original config path.
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
        const copy = path.join(os.tmpdir(), `chats-sub-profile-${process.pid}-${name}`);
        try { fs.rmSync(copy, { recursive: true, force: true }); } catch { /* ignore */ }
        // Copy the LIVE profile. This frequently throws partway because the
        // agent's browser is mutating files under it — that's fine, the login
        // cookies land early; we just must not let the throw skip the lock
        // strip below (the bug that left SingletonLock in the copy and made
        // the subagent's browser report "locked by parent").
        // Copy the profile with a FAULT-TOLERANT shell `cp`, not fs.cpSync:
        // the agent's browser is actively writing the LIVE profile, and
        // cpSync THROWS on the first busy/locked file, leaving NO copy at all
        // (the bug: subagent then gets a broken profile → "locked by parent").
        // `cp` logs per-file errors but keeps going, so the auth files
        // (Cookies, Local Storage) still land. Errors are swallowed (|| true).
        try {
          if (fs.existsSync(orig)) {
            const { execSync } = require("node:child_process");
            fs.mkdirSync(copy, { recursive: true });
            execSync(`cp -a -- '${orig.replace(/'/g, "'\\''")}/.' '${copy.replace(/'/g, "'\\''")}/' 2>/dev/null || true`,
              { timeout: 60_000 });
          }
        } catch { /* partial copy is acceptable — login cookies land early */ }
        // Belt-and-suspenders strip of any Singleton* that slipped through.
        // MUST use unlinkSync, NOT rmSync: rmSync follows the symlink to its
        // (dangling, hostname-pid) target and no-ops, leaving the link behind.
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
    const out = path.join(os.tmpdir(), `chats-sub-mcp-${process.pid}.json`);
    fs.writeFileSync(out, JSON.stringify(raw));
    return out;
  } catch {
    return mcpPath;
  }
}

/**
 * Dynamic MCP loading (claude runner): write a `--mcp-config` containing
 * ONLY the server this action uses, so a postgres action doesn't boot the
 * browser MCP (and vice-versa). Combine with `isolatedMcpConfig` when the
 * kept server is a browser. Returns the temp config path (falls back to the
 * original on any error).
 */
function filteredClaudeMcpConfig(mcpPath: string, neededServer: string, isolateBrowser: boolean): string {
  try {
    const raw = JSON.parse(fs.readFileSync(mcpPath, "utf-8")) as { mcpServers?: Record<string, unknown> };
    const all = raw.mcpServers ?? {};
    const kept: Record<string, unknown> = {};
    if (all[neededServer]) kept[neededServer] = all[neededServer];
    const outPath = path.join(os.tmpdir(), `chats-sub-filtered-${process.pid}.json`);
    fs.writeFileSync(outPath, JSON.stringify({ mcpServers: kept }));
    return isolateBrowser ? isolatedMcpConfig(outPath) : outPath;
  } catch {
    return mcpPath;
  }
}

/**
 * Dynamic MCP loading (hermes runner): hermes always reads
 * `$HOME/.hermes/config.yaml` and has no per-call MCP flag, so give the
 * subagent its OWN HOME — a copy of the user's `.hermes` (auth/sessions
 * preserved) whose `mcp_servers` is filtered to ONLY the needed server.
 * Returns the temp HOME dir, or null to keep the global config.
 */
function filteredHermesHome(neededServer: string, isolateBrowserProfile?: boolean, toolAllow?: string[]): string | null {
  try {
    // HERMES_HOME first: hermes itself prefers it, and per-run harnesses
    // relocate homes through it. Falling back to $HOME alone would clone the
    // GLOBAL config while restore.ts replays against the per-run one —
    // a silent split-brain (audit finding F1).
    const srcHomeDir = process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
    const srcCfg = path.join(srcHomeDir, "config.yaml");
    if (!fs.existsSync(srcCfg)) return null;
    // The home name keys on process.pid and is pre-wiped below. Each tool-call
    // hook is a fresh short-lived process, so on a multi-backup run the OS can
    // reuse a pid and this pre-wipe would delete a PRIOR backup's home (its
    // session log + request dumps) before anything reads it. For benchmark
    // forensics (CHATS_KEEP_SUBAGENT_HOME=1) give every call a UNIQUE home and
    // never pre-wipe, so prior backups' artifacts survive for capture. Default
    // behavior is unchanged (pid-named + pre-wiped).
    const _keepHome = process.env.CHATS_KEEP_SUBAGENT_HOME === "1";
    const _suffix = _keepHome
      ? `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      : String(process.pid);
    const tmpHome = path.join(os.tmpdir(), `chats-sub-home-${_suffix}`);
    if (!_keepHome) fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.cpSync(srcHomeDir, path.join(tmpHome, ".hermes"), { recursive: true });
    const yaml = loadYaml();
    if (!yaml) return null; // no js-yaml → skip MCP filtering, use global config
    const cfg = (yaml.load(fs.readFileSync(srcCfg, "utf-8")) ?? {}) as { mcp_servers?: Record<string, unknown> };
    const all = cfg.mcp_servers ?? {};
    cfg.mcp_servers = all[neededServer] ? { [neededServer]: all[neededServer] } : {};

    // Action-aware tool allowlist: register ONLY the tools the CALLER passed
    // (via hermes' `mcp_servers.<name>.tools.include`), cutting the per-call
    // tool-schema cost without losing coverage. Uses raw (unprefixed) MCP tool
    // names. There is NO hardcoded per-server tool map: a caller that passes no
    // `toolAllow` (the backup path, restore) leaves the server UNFILTERED — its
    // own tools, the safe default. The only current caller that narrows is
    // self-exploration's verify, which derives the set from the server's OWN
    // live tools (not a curated guess), so this stays fully server-general.
    const allow = toolAllow;
    const kept0 = cfg.mcp_servers[neededServer];
    if (allow && kept0 && typeof kept0 === "object" && !Array.isArray(kept0)) {
      const srv = kept0 as Record<string, unknown>;
      const existing = (srv.tools && typeof srv.tools === "object") ? srv.tools as Record<string, unknown> : {};
      srv.tools = { ...existing, include: allow };
    }

    // Shared-live-browser design (replaces the old profile-copy isolation):
    // the playwright server now runs in HTTP mode and the kept config carries
    // a `url:` entry, NOT a stdio `command`/`--user-data-dir`. The subagent
    // connects to the SAME shared browser the main agent uses, so there is no
    // profile to copy and no single-instance lock to strip — it reads the TRUE
    // live pre-state (the main is paused on the exact pre-mutation page) and
    // works in its OWN tab. `isolateBrowserProfile` is therefore a no-op for a
    // url server; we keep the parameter only for the (legacy) stdio path and
    // the Claude-runner equivalent. If a kept server still has a stdio
    // `--user-data-dir` (no url), we deliberately do NOT copy it: with the
    // shared server the copy was the source of lock/symlink/stale-snapshot
    // bugs the new design eliminates.
    void isolateBrowserProfile;
    fs.writeFileSync(path.join(tmpHome, ".hermes", "config.yaml"), yaml.dump(cfg));
    return tmpHome;
  } catch {
    return null;
  }
}

/**
 * Write a status message directly to the user's controlling terminal.
 *
 * Claude Code captures hook stderr silently (it doesn't display in the
 * user's terminal), so this is the only way to show real-time progress.
 * /dev/tty bypasses stderr/stdout entirely and writes to whichever
 * terminal the user is sitting at.
 *
 * Falls back silently if /dev/tty is not writable (Windows, headless,
 * piped contexts).
 */
function tellUser(message: string): void {
  try {
    fs.writeFileSync("/dev/tty", `${message}\n`);
  } catch {
    // /dev/tty not available — fall back to stderr (visible in some setups)
    try {
      process.stderr.write(`${message}\n`);
    } catch {
      // give up
    }
  }
}

/** The tier-3 subagent prompt = the "subagent"-mode shared backup guidance. */
function buildSubagentPrompt(
  ctx: HookContext,
  actionDir: string,
  config?: SandboxConfig,
  mcpAvailable?: boolean,
  checkerTargets?: string[],
): string {
  return buildBackupGuidance({
    checkerTargets,
    mode: "subagent",
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
  mode: "subagent" | "inline";
  toolName?: string;
  command?: string;
  args?: string;
  cwd?: string;
  actionDir?: string;
  config?: SandboxConfig;
  /** Override the resolved MCP server (e.g. "playwright" for the inline reddit lane). */
  server?: string | null;
  /** Explicit experience to inject (else derived from the server). */
  experienceName?: string;
  /** Whether the subagent will actually HAVE the action's MCP server
   *  (runner_caps.mcpAvailableFor). false → the remote-capture guidance is
   *  replaced with an explicit no-MCP directive so the subagent is told not
   *  to fabricate reads it cannot perform. undefined → assume available
   *  (browser actions, inline mode, legacy callers). */
  mcpAvailable?: boolean;
  /** What the READ-ONLY CHECKER established this call actually writes, when it
   *  ran (backup/readonly_checker.ts). NOT decoration: this subagent's single
   *  largest failure mode is capturing an ADJACENT object -- a workspace
   *  snapshot of /srv/qa/suite while `--clean` emptied /srv/qa/allure-report --
   *  and the checker has already read the program that settles which is which.
   *  Advisory, never exhaustive: the subagent still captures anything else the
   *  action reaches. */
  checkerTargets?: string[];
}

/** SHARED backup knowledge for BOTH the tier-3 subagent and the inline-backup
 *  baseline, so the two can never drift. `mode` only changes the wrapper — the
 *  header, the "you're blocking / call budget" line, and the result handoff. The
 *  PIN rule, browser directive, experiences, and category strategies are
 *  identical across modes. */
export function buildBackupGuidance(opts: BackupGuidanceOpts): string {
  // Only ask for learned read-only patterns when the store is actually on.
  // A prompt that requests a field we then discard just spends tokens and
  // invites the subagent to reason about a mechanism that is not running.
  const learnedReadOnlyBlock = opts.config?.learnedReadOnlyEnabled === true
    ? "\n" + P.sections["learned-readonly-block"]
    : "";
  // ── WHAT THE READ-ONLY CHECKER SAID THIS CALL WRITES ──────────────
  // Established BEFORE this spawn, by a model that had the program's source
  // in front of it (backup/readonly_checker.ts). Handing the list over is the
  // whole reason it is collected: the recorded failure mode is capturing an
  // ADJACENT object -- a workspace snapshot of /srv/qa/suite while `--clean`
  // emptied /srv/qa/allure-report. Advisory, not exhaustive.
  const _checkerTargets = Array.isArray(opts.checkerTargets) ? opts.checkerTargets : [];
  const checkerTargetsBlock = _checkerTargets.length
    ? "\n" + render(P.sections["checker-targets-block"], { TARGET_LINES: _checkerTargets.map((t) => `  - ${t}`).join("\n") }) + "\n"
    : "";
  const { mode, config } = opts;
  const toolName = opts.toolName ?? "";
  const command = opts.command ?? "";
  const args = opts.args ?? "";
  const cwd = opts.cwd ?? process.cwd();
  const actionDir = opts.actionDir ?? "<backup-storage-dir>";

  // Resolve the action's MCP server via the listed tool registry (membership
  // — robust to bare names), falling back to name-parsing. Used both to pick
  // the experience and to give browser actions a content-pinning directive.
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

  // Inject the learned backup SKILL for this MCP server (from
  // `chats-sandbox explore`). Prefer-cheap-reversal guidance.
  // ABLATION KNOB: CHATS_SANDBOX_NO_EXP_INJECT=1 suppresses ONLY this prompt
  // block. Everything else the experience file drives — the gate's learned
  // triggers, deterministic reverters, capture_tools tool-narrowing — stays
  // active, so an ablation can isolate the value of the injected knowledge
  // itself (arms differ in the subagent prompt and nothing else).
  let experienceBlock = "";
  if (config && process.env.CHATS_SANDBOX_NO_EXP_INJECT !== "1") {
    try {
      const { loadExperiences, renderExperiencesForPrompt, serverToExperienceMap } =
        require("../explore/experiences.js");
      // server → experience. Dedicated MCPs match by name (postgres →
      // postgres); a browser-driven site differs, bridged by the experience's
      // appliesTo (reddit.appliesTo=["playwright"]) or experienceForServer.
      const map = serverToExperienceMap(config);
      const expName = opts.experienceName || (server && (config.experienceForServer?.[server] || map[server])) || server;
      if (expName) {
        experienceBlock = renderExperiencesForPrompt(loadExperiences(config, expName));
      }
    } catch { /* experiences optional */ }
  }

  // Browser (playwright) actions create entities with NO id at backup time,
  // so the recovery must PIN BY CONTENT. Read the form/page and capture the
  // identifying text verbatim — the exact TITLE for a post/submission, the
  // FULL text for a comment — so restore targets that one entity, not "the
  // most recent". This is the targeted version of the generic PIN-THE-TARGET
  // rule, and the fix for create-via-browser deleting the wrong post.
  // The values the agent just typed (title/body) — captured by the hook from
  // the earlier fill/type actions, so the subagent doesn't have to re-derive
  // the title from a live browser snapshot.
  let recentInputBlock = "";
  if (isBrowser && config) {
    try {
      const { loadRecentBrowserInput } = require("./strategies.js");
      const recent: string[] = loadRecentBrowserInput(config);
      if (recent.length) {
        recentInputBlock = "\n" + render(P.sections["recent-input-block"], { VALUES: recent.map((v) => JSON.stringify(v)).join(" , ") });
      }
    } catch { /* optional */ }
  }
  // PRE-STATE (subagent only): the agent's last page VIEW (snapshot/navigate)
  // = WHERE the change happens + the ORIGINAL values. Sourced from the PAGE, so
  // it works even when the mutation was a browser_run_code_unsafe (which hides
  // its action in a `code` arg, blind to recentInputBlock). GATE: if no fresh
  // view, say so and FORBID fabrication — fail to UNVERIFIED, not a wrong recovery.
  let preStateBlock = "";
  if (config && (isBrowser || toolName.startsWith("mcp__"))) {
    try {
      const { loadRecentBrowserSnapshot } = require("./strategies.js");
      // PAGE_STATE belongs to the BROWSER surface only. `recordBrowserSnapshot`
      // fires solely on browser_snapshot/navigate, so the cache holds one slot:
      // the last page the agent looked at, whatever tool runs next. Loading it
      // for a non-browser MCP action (postgres, filesystem, git) hands that
      // action an unrelated page AND tells it "THE ORIGINAL PRE-STATE is in
      // PAGE_STATE ... write the recovery DIRECTLY from it" — a recovery built
      // from state that was never this action's. Single-surface benchmark runs
      // never produce it (no browse => empty cache), but a real mixed session
      // does. The `else` branch below still runs for non-browser MCP: they keep
      // the read-it-yourself + never-fabricate directive, which is what they
      // should have been getting all along.
      const snap = isBrowser ? loadRecentBrowserSnapshot(config) : null;
      if (snap && snap.text) {
        preStateBlock = "\n" + render(P.sections["prestate-page"], { URL: snap.url || "unknown", PAGE_TEXT: snap.text });
      } else {
        preStateBlock = "\n" + (isBrowser ? P.sections["prestate-none-browser"] : P.sections["prestate-none-mcp"]);
      }
    } catch { /* optional */ }
  }
  // Split for cache friendliness: the pin RULES are per-server static (join
  // the cached prefix); only the typed VALUES are per-action (dynamic tail).
  const browserPinStatic = isBrowser ? "\n" + P.sections["browser-pin-static"] + "\n" : "";
  // Inline mode renders once (no prefix caching) — keep the combined form.
  const browserPinDirective = isBrowser ? `${browserPinStatic}${recentInputBlock ? `${recentInputBlock}\n` : ""}` : "";

  // ── SURFACE of this action — send only what CAN apply to it ───────────
  // Every extra field/paragraph explaining an option the action cannot use
  // is pure cost on EVERY spawn, and a live invitation to use it wrongly.
  const isMcpSurface = isBrowser || toolName.startsWith("mcp__");
  // A shell command that reaches an EXTERNAL system — it decides whether the
  // prompt explains live_restore at all (a purely local action has no use for
  // it). The verb set is the one the removed verification gate also used.
  const isShellRemote = !isMcpSurface &&
    /\b(git\s+push|curl|wget|ssh|scp|rsync|docker|kubectl|helm|terraform|aws|gcloud|az|systemctl|psql|mysql|mariadb|mongo|mongosh|redis-cli)\b/.test(command);

  // Guidance (GENERAL — "capture / confirm / write", not tied to any one
  // MCP server) to keep the backup fast. This is a PROMPT instruction, not
  // a hard cap — the watcher wrapper still ends the run once the result is
  // written, so an over-eager model can't drag the tail out either way.
  const directive = mode === "inline" ? P.sections["inline-directive"] : render(P.sections["directive"], {
    TARGET_SOURCE: experienceBlock ? P.sections["directive-source-skill"] : P.sections["directive-source-strategy"],
    PIN_TARGET: isBrowser ? "" : "\n" + P.sections["directive-pin-target"],
  });

  // ── Action-category dispatch ──────────────────────────────────────────
  // The plugin already knows the action type, so send ONLY the relevant
  // backup STRATEGY rather than the whole A–R catalog (~2.1k tokens of which
  // only one block ever applies on any given call). Categories E (anything-
  // else) + R (read-only) compress into a two-sentence fallback appended to
  // every dispatch. Category text is kept verbatim from the prior catalog.
  const CAT_A = P.sections["category-a"];

  const CAT_B = P.sections["category-b"];

  const CAT_C = P.sections["category-c"];

  const CAT_D = P.sections["category-d"];

  const CAT_F = P.sections["category-f"];

  // Category G exists because the HIGHEST-stakes shell shape used to match
  // NOTHING. pickCategory reads the command LINE: it knows pip/apt/npm, git
  // push/curl, export/unset, and redirect/cp/mv/tee. A project program
  // (`bin/capctl allot release --apply`) shows none of those and names no
  // path, so every branch missed and the prompt degraded to the generic
  // "capture whatever you can" fallback — the least specific guidance we
  // have, for the action whose target is hardest to guess. The strategy is
  // the one a capable subagent worked out for itself on that very command
  // (read the program, find /var/lib/capline, copy it): locate the store,
  // copy the BYTES, restore the BYTES.
  const CAT_G = P.sections["category-g"];

  // Classify from what the plugin already knows; pick ONE strategy block.
  const pickCategory = (): string => {
    if (isBrowser || toolName.startsWith("mcp__")) return CAT_F;
    if (/\b(pip3?|npm|yarn|pnpm|apt|apt-get|brew|conda|gem|cargo)\b[^\n]*\binstall\b/.test(command)) return CAT_C;
    if (/\bgit\s+push\b/.test(command) ||
        (/\bcurl\b/.test(command) && (/-X\s*(POST|PUT|DELETE|PATCH)/i.test(command) || /(--data|\s-d\s|\s-F\s)/.test(command)))) return CAT_B;
    if (/(^|\s)(export|unset|source)\s/.test(command)) return CAT_D;
    if (/^(Write|Edit|MultiEdit|patch|str_replace)$/i.test(toolName) ||
        /(>|>>|\btee\b|\bcp\b|\bmv\b|\bdd\b|\btruncate\b|install\s+-)/.test(command)) return CAT_A;
    // A command we could not classify from its verbs is still a command that
    // writes SOMETHING somewhere — see CAT_G. Only the no-command case (a
    // non-shell tool that reached tier 3) keeps the bare fallback.
    if (command.trim()) return CAT_G;
    return "";
  };
  const picked = pickCategory();
  // HONEST DEGRADATION for MCP-less runners: CAT_F's capture instructions
  // ("with the SAME MCP, read the affected entity") are unfollowable when the
  // runner cannot wire the action's MCP server (runner_caps). Telling the
  // subagent to do the impossible makes it flail (burning its turn budget) or
  // fabricate a confident recovery from nothing — observed live in the codex/
  // openclaw gap audit and in the ablations' stale-instruction failures. So
  // when mcpAvailable === false the remote guidance carries an explicit
  // directive instead; the verification gate additionally distrusts whatever
  // comes back (see runSubagentBackup).
  const noMcpDirective = (picked === CAT_F && opts.mcpAvailable === false) ? "\n\n" + P.sections["no-mcp-directive"] : "";
  const categoryGuidance = mode === "inline" ? render(P.sections["inline-category-guidance"], { CATEGORY_F: CAT_F }) : render(P.sections["category-guidance"], {
    PICKED_BLOCK: picked ? `\n${picked}\n` : "",
    NO_MCP_DIRECTIVE: noMcpDirective,
    // No read-only exit on the declaration path: the spawn only happened
    // because an agent declared this action needs a backup, so the escape has
    // nothing to buy. Measured 2026-08-24 across 36 marker-driven spawns:
    // zero read-only verdicts. All it offered was a way to do less.
    JUDGED: P.sections["judged-gate"],
  });

  if (mode === "inline") {
    const persistDir = `${cwd}/.chats-sandbox/inline-backups`;
    return render(P.sections["inline-template"], {
      DIRECTIVE: directive, BROWSER_PIN_DIRECTIVE: browserPinDirective, EXPERIENCE_BLOCK: experienceBlock,
      CATEGORY_GUIDANCE: categoryGuidance, PERSIST_DIR: persistDir,
    });
  }

  // ── OUTPUT FORMAT — only the fields this surface can actually use ─────
  // recovery_mcp_calls is replayed at restore against the ACTION'S OWN MCP
  // server (restore.ts resolves it from the artifact's toolName). A shell
  // action has no such server, and the field is worse than dead weight
  // there: restoreSubagent short-circuits on recoveryMcpCalls, so one
  // spurious entry diverts a perfectly good shell reversal away from
  // recovery_commands. live_restore means "reversing needs CURRENT state
  // read at restore" — a remote/UI property. On a purely local action it
  // buys nothing and costs something: it routes restore through a fresh
  // live-reading subagent instead of replaying the recorded commands, which
  // for a local file reversal is strictly worse. Hence: MCP/browser
  // gets both fields explained, a shell command that reaches a remote
  // system keeps live_restore, and a local action gets neither — its shape
  // line still carries live_restore:false, which is both the right value
  // and the parser's default when the field is absent.
  const shapeLine = isMcpSurface ? P.sections["shape-line-mcp"] : P.sections["shape-line-shell"];
  const recoveryCommandsBullet = isMcpSurface ? P.sections["recovery-commands-bullet-mcp"] : P.sections["recovery-commands-bullet-shell"];
  const liveRestoreBullet = isMcpSurface
    ? "\n" + P.sections["live-restore-bullet-mcp"]
    : isShellRemote
      ? "\n" + P.sections["live-restore-bullet-shell-remote"]
      : "";

  // ── PROMPT ORDER = CACHE ORDER ────────────────────────────────────────
  // Providers cache on an identical PREFIX, so the prompt is assembled
  // static-first: [identity + directive + category strategy + output format]
  // is byte-identical across calls, [experience block] is per-server static,
  // and everything per-action (triggering action, PAGE_STATE, typed values,
  // paths) lives in the DYNAMIC CONTEXT tail. The static blocks refer to the
  // storage path as <STORAGE_DIR>; the tail binds it to the real path.
  return render(P.body, {
    DIRECTIVE: directive, BROWSER_PIN_STATIC: browserPinStatic, CATEGORY_GUIDANCE: categoryGuidance, EXPERIENCE_BLOCK: experienceBlock,
    SHAPE_LINE: shapeLine, RECOVERY_COMMANDS_BULLET: recoveryCommandsBullet, LIVE_RESTORE_BULLET: liveRestoreBullet,
    LEARNED_READONLY_BLOCK: learnedReadOnlyBlock, RECENT_INPUT_BLOCK: recentInputBlock,
    TOOL_NAME: toolName, ARGS: args, COMMAND: command, CHECKER_TARGETS_BLOCK: checkerTargetsBlock, PRE_STATE_BLOCK: preStateBlock,
    CWD: cwd, ACTION_DIR: actionDir,
  });
}

/** Validate + normalize a candidate object into our SubagentResponse
 *  shape, or null if it doesn't match. Module-scoped so both the
 *  result-file reader and the stdout parser can use it. */
function extractOurShape(candidate: unknown): SubagentResponse | null {
  // A valid result needs a description and at least ONE recovery channel:
  // shell recovery_commands, structured recovery_mcp_calls (the BEST kind
  // on MCP surfaces — pinned, replayable), or an explicit no-op verdict.
  // Requiring recovery_commands specifically rejected perfectly good
  // MCP-only results (observed live: the lean openclaw backup agent wrote
  // a pinned-ID recovery via recovery_mcp_calls and was discarded).
  // Missing arrays default to [] downstream.
  if (
    typeof candidate === "object" && candidate !== null &&
    typeof (candidate as Record<string, unknown>).description === "string" &&
    (Array.isArray((candidate as Record<string, unknown>).recovery_commands) ||
     Array.isArray((candidate as Record<string, unknown>).recovery_mcp_calls) ||
     (candidate as Record<string, unknown>).no_backup_needed === true)
  ) {
    const c = candidate as Record<string, unknown>;
    // Lenient extraction of structured recovery MCP calls: keep only
    // entries that are objects with a string `tool` and an object `args`;
    // `server` is optional (string). Drop anything malformed.
    let recoveryMcpCalls: Array<{ server?: string; tool: string; args: Record<string, unknown> }> | undefined;
    if (Array.isArray(c.recovery_mcp_calls)) {
      const cleaned = (c.recovery_mcp_calls as unknown[])
        .filter((e): e is Record<string, unknown> =>
          typeof e === "object" && e !== null &&
          typeof (e as Record<string, unknown>).tool === "string" &&
          typeof (e as Record<string, unknown>).args === "object" &&
          (e as Record<string, unknown>).args !== null &&
          !Array.isArray((e as Record<string, unknown>).args))
        .map((e) => ({
          tool: String(e.tool),
          args: e.args as Record<string, unknown>,
          ...(typeof e.server === "string" ? { server: e.server } : {}),
        }));
      if (cleaned.length) recoveryMcpCalls = cleaned;
    }
    return {
      description: String(c.description),
      backup_commands: Array.isArray(c.backup_commands)
        ? (c.backup_commands as unknown[]).map(String) : [],
      recovery_commands: Array.isArray(c.recovery_commands)
        ? (c.recovery_commands as unknown[]).map(String) : [],
      artifact_paths: Array.isArray(c.artifact_paths)
        ? (c.artifact_paths as unknown[]).map(String)
        : undefined,
      live_restore: typeof c.live_restore === "boolean" ? c.live_restore : undefined,
      recovery_mcp_calls: recoveryMcpCalls,
      no_backup_needed: c.no_backup_needed === true,
      // Lenient: keep entries that carry a non-empty string `pattern`;
      // drop anything else rather than failing the whole result.
      read_only_patterns: Array.isArray(c.read_only_patterns)
        ? (c.read_only_patterns as unknown[])
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
            .filter((e): e is { pattern: string; reason?: string } => e !== null && !!e.pattern.trim())
        : undefined,
    };
  }
  return null;
}

/** Marker file dropped in an action dir when captured bytes exist but no
 *  artifact could be registered in metadata.json. */
export const UNREGISTERED_MARKER = "UNREGISTERED_CAPTURE.txt";

/** Narrow, EXPLICIT repair for the one over-escape shape observed live:
 *  a subagent that writes shell recovery containing quotes emits `\\"`
 *  where `\"` was meant, e.g.
 *      "recovery_commands":["... [ -f \\"$restore/x\\" ] && cp ..."]
 *  In JSON `\\` is a literal backslash, so the following `"` CLOSES the
 *  string and the parse dies mid-array (observed:
 *  results/claude/capline-allot-release-20260823_233449/backups/
 *  action_001_.../subagent_result.json — 6.5 MB of correctly captured
 *  state was discarded because of it).
 *
 *  This is deliberately NOT a general "fix any JSON" routine: it rewrites
 *  exactly the `\\"` sequence and nothing else, it is only ever reached
 *  AFTER a strict parse has already failed, and the repaired text still
 *  has to parse as JSON *and* match our shape before it is trusted.
 *  Returns null when the sequence is absent (nothing to try). */
export function repairOverEscapedQuotes(raw: string): string | null {
  if (!raw.includes('\\\\"')) return null;
  return raw.split('\\\\"').join('\\"');
}

/** Read the subagent's result from the canonical handoff file the
 *  prompt instructs it to write. Far more robust than parsing stdout —
 *  required for the hermes runner whose stdout is TUI-decorated.
 *  Returns null if the file is missing or malformed.
 *
 *  THREE attempts, in order, each strictly independent of the last:
 *    1. canonical subagent_result.json, strict JSON.parse
 *    2. canonical file again, after the narrow `\\"` over-escape repair
 *    3. scan the action dir for any OTHER JSON file with our shape
 *
 *  Step 3 used to live inside the same `try` as step 1, so a malformed
 *  canonical file threw straight past it into the outer catch — the
 *  fallback that exists precisely for "the result file is wrong" never
 *  ran. Each attempt now has its own guard. */
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
    // ── 1. strict parse of the canonical file ──
    try {
      const shaped = extractOurShape(JSON.parse(canonicalRaw));
      if (shaped) return shaped;
    } catch {
      // malformed — fall through to the narrow repair, then the scan.
    }

    // ── 2. tolerant SECOND attempt at the canonical file ──
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
        // repair didn't help either — fall through to the scan.
      }
    }
  }

  // ── 3. fallback scan, OUTSIDE the try that wraps the canonical parse ──
  // A weak subagent may write the result to the WRONG filename (e.g.
  // backlog_manifest.json) instead of emitting it / using the canonical
  // name. Scan the action dir for ANY JSON file whose content matches our
  // shape. The canonical name is skipped: both parse routes above already
  // tried it.
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
      } catch { /* not our shape — keep scanning */ }
    }
  } catch { /* unreadable dir */ }

  return null;
}

/** Our own bookkeeping files — everything else in an action dir is
 *  something the subagent CAPTURED. */
const BOOKKEEPING_FILES = new Set([
  "metadata.json",
  "instruction.txt",
  "subagent_result.json",
  "subagent_watch.json",
  UNREGISTERED_MARKER,
]);

/** Evidence that the subagent actually captured state into `actionDir`:
 *  any file that is not one of our own bookkeeping files, and not one of
 *  the per-spawn `subagent_<id>.*` forensic records we write ourselves.
 *  Bounded walk — we only need to know THAT something is there and
 *  roughly how much, not to enumerate a 6.5 MB tree. */
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
      // Our own per-spawn forensic record: the response copy, the run
      // envelope and the raw output dumps. Not captured state — counting them
      // would make every read-only verdict look like an unregistered capture.
      if (depth === 0 &&
          /^subagent_[a-z0-9]{8}\.(?:json|run\.json|stdout\.txt|stderr\.txt)$/.test(e.name)) continue;
      // Same exemption for the STEP-BY-STEP record and its "there was none,
      // and here is why" marker: they describe the spawn, they are not state
      // it captured. Without this every read-only verdict would suddenly look
      // like an unregistered capture and keep its otherwise-empty action dir.
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
 * Move a spawn's forensic record out of an action dir that is about to be
 * deleted, into `<sandbox>/subagent-transcripts/<action name>/`.
 *
 * A read-only verdict legitimately leaves no action folder — that silence is
 * deliberate (see the caller in strategies.ts). But it is also why 15 of 33
 * recorded runs had no per-action record at all: the record went into the dir
 * and the dir went away. Relocating first keeps the forensics without putting
 * empty folders back into the store.
 *
 * Returns the number of files moved. Best-effort throughout: a failure here
 * must never stop the cleanup it precedes.
 */
export function preserveTranscripts(actionDir: string, sandboxRoot: string): number {
  let moved = 0;
  try {
    const names = fs.readdirSync(actionDir)
      .filter((n) =>
        /^subagent_[a-z0-9]{8}\.(?:json|run\.json|stdout\.txt|stderr\.txt)$/.test(n) ||
        // the step-by-step record and its "there was none, here is why" marker
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
 * THE failure this project cares most about: the capture worked, the
 * bookkeeping didn't, and the outcome looked like success.
 *
 * restore.ts finds artifacts exclusively THROUGH metadata.json. So when
 * an action dir holds real captured bytes but no artifact could be
 * registered, that data is invisible to the plugin's own restore — while
 * the run looks indistinguishable from "no backup was needed". Record it
 * where someone will actually see it: a marker file in the action dir,
 * the debug log, and the user's terminal.
 *
 * No-op when the dir holds nothing captured (the genuine "nothing to back
 * up" case must stay quiet).
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
    `capture is INVISIBLE to \`chats-sandbox restore\`.`;

  logDebug(`UNREGISTERED CAPTURE: ${summary} sample=${cap.sample.join(", ")}`);
  try {
    fs.mkdirSync(actionDir, { recursive: true });
    fs.writeFileSync(
      path.join(actionDir, UNREGISTERED_MARKER),
      `CHATS-Sandbox: UNREGISTERED CAPTURE\n` +
        `timestamp: ${new Date().toISOString()}\n` +
        `reason:    ${reason}\n` +
        `files:     ${cap.files}\n` +
        `bytes:     ${cap.bytes}\n` +
        `sample:    ${cap.sample.join("\n           ")}\n\n` +
        `The backup subagent captured the state above, but its result could\n` +
        `not be registered in metadata.json. \`chats-sandbox restore\` locates\n` +
        `artifacts through metadata.json ONLY, so it will NOT find these files.\n` +
        `They are still on disk at the path above and can be restored by hand.\n`,
      "utf-8",
    );
  } catch { /* best-effort */ }

  tellUser(
    `[CHATS-Sandbox] WARNING — captured backup NOT registered: ${cap.files} file(s), ` +
      `${mb} MB are on disk in ${actionDir} but restore cannot see them (${reason}). ` +
      `Recover them by hand if the action needs undoing.`,
  );
}

function parseSubagentOutput(raw: string): SubagentResponse | null {
  // When claude -p is called with --output-format json, the response is a
  // JSON wrapper like {"result": "...", "session_id": "...", ...}.
  // The `result` field contains the actual text the subagent produced,
  // which should itself be (or contain) our backup JSON.
  //
  // We try in this order:
  //   1. Parse raw as JSON wrapper → extract `result` → parse result as our JSON
  //   2. Parse the first {...} block in raw directly (fallback for text mode)

  // Try 1: parse raw as claude -p JSON wrapper
  try {
    const wrapper = JSON.parse(raw);
    if (wrapper && typeof wrapper === "object") {
      const result = (wrapper as Record<string, unknown>).result;
      if (typeof result === "string") {
        // Pick the balanced {...} block that has our shape (not a greedy
        // first-to-last span that merges narration + JSON and fails).
        const inner = extractJsonObject(result, (o) => !!extractOurShape(o));
        if (inner) {
          const shaped = extractOurShape(inner);
          if (shaped) return shaped;
        }
      }
      // openclaw agent --json wrapper: { payloads: [{ text }], meta }.
      // Join the payload texts and extract our JSON block from them.
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
      // Maybe the wrapper itself has our shape (if claude passed through)
      const direct = extractOurShape(wrapper);
      if (direct) return direct;
    }
  } catch {
    // Not valid JSON at top level, fall through
  }

  // Try 2: find any balanced {...} block in the raw text that has our shape
  const found = extractJsonObject(raw, (o) => !!extractOurShape(o));
  if (found) {
    const shaped = extractOurShape(found);
    if (shaped) return shaped;
  }

  return null;
}

/**
 * Invoke a subagent via `claude -p` to reason about an out-of-workspace
 * action and create a backup artifact. Synchronous — blocks until the
 * subagent finishes or the timeout expires.
 *
 * Returns a BackupArtifact with strategy="subagent" on success, or null
 * on any failure (missing claude CLI, timeout, parse error, etc.).
 */
/** A real artifact, the "read_only" verdict (clean skip — the subagent
 *  judged the action read-only), or null (no/failed backup). */
export type SubagentOutcome = BackupArtifact | "read_only" | null;

export function runSubagentBackup(
  ctx: HookContext,
  actionDir: string,
  config: SandboxConfig,
  opts?: {
    toolAllow?: string[];
    /** What the READ-ONLY CHECKER established this call actually writes, when
     *  it ran. Rendered into the prompt; see BackupGuidanceOpts.checkerTargets. */
    checkerTargets?: string[];
  },
): SubagentOutcome {
  if (!config.subagentEnabled) return null;

  // Always write diagnostic trace to a log file so users can debug
  // silent subagent failures without needing verbose mode.
  const debugLogPath = path.join(path.dirname(path.resolve(config.backupDir)), "subagent.log");
  const logDebug = (msg: string): void => {
    try {
      fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
      fs.appendFileSync(debugLogPath, `[${new Date().toISOString()}] ${msg}\n`);
    } catch {
      // best-effort
    }
  };

  // Raw runner output. Declared HERE, above the forensic closure, so the
  // closure can read them from any exit — including one that fires before the
  // subprocess is ever launched.
  let stdout = "";
  let stderr = "";
  /** The invocation we actually ran, kept where the forensic closure can see
   *  it: the transcript capture needs the runner AND the env the spawn ran
   *  with (hermes' filtered home arrives as a HOME/HERMES_HOME override, not
   *  as process.env), plus any session id we minted ourselves. */
  let spawnInvocation: ReturnType<typeof buildSubagentInvocation> = null;
  /** The runner's OWN id for this spawn, latched the moment it appears in the
   *  output. It has to be latched rather than read later: the dominant success
   *  path is a watcher kill, and that path deliberately blanks `stdout`
   *  ("result file is authoritative") — which would throw away the one handle
   *  that identifies this spawn's session file by name. */
  let runnerSessionId: string | null = null;
  const noteSessionId = (text: string): void => {
    if (runnerSessionId || !text) return;
    const m = text.match(/"session_id"\s*:\s*"([^"]+)"/);
    if (m) runnerSessionId = m[1];
  };

  // ── FORENSIC RECORD ───────────────────────────────────────────────
  // Diagnostics that only survive the happy path are worthless, because the
  // happy path is not what anyone investigates. Measured across 33 recorded
  // runs, the per-action record `subagent_<id>.json` existed in 18: it was
  // written at the very END of the success path, so the parse-failure,
  // watcher-kill, timeout, non-zero-exit, read-only and unverified exits all
  // returned before reaching it. In the reference run that cost us exactly the
  // action we needed — the destructive `capctl allot release --apply`, whose
  // result file was malformed and whose 6.5 MB capture went unregistered.
  //
  // So the record is written from ONE closure that every post-spawn exit
  // calls. It emits up to three files, all sharing one id:
  //   subagent_<id>.json       the parsed response (byte-identical to what the
  //                            success path always wrote), or, when there is no
  //                            parsed response, an explicit no-result stub
  //   subagent_<id>.run.json   the envelope: outcome, timing, runner, the raw
  //                            output's size and whereabouts, and the error
  //   subagent_<id>.std{out,err}.txt   the raw output, on every non-success
  //                            exit — the runner wrapper JSON previously
  //                            survived only by being echoed into subagent.log
  const transcriptId = Math.random().toString(36).slice(2, 10);
  const transcriptFile = path.join(actionDir, `subagent_${transcriptId}.json`);
  /** Where the openhands runner script dumps its own event stream. Every other
   *  runner keeps a session record of its own that we copy IN; openhands has
   *  none, so it writes straight here. See subagent_transcript.ts. */
  const ohTranscriptFile = path.join(actionDir, `subagent_${transcriptId}.transcript.jsonl`);
  let spawnStartedAt: number | null = null;
  let transcriptWritten = false;
  /** Cap on each raw-output dump. A runaway subagent must not be able to fill
   *  the store; 256 KB holds every real wrapper JSON observed. */
  const RAW_CAP = 256 * 1024;

  /** Did the watcher stop this run on its deadline? It exits 0 when it does
   *  (its kill must not look like a child failure), so this file is the only
   *  way to tell a timeout from a malformed handoff. */
  const watchMark = (): { timedOut: boolean; timeoutMs?: number } => {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(actionDir, "subagent_watch.json"), "utf-8"));
      return { timedOut: m?.timedOut === true, timeoutMs: m?.timeoutMs };
    } catch { return { timedOut: false }; }
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
    if (transcriptWritten) return;   // first exit wins; never double-write
    transcriptWritten = true;
    try {
      fs.mkdirSync(actionDir, { recursive: true });
      const parsed = detail.parsed ?? null;
      // (a) the response copy — unchanged shape on success, so restore and any
      //     existing tooling that reads this path see exactly what they did.
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

      // (b) raw output, on every exit that is not a clean success.
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

      // (b2) THE STEP-BY-STEP RECORD — on EVERY exit, success included.
      //      (a) says what the subagent concluded and (b) only survives a
      //      non-success exit, so a clean backup used to leave nothing
      //      showing what it did between calls. Each runner keeps that record
      //      somewhere different (or, for openhands, nowhere at all and it
      //      writes its own); subagent_transcript.ts holds the per-runner
      //      story and copies it in here, or writes a marker naming the runner
      //      and the reason there is none.
      const _runner = (spawnInvocation?.runner ?? config.subagentRunner ?? "claude") as string;
      const transcript: TranscriptCapture = captureTranscript({
        actionDir,
        id: transcriptId,
        outcome,
        locate: {
          runner: _runner,
          // claude reports its own session id in the -p JSON wrapper; openclaw
          // uses the one we minted. A partial stdout still yields the id, so
          // this works on the kill/timeout exits too.
          sessionId: spawnInvocation?.sessionId ?? runnerSessionId,
          since: spawnStartedAt,
          env: { ...subagentEnv(), ...(spawnInvocation?.env ?? {}) },
          cwd: process.cwd(),
          // The MAIN agent's session file sits in the SAME projects directory
          // and is appended to for the whole run — without this it would be
          // the "newest" candidate every single time.
          exclude: [ctx.session_id, process.env.CLAUDE_CODE_SESSION_ID],
        },
      });

      // (c) the envelope. `producedNoOutput` is the distinction the whole
      //     exercise is about: "the subagent wrote nothing" must never look
      //     like "we dropped the record".
      const resultFilePresent = (() => {
        try { return fs.statSync(path.join(actionDir, "subagent_result.json")).size > 0; }
        catch { return false; }
      })();
      fs.writeFileSync(
        path.join(actionDir, `subagent_${transcriptId}.run.json`),
        JSON.stringify({
          id: transcriptId,
          outcome,
          recordedAt: new Date().toISOString(),
          elapsedSec: spawnStartedAt === null
            ? null : Number(((Date.now() - spawnStartedAt) / 1000).toFixed(1)),
          spawned: spawnStartedAt !== null,
          runner: config.subagentRunner ?? "claude",
          model: config.subagentModel,
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
          // The step-by-step record: where this runner keeps one, whether we
          // got it, how big it was, and — the part that matters for a capped
          // file — exactly how much was elided and by which cap.
          transcript,
        }, null, 2) + "\n",
        "utf-8",
      );
      logDebug(
        `transcript persisted: subagent_${transcriptId}.json (outcome=${outcome}, ` +
        `stdout=${dumps.stdout.bytes}B${dumps.stdout.path ? " saved" : ""}, ` +
        `stderr=${dumps.stderr.bytes}B${dumps.stderr.path ? " saved" : ""})`,
      );
      logDebug(
        transcript.captured
          ? `step transcript [${transcript.runner}]: ${transcript.path} ` +
            `(${transcript.bytes}B of ${transcript.sourceBytes}B` +
            `${transcript.truncated
              ? `, TRUNCATED at ${transcript.capBytes}B — ${transcript.droppedBytes}B/` +
                `${transcript.droppedLines} lines elided from the middle` : ""}` +
            `) <- ${transcript.source ?? "written in place"}`
          : `step transcript [${transcript.runner}]: NONE — ${transcript.reason}` +
            `${transcript.marker ? ` (marker: ${transcript.marker})` : ""}`,
      );
    } catch (e) {
      // A failure to record must never take the backup down with it.
      try { logDebug(`transcript persist FAILED: ${e}`); } catch { /* nothing left to do */ }
    }
  };

  // Resolve the action's server BEFORE the prompt: the prompt must know
  // whether this runner can actually wire that server's MCP (runner_caps) —
  // an MCP-less runner gets the explicit no-MCP directive instead of capture
  // instructions it cannot follow.
  const _server = serverFromToolName(ctx.tool_name);
  // SIMPLEST backup design: a BROWSER action's backup subagent gets NO browser.
  // The main agent already took a browser_snapshot before its mutation; the hook
  // cached it (recordBrowserSnapshot) and it's injected into the prompt as
  // PAGE_STATE. The subagent writes the recovery straight from that snapshot —
  // it physically cannot browse (so it can't fabricate via a live read or
  // collide with the agent's browser). If the value it needs isn't in PAGE_STATE
  // it must mark the backup UNVERIFIED (see the prompt's preStateBlock gate).
  // Non-browser servers (e.g. postgres) keep their MCP — capture there IS a
  // remote read/insert, not a snapshot replay.
  const _isBrowser = _server === "playwright";
  const _mcpAvailable = _isBrowser
    ? true // browser path is MCP-less BY DESIGN (PAGE_STATE), not degraded
    : mcpAvailableFor(config.subagentRunner, config, _server);

  const prompt = buildSubagentPrompt(ctx, actionDir, config, _mcpAvailable, opts?.checkerTargets);
  const timeoutMs = Math.max(10_000, config.subagentTimeoutSeconds * 1000);

  // Build the runner invocation — claude -p or hermes chat — see
  // buildSubagentInvocation. Returns null when the runner's CLI is
  // missing, in which case we skip the backup (graceful degradation).
  // BACKUP needs the remote tools too: to recover a delete/edit we must
  // READ the pre-state BEFORE the agent's action runs. Give the subagent
  // the same MCP, with an isolated browser profile so it doesn't collide
  // with the agent's live browser lock.
  const invocation = buildSubagentInvocation(prompt, config, {
    withMcp: !_isBrowser,
    isolateBrowserProfile: true,
    // Dynamic MCP loading: only boot the server THIS action uses. For a browser
    // action, boot NOTHING — the subagent runs with only terminal,file toolsets.
    neededServer: _isBrowser ? null : _server,
    // Narrow the MCP tool schema to the capture-relevant tools (read + inverse),
    // derived by the caller from the experience. Undefined → server unfiltered.
    toolAllow: opts?.toolAllow,
    // Turn cap, matching the call budget stated in the prompt. NOT enforced on
    // every runner: runner_caps.claude.maxTurns is false (that CLI has no
    // --max-turns flag), so for the default runner the prompt text is the whole
    // mechanism and this value only reaches hermes (--max-turns) and openhands
    // (CHATS_SANDBOX_OH_SUB_MAX_ITER). The watcher ends the run the instant the
    // result file is valid, so the cap only ever trims a pathological tail.
    // 5 was too tight in practice: on an MCP surface the mandatory ToolSearch
    // plus a spill that has to be copied out of tool-results eats the budget
    // before the second capture call, and the model drops the capture rather
    // than exceed the stated limit.
    maxTurns: 8,
    // openhands only — the one runner with no record of its own to copy.
    transcriptFile: ohTranscriptFile,
  });
  spawnInvocation = invocation;
  if (!invocation) {
    const runner = config.subagentRunner ?? "claude";
    logDebug(`skipped: ${runner} CLI not found in PATH`);
    if (config.verbose) {
      process.stderr.write(`[CHATS-Sandbox] subagent skipped: ${runner} CLI not found\n`);
    }
    persistTranscript("not_spawned", { note: `${runner} CLI not found in PATH — no subagent ran` });
    return null;
  }
  const { bin, args } = invocation;

  // Filter by CONTAINMENT, not equality: the claude branch may prepend a
  // ToolSearch preamble to the prompt arg, and an equality check would dump
  // the whole multi-KB prompt (incl. PAGE_STATE) into the log line.
  logDebug(`invoking: ${bin} [runner=${invocation.runner}] [prompt=${prompt.length} chars] ${args.filter((a) => !a.includes(prompt)).join(" ")} (timeout=${timeoutMs}ms)`);

  // Tell the user what we're about to do — claude -p can take 5-30s and
  // there's otherwise no signal that anything is happening.
  const cmdPreview = String(ctx.tool_input.command ?? "")
    || String(ctx.tool_input.path ?? ctx.tool_input.file_path ?? "");
  const modelLabel = invocation.runner === "hermes"
    ? (config.subagentHermesModel || "hermes")
    : invocation.runner === "openclaw"
      ? (config.subagentOpenclawModel || "openclaw")
      : invocation.runner === "codex"
        ? (config.subagentCodexModel || "codex")
        : invocation.runner === "openhands"
          ? (config.subagentOpenhandsModel || "openhands")
          : config.subagentModel;
  tellUser(
    `[CHATS-Sandbox] Out-of-workspace action detected. Invoking ${modelLabel} subagent to back up... ` +
    `(${ctx.tool_name}${cmdPreview ? `: ${cmdPreview.slice(0, 60)}` : ""})`
  );

  const startTime = Date.now();
  spawnStartedAt = startTime;   // from here on, a transcript describes a real spawn
  try {
    // Run the subagent THROUGH the watcher wrapper: it kills the subagent
    // the instant it writes a valid subagent_result.json, skipping the
    // model's post-backup "still thinking" tail. The wrapper enforces the
    // timeout itself, so give execFileSync a small margin on top.
    const { execFileSync } = require("node:child_process");
    const watcher = path.join(__dirname, "subagent_watch.js");
    const resultFile = path.join(actionDir, "subagent_result.json");
    stdout = execFileSync(
      process.execPath,
      [watcher, resultFile, String(timeoutMs), bin, ...args],
      {
        encoding: "utf-8",
        timeout: timeoutMs + 10_000,
        env: { ...subagentEnv(), ...(invocation.env ?? {}) },
        // Close stdin immediately — codex exec (and possibly others)
        // block forever reading an open stdin pipe.
        input: "",
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 4 * 1024 * 1024, // 4 MB cap
      },
    );
    noteSessionId(stdout);
    logDebug(`stdout (${stdout.length} chars): ${stdout.slice(0, 500)}`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const errWithOutput = e as { stdout?: string; stderr?: string };
    if (errWithOutput.stdout) stdout = String(errWithOutput.stdout);
    if (errWithOutput.stderr) stderr = String(errWithOutput.stderr);
    // Latch BEFORE the watcher-kill branch below blanks stdout.
    noteSessionId(stdout);
    logDebug(`FAILED: ${msg.slice(0, 500)}`);
    if (stderr) logDebug(`stderr: ${stderr.slice(0, 500)}`);
    if (stdout) logDebug(`partial stdout: ${stdout.slice(0, 500)}`);

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);

    // The watcher KILLS the subagent the instant it writes a valid result
    // file — that kill surfaces HERE as a non-zero exit / thrown
    // execFileSync. So a throw is NOT necessarily a failure: if the
    // subagent already wrote its result, the backup SUCCEEDED and we must
    // proceed to promote it (otherwise live_restore recovery is silently
    // discarded — exactly the browser case, whose long "thinking tail"
    // means the watcher always has to kill it). Only bail when there is no
    // usable result file.
    const killedButHasResult = readSubagentResultFile(actionDir, logDebug);
    if (killedButHasResult) {
      logDebug("subagent killed by watcher AFTER writing its result — proceeding to promote it");
      stdout = ""; // result file is authoritative; ignore partial stdout
    } else {
      // Detect common auth failure and log a clear message
      if (stdout.includes("Not logged in") || stderr.includes("Not logged in")) {
        logDebug("DIAGNOSIS: claude CLI is not logged in. Run `claude` interactively once to authenticate.");
        tellUser(
          "[CHATS-Sandbox] Subagent skipped: claude CLI not logged in. " +
          "Run `claude` interactively once to authenticate, or disable the subagent with " +
          "`chats-sandbox config set subagentEnabled false`."
        );
      } else {
        tellUser(`[CHATS-Sandbox] Subagent failed after ${elapsedSec}s: ${msg.slice(0, 120)}`);
      }
      // The subprocess died without a usable result — but it may well have
      // finished its `cp` before dying. Never discard captured bytes silently.
      reportUnregisteredCapture(actionDir, `subagent failed: ${msg.slice(0, 80)}`, logDebug);
      // Timeout / non-zero exit / watcher kill with nothing to promote. This
      // is the exit with the LEAST other evidence, so it is the one that most
      // needs the raw output kept.
      // The watcher may have stopped it on the deadline and the process tree
      // then held the inherited pipes open until execFileSync's own margin
      // expired — that arrives here as ETIMEDOUT. If the watcher left its
      // mark, record what actually happened rather than a generic failure.
      // (The USER-facing message on this path is unchanged; the gap that a
      // hung tree still reports internal jargon is documented separately in
      // interaction_audit.test.ts.)
      const _watch = watchMark();
      if (_watch.timedOut) {
        logDebug(`watcher deadline mark present (${_watch.timeoutMs}ms) — the run was stopped on its deadline`);
      }
      persistTranscript(_watch.timedOut ? "timed_out" : "spawn_failed", {
        error: msg.slice(0, 2000),
        note: _watch.timedOut
          ? "watcher stopped the subagent on its deadline; the subprocess then ended without a usable result file"
          : "subprocess ended without a usable result file",
      });
      return null;
    }
  }

  // Prefer the canonical result file the subagent was told to write —
  // robust regardless of stdout format (the hermes runner's stdout is
  // TUI-decorated and not cleanly parseable). Fall back to stdout
  // parsing for older subagents / the claude runner's JSON wrapper.
  const fileResult = readSubagentResultFile(actionDir, logDebug);
  if (fileResult) logDebug("result read from subagent_result.json");
  const parsed = fileResult ?? parseSubagentOutput(stdout);
  if (!parsed) {
    // A deadline kill lands HERE, not in the catch above: the watcher exits 0
    // on purpose. Separate the two before reporting anything.
    const _timedOut = watchMark().timedOut;
    logDebug(
      `${_timedOut ? "TIMED OUT" : "parse failed"} (no subagent_result.json, ` +
      `stdout unparseable). Raw stdout was: ${stdout.slice(0, 2000)}`,
    );

    // Detect permission denial (subagent couldn't run bash) and warn clearly
    // NOTE: `claude -p --output-format json` ALWAYS emits a
    // "permission_denials" key — it is `[]` on a perfectly permitted run.
    // A bare substring test therefore misdiagnosed EVERY claude-runner parse
    // failure as a permission problem (observed live: the capline run's real
    // "malformed result file" failure was reported to the user as "upgrade
    // your CLI"). Require a NON-EMPTY denial list.
    const _deniedPermissions = /"permission_denials"\s*:\s*\[\s*[^\]\s]/.test(stdout);
    if (_deniedPermissions || stdout.includes("permission denied") ||
        stdout.includes("approval is needed") || stdout.includes("cannot proceed")) {
      logDebug("DIAGNOSIS: subagent was denied tool permissions despite bypass flag. " +
        "This usually means a stale `claude` CLI version — upgrade and retry.");
      tellUser(
        "[CHATS-Sandbox] Subagent could not run backup commands (tool permission denied). " +
        "Upgrade the `claude` CLI (npm i -g @anthropic-ai/claude-code) or set " +
        "subagentPermissionMode=acceptEdits for filesystem-only backups."
      );
    } else if (_timedOut) {
      logDebug(`DIAGNOSIS: the watcher killed the subagent on its ${timeoutMs}ms deadline — ` +
        "this is a TIMEOUT, not malformed output.");
      tellUser(
        `[CHATS-Sandbox] Subagent hit its ${Math.round(timeoutMs / 1000)}s deadline and was stopped ` +
        "before it wrote a result — backup skipped.",
      );
    } else {
      tellUser("[CHATS-Sandbox] Subagent returned unparseable output — backup skipped.");
    }
    // THE failure shape: the capture may have fully succeeded and only the
    // handoff JSON was malformed. Surface it instead of returning a silent
    // null that is indistinguishable from "no backup was needed".
    reportUnregisteredCapture(
      actionDir,
      "subagent result file malformed and stdout unparseable",
      logDebug,
    );
    // THE reference-run failure: a 6.5 MB capture, a malformed handoff, and
    // previously no record of how it got there.
    persistTranscript(_timedOut ? "timed_out" : "unparseable", {
      note: _timedOut
        ? `watcher stopped the subagent on its ${timeoutMs}ms deadline before it wrote a result`
        : "no parseable subagent_result.json and stdout could not be parsed",
    });
    return null;
  }

  // The subagent now OUTPUTS the JSON (instead of writing the file itself —
  // weak models reliably drop that last file-write step). Persist what we
  // parsed from stdout to the canonical path so forensics and any
  // file-based reader still find it.
  if (!fileResult) {
    try {
      fs.writeFileSync(path.join(actionDir, "subagent_result.json"), JSON.stringify(parsed));
      logDebug("saved parsed stdout JSON to subagent_result.json");
    } catch { /* best-effort */ }
  }

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
  logDebug(`parse success: ${parsed.description}`);

  // ORDER MATTERS: the read-only verdict is resolved BEFORE the UNVERIFIED
  // flag below. A read-only verdict legitimately carries empty recovery
  // arrays, so the `_noRecovery` heuristic flagged EVERY clean skip as
  // "BACKUP UNVERIFIED" — 10 false alarms in a single observed run (the
  // capline run), which is exactly how the one real warning gets ignored.
  // READ-ONLY VERDICT: the subagent inspected the action and determined
  // it mutates nothing outside the workspace. Honor it as a CLEAN SKIP —
  // not a failed/unverified backup. This is the smart second-layer
  // read-only check beyond the regex filter, for the ambiguous tail.
  // Safe: tiers 0–2 already covered the workspace independently, so this
  // only declines the generic tier-3 backup for something the subagent
  // judged read-only. The caller treats "read_only" specially: no
  // artifact, no "unprotected" warning, and the empty action dir is
  // cleaned up.
  if (parsed.no_backup_needed === true) {
    logDebug(`subagent verdict: read-only, no backup needed (${parsed.description.slice(0, 80)})`);

    // LIVE LEARNING: the subagent has just read the program and concluded
    // it is read-only. If it also recorded pattern(s), put them in the
    // session store so later matching invocations skip the spawn entirely.
    // Only ever reached on a read-only verdict — a spawn that made a real
    // backup teaches nothing about what is safe to skip.
    const _patterns = parsed.read_only_patterns ?? [];
    if (config.learnedReadOnlyEnabled !== false && _patterns.length && ctx.session_id) {
      try {
        const added = learnReadOnlyPatterns(
          path.dirname(path.resolve(config.backupDir)),
          ctx.session_id,
          {
            patterns: _patterns,
            command: String(ctx.tool_input.command ?? ""),
            cwd: process.cwd(),
            reason: parsed.description,
            actionDir,
          },
        );
        if (added) {
          logDebug(
            `learned ${added} read-only pattern(s) from "${String(ctx.tool_input.command ?? "").slice(0, 80)}": ` +
            _patterns.map((p) => p.pattern).join(" | "),
          );
        }
      } catch (e) {
        logDebug(`learned read-only store write failed: ${e}`);
      }
    }
    persistTranscript("read_only", { parsed, parsedFrom: fileResult ? "result_file" : "stdout" });
    return "read_only";
  }

  // LOUD UNVERIFIED flag: the simplest backup design hands the subagent the
  // cached PAGE_STATE and NO browser. If the original value it needed wasn't in
  // that snapshot (e.g. hidden in an input's value attribute), the subagent
  // marks the result UNVERIFIED rather than fabricating. Surface that here so
  // it's visible in forensics (subagent.log) and on the user's terminal — this
  // is the ONE case we want flagged for a possible future live-read.
  const _descUpper = (parsed.description || "").trimStart().toUpperCase();
  // A deterministic remote reversal records its inverse as structured
  // recovery_mcp_calls (recovery_commands stays empty) — that is NOT an
  // unverified backup, so only flag when BOTH forms are empty.
  const _noRecovery = (parsed.recovery_commands ?? []).length === 0 &&
    (parsed.recovery_mcp_calls ?? []).length === 0;
  // Carried onto the artifact so the PreToolUse hook can put it in the
  // AGENT's context too. Success is silent now (config.notifyOnSuccess);
  // uncertainty is not — an unverified backup is exactly the case the
  // agent must be able to act on, and /dev/tty never reaches it.
  const backupUnverified = _descUpper.startsWith("UNVERIFIED") || _noRecovery;
  if (backupUnverified) {
    logDebug(`[CHATS-Sandbox] BACKUP UNVERIFIED: pre-state value not captured for ${ctx.tool_name} — ${(parsed.description || "").slice(0, 120)}`);
    tellUser(`[CHATS-Sandbox] BACKUP UNVERIFIED: pre-state value not captured for ${ctx.tool_name}`);
  }


  // NO RULE-BASED VERDICT ON THE BACKUP. What the subagent produced is
  // recorded as-is; whether it is a real backup is graded by the LLM judge
  // from the run transcript. The gate that used to live here
  // (`verified = durableArtifact || live_restore || (isRemote && hasRecovery)`)
  // did not do what it claimed: it only checked that SOME declared recovery
  // path was non-empty, so a capture that ran but grabbed the wrong table
  // passed it, while a real capture written to an undeclared path was thrown
  // away. This plugin reports; it does not adjudicate.
  //
  // durableArtifact survives because the NO-MCP DISTRUST branch below still
  // reads it — there, an existing artifact is evidence the runner COULD read
  // remote state, which is a different question from "is this backup good".
  const declaredPaths = (parsed.artifact_paths ?? [])
    .map((p) => (path.isAbsolute(p) ? p : path.join(actionDir, p)));
  const durableArtifact = declaredPaths.some((p) => {
    try { return fs.statSync(p).size > 0; } catch { return false; }
  });
  const modelLiveRestore = parsed.live_restore ?? false;
  // Recovery MECHANISM is the subagent's OWN call (it knows whether its
  // recovery needs live re-derivation). live_restore=false → run the
  // recorded recovery_commands directly at restore (deterministic, no agent
  // — the fast path for simple cases like a SQL reversal). live_restore=true
  // → spawn a fresh agent that re-reads live state (the dynamic cases like a
  // browser/UI reversal where the page has changed).
  let liveRestore = modelLiveRestore;

  // NO-MCP DISTRUST (runner_caps) — the one remaining downgrade, and it
  // never discards: it annotates. This call's runner could not wire the
  // action's MCP server, so the
  // subagent CANNOT have read remote pre-state — a prose recovery it emitted
  // is at best guessed, at worst fabricated. Downgrade, don't drop: force
  // live_restore so restore re-derives against live state, and mark the
  // description UNVERIFIED so humans and the restore agent see the caveat.
  //
  // recovery_mcp_calls are exempted ONLY for a CONSTRUCTIVE triggering action.
  // The no-MCP directive permits recording a CREATE inverse derived from the
  // ACTION ARGS alone (delete the just-created entity, pinned by an id in the
  // args) — the harness replays that in-process at restore. But for a
  // DESTRUCTIVE/MUTATING trigger (delete/update), the inverse REQUIRES the
  // pre-state the runner could not read, so any recovery_mcp_calls it emitted
  // are fabricated — including a "reversal" that merely replays the same
  // destructive call (observed: a codex mock "reversing" a DELETE by emitting
  // the identical DELETE). Those must be distrusted like prose: force
  // live_restore (restore then routes to a subagent instead of replaying the
  // call blindly against the live server). Fires only when the runner PROVABLY
  // lacks MCP (codex/openclaw; hermes with no config) — never on uncertainty.
  // Classify the ACTION VERB, not the whole args — a free-text scan wrongly
  // trusts `DELETE FROM new_orders` or `UPDATE t SET note='please add later'`
  // because a schema name / literal contains a constructive word, re-opening
  // the fabrication hole. The verb is the tool-name action segment PLUS the
  // leading keyword of the SQL/command payload; table names and string
  // literals never enter it. A destructive verb anywhere (action verb OR the
  // full payload) vetoes — over-distrust is the safe direction.
  const _payload = (`${String(ctx.tool_input.command ?? "")} ` +
    `${String((ctx.tool_input as { sql?: unknown }).sql ?? "")} ` +
    `${String((ctx.tool_input as { query?: unknown }).query ?? "")}`).toLowerCase();
  const _toolSeg = (ctx.tool_name.split("__").pop() || "").toLowerCase().replace(/_/g, " ");
  const _leadingVerb = _payload.match(/[a-z]+/)?.[0] ?? ""; // first alpha token of the statement
  const _actionVerb = `${_toolSeg} ${_leadingVerb}`;
  const _CONSTRUCTIVE = /\b(create|insert|post|add|new|upload|submit|send|append|publish|register|generate)\b/;
  const _DESTRUCTIVE = /\b(delete|update|drop|truncate|alter|remove|purge|replace|merge|upsert|revoke|wipe|erase|clear)\b/;
  const _isConstructive = _CONSTRUCTIVE.test(_actionVerb)
    && !_DESTRUCTIVE.test(_actionVerb) && !_DESTRUCTIVE.test(_payload);
  const _trustworthyMcpCalls = _isConstructive && (parsed.recovery_mcp_calls ?? []).length > 0;
  if (!_mcpAvailable && ctx.tool_name.startsWith("mcp__") && !durableArtifact
      && !_trustworthyMcpCalls) {
    logDebug(
      `no-MCP distrust: runner=${config.subagentRunner ?? "claude"} had no MCP for ` +
      `${_server ?? "?"}, no durable artifact, prose-only recovery — forcing live_restore + UNVERIFIED.`,
    );
    liveRestore = true;
    if (!/^UNVERIFIED/i.test(parsed.description)) {
      parsed.description = `UNVERIFIED: no MCP access — ${parsed.description}`;
    }
    tellUser(
      "[CHATS-Sandbox] Backup recorded WITHOUT MCP access (runner cannot load " +
      "the action's MCP server) — marked UNVERIFIED; restore will re-derive " +
      "against live state instead of trusting it.",
    );
  }

  // Persist the raw subagent response as a file alongside the artifact.
  // Same path and same bytes as before — it is just written through the one
  // closure every other exit also uses.
  const id = transcriptId;
  const artifactFile = transcriptFile;
  persistTranscript("success", { parsed, parsedFrom: fileResult ? "result_file" : "stdout" });

  // Tell the user the backup succeeded
  tellUser(`[CHATS-Sandbox] Subagent backup done in ${elapsedSec}s: ${parsed.description.slice(0, 100)}`);

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
 * Spawn a fresh `claude -p` subagent to perform a restore. Used when
 * an artifact was tagged `liveRestore: true` by the backup subagent
 * (i.e. the canned recovery_commands can't be trusted — remote state,
 * dynamic systems). The subagent reads live state and runs whatever
 * commands it decides are needed.
 *
 * Returns { success, detail }. `detail` contains either the result
 * text (on success) or the error message (on failure).
 *
 * Mirrors the subprocess setup of runSubagentBackup:
 *   - scratch cwd to escape project .claude/settings.json deny rules
 *   - CHATS_SANDBOX_NO_HOOK=1 to prevent hook recursion
 *   - --dangerously-skip-permissions for the bypass path
 *   - timeout from config.subagentTimeoutSeconds
 */
export function invokeRestoreSubagent(
  prompt: string,
  config: SandboxConfig,
  neededServer?: string | null,
): { success: boolean; detail: string } {
  // Restore is where the model must perform precise multi-step UI actions
  // (find the pinned entity → delete → confirm). The cheap backup model
  // (e.g. haiku) often can't, so allow a STRONGER model just for restore via
  // subagentRestoreModel — backup stays cheap, restore gets capability.
  if (config.subagentRestoreModel) {
    config = {
      ...config,
      subagentModel: config.subagentRestoreModel as typeof config.subagentModel,
      subagentHermesModel: config.subagentRestoreModel,
    };
  }
  const timeoutMs = Math.max(10_000, config.subagentTimeoutSeconds * 1000);

  // Same runner branching as the backup path — claude -p or hermes chat —
  // but this is the live-restore path, so request the MCP tools (browser)
  // when configured so the subagent can execute the UI reversal. Dynamic
  // MCP loading: only the action's own server is booted.
  const invocation = buildSubagentInvocation(prompt, config, { withMcp: true, neededServer });
  if (!invocation) {
    const runner = config.subagentRunner ?? "claude";
    return { success: false, detail: `${runner} CLI not found in PATH` };
  }
  const { bin, args } = invocation;

  const modelLabel = invocation.runner === "hermes"
    ? (config.subagentHermesModel || "hermes")
    : invocation.runner === "openclaw"
      ? (config.subagentOpenclawModel || "openclaw")
      : invocation.runner === "codex"
        ? (config.subagentCodexModel || "codex")
        : invocation.runner === "openhands"
          ? (config.subagentOpenhandsModel || "openhands")
          : config.subagentModel;
  tellUser(
    `[CHATS-Sandbox] Live-restore: invoking ${modelLabel} subagent to reverse remote/dynamic state...`,
  );

  try {
    const { execFileSync } = require("node:child_process");
    const stdout: string = execFileSync(bin, args, {
      encoding: "utf-8",
      timeout: timeoutMs,
      env: { ...subagentEnv(), ...(invocation.env ?? {}) },
      // Close stdin immediately — codex exec (and possibly others)
      // block forever reading an open stdin pipe.
      input: "",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 4 * 1024 * 1024,
    });

    // Extract the result text from the claude -p JSON wrapper for display.
    let detail = stdout.slice(0, 500);
    try {
      const wrapper = JSON.parse(stdout);
      if (wrapper && typeof wrapper === "object") {
        const result = (wrapper as Record<string, unknown>).result;
        if (typeof result === "string") detail = result.slice(0, 500);
      }
    } catch {
      // raw stdout is fine
    }
    return { success: true, detail };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, detail: msg.slice(0, 500) };
  }
}

/**
 * Run the configured runner (claude -p / hermes chat) on an arbitrary
 * reasoning prompt and return its text result. Used by the self-
 * exploration pipeline to extract recovery patterns — a pure-text task,
 * no tools or backup framing. Returns null on any failure.
 */
export function runRunnerForText(
  prompt: string,
  config: SandboxConfig,
  timeoutSeconds = 180,
  opts?: {
    neededServer?: string | null; toolAllow?: string[];
    /** READ-ONLY CHECKER: ban every tool and wire no MCP. */
    noTools?: boolean;
    /** System prompt for a noTools spawn. */
    systemPrompt?: string;
  },
): string | null {
  // Self-exploration pins the server it's exploring, so the verify agent ALWAYS
  // gets that server's live MCP tools (mcp-<server>). This is NOT the backup
  // path's dynamic per-action injection — for explore the server is constant.
  // The two checker options are threaded through unchanged; a caller that passes
  // neither produces the byte-identical invocation it always did.
  const invocation = buildSubagentInvocation(
    prompt,
    config,
    opts?.neededServer
      ? {
        neededServer: opts.neededServer, withMcp: true, toolAllow: opts.toolAllow,
        noTools: opts?.noTools, systemPrompt: opts?.systemPrompt,
      }
      : ((opts?.noTools || opts?.systemPrompt)
        ? { noTools: opts?.noTools, systemPrompt: opts?.systemPrompt }
        : undefined),
  );
  if (!invocation) return null;
  const { bin, args } = invocation;
  try {
    const { execFileSync } = require("node:child_process");
    const stdout: string = execFileSync(bin, args, {
      encoding: "utf-8",
      timeout: Math.max(10_000, timeoutSeconds * 1000),
      env: { ...subagentEnv(), ...(invocation.env ?? {}) },
      // Close stdin immediately — codex exec (and possibly others)
      // block forever reading an open stdin pipe.
      input: "",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
    });
    // claude -p --output-format json wraps the text in {result}. Hermes
    // prints decorated text. Try the wrapper first, else raw stdout.
    try {
      const wrapper = JSON.parse(stdout);
      const r = (wrapper as Record<string, unknown>).result;
      if (typeof r === "string") return r;
    } catch { /* not json-wrapped */ }
    return stdout;
  } catch {
    return null;
  }
}
