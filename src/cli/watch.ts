/**
 * `backupper watch`: a live, read-only terminal view of `.backupper/`, meant for a side pane
 * next to the agent (`backupper panel on`). It never writes to the store except for an explicit
 * `r` restore confirmed with `y`. Without a TTY it prints one snapshot and exits.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { getConfigDir, loadConfig } from "../config/load.js";
import { dirSize } from "../backup/strategies.js";
import type { SandboxConfig } from "../types.js";
import { actionDetail, actionNames, backupRoot, snapshotDiff, summarizeAction, type ActionSummary } from "../view/actions.js";
import { emptyState, renderWatch, type WatchState } from "../view/watch.js";
import { registerWatchPid } from "./panel.js";

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
      const { restoreActionLoop } = require("../restore/restore.js") as typeof import("../restore/restore.js");
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
    if ((key?.ctrl && name === "c") || name === "q") { quit(); return; }
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
