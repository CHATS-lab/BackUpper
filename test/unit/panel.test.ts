/**
 * Tests for `backupper panel` (cli/panel.ts): terminal detection, the split/close commands and
 * the VS Code task merge. Nothing is spawned.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { closeCommand, detectTerminal, mergeVscodeTasks, parsePanelPrompt, splitCommand, VSCODE_TASK_LABEL } from "../../src/cli/panel.js";

const W = ["/usr/bin/node", "/opt/bu/dist/cli.js", "watch"];

describe("detectTerminal", () => {
  it("prefers multiplexers over the host app", () => {
    assert.equal(detectTerminal({ TMUX: "/tmp/tmux-1/default,1,0", TERM_PROGRAM: "vscode" }), "tmux");
    assert.equal(detectTerminal({ ZELLIJ: "0", TERM_PROGRAM: "iTerm.app" }), "zellij");
  });
  it("recognises each terminal", () => {
    assert.equal(detectTerminal({ TERM_PROGRAM: "vscode" }), "vscode");
    assert.equal(detectTerminal({ WEZTERM_PANE: "3" }), "wezterm");
    assert.equal(detectTerminal({ KITTY_WINDOW_ID: "1" }), "kitty");
    assert.equal(detectTerminal({ TERM_PROGRAM: "iTerm.app" }), "iterm2");
    assert.equal(detectTerminal({ TERM_PROGRAM: "Apple_Terminal" }), "unknown");
    assert.equal(detectTerminal({}), "unknown");
  });
});

describe("splitCommand", () => {
  it("tmux splits right, keeps focus and prints the pane id", () => {
    const l = splitCommand("tmux", "/work/my proj", W)!;
    assert.equal(l.cmd, "tmux");
    assert.deepEqual(l.args.slice(0, 8), ["split-window", "-h", "-d", "-P", "-F", "#{pane_id}", "-c", "/work/my proj"]);
    assert.equal(l.args[8], "/usr/bin/node /opt/bu/dist/cli.js watch");
    assert.ok(l.printsPaneId);
  });
  it("zellij, wezterm and kitty pass the argv through", () => {
    assert.deepEqual(splitCommand("zellij", "/w", W)!.args, ["run", "--direction", "right", "--close-on-exit", "--cwd", "/w", "--", ...W]);
    assert.deepEqual(splitCommand("wezterm", "/w", W)!.args, ["cli", "split-pane", "--right", "--cwd", "/w", "--", ...W]);
    assert.deepEqual(splitCommand("kitty", "/w", W)!.args, ["@", "launch", "--location=vsplit", "--keep-focus", "--cwd", "/w", ...W]);
  });
  it("iTerm2 splits vertically through AppleScript with quoted paths", () => {
    const l = splitCommand("iterm2", `/w/it's "here"`, W)!;
    assert.equal(l.cmd, "osascript");
    assert.match(l.args[1], /split vertically with default profile/);
    assert.match(l.args[1], /exec \/usr\/bin\/node \/opt\/bu\/dist\/cli\.js watch/);
    assert.match(l.args[1], /\\"here\\"/);
  });
  it("no scripted split for VS Code or unknown terminals", () => {
    assert.equal(splitCommand("vscode", "/w", W), null);
    assert.equal(splitCommand("unknown", "/w", W), null);
  });
  it("close targets exactly the recorded pane", () => {
    assert.deepEqual(closeCommand("tmux", "%7")!.args, ["kill-pane", "-t", "%7"]);
    assert.deepEqual(closeCommand("wezterm", "12")!.args, ["cli", "kill-pane", "--pane-id", "12"]);
    assert.deepEqual(closeCommand("kitty", "4")!.args, ["@", "close-window", "--match=id:4"]);
    assert.equal(closeCommand("tmux", undefined), null);
    assert.equal(closeCommand("zellij", "1"), null);
  });
});

describe("VS Code tasks.json merge", () => {
  it("creates the file when absent", () => {
    const r = mergeVscodeTasks(null, W);
    const doc = JSON.parse(r.text!);
    assert.equal(doc.version, "2.0.0");
    assert.equal(doc.tasks[0].label, VSCODE_TASK_LABEL);
    assert.equal(doc.tasks[0].command, W[0]);
    assert.equal(doc.tasks[0].presentation.group, "backupper");
  });
  it("keeps the user's tasks and is idempotent", () => {
    const mine = JSON.stringify({ version: "2.0.0", tasks: [{ label: "build", type: "shell", command: "make" }], inputs: [] });
    const once = mergeVscodeTasks(mine, W);
    const doc = JSON.parse(once.text!);
    assert.deepEqual(doc.tasks.map((t: { label: string }) => t.label), ["build", VSCODE_TASK_LABEL]);
    assert.deepEqual(doc.inputs, []);
    assert.equal(mergeVscodeTasks(once.text, W).text, null);
  });
  it("never rewrites a tasks.json it cannot parse (JSONC comments)", () => {
    const r = mergeVscodeTasks('{\n  // my tasks\n  "version": "2.0.0", "tasks": []\n}', W);
    assert.equal(r.text, null);
    assert.match(r.reason, /left untouched/);
  });
});

describe("parsePanelPrompt", () => {
  it("matches only a bare panel command", () => {
    assert.equal(parsePanelPrompt("/backupper-panel"), "toggle");
    assert.equal(parsePanelPrompt("  /backupper-panel off "), "off");
    assert.equal(parsePanelPrompt("/bu panel on"), "on");
    assert.equal(parsePanelPrompt("/backupper-panel status"), "status");
    assert.equal(parsePanelPrompt("/backupper-panel please and also delete x"), null);
    assert.equal(parsePanelPrompt("open /backupper-panel"), null);
    assert.equal(parsePanelPrompt("/backupper-list"), null);
  });
});
