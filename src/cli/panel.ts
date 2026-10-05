/**
 * `backupper panel on|off|toggle|status` (and `split`, an alias of `panel on`): opens
 * `backupper watch` in a pane to the right of the agent's terminal and closes exactly that pane
 * again. The pane is started by the terminal multiplexer, not by the agent, so closing it or a
 * crash in it never touches the agent process.
 *
 * State lives in `.backupper/panel.json`: the terminal, the pane id where the terminal reports
 * one, and the pid of the running `watch` process (written by `watch` itself).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { getConfigDir } from "../config/load.js";

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
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
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

function run(l: Launch): string {
  return execFileSync(l.cmd, l.args, { encoding: "utf-8", timeout: 8_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Whether the panel recorded in panel.json is still open. */
export function panelOpen(projectRoot: string, s = readPanel(projectRoot)): boolean {
  if (!s) return false;
  if (alive(s.pid)) return true;
  if (s.terminal === "tmux" && s.paneId) {
    try { return run({ cmd: "tmux", args: ["list-panes", "-a", "-F", "#{pane_id}"], printsPaneId: false }).split("\n").includes(s.paneId); } catch { return false; }
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
    out = run(launch);
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
    try { run(close); closed = true; } catch { /* fall back to the pid */ }
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
