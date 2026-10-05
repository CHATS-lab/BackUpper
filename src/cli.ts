#!/usr/bin/env node
/**
 * BackUpper command-line interface: project setup (init, install, uninstall, doctor, demo),
 * read views over the action store (list, show, diff, status, config), the live side panel
 * (watch, panel) and undo (restore, clear). Read commands accept --json.
 *
 * Sections: the side panel (panel), doctor, demo, watch, then the CLI proper; main() runs
 * only when this file is the program (the hooks import the panel helpers from it).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { getConfigDir, getConfigPath, loadConfig, saveConfig, configWarnings, ensureConfig } from "./config/load.js";
import { quote } from "./util.js";
import * as os from "node:os";
import { ALL_ADAPTERS, findAdapter, ignoreStore, installedAdapters, ocLaunch, type AgentAdapter } from "./agents.js";
import { validateConfig, CONFIG_SCHEMA, parseConfigValue } from "./config/schema.js";
import { resolveRunner, subagentModelFor } from "./backup/runner_caps.js";
import { buildSubagentInvocation, cleanupSubagentInvocation, isCommandAvailable, subagentEnv } from "./backup/subagent.js";
import { storeDirOverride, type SandboxConfig, type SubagentRunnerName } from "./types.js";
import { listActionSummaries, actionDetail, actionNames, backupRoot, snapshotDiff, summarizeAction, artifactLabel, detailLines, emptyState, headlineTier, renderWatch, TIER_NAME, resolveAction, tierOf, type ActionSummary, type WatchState } from "./view.js";
import * as readline from "node:readline";
import { dirSize } from "./backup/strategies.js";
import type { RestoreResult } from "./restore/restore.js";

// =============================================================================
// ── panel ──
// =============================================================================

/**
 * `backupper panel on|off|toggle|status` (and `split`, an alias of `panel on`): opens
 * `backupper watch` in a pane to the right of the agent's terminal and closes exactly that pane
 * again. The pane is started by the terminal multiplexer, not by the agent, so closing it or a
 * crash in it never touches the agent process.
 *
 * State lives in `.backupper/panel.json`: the terminal, the pane id where the terminal reports
 * one, and the pid of the running `watch` process (written by `watch` itself).
 */

export type TerminalKind = "tmux" | "zellij" | "wezterm" | "kitty" | "iterm2" | "vscode" | "unknown";

export interface PanelState {
  terminal: TerminalKind;
  /** tmux `%3`, WezTerm pane id, kitty window id. */
  paneId?: string;
  /** pid of the `backupper watch` process, written when it starts. */
  pid?: number;
  openedAt: string;
}

export interface Launch {
  cmd: string;
  args: string[];
  /** stdout of the launch command is the new pane's id. */
  printsPaneId: boolean;
}

/** The terminal the agent runs in, from its environment. Multiplexers win over the host app. */
export function detectTerminal(env: NodeJS.ProcessEnv): TerminalKind {
  if (env.TMUX) return "tmux";
  if (env.ZELLIJ !== undefined && env.ZELLIJ !== "") return "zellij";
  if (env.TERM_PROGRAM === "vscode") return "vscode";
  if (env.WEZTERM_PANE || env.TERM_PROGRAM === "WezTerm") return "wezterm";
  if (env.KITTY_WINDOW_ID) return "kitty";
  if (env.TERM_PROGRAM === "iTerm.app" || env.ITERM_SESSION_ID) return "iterm2";
  return "unknown";
}

/** POSIX shell quoting for one argument. */
export function shq(s: string): string {
  return quote(s);
}

function appleString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The command that opens `watch` (an argv) in a pane to the right, keeping focus on the
 * agent's pane where the terminal allows it. Null for terminals without a scriptable split.
 */
export function splitCommand(term: TerminalKind, cwd: string, watch: string[]): Launch | null {
  switch (term) {
    case "tmux":
      return {
        cmd: "tmux",
        args: ["split-window", "-h", "-d", "-P", "-F", "#{pane_id}", "-c", cwd, watch.map(shq).join(" ")],
        printsPaneId: true,
      };
    case "zellij":
      return { cmd: "zellij", args: ["run", "--direction", "right", "--close-on-exit", "--cwd", cwd, "--", ...watch], printsPaneId: false };
    case "wezterm":
      return { cmd: "wezterm", args: ["cli", "split-pane", "--right", "--cwd", cwd, "--", ...watch], printsPaneId: true };
    case "kitty":
      return { cmd: "kitty", args: ["@", "launch", "--location=vsplit", "--keep-focus", "--cwd", cwd, ...watch], printsPaneId: true };
    case "iterm2": {
      const line = `cd ${shq(cwd)} && exec ${watch.map(shq).join(" ")}`;
      const script = [
        'tell application "iTerm2"',
        "  set agentSession to current session of current window",
        "  tell agentSession",
        "    set panelSession to (split vertically with default profile)",
        "  end tell",
        `  tell panelSession to write text ${appleString(line)}`,
        "  tell agentSession to select",
        "  return id of panelSession",
        "end tell",
      ].join("\n");
      return { cmd: "osascript", args: ["-e", script], printsPaneId: true };
    }
    default:
      return null;
  }
}

/** The command that closes a pane opened by `splitCommand`, when the terminal can address it. */
export function closeCommand(term: TerminalKind, paneId: string | undefined): Launch | null {
  if (!paneId) return null;
  switch (term) {
    case "tmux": return { cmd: "tmux", args: ["kill-pane", "-t", paneId], printsPaneId: false };
    case "wezterm": return { cmd: "wezterm", args: ["cli", "kill-pane", "--pane-id", paneId], printsPaneId: false };
    case "kitty": return { cmd: "kitty", args: ["@", "close-window", `--match=id:${paneId}`], printsPaneId: false };
    case "iterm2": return {
      cmd: "osascript",
      args: ["-e", [
        'tell application "iTerm2"',
        "  repeat with w in windows",
        "    repeat with t in tabs of w",
        "      repeat with s in sessions of t",
        `        if id of s is ${appleString(paneId)} then close s`,
        "      end repeat",
        "    end repeat",
        "  end repeat",
        "end tell",
      ].join("\n")],
      printsPaneId: false,
    };
    default: return null;
  }
}

// ── State ────────────────────────────────────────────────────────────

export function panelFile(projectRoot: string): string {
  return path.join(getConfigDir(projectRoot), "panel.json");
}

export function readPanel(projectRoot: string): PanelState | null {
  try {
    const s = JSON.parse(fs.readFileSync(panelFile(projectRoot), "utf-8"));
    return s && typeof s === "object" ? s as PanelState : null;
  } catch {
    return null;
  }
}

function writePanel(projectRoot: string, s: PanelState): void {
  fs.mkdirSync(path.dirname(panelFile(projectRoot)), { recursive: true });
  fs.writeFileSync(panelFile(projectRoot), JSON.stringify(s, null, 2));
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

function runLaunch(l: Launch): string {
  return execFileSync(l.cmd, l.args, { encoding: "utf-8", timeout: 8_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Whether the panel recorded in panel.json is still open. */
export function panelOpen(projectRoot: string, s = readPanel(projectRoot)): boolean {
  if (!s) return false;
  if (alive(s.pid)) return true;
  if (s.terminal === "tmux" && s.paneId) {
    try { return runLaunch({ cmd: "tmux", args: ["list-panes", "-a", "-F", "#{pane_id}"], printsPaneId: false }).split("\n").includes(s.paneId); } catch { return false; }
  }
  // Just launched: the watch process has not written its pid yet.
  return !s.pid && Date.now() - Date.parse(s.openedAt) < 5_000;
}

/** Called by `watch` on start and exit, so `off` can stop exactly this process. */
export function registerWatchPid(projectRoot: string, pid: number | null): void {
  try {
    const s = readPanel(projectRoot);
    if (pid === null) {
      if (s?.pid === process.pid) {
        if (s.paneId) writePanel(projectRoot, { ...s, pid: undefined });
        else fs.rmSync(panelFile(projectRoot), { force: true });
      }
      return;
    }
    writePanel(projectRoot, { terminal: s?.terminal ?? detectTerminal(process.env), paneId: s?.paneId, openedAt: s?.openedAt ?? new Date().toISOString(), pid });
  } catch { /* the panel works without bookkeeping */ }
}

export interface PanelResult {
  ok: boolean;
  /** Short lines for the user. */
  lines: string[];
}

export interface PanelEnv {
  projectRoot: string;
  /** argv that runs `backupper watch`. */
  watch: string[];
  env?: NodeJS.ProcessEnv;
}

/** How to run the panel by hand, shown wherever no split could be scripted. */
const MANUAL = "Split your terminal and run `backupper watch` in the new pane.";

export function panelOn(o: PanelEnv): PanelResult {
  const env = o.env ?? process.env;
  if (panelOpen(o.projectRoot)) return { ok: true, lines: ["BackUpper panel is already open."] };
  const term = detectTerminal(env);
  if (term === "vscode") {
    const keys = process.platform === "darwin" ? "Cmd+\\" : "Ctrl+Shift+5";
    return { ok: false, lines: [`VS Code cannot split its terminal from a script: press ${keys} and run \`backupper watch\` in the new pane.`] };
  }
  const launch = splitCommand(term, o.projectRoot, o.watch);
  if (!launch) return { ok: false, lines: [`No scriptable terminal split detected (tmux, Zellij, WezTerm, kitty, iTerm2). ${MANUAL}`] };
  let out: string;
  try {
    out = runLaunch(launch);
  } catch (e) {
    const err = (e as { stderr?: string }).stderr?.trim() || (e as Error).message;
    const hint = term === "kitty" ? " (kitty needs `allow_remote_control yes` in kitty.conf)" : "";
    return { ok: false, lines: [`Could not split the ${term} window${hint}: ${err.split("\n")[0]}`, MANUAL] };
  }
  writePanel(o.projectRoot, { terminal: term, paneId: launch.printsPaneId && out ? out.split("\n").pop() : undefined, openedAt: new Date().toISOString() });
  return { ok: true, lines: [`BackUpper panel opened on the right (${term}). Turn it off with \`backupper panel off\`.`] };
}

export function panelOff(o: PanelEnv): PanelResult {
  const s = readPanel(o.projectRoot);
  if (!s || !panelOpen(o.projectRoot, s)) {
    try { fs.rmSync(panelFile(o.projectRoot), { force: true }); } catch { /* fine */ }
    return { ok: true, lines: ["BackUpper panel is not open."] };
  }
  const close = closeCommand(s.terminal, s.paneId);
  let closed = false;
  if (close) {
    try { runLaunch(close); closed = true; } catch { /* fall back to the pid */ }
  }
  if (!closed && alive(s.pid)) {
    try { process.kill(s.pid as number, "SIGTERM"); closed = true; } catch { /* gone */ }
  }
  try { fs.rmSync(panelFile(o.projectRoot), { force: true }); } catch { /* fine */ }
  return { ok: closed, lines: [closed ? "BackUpper panel closed." : "Could not close the BackUpper panel; close its pane by hand."] };
}

export function panelStatus(o: PanelEnv): PanelResult {
  const s = readPanel(o.projectRoot);
  const open = panelOpen(o.projectRoot, s);
  return {
    ok: true,
    lines: [open
      ? `BackUpper panel is open (${s?.terminal}${s?.paneId ? ` pane ${s.paneId}` : ""}${s?.pid ? `, pid ${s.pid}` : ""}).`
      : `BackUpper panel is off. Terminal: ${detectTerminal(o.env ?? process.env)}.`],
  };
}

export function panelCommand(action: string, o: PanelEnv): PanelResult {
  switch (action) {
    case "on": return panelOn(o);
    case "off": return panelOff(o);
    case "status": return panelStatus(o);
    case "toggle": case "": return panelOpen(o.projectRoot) ? panelOff(o) : panelOn(o);
    default: return { ok: false, lines: [`Unknown panel action: ${action}. Use on, off, toggle or status.`] };
  }
}

/**
 * A prompt that is only a panel command (`/backupper-panel [on|off|toggle|status]` or
 * `/bu panel [...]`), which the UserPromptSubmit hook answers without involving the model.
 * Returns the action, or null for any other prompt.
 */
export function parsePanelPrompt(prompt: string): string | null {
  const m = /^\s*\/(?:backupper-panel|bu\s+panel)(?:\s+(on|off|toggle|status))?\s*$/i.exec(prompt);
  return m ? (m[1] ?? "toggle").toLowerCase() : null;
}

// =============================================================================
// ── doctor ──
// =============================================================================

/**
 * `backupper doctor`: checks that an agent, its hooks, the config, git and the tier-4 runner
 * are ready. Every failed check carries a one-line fix. `--probe` makes one small model call
 * through the invocation the tier-4 subagent uses.
 */

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface Check {
  id: string;
  status: CheckStatus;
  summary: string;
  fix?: string;
}

function runCheck(bin: string, args: string[], timeoutMs = 20_000, cwd?: string): { ok: boolean; out: string; err: string } {
  const r = spawnSync(bin, args, { encoding: "utf-8", timeout: timeoutMs, cwd, input: "" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() || (r.error?.message ?? "") };
}

function firstLine(s: string): string {
  return s.split("\n").find((l) => l.trim())?.trim() ?? "";
}

function checkNode(): Check {
  const major = parseInt(process.versions.node.split(".")[0], 10);
  return major >= 18
    ? { id: "node", status: "ok", summary: `node ${process.versions.node}` }
    : { id: "node", status: "fail", summary: `node ${process.versions.node} is too old`, fix: "install Node.js 18 or newer" };
}

function checkAgentCli(adapter: AgentAdapter): Check {
  const id = "agent.cli";
  if (!isCommandAvailable(adapter.bin)) {
    const fix = ({
      "claude-code": "install Claude Code: npm install -g @anthropic-ai/claude-code",
      codex: "install Codex: npm install -g @openai/codex",
      hermes: "install Hermes and make sure `hermes` is on PATH",
      openhands: "install the OpenHands CLI (uv tool install openhands); SDK scripts need none",
      "deepseek-harness": "install DeepSeek Harness: npm install -g @deepseek-ai/dsh",
      openclaw: "install OpenClaw: npm install -g openclaw",
    } as Record<string, string>)[adapter.name];
    if (adapter.name === "openhands") return { id, status: "warn", summary: `${adapter.bin} not found on PATH`, fix };
    return { id, status: "fail", summary: `${adapter.bin} not found on PATH`, fix };
  }
  const v = firstLine(runCheck(adapter.bin, ["--version"]).out) || "(version unknown)";
  return { id, status: "ok", summary: v.toLowerCase().includes(adapter.bin) ? v : `${adapter.bin} ${v}` };
}

function checkHooks(adapter: AgentAdapter, projectRoot: string, pkgRoot: string): Check[] {
  const st = adapter.hookStatus(projectRoot);
  if (!st.installed) {
    return [{
      id: "hooks", status: "fail",
      summary: `hooks not installed in ${st.location}`,
      fix: `backupper install ${adapter.name}`,
    }];
  }
  const checks: Check[] = [];
  // hook.js lives directly in the installed dist/ directory.
  const ours = path.resolve(pkgRoot);
  const foreign = st.hookScripts.filter((s) => path.dirname(path.resolve(s)) !== ours);
  const missing = st.hookScripts.filter((s) => !fs.existsSync(s));
  if (missing.length) {
    checks.push({ id: "hooks", status: "fail", summary: `hook script missing: ${missing[0]}`, fix: `backupper install ${adapter.name}` });
  } else if (foreign.length) {
    checks.push({
      id: "hooks", status: "warn",
      summary: `hooks in ${st.location} point at another BackUpper install (${path.dirname(foreign[0])})`,
      fix: `backupper install ${adapter.name}   # re-point them at this install`,
    });
  } else {
    checks.push({ id: "hooks", status: "ok", summary: `hooks installed in ${st.location}, pointing at this install` });
  }
  if (adapter.name === "codex" && isCommandAvailable("codex")) {
    const f = runCheck("codex", ["features", "list"]);
    const line = f.out.split("\n").find((l) => /^hooks\s/.test(l));
    if (line && !/\btrue\b/.test(line)) {
      checks.push({ id: "hooks.feature", status: "fail", summary: "the codex `hooks` feature is disabled", fix: "codex --enable hooks  (or set features.hooks = true in ~/.codex/config.toml)" });
    }
    checks.push({
      id: "hooks.trust", status: "warn",
      summary: "codex runs new hooks only after they are trusted",
      fix: "open `codex` in this project once and approve the hooks, or pass --dangerously-bypass-hook-trust",
    });
  }
  if (adapter.name === "openhands" && !isCommandAvailable("backupper")) {
    checks.push({
      id: "hooks.cli", status: "fail",
      summary: "the OpenHands plugin runs `backupper hook`, but `backupper` is not on PATH",
      fix: "npm install -g agents-backupper   # in the environment OpenHands runs in",
    });
  }
  if (adapter.name === "hermes") {
    const on = /^(1|true|yes|on)$/i.test(String(process.env.HERMES_ENABLE_PROJECT_PLUGINS ?? ""));
    checks.push(on
      ? { id: "hooks.enabled", status: "ok", summary: "HERMES_ENABLE_PROJECT_PLUGINS is set" }
      : {
        id: "hooks.enabled", status: "warn",
        summary: "Hermes reads project plugins only with HERMES_ENABLE_PROJECT_PLUGINS=1",
        fix: "HERMES_ENABLE_PROJECT_PLUGINS=1 hermes   # start Hermes from this project like this",
      });
  }
  if (adapter.name === "deepseek-harness") {
    checks.push({
      id: "hooks.launch", status: "warn",
      summary: "dsh loads the hooks only when launched with the BackUpper patch layer",
      fix: "dsh --patch .dsh/backupper/cordis.patch.yml   # from this project",
    });
  }
  if (adapter.name === "openclaw" && isCommandAvailable("openclaw")) {
    const on = /^true$/.test(firstLine(runCheck("openclaw", ["config", "get", "plugins.entries.backupper.enabled"]).out));
    checks.push(on
      ? { id: "hooks.enabled", status: "ok", summary: "the backupper plugin is enabled in the OpenClaw config" }
      : {
        id: "hooks.enabled", status: "fail",
        summary: "OpenClaw loads workspace plugins only once enabled",
        fix: "openclaw config set plugins.entries.backupper.enabled true",
      });
    const pinned = firstLine(runCheck("openclaw", ["config", "get", "agents.defaults.workspace"]).out).replace(/^"|"$/g, "");
    checks.push(pinned && !/not set|undefined|null/i.test(pinned)
      ? {
        id: "hooks.workspace", status: "warn",
        summary: `agents.defaults.workspace is set (${pinned}), so OPENCLAW_WORKSPACE_DIR is ignored`,
        fix: `openclaw config set agents.defaults.workspace ${JSON.stringify(projectRoot)}   # or unset it`,
      }
      : { id: "hooks.workspace", status: "ok", summary: `start OpenClaw with ${ocLaunch(projectRoot)}` });
  }
  return checks;
}

function checkConfig(projectRoot: string): Check {
  const p = getConfigPath(projectRoot);
  if (!fs.existsSync(p)) {
    return { id: "config", status: "fail", summary: "no .backupper/config.json in this project", fix: "backupper init" };
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (e) {
    return { id: "config", status: "fail", summary: `config.json does not parse: ${(e as Error).message}`, fix: `fix or delete ${p}, then: backupper init` };
  }
  const problems = validateConfig(raw);
  if (problems.length) {
    return { id: "config", status: "fail", summary: `config.json: ${problems.join("; ")}`, fix: "backupper config set <key> <value>" };
  }
  const c = loadConfig(projectRoot);
  if (!c.enabled || c.mode === "off") {
    return { id: "config", status: "warn", summary: `config valid, but BackUpper is ${c.enabled ? "in mode off" : "disabled"}`, fix: "backupper config set enabled true && backupper config set mode checker" };
  }
  return { id: "config", status: "ok", summary: `config valid (mode ${c.mode})` };
}

function checkGit(): Check {
  const v = runCheck("git", ["--version"]);
  return v.ok
    ? { id: "git", status: "ok", summary: `${firstLine(v.out)} (tier 3 snapshots)` }
    : { id: "git", status: "fail", summary: "git not found; tier 3 snapshots are disabled", fix: "install git" };
}

function presentEnv(names: string[]): string[] {
  return names.filter((n) => String(process.env[n] ?? "").trim() !== "");
}

/** Whether the runner CLI is installed and has credentials, without calling a model. */
function checkRunnerAuth(runner: string, config: SandboxConfig): Check[] {
  const id = "tier4.runner";
  if (!isCommandAvailable(runner)) {
    return [{ id, status: "fail", summary: `tier-4 runner \`${runner}\` not found on PATH`, fix: `install ${runner}, or: backupper config set subagentRunner <claude|codex|hermes>` }];
  }
  const chosen = subagentModelFor(config, runner as SubagentRunnerName);
  const model = chosen ? ` with model ${chosen}` : " with its default model";
  const checks: Check[] = [{ id, status: "ok", summary: `tier-4 subagent runs \`${runner}\`${model}` }];

  if (runner === "claude") {
    const env = presentEnv(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]);
    const st = runCheck("claude", ["auth", "status"], 20_000);
    let loggedIn = false;
    let method = "";
    try {
      const j = JSON.parse(st.out);
      loggedIn = j.loggedIn === true;
      method = String(j.authMethod ?? "");
    } catch { /* older CLI without `auth status` */ }
    if (loggedIn) checks.push({ id: "tier4.auth", status: "ok", summary: `claude is logged in (${method || "login"})` });
    else if (env.length) checks.push({ id: "tier4.auth", status: "ok", summary: `claude credentials from ${env.join(", ")}` });
    else checks.push({ id: "tier4.auth", status: "fail", summary: "claude is not logged in and no API key is set", fix: "run `claude` and /login, or export ANTHROPIC_API_KEY=..." });
  } else if (runner === "codex") {
    const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    const env = presentEnv(["OPENAI_API_KEY", "CODEX_API_KEY"]);
    if (fs.existsSync(path.join(home, "auth.json"))) checks.push({ id: "tier4.auth", status: "ok", summary: `codex login found (${path.join(home, "auth.json")})` });
    else if (env.length) checks.push({ id: "tier4.auth", status: "ok", summary: `codex credentials from ${env.join(", ")}` });
    else checks.push({ id: "tier4.auth", status: "fail", summary: "codex has no login and no API key is set", fix: "codex login   (or export OPENAI_API_KEY=...)" });
  } else if (runner === "hermes") {
    const home = process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
    const cfg = path.join(home, "config.yaml");
    let provider = config.subagentProvider;
    let modelName = chosen;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const yaml = require("js-yaml");
      const doc = yaml.load(fs.readFileSync(cfg, "utf-8")) as Record<string, unknown> | undefined;
      const m = doc?.model;
      if (m && typeof m === "object") {
        provider ||= String((m as Record<string, unknown>).provider ?? "");
        modelName ||= String((m as Record<string, unknown>).default ?? (m as Record<string, unknown>).model ?? "");
      } else if (typeof m === "string") {
        modelName ||= m;
      }
    } catch { /* no hermes config */ }
    if (!provider && !modelName) {
      checks.push({ id: "tier4.auth", status: "fail", summary: `no hermes model/provider configured (${cfg})`, fix: "hermes setup   (or: backupper config set subagentProvider <name> && backupper config set subagentModel <id>)" });
    } else {
      const keyVars = Object.keys(process.env).filter((k) => /_API_KEY$|_TOKEN$/.test(k) && process.env[k]);
      const envFile = path.join(home, ".env");
      const hasEnvFile = fs.existsSync(envFile);
      checks.push(keyVars.length || hasEnvFile
        ? { id: "tier4.auth", status: "ok", summary: `hermes provider ${provider || "(default)"}${modelName ? `, model ${modelName}` : ""}; credentials ${hasEnvFile ? `in ${envFile}` : "in the environment"}` }
        : { id: "tier4.auth", status: "warn", summary: `hermes provider ${provider || "(default)"} configured, but no API key found in the environment or ${envFile}`, fix: "hermes setup   (or export the provider's API key)" });
    }
  }
  return checks;
}

/** One real, tiny model call through the tier-4 invocation (tools disabled). */
function probe(config: SandboxConfig, runner: string, projectRoot: string): Check {
  const cfg = { ...config, subagentRunner: runner as SandboxConfig["subagentRunner"] };
  const inv = buildSubagentInvocation("Reply with exactly the word READY and nothing else.", cfg, {
    noTools: true,
    systemPrompt: "You are a connectivity probe. Answer with one word.",
  });
  if (!inv) return { id: "tier4.probe", status: "fail", summary: `${runner} not found on PATH`, fix: `install ${runner}` };
  const t0 = Date.now();
  let r;
  try {
    r = spawnSync(inv.bin, inv.args, {
      encoding: "utf-8",
      timeout: Math.max(30, config.subagentTimeoutSeconds) * 1000,
      cwd: projectRoot,
      env: { ...subagentEnv(), ...(inv.env ?? {}) },
      input: "",
      maxBuffer: 8 * 1024 * 1024,
    });
  } finally {
    cleanupSubagentInvocation(inv);
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const out = `${r.stdout ?? ""}`;
  if (r.status === 0 && /READY/i.test(out)) {
    return { id: "tier4.probe", status: "ok", summary: `probe call through ${runner} answered in ${secs}s` };
  }
  const why = firstLine(`${r.stderr ?? ""}`.split("\n").reverse().join("\n")) || firstLine(out) || r.error?.message || `exit ${r.status}`;
  return {
    id: "tier4.probe", status: "fail",
    summary: `probe call through ${runner} failed after ${secs}s: ${why.slice(0, 200)}`,
    fix: runner === "claude" ? "check `claude -p hi` works in this shell (login, network, org policy)"
      : runner === "codex" ? "check `codex exec hi` works in this shell (login, network)"
        : "check `hermes chat -q hi` works in this shell (provider and key)",
  };
}

export function doctor(adapter: AgentAdapter, projectRoot: string, pkgRoot: string, opts: { probe: boolean }): Check[] {
  const config = loadConfig(projectRoot);
  const runner = resolveRunner(config, adapter.name);
  const checks: Check[] = [checkNode(), checkAgentCli(adapter), ...checkHooks(adapter, projectRoot, pkgRoot), checkConfig(projectRoot), checkGit()];
  if (!config.subagentEnabled) {
    checks.push({ id: "tier4.runner", status: "skip", summary: "tier-4 subagent disabled (subagentEnabled=false)" });
    return checks;
  }
  const runnerChecks = checkRunnerAuth(runner, config);
  checks.push(...runnerChecks);
  if (opts.probe) {
    checks.push(runnerChecks.some((c) => c.status === "fail")
      ? { id: "tier4.probe", status: "skip", summary: "probe skipped: the runner is not ready" }
      : probe(config, runner, projectRoot));
  }
  return checks;
}

// =============================================================================
// ── demo ──
// =============================================================================

/**
 * `backupper demo`: an offline walk-through in a temporary project. It feeds two tool calls to
 * the real PreToolUse hook (an `rm` of a file and an in-workspace edit), carries them out and
 * reports them to the PostToolUse hook as an agent would, lists what tiers 1-3 captured, then
 * restores and checks both files.
 * No agent, model or key is involved: the tier-4 subagent and the checker are disabled.
 */

const NOTES = "Meeting notes\n- ship the parser on Friday\n- ask about the budget\n";
const SETTINGS = "retries = 3\ntimeout = 30\n";
const EDITED = "retries = 0\n";

interface HookReply {
  hookSpecificOutput?: { updatedInput?: Record<string, unknown>; additionalContext?: string };
}

export function demo(pkgRoot: string, opts: { keep: boolean; json: boolean }): number {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backupper-demo-")));
  const log: string[] = [];
  const say = (s = "") => { if (!opts.json) console.log(s); log.push(s); };
  const env = {
    ...process.env,
    BACKUPPER_READONLY_CHECKER: "0",
    BACKUPPER_STORE_DIR: "",
    BACKUPPER_NO_HOOK: "",
  };
  const hook = (payload: Record<string, unknown>, sub = "pre"): HookReply => {
    const r = spawnSync(process.execPath, [path.join(pkgRoot, "hook.js"), sub, "--agent", "claude-code"], {
      cwd: dir, env, input: JSON.stringify({ ...payload, cwd: dir, session_id: "demo" }), encoding: "utf-8", timeout: 60_000,
    });
    if (r.status !== 0) throw new Error(`hook exited ${r.status}: ${r.stderr}`);
    return r.stdout.trim() ? JSON.parse(r.stdout) as HookReply : {};
  };
  const results: Array<{ step: string; ok: boolean }> = [];
  const check = (step: string, ok: boolean) => { results.push({ step, ok }); say(`  ${ok ? "[ok]  " : "[FAIL]"} ${step}`); };

  try {
    fs.writeFileSync(path.join(dir, "notes.txt"), NOTES);
    fs.writeFileSync(path.join(dir, "settings.toml"), SETTINGS);
    // Offline configuration: tiers 1-3 only.
    saveConfig({ enabled: true, mode: "checker", subagentEnabled: false, announceOnce: false }, dir);

    say(`BackUpper demo, in a scratch project: ${dir}`);
    say("It contains notes.txt and settings.toml. Two tool calls follow, each sent to the");
    say("real PreToolUse hook first, exactly as Claude Code would send them.\n");

    say("1. The agent runs `rm notes.txt`.");
    const r1 = hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm notes.txt" } });
    const cmd = String(r1.hookSpecificOutput?.updatedInput?.command ?? "rm notes.txt");
    say(`   The hook moved the file into its trash and rewrote the command to: ${cmd}`);
    execFileSync("sh", ["-c", cmd], { cwd: dir, env });
    hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: cmd }, tool_response: "" }, "post");
    check("notes.txt is gone from the workspace, as the agent asked", !fs.existsSync(path.join(dir, "notes.txt")));

    say("\n2. The agent overwrites settings.toml with a Write call.");
    hook({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: path.join(dir, "settings.toml"), content: EDITED } });
    fs.writeFileSync(path.join(dir, "settings.toml"), EDITED);
    hook({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: path.join(dir, "settings.toml"), content: EDITED }, tool_response: "" }, "post");
    say("   The hook snapshotted the workspace into its shadow git repo; then the write ran.");
    check("settings.toml now holds the new content", fs.readFileSync(path.join(dir, "settings.toml"), "utf-8") === EDITED);

    say("\n3. What BackUpper recorded (`backupper list`):");
    const cfg = loadConfig(dir);
    const prev = process.cwd();
    process.chdir(dir);
    let actions;
    try { actions = listActionSummaries(cfg, dir); } finally { process.chdir(prev); }
    for (const a of actions) {
      say(`   #${a.seq}  tier ${a.tiers.join(",") || "-"}  ${a.originalAction || a.toolName}  (${a.strategies.join(" + ")})`);
    }
    check("two actions were recorded", actions.length === 2);
    check("the rm was captured by tier 1 (move to trash)", actions[0]?.strategies.includes("policy_rewrite") ?? false);
    check("the edit was captured by tier 3 (snapshot)", actions[1]?.strategies.includes("git_snapshot") ?? false);

    const first = actions[0]?.seq ?? 1;
    say(`\n4. Undo both steps: \`backupper restore ${first}\` (undo action #${first} and everything after it).`);
    const rr = spawnSync(process.execPath, [path.join(pkgRoot, "cli.js"), "restore", String(first)], {
      cwd: dir, env, encoding: "utf-8", timeout: 120_000,
    });
    for (const line of (rr.stdout ?? "").split("\n").filter((l) => l.trim())) say(`   ${line}`);
    check("notes.txt is back with its original content",
      fs.existsSync(path.join(dir, "notes.txt")) && fs.readFileSync(path.join(dir, "notes.txt"), "utf-8") === NOTES);
    check("settings.toml has its original content again", fs.readFileSync(path.join(dir, "settings.toml"), "utf-8") === SETTINGS);
  } catch (e) {
    check(`demo step failed: ${e instanceof Error ? e.message : String(e)}`, false);
  } finally {
    if (opts.keep) say(`\nScratch project kept at ${dir}`);
    else fs.rmSync(dir, { recursive: true, force: true });
  }

  const ok = results.every((r) => r.ok);
  if (opts.json) {
    // `project` is the scratch directory the demo ran in; `kept` says whether it still exists.
    console.log(JSON.stringify({ ok, project: dir, kept: opts.keep, checks: results, transcript: log }, null, 2));
  } else {
    say(ok
      ? "\nDemo passed. In a real project: backupper init && backupper install <agent>."
      : "\nDemo FAILED; see the steps marked [FAIL] above.");
  }
  return ok ? 0 : 1;
}

// =============================================================================
// ── watch ──
// =============================================================================

/**
 * `backupper watch`: a live, read-only terminal view of `.backupper/`, meant for a side pane
 * next to the agent (`backupper panel on`). It never writes to the store except for an explicit
 * `r` restore confirmed with `y`. Without a TTY it prints one snapshot and exits.
 */

/** Summaries are cached per action folder and recomputed only when its metadata changes. */
class Store {
  private cache = new Map<string, { mtime: number; summary: ActionSummary }>();
  constructor(readonly projectRoot: string) {}

  load(prev: WatchState): WatchState {
    const config = loadConfig(this.projectRoot);
    const names = actionNames(config);
    const actions: ActionSummary[] = [];
    for (const n of names) {
      let mtime = 0;
      try { mtime = fs.statSync(path.join(backupRoot(config), n, "metadata.json")).mtimeMs; } catch { /* not written yet */ }
      const hit = this.cache.get(n);
      if (hit && hit.mtime === mtime) { actions.push(hit.summary); continue; }
      const summary = summarizeAction(config, n, this.projectRoot);
      this.cache.set(n, { mtime, summary });
      actions.push(summary);
    }
    for (const k of [...this.cache.keys()]) if (!names.includes(k)) this.cache.delete(k);

    // Keep the selection on the same action; follow the tail when it was on the newest.
    const prevName = prev.actions[prev.selected]?.name;
    const followTail = !prev.actions.length || prev.selected >= prev.actions.length - 1;
    let selected = followTail ? actions.length - 1 : actions.findIndex((a) => a.name === prevName);
    if (selected < 0) selected = Math.min(prev.selected, actions.length - 1);
    selected = Math.max(selected, 0);
    const s: WatchState = {
      ...prev,
      project: this.projectRoot,
      mode: config.enabled ? config.mode : "disabled",
      personalization: config.personalization ?? "",
      storeBytes: dirSize(getConfigDir(this.projectRoot)),
      actions,
      selected,
    };
    return this.withDetail(s, config);
  }

  withDetail(s: WatchState, config: SandboxConfig = loadConfig(this.projectRoot)): WatchState {
    const a = s.actions[s.selected];
    if (!a || !s.expanded) return { ...s, detail: undefined };
    if (s.detail?.name === a.name && s.detail.timestamp === a.timestamp) return s;
    try { return { ...s, detail: actionDetail(config, a.name, this.projectRoot) }; } catch { return { ...s, detail: undefined }; }
  }
}

function snapshot(projectRoot: string): void {
  const s = new Store(projectRoot).load(emptyState());
  const width = Math.max(process.stdout.columns || 100, 60);
  console.log(renderWatch(s, width, undefined, false).slice(0, -1).join("\n"));
}

/**
 * `backupper watch --json [--select N]`: the panel's content as data, for a host that draws it
 * itself (the Claude Code mod in claude-plugin/). The detail is for action N, else the newest.
 */
export function watchJson(projectRoot: string, select?: number, width = 60): unknown {
  let s = new Store(projectRoot).load(emptyState());
  const i = select === undefined ? -1 : s.actions.findIndex((a) => a.seq === select);
  if (i >= 0) s = new Store(projectRoot).withDetail({ ...s, selected: i });
  const a = s.actions[s.selected];
  return {
    project: s.project,
    mode: s.mode,
    scope: s.personalization ? `personalized (${s.personalization})` : "Full",
    storeBytes: s.storeBytes,
    actions: s.actions.map((x) => {
      const head = headlineTier(x);
      return {
        seq: x.seq,
        call: x.originalAction || x.toolName || "(unknown call)",
        tier: head?.tier ?? null,
        tierName: head ? TIER_NAME[head.tier] : null,
        artifact: head ? artifactLabel(x, head.strategy) : null,
      };
    }),
    selected: a?.seq ?? null,
    detail: a ? detailLines(s.detail ?? a, s.actions.length - 1 - s.selected, width, false) : [],
  };
}

export async function watch(projectRoot: string): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    snapshot(projectRoot);
    return;
  }
  const store = new Store(projectRoot);
  let state = store.load(emptyState());
  const out = process.stdout;

  const draw = () => {
    const lines = renderWatch(state, out.columns || 80, out.rows || 24);
    out.write("\x1b[H" + lines.map((l) => l + "\x1b[K").join("\n") + "\x1b[J");
  };

  let timer: NodeJS.Timeout | null = null;
  const refresh = () => {
    if (timer) return;
    // Debounced: a burst of writes from one backup costs one re-read.
    timer = setTimeout(() => {
      timer = null;
      try { state = store.load(state); } catch { /* store mid-write; next event retries */ }
      draw();
    }, 250);
  };

  const watchers: fs.FSWatcher[] = [];
  const storeDir = getConfigDir(projectRoot);
  try {
    fs.mkdirSync(storeDir, { recursive: true });
    watchers.push(fs.watch(storeDir, { recursive: true, persistent: true }, refresh));
  } catch {
    try { watchers.push(fs.watch(storeDir, { persistent: true }, refresh)); } catch { /* polling only */ }
  }
  // Fallback for filesystems where fs.watch is silent (network mounts, some containers).
  let pollSig = "";
  const poll = setInterval(() => {
    const config = loadConfig(projectRoot);
    const names = actionNames(config);
    const last = names[names.length - 1];
    let sig = `${names.length}:${last}`;
    try { if (last) sig += `:${fs.statSync(path.join(backupRoot(config), last, "metadata.json")).mtimeMs}`; } catch { /* none */ }
    if (sig !== pollSig) { pollSig = sig; refresh(); }
  }, 3_000);
  poll.unref();

  registerWatchPid(projectRoot, process.pid);
  out.write("\x1b[?1049h\x1b[?25l");
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  let done: () => void = () => {};
  const finished = new Promise<void>((resolve) => { done = resolve; });
  const quit = () => {
    for (const w of watchers) w.close();
    clearInterval(poll);
    if (timer) clearTimeout(timer);
    try { process.stdin.setRawMode(false); } catch { /* closed */ }
    process.stdin.pause();
    out.write("\x1b[?25h\x1b[?1049l");
    registerWatchPid(projectRoot, null);
    done();
  };
  process.on("SIGTERM", () => { quit(); process.exit(0); });
  process.on("SIGHUP", () => { quit(); process.exit(0); });
  out.on("resize", draw);

  const move = (d: number) => {
    if (state.diff) {
      state = { ...state, diffScroll: Math.max(0, Math.min(state.diffScroll + d, state.diff.length - 1)) };
    } else if (state.actions.length) {
      const selected = Math.max(0, Math.min(state.selected + d, state.actions.length - 1));
      state = store.withDetail({ ...state, selected, message: undefined });
    }
    draw();
  };

  const toggleDiff = () => {
    if (state.diff) { state = { ...state, diff: undefined, diffScroll: 0 }; draw(); return; }
    const a = state.actions[state.selected];
    if (!a) return;
    try {
      const d = snapshotDiff(loadConfig(projectRoot), a.name, projectRoot);
      if (!d) state = { ...state, message: [`#${a.seq} has no workspace snapshot to diff against.`] };
      else if (!d.stat) state = { ...state, message: [`No workspace changes since the snapshot before #${a.seq}.`] };
      else state = { ...state, message: undefined, diffScroll: 0, diff: [`Changes since the snapshot before #${a.seq} (${d.commit.slice(0, 8)})`, "", ...d.stat.split("\n"), "", ...d.diff.split("\n")] };
    } catch (e) {
      state = { ...state, message: [`Diff failed: ${(e as Error).message.split("\n")[0]}`] };
    }
    draw();
  };

  const restore = async (a: ActionSummary) => {
    state = { ...state, confirm: undefined, busy: true, message: [`Restoring #${a.seq}…`] };
    draw();
    // Restore code may log; keep it off the screen and show the results instead.
    const saved = { log: console.log, error: console.error, warn: console.warn };
    console.log = console.error = console.warn = () => {};
    let lines: string[];
    try {
      const { restoreActionLoop } = require("./restore/restore.js") as typeof import("./restore/restore.js");
      const results = await restoreActionLoop(a.name, loadConfig(projectRoot));
      lines = results.map((r) => `${r.success ? "[OK]" : "[FAIL]"} ${r.description}`);
      if (results.some((r) => r.subagentPrompt)) lines.push(`Part of #${a.seq} needs an agent to restore; run \`backupper restore ${a.seq}\` for the prompt.`);
      if (!lines.length) lines.push(`Nothing to restore for #${a.seq}.`);
    } catch (e) {
      lines = [`[FAIL] restore #${a.seq}: ${(e as Error).message.split("\n")[0]}`];
    } finally {
      Object.assign(console, saved);
    }
    state = { ...store.load({ ...state, detail: undefined }), busy: false, message: lines.slice(-6) };
    draw();
  };

  process.stdin.on("keypress", (str: string | undefined, key: readline.Key | undefined) => {
    const name = key?.name ?? str;
    if ((key?.ctrl && name === "c") || name === "q" || name === "x") { quit(); return; }
    if (state.busy) return;
    if (state.confirm) {
      const a = state.actions[state.selected];
      if (name === "y" && a) { void restore(a); return; }
      state = { ...state, confirm: undefined, message: ["Restore cancelled."] };
      draw();
      return;
    }
    switch (name) {
      case "up": case "k": move(-1); break;
      case "down": case "j": move(1); break;
      case "pageup": move(-10); break;
      case "pagedown": move(10); break;
      case "return": case "enter":
        state = store.withDetail({ ...state, expanded: !state.expanded });
        draw();
        break;
      case "d": toggleDiff(); break;
      case "escape":
        state = { ...state, diff: undefined, message: undefined };
        draw();
        break;
      case "r": {
        const a = state.actions[state.selected];
        if (!a) break;
        const later = state.actions.length - 1 - state.selected;
        state = { ...state, diff: undefined, confirm: `Undo #${a.seq}${later ? ` and the ${later} later action${later === 1 ? "" : "s"}` : ""}?` };
        draw();
        break;
      }
    }
  });

  draw();
  await finished;
}

// =============================================================================
// ── cli ──
// =============================================================================

/**
 * BackUpper command-line interface: project setup (init, install, uninstall, doctor, demo),
 * read views over the action store (list, show, diff, status, config), the live side panel
 * (watch, panel) and undo (restore, clear). Read commands accept --json.
 */

/** The installed dist/ directory; hook scripts are resolved from it. */
const PKG_DIST = path.resolve(__dirname);
const PKG_ROOT = path.dirname(PKG_DIST);

function version(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf-8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ── Argument helpers ─────────────────────────────────────────────────

const argv = process.argv.slice(2);
/** The directory the CLI was started in (main() moves to the project root). */
const CALLER_CWD = process.cwd();
const JSON_OUT = argv.includes("--json");

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Positional arguments, skipping flags and the values of flags that take one. */
function positionals(args: string[], valued: string[] = []): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (valued.includes(args[i])) { i++; continue; }
    if (args[i].startsWith("--")) continue;
    out.push(args[i]);
  }
  return out;
}

function fail(msg: string, fix?: string): never {
  console.error(msg);
  if (fix) console.error(`  fix: ${fix}`);
  process.exit(1);
}

function printJson(v: unknown): void {
  console.log(JSON.stringify(v, null, 2));
}

/**
 * The project root: the nearest directory at or above cwd holding `.backupper/`, else cwd.
 * Store-reading commands run from there so relative store paths resolve.
 */
function projectRootFor(cwd: string): string {
  if (storeDirOverride()) return cwd;
  let dir = cwd;
  for (;;) {
    if (fs.existsSync(path.join(dir, ".backupper"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return cwd;
    dir = up;
  }
}

function adapterArg(name: string | undefined, fallback: AgentAdapter[] | null): AgentAdapter[] {
  if (name) {
    const a = findAdapter(name);
    if (!a) fail(`Unknown agent: ${name}`, `use one of: ${ALL_ADAPTERS.map((x) => x.name).join(", ")}`);
    return [a];
  }
  return fallback ?? [];
}

// ── Setup ────────────────────────────────────────────────────────────

/** Copy the bundled experiences into the store, keeping any file already there. */
function seedExperiences(projectRoot: string): number {
  const src = path.join(PKG_ROOT, "experiences");
  const dest = path.join(getConfigDir(projectRoot), "experiences");
  let n = 0;
  try {
    for (const f of fs.readdirSync(src).filter((x) => x.endsWith(".json"))) {
      fs.mkdirSync(dest, { recursive: true });
      const to = path.join(dest, f);
      if (!fs.existsSync(to)) { fs.copyFileSync(path.join(src, f), to); n++; }
    }
  } catch { /* no bundled experiences */ }
  return n;
}

function initProject(projectRoot: string, quiet = false): void {
  const created = ensureConfig(projectRoot);
  const seeded = seedExperiences(projectRoot);
  const ignored = ignoreStore(projectRoot);
  if (quiet) return;
  console.log(created
    ? `Created ${path.relative(projectRoot, getConfigPath(projectRoot)) || getConfigPath(projectRoot)} (mode checker)`
    : `Kept the existing ${getConfigPath(projectRoot)}`);
  if (created) {
    const models = loadConfig(projectRoot).subagentModels ?? {};
    const shown = (["claude", "codex", "hermes"] as const).map((r) => `${r}: ${models[r] || "its default"}`).join(", ");
    console.log(`Tier-4 model per runner (${shown}); override with: backupper config set subagentModel <model>`);
  }
  if (seeded) console.log(`Copied ${seeded} starter experience file(s) to .backupper/experiences/`);
  if (ignored) console.log(ignored);
  console.log("\nNext: backupper install <claude-code|codex|hermes|openhands|deepseek-harness|openclaw>, then backupper doctor");
}

function install(projectRoot: string, args: string[]): void {
  const name = positionals(args)[0] ?? "claude-code";
  const [adapter] = adapterArg(name, null);
  initProject(projectRoot, true);
  const { log } = adapter.install(projectRoot, PKG_DIST);
  console.log(`BackUpper installed for ${adapter.description.split(" (")[0]}.`);
  for (const l of log) console.log(`  ${l}`);
  console.log(`  Config: ${getConfigPath(projectRoot)}`);
  const config = loadConfig(projectRoot);
  if (config.subagentEnabled) {
    const runner = resolveRunner(config, adapter.name);
    const model = subagentModelFor(config, runner);
    console.log(`  Tier-4 subagent runs \`${runner}\`` +
      (model ? ` with model ${model} and your existing login` : " with its default model and your existing login"));
    console.log("  Change the model: backupper config set subagentModel <model>");
  }
  console.log(`\nCheck it: backupper doctor ${adapter.name}`);
}

function uninstall(projectRoot: string, args: string[]): void {
  const installed = installedAdapters(projectRoot);
  const targets = adapterArg(positionals(args)[0], installed);
  if (!targets.length) {
    console.log("No BackUpper hooks are installed in this project.");
  }
  for (const a of targets) {
    const { log } = a.uninstall(projectRoot);
    console.log(log.length ? `Uninstalled from ${a.name}:` : `Nothing to remove for ${a.name}.`);
    for (const l of log) console.log(`  ${l}`);
  }
  const store = getConfigDir(projectRoot);
  if (fs.existsSync(store)) {
    console.log(`\nYour config and recorded backups remain in ${store}` +
      (fs.existsSync(path.join(projectRoot, ".gitignore")) ? " (still listed in .gitignore)." : "."));
    console.log("Delete the backups with `backupper clear --yes`, or remove that directory yourself.");
  }
}

function doctorCommand(projectRoot: string, args: string[]): void {
  const installed = installedAdapters(projectRoot);
  const targets = adapterArg(positionals(args)[0], installed.length ? installed : [findAdapter("claude-code")!]);
  const reports = targets.map((a) => ({ agent: a.name, checks: doctor(a, projectRoot, PKG_DIST, { probe: args.includes("--probe") }) }));
  const ok = reports.every((r) => r.checks.every((c) => c.status !== "fail"));
  if (JSON_OUT) {
    printJson({ ok, project: projectRoot, version: version(), reports });
  } else {
    for (const r of reports) {
      console.log(`BackUpper ${version()} doctor: ${r.agent} (project ${projectRoot})`);
      for (const c of r.checks) {
        const tag = { ok: "[ok]  ", warn: "[warn]", fail: "[FAIL]", skip: "[skip]" }[c.status];
        console.log(`  ${tag} ${c.summary}`);
        if (c.fix && c.status !== "ok") console.log(`         fix: ${c.fix}`);
      }
      console.log();
    }
    console.log(ok ? "All required checks passed." : "Some checks failed; apply the fixes above and run doctor again.");
  }
  process.exit(ok ? 0 : 1);
}

// ── Read views ───────────────────────────────────────────────────────

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function listCommand(projectRoot: string, args: string[]): void {
  const config = loadConfig(projectRoot);
  const all = listActionSummaries(config, projectRoot);
  const limitArg = flagValue(args, "--limit") ?? positionals(args, ["--limit"])[0];
  const limit = limitArg ? parseInt(limitArg, 10) : 20;
  if (limitArg && (!Number.isInteger(limit) || limit < 1)) fail(`Invalid limit: ${limitArg}`);
  const shown = all.slice(-limit);
  if (JSON_OUT) {
    printJson({ total: all.length, actions: shown });
    return;
  }
  if (!all.length) {
    console.log("No actions recorded yet. Actions appear once a hooked agent makes a call that can change state.");
    return;
  }
  console.log(`${"#".padStart(4)}  ${"time".padEnd(19)}  ${"tiers".padEnd(7)}  action`);
  for (const a of shown) {
    const call = a.originalAction || a.toolName;
    console.log(`${String(a.seq).padStart(4)}  ${a.timeFormatted.padEnd(19)}  ${(a.tiers.join(",") || "-").padEnd(7)}  ${oneLine(call, 90)}`);
    if (a.incomplete) console.log(`${" ".repeat(34)}INCOMPLETE: not captured: ${oneLine(a.incomplete.paths.length ? a.incomplete.paths.join(", ") : a.incomplete.segments.join(" | "), 80)}`);
    if (a.instruction) console.log(`${" ".repeat(34)}asked: "${oneLine(a.instruction, 70)}"`);
  }
  if (all.length > shown.length) console.log(`(${all.length - shown.length} older action(s) hidden; use --limit ${all.length})`);
  console.log("\nDetails: backupper show <#>    Undo: backupper restore <#>");
}

const STRATEGY_TEXT: Record<string, string> = {
  policy_rewrite: "command rewritten into a reversible form",
  command_pairing: "state saved before the command ran unmodified",
  rule_copy: "copies the workspace snapshot does not hold",
  pip_freeze: "package manifest (pip freeze)",
  npm_list: "package manifest (npm list)",
  env_snapshot: "environment dump",
  git_tag: "git ref pinned",
  git_snapshot: "workspace snapshot (shadow git commit)",
  file_copy: "exact pre-image copy of the file",
  subagent: "backup subagent capture",
  learned_rule: "learned capture rule",
};

function showCommand(projectRoot: string, args: string[]): void {
  const config = loadConfig(projectRoot);
  const ref = args.includes("--latest") ? "latest" : positionals(args)[0] ?? "latest";
  const name = resolveAction(config, ref);
  if (!name) fail(actionNames(config).length ? `No action ${ref}.` : "No actions recorded yet.", "backupper list");
  const d = actionDetail(config, name, projectRoot);
  if (JSON_OUT) {
    printJson(d);
    return;
  }
  console.log(`Action #${d.seq}  ${d.timeFormatted}  (${d.name})`);
  console.log(`  Tool call:   ${oneLine(d.originalAction || d.toolName, 200)}`);
  if (d.instruction) console.log(`  Asked:       "${oneLine(d.instruction, 160)}"`);
  if (d.backupMs !== undefined) console.log(`  Added delay: ${d.backupMs} ms`);
  console.log("  Captured:");
  for (const a of d.artifacts) {
    const t = tierOf(a.strategy);
    const label = a.strategy === "policy_rewrite" && a.backupOnly
      ? "pre-state captured by a tier-1 rule (the command ran unmodified)"
      : STRATEGY_TEXT[a.strategy] ?? a.strategy;
    console.log(`    tier ${t ?? "?"}  ${label}`);
    console.log(`            ${oneLine(a.description ?? "", 160)}`);
    if (a.artifactPath && a.strategy !== "git_tag") console.log(`            stored at ${a.artifactPath}${a.commitHash ? ` @ ${a.commitHash.slice(0, 10)}` : ""}`);
    const undo = [...(a.recoveryCommands ?? []), ...(a.strategy === "subagent" ? (a.subagentCommands ?? []) : [])];
    for (const c of undo.slice(0, 5)) console.log(`            undo: ${oneLine(c, 150)}`);
    if (undo.length > 5) console.log(`            (+${undo.length - 5} more undo commands; see --json)`);
    if (a.liveRestore) console.log("            restore re-derives the reversal with a fresh subagent (live restore)");
    if (a.unverified) console.log("            UNVERIFIED: the pre-state could not be confirmed");
  }
  if (d.incomplete) {
    console.log(`  INCOMPLETE:  ${d.incomplete.reason}`);
    for (const sgm of d.incomplete.segments.slice(0, 5)) console.log(`               not captured: ${oneLine(sgm, 150)}`);
    if (d.incomplete.paths.length) console.log(`               paths a restore cannot bring back: ${oneLine(d.incomplete.paths.join(", "), 150)}`);
  }
  if (d.files.length) {
    console.log(`  Snapshot:    ${d.files.slice(0, 8).join(", ")}${d.files.length > 8 ? `, +${d.files.length - 8} more` : ""}`);
    if (d.stats) console.log(`               ${d.stats}`);
  }
  console.log(`\n  Undo this action and everything after it:  backupper restore ${d.seq}`);
  if (d.files.length) console.log(`  Restore one file from its snapshot:        backupper restore ${d.seq} --file <path>`);
}

function hookSummary(projectRoot: string): Array<{ agent: string; location: string }> {
  return installedAdapters(projectRoot).map((a) => ({ agent: a.name, location: a.hookStatus(projectRoot).location }));
}

/** Print config.json problems to stderr (the effective values fall back to defaults). */
function printConfigWarnings(projectRoot: string): string[] {
  const warnings = configWarnings(projectRoot);
  for (const w of warnings) console.error(`warning: ${w}`);
  return warnings;
}

function statusCommand(projectRoot: string): void {
  const warnings = printConfigWarnings(projectRoot);
  const config = loadConfig(projectRoot);
  const names = actionNames(config);
  const bytes = names.reduce((s, n) => s + dirSize(path.join(backupRoot(config), n)), 0);
  const hooks = hookSummary(projectRoot);
  const status = {
    version: version(),
    project: projectRoot,
    store: getConfigDir(projectRoot),
    configFile: fs.existsSync(getConfigPath(projectRoot)) ? getConfigPath(projectRoot) : null,
    enabled: config.enabled,
    mode: config.mode,
    hooks,
    subagent: config.subagentEnabled
      ? { runner: resolveRunner(config), configuredRunner: config.subagentRunner, model: subagentModelFor(config, resolveRunner(config)) || null }
      : null,
    actions: names.length,
    maxActions: config.maxActions,
    backupBytes: bytes,
    latest: names.length ? names[names.length - 1] : null,
    configWarnings: warnings,
  };
  if (JSON_OUT) {
    printJson(status);
    return;
  }
  console.log(`BackUpper ${status.version}`);
  console.log(`  Project:   ${projectRoot}`);
  console.log(`  Config:    ${status.configFile ?? "none (defaults; run backupper init)"}`);
  console.log(`  Enabled:   ${config.enabled}   mode: ${config.mode}`);
  console.log(`  Hooks:     ${hooks.length ? hooks.map((h) => `${h.agent} (${h.location})`).join(", ") : "not installed (backupper install <agent>)"}`);
  console.log(`  Tier 4:    ${status.subagent ? `\`${status.subagent.runner}\`${status.subagent.model ? ` model ${status.subagent.model}` : " default model"}${config.subagentRunner === "auto" ? " (auto)" : ""}` : "disabled"}`);
  console.log(`  Actions:   ${names.length}${config.maxActions > 0 ? ` (keeps the newest ${config.maxActions})` : ""}, ${(bytes / 1024).toFixed(1)} KB in action folders`);
}

function configCommand(projectRoot: string, args: string[]): void {
  const pos = positionals(args);
  if (pos[0] === "set") {
    const [key, ...rest] = pos.slice(1);
    if (!key || !rest.length) fail("Usage: backupper config set <key> <value>");
    let value: unknown;
    try { value = parseConfigValue(key, rest.join(" ")); } catch (e) { fail((e as Error).message); }
    saveConfig({ [key]: value } as Record<string, unknown>, projectRoot);
    console.log(`Set ${key} = ${JSON.stringify(value)} in ${getConfigPath(projectRoot)}`);
    return;
  }
  printConfigWarnings(projectRoot);
  const config = loadConfig(projectRoot);
  if (pos[0] === "get" && pos[1]) {
    const v = (config as unknown as Record<string, unknown>)[pos[1]];
    console.log(JSON_OUT ? JSON.stringify(v ?? null) : typeof v === "string" ? v : JSON.stringify(v));
    return;
  }
  const effective = config as unknown as Record<string, unknown>;
  const inFile = rawConfigKeys(projectRoot);
  // Every documented key, in the README table's order; unset keys are shown as null.
  const documented = Object.keys(CONFIG_SCHEMA);
  const settings: Record<string, unknown> = {};
  for (const k of documented) settings[k] = effective[k] ?? null;
  // Internal keys (store layout) are kept apart from the documented settings.
  const internal: Record<string, unknown> = {};
  for (const k of Object.keys(effective)) if (!documented.includes(k)) internal[k] = effective[k];
  if (JSON_OUT) {
    printJson({ ...settings, internal });
    return;
  }
  const file = fs.existsSync(getConfigPath(projectRoot)) ? getConfigPath(projectRoot) : "no config file; all defaults";
  console.log(`Effective configuration (${file}):\n`);
  const width = Math.max(...documented.map((k) => k.length));
  for (const k of documented) {
    const v = effective[k];
    const shown = v === undefined ? "(unset)" : JSON.stringify(v);
    const note = v === undefined ? "" : inFile.has(k) ? "" : "  (default)";
    console.log(`  ${k.padEnd(width)}  ${oneLine(shown, 100)}${note}`);
  }
  console.log("\nChange a key: backupper config set <key> <value>    Read one: backupper config get <key>");
}

/** Keys written in config.json (empty when absent or unparseable). */
function rawConfigKeys(projectRoot: string): Set<string> {
  try {
    const raw = JSON.parse(fs.readFileSync(getConfigPath(projectRoot), "utf-8"));
    return new Set(raw && typeof raw === "object" && !Array.isArray(raw) ? Object.keys(raw) : []);
  } catch {
    return new Set();
  }
}

function diffCommand(projectRoot: string, args: string[]): void {
  const config = loadConfig(projectRoot);
  const ref = positionals(args)[0] ?? "latest";
  const name = resolveAction(config, ref);
  if (!name) fail(actionNames(config).length ? `No action ${ref}.` : "No actions recorded yet.", "backupper list");
  let d: ReturnType<typeof snapshotDiff>;
  try {
    d = snapshotDiff(config, name, projectRoot);
  } catch (e) {
    fail(`Diff failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
  }
  if (!d) {
    if (JSON_OUT) printJson({ action: name, stat: "", diff: "", note: "no workspace snapshot in this action" });
    else console.log(`Action ${name} has no workspace snapshot to diff against.`);
    return;
  }
  if (JSON_OUT) { printJson({ action: name, ...d }); return; }
  if (!d.stat) { console.log(`No workspace changes since the snapshot of ${name}.`); return; }
  console.log(`Changes since the snapshot taken before action #${name.split("_")[1].replace(/^0+/, "")} (${d.commit.slice(0, 8)}):\n`);
  console.log(d.stat);
  console.log(`\n${d.diff}`);
}

// ── Undo ─────────────────────────────────────────────────────────────

function printRestoreResults(results: RestoreResult[]): void {
  for (const r of results) {
    console.log(`  [${r.warning ? "WARN" : r.success ? "OK" : "FAIL"}] ${r.description}`);
    if (/UNVERIFIED/i.test(r.description)) {
      console.log("       ^ recovery was re-derived from live state, not a captured snapshot; verify the result.");
    }
    if (r.subagentPrompt) {
      console.log("\n  --- Restore of out-of-workspace state needs an agent ---");
      console.log("  Give this prompt to your agent:\n");
      console.log(r.subagentPrompt.split("\n").map((l) => `    ${l}`).join("\n"));
      console.log();
    }
  }
}

async function restoreCommand(projectRoot: string, args: string[]): Promise<void> {
  const config = loadConfig(projectRoot);
  const ref = positionals(args, ["--file"])[0];
  if (!ref) {
    console.log("Pass the action to undo: backupper restore <#|last>. Recorded actions:\n");
    listCommand(projectRoot, []);
    return;
  }
  const name = resolveAction(config, ref);
  if (!name) fail(actionNames(config).length ? `No action ${ref}.` : "No actions recorded yet.", "backupper list");
  const restore = require("./restore/restore.js") as typeof import("./restore/restore.js");
  const rawFile = flagValue(args, "--file");
  // A relative --file path is relative to where the command was run, not the project root.
  const file = rawFile ? path.resolve(CALLER_CWD, rawFile) : undefined;
  let results: RestoreResult[];
  if (file) {
    console.log(`Restoring ${file} from the snapshot taken before ${name}\n`);
    results = await restore.restoreActionDirect(name, config, { fileOnly: file });
  } else if (args.includes("--direct")) {
    console.log(`Applying only the artifacts of ${name}\n`);
    results = await restore.restoreActionDirect(name, config);
  } else {
    console.log(`Undoing ${name} and every later action, newest first\n`);
    results = await restore.restoreActionLoop(name, config);
  }
  printRestoreResults(results);
  // 1: a step failed. 3: every step ran, but some state was never captured (see [WARN]).
  if (results.some((r) => !r.success)) process.exitCode = 1;
  else if (results.some((r) => r.warning)) process.exitCode = 3;
}

/** Store entries `clear` keeps: configuration and learned knowledge, not recorded backups. */
const KEEP_ON_CLEAR = new Set(["config.json", "experiences", "learned-backup-rules.json", "tool-registry.json", "panel.json"]);

function clearCommand(projectRoot: string, args: string[]): void {
  const store = getConfigDir(projectRoot);
  const entries = fs.existsSync(store) ? fs.readdirSync(store).filter((f) => !KEEP_ON_CLEAR.has(f)) : [];
  if (!entries.length) {
    console.log("Nothing to clear.");
    return;
  }
  if (!args.includes("--yes") && !args.includes("-y")) {
    console.log(`This permanently deletes the recorded backups and logs in ${store}:`);
    for (const e of entries) console.log(`  - ${e}`);
    console.log(`Kept: ${[...KEEP_ON_CLEAR].join(", ")}.`);
    console.log("\nNothing was deleted. Re-run with --yes to confirm: backupper clear --yes");
    return;
  }
  for (const e of entries) fs.rmSync(path.join(store, e), { recursive: true, force: true });
  console.log(`Removed ${entries.length} item(s) from ${store}. Hooks and config are untouched.`);
}

// ── Side panel ───────────────────────────────────────────────────────

/** argv that starts `backupper watch` from this install, independent of the pane's PATH. */
function watchArgv(): string[] {
  return [process.execPath, path.join(PKG_DIST, "cli.js"), "watch"];
}

function panelCli(projectRoot: string, action: string): void {
  const r = panelCommand(action, { projectRoot, watch: watchArgv() });
  for (const l of r.lines) console.log(l);
  if (!r.ok) process.exitCode = 1;
}

// ── Main ─────────────────────────────────────────────────────────────

const HELP = `BackUpper ${version()}: captures what an agent's tool call is about to destroy, before it runs.

Usage: backupper <command> [options]

Setup
  init                          Create .backupper/ with the default config in this project
  install <agent>               Register the hooks for claude-code | codex | hermes | openhands |
                                deepseek-harness | openclaw
  uninstall [agent]             Remove the hooks (every installed agent when none is named)
  doctor [agent] [--probe]      Check the agent, hooks, config, git and the tier-4 runner
  demo [--keep]                 Offline demo in a temporary directory (no agent, no key)
  hook <pre|post|prompt> [--agent <name>]
                                Run one hook on the JSON on stdin (what installed agents call)

Inspect
  list [--limit N]              Recorded actions, oldest first
  show <N|--latest>             What one action captured and how to undo it
  diff [N]                      Workspace changes since action N's snapshot (default: latest)
  status                        Hooks, settings and store summary
  config                        Effective value of every setting
  config get <key>              One setting's effective value
  config set <key> <value>      Change one setting

Side panel
  panel [on|off|toggle|status]  Live view of captures in a pane to the right (default: toggle)
  split                         Same as panel on
  watch [--json]                The panel itself: live action list, r restores, d diffs

Undo
  restore <N|last>              Undo action N and every action after it
  restore <N> --file <path>     Restore one path as it was before action N (snapshot, trash or outside copy)
  restore <N> --direct          Undo only action N (later actions and their backups are kept)
  clear [--yes]                 Delete recorded backups (keeps hooks and config)

Read commands (list, show, diff, status, config, doctor, demo) accept --json.
<command> --help prints that command's usage. --version prints the version.`;

/** The HELP lines for one command, for `<command> --help`. */
function commandHelp(command: string): string {
  const names = command === "history" || command === "backups" ? ["list"] : [command];
  const lines = HELP.split("\n").filter((l) => names.some((n) => l.startsWith(`  ${n} `) || l.trim() === n));
  return lines.length
    ? `Usage: backupper ${command}\n\n${lines.join("\n")}`
    : HELP;
}

async function main(): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "hook") {
    // The hook reads its subcommand from argv and runs in the agent's working directory.
    process.argv = [process.argv[0], path.join(PKG_DIST, "hook.js"), ...rest];
    require("./hook.js");
    return;
  }
  const cwd = process.cwd();
  const setup = ["init", "install", "demo", "help", "--help", "-h", "--version", "-v", undefined];
  // `<command> --help` prints usage and never acts.
  if (command && (rest.includes("--help") || rest.includes("-h"))) {
    console.log(commandHelp(command));
    return;
  }
  const projectRoot = setup.includes(command) ? cwd : projectRootFor(cwd);
  if (projectRoot !== cwd) process.chdir(projectRoot);

  switch (command) {
    case "init": initProject(projectRoot); break;
    case "install": install(projectRoot, rest); break;
    case "uninstall": uninstall(projectRoot, rest); break;
    case "doctor": doctorCommand(projectRoot, rest); break;
    case "demo": {
      process.exitCode = demo(PKG_DIST, { keep: rest.includes("--keep"), json: JSON_OUT });
      break;
    }
    case "list": case "history": case "backups": listCommand(projectRoot, rest); break;
    case "show": showCommand(projectRoot, rest); break;
    case "diff": diffCommand(projectRoot, rest); break;
    case "status": statusCommand(projectRoot); break;
    case "config": configCommand(projectRoot, rest); break;
    case "watch": {
      if (JSON_OUT) {
        const sel = flagValue(rest, "--select");
        const width = flagValue(rest, "--width");
        console.log(JSON.stringify(watchJson(projectRoot, sel ? Number(sel) : undefined, width ? Number(width) : undefined)));
      } else {
        await watch(projectRoot);
      }
      break;
    }
    case "panel": panelCli(projectRoot, positionals(rest)[0] ?? "toggle"); break;
    case "split": panelCli(projectRoot, "on"); break;
    case "restore": await restoreCommand(projectRoot, rest); break;
    case "restore_direct": await restoreCommand(projectRoot, [...rest, "--direct"]); break;
    case "clear": clearCommand(projectRoot, rest); break;
    case "--version": case "-v": console.log(version()); break;
    case undefined: case "help": case "--help": case "-h": console.log(HELP); break;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

// Only as the program: the hooks import the panel helpers from this module.
if (require.main === module) {
  main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
}
