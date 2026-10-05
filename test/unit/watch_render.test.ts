/**
 * Tests for the `backupper watch` renderer (view/watch.ts): store snapshot in, lines out.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ActionDetail, ActionSummary } from "../../src/view/actions.js";
import { actionRow, clip, emptyState, headlineTier, renderWatch, type WatchState } from "../../src/view/watch.js";

function action(seq: number, over: Partial<ActionSummary> = {}): ActionSummary {
  return {
    name: `action_${String(seq).padStart(3, "0")}_20261004120000`,
    seq,
    timestamp: "2026-10-04T12:00:00.000Z",
    timeFormatted: "2026-10-04 12:00:00",
    instruction: "",
    strategies: ["git_snapshot"],
    tiers: [3],
    files: ["a.txt", "b.txt"],
    stats: "",
    toolName: "Bash",
    originalAction: `echo step ${seq}`,
    sizeBytes: 0,
    ageMs: 0,
    storage: [{ strategy: "git_snapshot", path: "/s/shadow.git" }],
    ...over,
  };
}

function state(actions: ActionSummary[], over: Partial<WatchState> = {}): WatchState {
  return { ...emptyState(), project: "/work/demo", mode: "checker", storeBytes: 2048, actions, selected: actions.length - 1, ...over };
}

const plain = (s: WatchState, w = 100, h?: number) => renderWatch(s, w, h, false);

describe("watch renderer", () => {
  it("header shows project, mode, scope and store size", () => {
    const head = plain(state([]))[0];
    assert.match(head, /BackUpper · demo/);
    assert.match(head, /mode checker · Full · 2\.0 KB/);
    assert.match(plain(state([], { personalization: "high-impact" }))[0], /personalized \(high-impact\)/);
  });

  it("empty store says so", () => {
    assert.ok(plain(state([])).some((l) => /No actions recorded yet/.test(l)));
  });

  it("rows read #N <call> → Tier K <name> <artifact>, newest at the bottom", () => {
    const lines = plain(state([action(1), action(2, { strategies: ["policy_rewrite"], tiers: [1], files: [], originalAction: "rm notes.txt", storage: [{ strategy: "policy_rewrite", path: "/s/trash/notes.txt" }] })], { expanded: false }));
    const rows = lines.filter((l) => /#\d/.test(l));
    assert.match(rows[0], /#1 echo step 1 → Tier 3 snapshot 2 files$/);
    assert.match(rows[1], /^› #2 rm notes\.txt → Tier 1 command rewriting notes\.txt$/);
  });

  it("the headline tier is the most specific capture", () => {
    assert.deepEqual(headlineTier(action(1, { strategies: ["git_snapshot", "subagent"] })), { tier: 4, strategy: "subagent" });
    assert.equal(headlineTier(action(1, { strategies: [] })), null);
  });

  it("long calls are truncated to the width, colour codes excluded", () => {
    const row = actionRow(action(7, { originalAction: "x".repeat(300) }), 60, false, false);
    assert.equal(row.length, 60);
    assert.match(row, /… → Tier 3 snapshot 2 files$/);
    const colored = actionRow(action(7), 60, false, true);
    assert.match(colored, /\x1b\[33mTier 3 snapshot\x1b\[0m/);
  });

  it("detail block has MATCHED, RUNS and how to restore", () => {
    const detail: ActionDetail = {
      ...action(2),
      artifacts: [{ id: "c", timestamp: "", trigger: "rule", toolName: "Bash", description: "Snapshot of the workspace", strategy: "git_snapshot", artifactPath: "/s" }],
    };
    const lines = plain(state([action(1), action(2)], { selected: 1, detail }));
    assert.ok(!plain(state([action(1), action(2)], { selected: 0, detail })).join("\n").includes("Snapshot of the workspace"), "stale detail is ignored");
    const text = lines.join("\n");
    assert.match(text, /MATCHED\s+Tier 3 snapshot · Snapshot of the workspace/);
    assert.match(text, /RUNS\s+echo step 2/);
    assert.match(text, /RESTORE\s+press r to undo #2, or run: backupper restore 2/);
  });

  it("restore scope counts the later actions", () => {
    const text = plain(state([action(1), action(2), action(3)], { selected: 0 })).join("\n");
    assert.match(text, /press r to undo #1 and the 2 later actions/);
  });

  it("fills exactly the terminal height and keeps the selection visible", () => {
    const many = Array.from({ length: 50 }, (_, i) => action(i + 1));
    for (const selected of [0, 25, 49]) {
      const lines = plain(state(many, { selected, expanded: false }), 80, 12);
      assert.equal(lines.length, 12);
      assert.ok(lines.some((l) => l.startsWith(`› #${selected + 1} `)), `selection ${selected} visible`);
    }
    const tail = plain(state(many, { expanded: false }), 80, 12);
    assert.match(tail[1], /↑ \d+ older/);
  });

  it("confirm prompt and messages sit above the footer", () => {
    const lines = plain(state([action(1)], { confirm: "Undo #1?", message: ["[OK] restored"] }), 80, 20);
    assert.match(lines[18], /\[OK\] restored/);
    assert.match(lines[19], /Undo #1\? y = yes · n = no/);
  });

  it("diff view replaces the list and scrolls", () => {
    const diff = Array.from({ length: 40 }, (_, i) => `+line ${i}`);
    const lines = plain(state([action(1)], { diff, diffScroll: 5 }), 80, 10);
    assert.equal(lines.length, 10);
    assert.equal(lines[1], "+line 5");
    assert.match(lines[9], /d back/);
  });

  it("non-TTY snapshot prints every action", () => {
    const many = Array.from({ length: 30 }, (_, i) => action(i + 1));
    const lines = plain(state(many, { expanded: false }), 80);
    assert.equal(lines.filter((l) => /#\d+ echo/.test(l)).length, 30);
  });

  it("clip collapses whitespace", () => {
    assert.equal(clip("a\n  b", 10), "a b");
    assert.equal(clip("abcdef", 4), "abc…");
  });
});
