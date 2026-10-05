/**
 * Unit tests for the tier-1 fs-overwrite / git rules added beyond the
 * core `rm` rule: mv-overwrite, sed-in-place, truncate, and
 * git-discard-worktree. Each rule runs the destructive op inside apply()
 * and must produce recoveryCommands that exactly restore the prior state.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { applyPolicyRules } from "../../src/backup/policy_rules.js";
import type { HookContext } from "../../src/types.js";

function bash(command: string): HookContext {
  return { hook_event: "PreToolUse", tool_name: "Bash", tool_input: { command } };
}

let workspace: string;
let trash: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "backupper-pre-"));
  process.chdir(workspace);
  trash = path.join(workspace, ".trash");
});

afterEach(() => {
  process.chdir(originalCwd);
  try {
    fs.rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function recover(r: { recoveryCommands: string[] }): void {
  for (const c of r.recoveryCommands) execSync(c, { stdio: "ignore" });
}

describe("policy rule: sed-in-place", () => {
  it("snapshots and restores an in-place edit", () => {
    fs.writeFileSync("a.txt", "hello world\n");
    const r = applyPolicyRules(bash("sed -i 's/hello/goodbye/' a.txt"), trash);
    assert.ok(r && r.ruleId === "sed-in-place");
    assert.equal(fs.readFileSync("a.txt", "utf8"), "goodbye world\n");
    recover(r!);
    assert.equal(fs.readFileSync("a.txt", "utf8"), "hello world\n");
  });

  it("ignores sed without an in-place flag", () => {
    fs.writeFileSync("a.txt", "x\n");
    assert.equal(applyPolicyRules(bash("sed 's/a/b/' a.txt"), trash), null);
  });

  it("ignores sed -e (ambiguous file identification)", () => {
    fs.writeFileSync("a.txt", "x\n");
    assert.equal(applyPolicyRules(bash("sed -i -e 's/a/b/' a.txt"), trash), null);
  });
});

describe("policy rule: truncate", () => {
  it("snapshots and restores a wiped file", () => {
    fs.writeFileSync("b.txt", "some content here\n");
    const r = applyPolicyRules(bash("truncate -s 0 b.txt"), trash);
    assert.ok(r && r.ruleId === "truncate");
    assert.equal(fs.statSync("b.txt").size, 0);
    recover(r!);
    assert.equal(fs.readFileSync("b.txt", "utf8"), "some content here\n");
  });

  it("ignores truncate of a missing file", () => {
    assert.equal(applyPolicyRules(bash("truncate -s 0 nope.txt"), trash), null);
  });
});

describe("policy rule: mv-overwrite", () => {
  it("records an inverse move (no clobber)", () => {
    fs.writeFileSync("src.txt", "movable\n");
    const r = applyPolicyRules(bash("mv src.txt dst.txt"), trash);
    assert.ok(r && r.ruleId === "mv-overwrite");
    assert.ok(!fs.existsSync("src.txt"));
    assert.equal(fs.readFileSync("dst.txt", "utf8"), "movable\n");
    recover(r!);
    assert.ok(fs.existsSync("src.txt") && !fs.existsSync("dst.txt"));
  });

  it("snapshots a clobbered destination and restores both files", () => {
    fs.writeFileSync("s2.txt", "new\n");
    fs.writeFileSync("d2.txt", "OLD-original\n");
    const r = applyPolicyRules(bash("mv s2.txt d2.txt"), trash);
    assert.ok(r && r.ruleId === "mv-overwrite");
    assert.equal(fs.readFileSync("d2.txt", "utf8"), "new\n");
    recover(r!);
    assert.equal(fs.readFileSync("s2.txt", "utf8"), "new\n");
    assert.equal(fs.readFileSync("d2.txt", "utf8"), "OLD-original\n");
  });

  it("ignores compound mv commands", () => {
    fs.writeFileSync("a.txt", "x\n");
    assert.equal(applyPolicyRules(bash("mv a.txt b.txt && echo done"), trash), null);
  });
});

describe("policy rule: git-discard-worktree", () => {
  function initRepo(): void {
    execSync("git init -q && git config user.email t@t && git config user.name t");
    fs.writeFileSync("tracked.txt", "committed\n");
    execSync("git add tracked.txt && git commit -q -m init");
  }

  it("recovers a discarded edit via git restore", () => {
    initRepo();
    fs.writeFileSync("tracked.txt", "uncommitted edit\n");
    const r = applyPolicyRules(bash("git restore tracked.txt"), trash);
    assert.ok(r && r.ruleId === "git-discard-worktree");
    assert.equal(fs.readFileSync("tracked.txt", "utf8"), "committed\n");
    recover(r!);
    assert.equal(fs.readFileSync("tracked.txt", "utf8"), "uncommitted edit\n");
  });

  it("recovers a discarded edit via git checkout -- <path>", () => {
    initRepo();
    fs.writeFileSync("tracked.txt", "another edit\n");
    const r = applyPolicyRules(bash("git checkout -- tracked.txt"), trash);
    assert.ok(r && r.ruleId === "git-discard-worktree");
    recover(r!);
    assert.equal(fs.readFileSync("tracked.txt", "utf8"), "another edit\n");
  });

  it("does NOT intercept a branch switch", () => {
    initRepo();
    execSync("git checkout -q -b feature");
    assert.equal(applyPolicyRules(bash("git checkout main"), trash), null);
  });
});
