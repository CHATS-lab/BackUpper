/**
 * Rules: the rule engine, the tier-1 command-rewriting policy rules, and the guard against foreign execution targets.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../../src/engine.js";
import { DEFAULT_CONFIG, type HookContext, type SandboxConfig } from "../../src/types.js";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { applyPolicyRules, foreignExecTarget, execTargetIsSelf } from "../../src/backup/policy_rules.js";
import { isDangerousRecoveryCommand } from "../../src/restore/restore.js";

/** In-place sed for this platform: BSD/macOS sed takes the suffix as a separate argument. */
const SED_I = process.platform === "darwin" ? "sed -i ''" : "sed -i";

// Each section below was a test file of its own. Its root-level hooks apply only to its
// own top-level suites (onlyIn), and a root-level before() runs once, before the first of
// them (onceIn), so a hook never runs for another section's tests.
function inSuites(suites: string[], t: unknown): boolean {
  const name = (t as { fullName: string }).fullName;
  return suites.some((s) => name === s || name.startsWith(s + " > "));
}
function onlyIn(suites: string[], fn: () => unknown): (t: unknown) => unknown {
  return (t) => (inSuites(suites, t) ? fn() : undefined);
}
function onceIn(suites: string[], fn: () => unknown): (t: unknown) => unknown {
  let done = false;
  return (t) => {
    if (done || !inSuites(suites, t)) return undefined;
    done = true;
    return fn();
  };
}

// =============================================================================
// ── rules ──
// =============================================================================

/**
 * Tests for the rule engine (engine.ts).
 */

function makeCtx(toolName: string, toolInput: Record<string, unknown>): HookContext {
  return { hook_event: "PreToolUse", tool_name: toolName, tool_input: toolInput };
}

function cfg(overrides?: Partial<SandboxConfig>): SandboxConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

// ── Precaution field ─────────────────────────────────────────────────

describe("precaution field", () => {
  it("triggers backup when precaution=true", () => {
    const r = evaluate(makeCtx("Bash", { command: "make deploy", precaution: true }), cfg());
    assert.equal(r.decision, "backup");
    assert.equal(r.trigger, "precaution_field");
  });

  it("triggers backup when precaution='true' (string)", () => {
    const r = evaluate(makeCtx("Bash", { command: "make deploy", precaution: "true" }), cfg());
    assert.equal(r.decision, "backup");
    assert.equal(r.trigger, "precaution_field");
  });

  it("does not trigger on precaution=false", () => {
    const r = evaluate(makeCtx("Bash", { command: "ls" }), cfg());
    assert.notEqual(r.trigger, "precaution_field");
  });
});

// ── Read-only tools ──────────────────────────────────────────────────

describe("read-only tools", () => {
  for (const tool of ["Read", "read_file", "Glob", "Grep", "WebSearch", "WebFetch"]) {
    it(`passes through ${tool}`, () => {
      const r = evaluate(makeCtx(tool, {}), cfg());
      assert.equal(r.decision, "pass");
    });
  }
});

// ── backupper CLI commands ────────────────────────────────────────

describe("backupper CLI commands", () => {
  for (const cmd of [
    "backupper status",
    "backupper restore 1",
    "backupper restore_direct 2",
    "backupper history",
    "backupper clear",
    "backupper diff 1",
    "backupper config",
  ]) {
    it(`passes through "${cmd}"`, () => {
      const r = evaluate(makeCtx("Bash", { command: cmd }), cfg());
      assert.equal(r.decision, "pass", `Expected pass for "${cmd}", got ${r.decision}: ${r.reason}`);
    });
  }
});

// ── File-mutating tools ──────────────────────────────────────────────

describe("file-mutating tools", () => {
  for (const tool of ["FileEdit", "Write", "write_file", "patch", "NotebookEdit"]) {
    it(`backs up ${tool}`, () => {
      const r = evaluate(makeCtx(tool, { path: "/some/file.py" }), cfg());
      assert.equal(r.decision, "backup");
      assert.equal(r.trigger, "backup_rule");
    });
  }
});

// ── Rule-based patterns ──────────────────────────────────────────────

describe("backup patterns", () => {
  const cases: Array<[string, string]> = [
    ["rm file.txt", "rm\\s"],
    ["git push origin main", "git\\s+push"],
    ["git rebase main", "git\\s+rebase"],
    ["pip install flask", "pip\\s+install"],
    ["npm uninstall lodash", "npm\\s+uninstall"],
    ["apt install curl", "apt\\s+install"],
    ["DROP TABLE users", "DROP\\s+TABLE"],
  ];

  for (const [cmd, pattern] of cases) {
    it(`backs up "${cmd}" (matched ${pattern})`, () => {
      const r = evaluate(makeCtx("Bash", { command: cmd }), cfg());
      assert.equal(r.decision, "backup");
      assert.equal(r.trigger, "backup_rule");
    });
  }
});

// ── Default backup ───────────────────────────────────────────────────

describe("default backup", () => {
  it("backs up unknown commands in checker mode", () => {
    const r = evaluate(makeCtx("Bash", { command: "some-unknown-tool --do-stuff" }), cfg());
    assert.equal(r.decision, "backup");
    assert.equal(r.trigger, "default_backup");
  });

  it("backs up unknown tools", () => {
    const r = evaluate(makeCtx("SomeNewTool", { data: "foo" }), cfg());
    assert.equal(r.decision, "backup");
    assert.equal(r.trigger, "default_backup");
  });
});

// ── mode off ─────────────────────────────────────────────────────────

describe('mode="off"', () => {
  it("passes everything when off", () => {
    const r = evaluate(makeCtx("Bash", { command: "rm important.txt" }), cfg({ mode: "off" }));
    assert.equal(r.decision, "pass");
  });
});

// =============================================================================
// ── policy rules extra ──
// =============================================================================

/**
 * Unit tests for the tier-1 fs-overwrite / git rules added beyond the
 * core `rm` rule: mv-overwrite, sed-in-place, truncate, and
 * git-discard-worktree. Each rule runs the destructive op inside apply()
 * and must produce recoveryCommands that exactly restore the prior state.
 */

const SUITES_POLICY_RULES_EXTRA = ["policy rule: sed-in-place", "policy rule: truncate", "policy rule: mv-overwrite", "policy rule: git-discard-worktree"];
function bash(command: string): HookContext {
  return { hook_event: "PreToolUse", tool_name: "Bash", tool_input: { command } };
}

let workspace: string;
let trash: string;
let originalCwd: string;

beforeEach(onlyIn(SUITES_POLICY_RULES_EXTRA, () => {
  originalCwd = process.cwd();
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "backupper-pre-"));
  process.chdir(workspace);
  trash = path.join(workspace, ".trash");
}));

afterEach(onlyIn(SUITES_POLICY_RULES_EXTRA, () => {
  process.chdir(originalCwd);
  try {
    fs.rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}));

function recover(r: { recoveryCommands: string[] }): void {
  for (const c of r.recoveryCommands) execSync(c, { stdio: "ignore" });
}

describe("policy rule: sed-in-place", () => {
  it("snapshots and restores an in-place edit", () => {
    fs.writeFileSync("a.txt", "hello world\n");
    const r = applyPolicyRules(bash(`${SED_I} 's/hello/goodbye/' a.txt`), trash);
    assert.ok(r && r.ruleId === "sed-in-place");
    assert.equal(fs.readFileSync("a.txt", "utf8"), "goodbye world\n");
    recover(r!);
    assert.equal(fs.readFileSync("a.txt", "utf8"), "hello world\n");
  });

  it("ignores sed without an in-place flag", () => {
    fs.writeFileSync("a.txt", "x\n");
    assert.equal(applyPolicyRules(bash("sed 's/a/b/' a.txt"), trash), null);
  });

  it("recognises the BSD form `sed -i ''`", () => {
    fs.writeFileSync("a.txt", "hello world\n");
    const r = applyPolicyRules(bash("sed -i '' 's/hello/goodbye/' a.txt"), trash, undefined, { rewrite: false });
    assert.ok(r && r.ruleId === "sed-in-place", `expected sed-in-place, got ${r?.ruleId}`);
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

// =============================================================================
// ── policy rules gaps ──
// =============================================================================

/**
 * Tier-1 rules for further destructive commands:
 * git-clean, git-worktree-remove-force, rsync-delete, find-delete,
 * shell-truncate, helm-uninstall, and the recursive (`-R`) forms of
 * chmod / chown.
 *
 * Every case proves BOTH directions, because a rule that only neutralises
 * the command is worse than no rule at all:
 *   1. the destructive command is intercepted (state is gone / changed
 *      exactly as the agent expects), and
 *   2. running the RECORDED recoveryCommands verbatim puts the prior
 *      state back.
 *
 * Same shape as the policy_rules_extra section above.
 */

{
const SUITES_POLICY_RULES_GAPS = ["policy rule: git-clean", "policy rule: git-worktree-remove-force", "policy rule: rsync-delete", "policy rule: find-delete", "policy rule: shell-truncate", "policy rule: helm-uninstall", "policy rule: chmod -R", "policy rule: chown -R"];
function bash(command: string): HookContext {
  return { hook_event: "PreToolUse", tool_name: "Bash", tool_input: { command } };
}

let workspace: string;
let trash: string;
let originalCwd: string;
let originalPath: string;

beforeEach(onlyIn(SUITES_POLICY_RULES_GAPS, () => {
  originalCwd = process.cwd();
  originalPath = process.env.PATH ?? "";
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "backupper-gap-"));
  process.chdir(workspace);
  trash = path.join(workspace, ".trash");
}));

afterEach(onlyIn(SUITES_POLICY_RULES_GAPS, () => {
  process.chdir(originalCwd);
  process.env.PATH = originalPath;
  try {
    fs.rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}));

function recover(r: { recoveryCommands: string[] }): void {
  for (const c of r.recoveryCommands) {
    // `backupper restore` screens every recovery command through this
    // guard before running it. A rule whose own inverse looks dangerous
    // (a trash filename containing "find … -delete", say) would be
    // refused at restore time and the test below would never notice, so
    // assert it here on every recovery path.
    assert.equal(
      isDangerousRecoveryCommand(c),
      false,
      `recovery command would be refused by the restore guard: ${c}`,
    );
    execSync(c, { stdio: "ignore" });
  }
}

function initRepo(): void {
  execSync("git init -q -b main && git config user.email t@t && git config user.name t");
  fs.writeFileSync("tracked.txt", "committed\n");
  execSync("git add tracked.txt && git commit -q -m init");
}

// ── git clean ────────────────────────────────────────────────────────

describe("policy rule: git-clean", () => {
  it("moves untracked files/dirs to trash and restores them", () => {
    initRepo();
    fs.writeFileSync("junk.log", "scratch output\n");
    fs.mkdirSync("build", { recursive: true });
    fs.writeFileSync(path.join("build", "out.bin"), "artifact\n");

    const r = applyPolicyRules(bash("git clean -fd"), trash);
    assert.ok(r && r.ruleId === "git-clean", `expected git-clean, got ${r?.ruleId}`);
    // Destructive effect really happened.
    assert.ok(!fs.existsSync("junk.log"));
    assert.ok(!fs.existsSync("build"));
    // Tracked content untouched.
    assert.equal(fs.readFileSync("tracked.txt", "utf8"), "committed\n");
    // The rewritten command is a no-op.
    assert.match(String(r!.updatedInput?.command), /^true\b/);

    recover(r!);
    assert.equal(fs.readFileSync("junk.log", "utf8"), "scratch output\n");
    assert.equal(fs.readFileSync(path.join("build", "out.bin"), "utf8"), "artifact\n");
  });

  it("respects -e excludes when enumerating victims", () => {
    initRepo();
    fs.writeFileSync("a.log", "a\n");
    fs.writeFileSync("keep.me", "k\n");

    const r = applyPolicyRules(bash("git clean -fd -e keep.me"), trash);
    assert.ok(r && r.ruleId === "git-clean");
    assert.ok(!fs.existsSync("a.log"));
    assert.equal(fs.readFileSync("keep.me", "utf8"), "k\n");
    recover(r!);
    assert.equal(fs.readFileSync("a.log", "utf8"), "a\n");
  });

  it("ignores a dry run (-n) — nothing is destroyed", () => {
    initRepo();
    fs.writeFileSync("junk.log", "x\n");
    assert.equal(applyPolicyRules(bash("git clean -nd"), trash), null);
    assert.ok(fs.existsSync("junk.log"));
  });

  it("ignores git clean without -f (git refuses it anyway)", () => {
    initRepo();
    fs.writeFileSync("junk.log", "x\n");
    assert.equal(applyPolicyRules(bash("git clean -d"), trash), null);
  });

  it("ignores git clean with nothing to remove", () => {
    initRepo();
    assert.equal(applyPolicyRules(bash("git clean -fd"), trash), null);
  });
});

// ── git worktree remove --force ──────────────────────────────────────

describe("policy rule: git-worktree-remove-force", () => {
  it("snapshots untracked worktree content and restores it", () => {
    initRepo();
    execSync("git worktree add -q -b side wt", { stdio: "ignore" });
    // A common shape: agent session transcripts live untracked inside
    // the worktree and are exactly what --force throws away.
    fs.mkdirSync(path.join("wt", ".claude"), { recursive: true });
    fs.writeFileSync(path.join("wt", ".claude", "session.md"), "transcript\n");

    const r = applyPolicyRules(bash("git worktree remove --force wt"), trash);
    assert.ok(
      r && r.ruleId === "git-worktree-remove-force",
      `expected git-worktree-remove-force, got ${r?.ruleId}`,
    );
    assert.ok(!fs.existsSync("wt"), "worktree dir should be gone");

    recover(r!);
    assert.equal(
      fs.readFileSync(path.join("wt", ".claude", "session.md"), "utf8"),
      "transcript\n",
    );
    assert.equal(fs.readFileSync(path.join("wt", "tracked.txt"), "utf8"), "committed\n");
    // Re-registered as a real worktree, not a loose copy.
    const list = execSync("git worktree list", { encoding: "utf8" });
    assert.match(list, /wt\b/);
  });

  it("ignores a non-forced remove (git refuses to lose untracked content)", () => {
    initRepo();
    execSync("git worktree add -q -b side2 wt2", { stdio: "ignore" });
    assert.equal(applyPolicyRules(bash("git worktree remove wt2"), trash), null);
    assert.ok(fs.existsSync("wt2"));
  });

  it("ignores `git worktree list`", () => {
    initRepo();
    assert.equal(applyPolicyRules(bash("git worktree list"), trash), null);
  });
});

// ── rsync --delete ───────────────────────────────────────────────────

describe("policy rule: rsync-delete", () => {
  function setupTrees(): void {
    fs.mkdirSync("src", { recursive: true });
    fs.mkdirSync(path.join("dst", "nested"), { recursive: true });
    fs.writeFileSync(path.join("src", "new.txt"), "from source\n");
    fs.writeFileSync(path.join("dst", "doomed.txt"), "only in dest\n");
    fs.writeFileSync(path.join("dst", "nested", "deep.txt"), "deep\n");
  }

  it("snapshots the destination tree and restores it after --delete", () => {
    setupTrees();
    const r = applyPolicyRules(bash("rsync -a --delete src/ dst/"), trash);
    assert.ok(r && r.ruleId === "rsync-delete", `expected rsync-delete, got ${r?.ruleId}`);
    // The sync really ran: dest now mirrors src.
    assert.ok(!fs.existsSync(path.join("dst", "doomed.txt")));
    assert.ok(!fs.existsSync(path.join("dst", "nested")));
    assert.equal(fs.readFileSync(path.join("dst", "new.txt"), "utf8"), "from source\n");

    recover(r!);
    assert.equal(fs.readFileSync(path.join("dst", "doomed.txt"), "utf8"), "only in dest\n");
    assert.equal(fs.readFileSync(path.join("dst", "nested", "deep.txt"), "utf8"), "deep\n");
    // Files the sync ADDED are removed again by the inverse --delete.
    assert.ok(!fs.existsSync(path.join("dst", "new.txt")));
  });

  it("ignores rsync without a delete flag", () => {
    setupTrees();
    assert.equal(applyPolicyRules(bash("rsync -a src/ dst/"), trash), null);
  });

  it("ignores an rsync --delete dry run", () => {
    setupTrees();
    assert.equal(applyPolicyRules(bash("rsync -an --delete src/ dst/"), trash), null);
    assert.ok(fs.existsSync(path.join("dst", "doomed.txt")));
  });

  it("ignores a remote destination (tier 4's job, not ours)", () => {
    setupTrees();
    assert.equal(
      applyPolicyRules(bash("rsync -a --delete src/ backup-host:/srv/dst/"), trash),
      null,
    );
  });
});

// ── find … -delete / -exec rm ────────────────────────────────────────

describe("policy rule: find-delete", () => {
  function setupTree(): void {
    fs.mkdirSync(path.join("data", "sub"), { recursive: true });
    fs.writeFileSync(path.join("data", "a.log"), "aaa\n");
    fs.writeFileSync(path.join("data", "sub", "b.log"), "bbb\n");
    fs.writeFileSync(path.join("data", "keep.txt"), "keep\n");
  }

  it("moves `-delete` victims to trash and restores them", () => {
    setupTree();
    const r = applyPolicyRules(bash("find data -name '*.log' -delete"), trash);
    assert.ok(r && r.ruleId === "find-delete", `expected find-delete, got ${r?.ruleId}`);
    assert.ok(!fs.existsSync(path.join("data", "a.log")));
    assert.ok(!fs.existsSync(path.join("data", "sub", "b.log")));
    assert.equal(fs.readFileSync(path.join("data", "keep.txt"), "utf8"), "keep\n");

    recover(r!);
    assert.equal(fs.readFileSync(path.join("data", "a.log"), "utf8"), "aaa\n");
    assert.equal(fs.readFileSync(path.join("data", "sub", "b.log"), "utf8"), "bbb\n");
  });

  it("handles `-exec rm {} \\;` the same way", () => {
    setupTree();
    const r = applyPolicyRules(bash("find data -name '*.log' -exec rm {} \\;"), trash);
    assert.ok(r && r.ruleId === "find-delete", `expected find-delete, got ${r?.ruleId}`);
    assert.ok(!fs.existsSync(path.join("data", "a.log")));
    recover(r!);
    assert.equal(fs.readFileSync(path.join("data", "a.log"), "utf8"), "aaa\n");
  });

  it("restores a whole subtree removed via `-exec rm -rf {} +`", () => {
    setupTree();
    const r = applyPolicyRules(bash("find data -name sub -exec rm -rf {} +"), trash);
    assert.ok(r && r.ruleId === "find-delete", `expected find-delete, got ${r?.ruleId}`);
    assert.ok(!fs.existsSync(path.join("data", "sub")));
    recover(r!);
    assert.equal(fs.readFileSync(path.join("data", "sub", "b.log"), "utf8"), "bbb\n");
  });

  it("ignores a read-only find", () => {
    setupTree();
    assert.equal(applyPolicyRules(bash("find data -name '*.log' -print"), trash), null);
    assert.ok(fs.existsSync(path.join("data", "a.log")));
  });

  it("ignores -exec with a command that is not rm", () => {
    setupTree();
    assert.equal(
      applyPolicyRules(bash("find data -name '*.log' -exec grep -l x {} \\;"), trash),
      null,
    );
  });

  it("bails on a non-empty directory that `-delete` could not have removed", () => {
    setupTree();
    // `find … -delete` fails on a non-empty dir; moving the whole subtree
    // would destroy MORE than the command would have.
    assert.equal(applyPolicyRules(bash("find data -name sub -delete"), trash), null);
    assert.ok(fs.existsSync(path.join("data", "sub", "b.log")));
  });
});

// ── `> file` / `: > file` truncation ─────────────────────────────────

describe("policy rule: shell-truncate", () => {
  it("snapshots and restores a `> file` truncation", () => {
    fs.writeFileSync("app.log", "important log lines\n");
    const r = applyPolicyRules(bash("> app.log"), trash);
    assert.ok(r && r.ruleId === "shell-truncate", `expected shell-truncate, got ${r?.ruleId}`);
    assert.equal(fs.statSync("app.log").size, 0);
    recover(r!);
    assert.equal(fs.readFileSync("app.log", "utf8"), "important log lines\n");
  });

  it("handles the `: > file` spelling", () => {
    fs.writeFileSync("app.log", "content\n");
    const r = applyPolicyRules(bash(": > app.log"), trash);
    assert.ok(r && r.ruleId === "shell-truncate");
    assert.equal(fs.statSync("app.log").size, 0);
    recover(r!);
    assert.equal(fs.readFileSync("app.log", "utf8"), "content\n");
  });

  it("ignores a redirect that creates a NEW file (nothing is lost)", () => {
    assert.equal(applyPolicyRules(bash("> fresh.log"), trash), null);
  });

  it("ignores a redirect that carries data (not a truncation)", () => {
    fs.writeFileSync("app.log", "content\n");
    assert.equal(applyPolicyRules(bash("echo hi > app.log"), trash), null);
  });
});

// ── helm uninstall ───────────────────────────────────────────────────

/**
 * A stub `helm` on PATH backed by a JSON state file. Real helm is not
 * available in CI, and the point under test is OUR contract: dump the
 * release, uninstall in a form that keeps history, and record a rollback
 * that actually reinstates it.
 */
function installHelmStub(dir: string, stateFile: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    stateFile,
    JSON.stringify({ status: "deployed", revision: 3, keptHistory: false }),
  );
  const script = `#!/bin/sh
STATE=${JSON.stringify(stateFile)}
sub="$1"; shift
case "$sub" in
  history)
    echo '[{"revision":1},{"revision":2},{"revision":3}]' ;;
  get)
    echo "NAME: myrel"; echo "REVISION: 3" ;;
  uninstall|delete|del)
    keep=no
    for a in "$@"; do [ "$a" = "--keep-history" ] && keep=yes; done
    if [ "$keep" = no ]; then
      printf '{"status":"gone","revision":0,"keptHistory":false}' > "$STATE"
    else
      printf '{"status":"uninstalled","revision":3,"keptHistory":true}' > "$STATE"
    fi ;;
  rollback)
    [ "$(cat "$STATE")" = '{"status":"uninstalled","revision":3,"keptHistory":true}' ] || exit 1
    printf '{"status":"deployed","revision":4,"keptHistory":true}' > "$STATE" ;;
  *) exit 1 ;;
esac
exit 0
`;
  const p = path.join(dir, "helm");
  fs.writeFileSync(p, script, { mode: 0o755 });
  process.env.PATH = `${dir}${path.delimiter}${process.env.PATH ?? ""}`;
}

describe("policy rule: helm-uninstall", () => {
  it("keeps history on uninstall and rolls the release back on restore", () => {
    const stateFile = path.join(workspace, "helm-state.json");
    installHelmStub(path.join(workspace, "stubbin"), stateFile);

    const r = applyPolicyRules(bash("helm uninstall myrel -n prod"), trash);
    assert.ok(r && r.ruleId === "helm-uninstall", `expected helm-uninstall, got ${r?.ruleId}`);
    // The uninstall really ran, in the reversible form.
    const after = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(after.status, "uninstalled");
    assert.equal(after.keptHistory, true);
    // `helm get all` was dumped into the action trash.
    const dumped = fs.readdirSync(trash).filter((f) => f.startsWith("helm-"));
    assert.equal(dumped.length, 1, `expected one helm dump, got ${dumped.join(",")}`);
    assert.match(fs.readFileSync(path.join(trash, dumped[0]), "utf8"), /NAME: myrel/);
    // Inverse targets the last recorded revision.
    assert.deepEqual(r!.recoveryCommands, ["helm rollback myrel 3 -n prod"]);

    recover(r!);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).status, "deployed");
  });

  it("ignores a helm uninstall dry run", () => {
    const stateFile = path.join(workspace, "helm-state.json");
    installHelmStub(path.join(workspace, "stubbin"), stateFile);
    assert.equal(applyPolicyRules(bash("helm uninstall myrel --dry-run"), trash), null);
  });

  it("ignores a multi-release uninstall (no partial inverses)", () => {
    const stateFile = path.join(workspace, "helm-state.json");
    installHelmStub(path.join(workspace, "stubbin"), stateFile);
    assert.equal(applyPolicyRules(bash("helm uninstall relA relB"), trash), null);
  });
});

// ── chmod -R / chown -R ──────────────────────────────────────────────

function modeOf(p: string): string {
  return (fs.statSync(p).mode & 0o7777).toString(8);
}

describe("policy rule: chmod -R", () => {
  function setupTree(): void {
    fs.mkdirSync(path.join("tree", "sub"), { recursive: true });
    fs.writeFileSync(path.join("tree", "a.sh"), "#!/bin/sh\n");
    fs.writeFileSync(path.join("tree", "sub", "b.conf"), "k=v\n");
    fs.chmodSync("tree", 0o755);
    fs.chmodSync(path.join("tree", "a.sh"), 0o750);
    fs.chmodSync(path.join("tree", "sub"), 0o700);
    fs.chmodSync(path.join("tree", "sub", "b.conf"), 0o640);
  }

  it("records every mode in the subtree and restores them all", () => {
    setupTree();
    const r = applyPolicyRules(bash("chmod -R 777 tree"), trash);
    assert.ok(r && r.ruleId === "chmod", `expected chmod, got ${r?.ruleId}`);
    assert.match(r!.description, /chmod -R \(4 entries/);
    // chmod is record-and-pass: the agent's own command still runs.
    execSync("chmod -R 777 tree");
    assert.equal(modeOf(path.join("tree", "a.sh")), "777");

    recover(r!);
    assert.equal(modeOf("tree"), "755");
    assert.equal(modeOf(path.join("tree", "a.sh")), "750");
    assert.equal(modeOf(path.join("tree", "sub")), "700");
    assert.equal(modeOf(path.join("tree", "sub", "b.conf")), "640");
  });

  it("records the subtree without GNU find (macOS)", () => {
    setupTree();
    const shim = fs.mkdtempSync(path.join(os.tmpdir(), "bu-bsd-"));
    fs.writeFileSync(path.join(shim, "find"), "#!/bin/sh\necho 'find: -printf: unknown primary or operator' >&2\nexit 1\n", { mode: 0o755 });
    const saved = process.env.PATH;
    process.env.PATH = `${shim}:${saved}`;
    try {
      const r = applyPolicyRules(bash("chmod -R 777 tree"), trash);
      assert.ok(r && r.ruleId === "chmod", `expected chmod, got ${r?.ruleId}`);
      assert.match(r!.description, /chmod -R \(4 entries/);
    } finally {
      process.env.PATH = saved;
      fs.rmSync(shim, { recursive: true, force: true });
    }
  });

  it("still handles the non-recursive form per path", () => {
    setupTree();
    const r = applyPolicyRules(bash("chmod 600 tree/a.sh"), trash);
    assert.ok(r && r.ruleId === "chmod");
    execSync("chmod 600 tree/a.sh");
    recover(r!);
    assert.equal(modeOf(path.join("tree", "a.sh")), "750");
  });

  it("bails on a tree it cannot enumerate", () => {
    assert.equal(applyPolicyRules(bash("chmod -R 777 no-such-tree"), trash), null);
  });
});

describe("policy rule: chown -R", () => {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

  function setupTree(): void {
    fs.mkdirSync(path.join("otree", "sub"), { recursive: true });
    fs.writeFileSync(path.join("otree", "a.txt"), "a\n");
    fs.writeFileSync(path.join("otree", "sub", "b.txt"), "b\n");
  }

  it("records every owner in the subtree as an exact inverse script", () => {
    setupTree();
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    const r = applyPolicyRules(bash("chown -R 12345:12345 otree"), trash);
    assert.ok(r && r.ruleId === "chown", `expected chown, got ${r?.ruleId}`);
    assert.match(r!.description, /chown -R \(4 entries/);
    assert.equal(r!.recoveryCommands.length, 1);
    const scriptPath = r!.recoveryCommands[0].replace(/^sh /, "").replace(/^'|'$/g, "");
    const script = fs.readFileSync(scriptPath, "utf8");
    for (const rel of ["otree", "otree/a.txt", "otree/sub", "otree/sub/b.txt"]) {
      const abs = path.resolve(workspace, rel);
      assert.ok(
        script.includes(`chown ${uid}:${gid} ${abs}`) ||
          script.includes(`chown ${uid}:${gid} '${abs}'`),
        `script should re-own ${abs}\n${script}`,
      );
    }
  });

  it("restores ownership after the chown actually ran", { skip: !isRoot }, () => {
    setupTree();
    const uid = process.getuid?.() ?? 0;
    const r = applyPolicyRules(bash("chown -R 12345:12345 otree"), trash);
    assert.ok(r && r.ruleId === "chown");
    execSync("chown -R 12345:12345 otree");
    assert.equal(fs.statSync(path.join("otree", "a.txt")).uid, 12345);
    recover(r!);
    assert.equal(fs.statSync(path.join("otree", "a.txt")).uid, uid);
    assert.equal(fs.statSync("otree").uid, uid);
  });
});
}

// =============================================================================
// ── exec target guard ──
// =============================================================================

/**
 * Tier-1 host-hazard guard.
 *
 * Tier-1 policy rules do not describe a rewrite, they PERFORM it — `mv`,
 * `cp`, `git stash` — inside the hook process, against the hook process's
 * own filesystem, and then no-op the agent's command. That is only sound
 * when the agent's tool calls land on that same filesystem.
 *
 * When the host agent uses a container/ssh terminal backend
 * (hermes `TERMINAL_ENV=docker`) the hook still runs on the HOST. A tier-1
 * match would then delete/move the HOST's files while the container the
 * agent is really driving stays untouched. These tests pin the fail-safe:
 * the rule must NOT execute, the file must survive, and the caller must get
 * null so the agent's original command passes through unmodified.
 */

{
const SUITES_EXEC_TARGET_GUARD = ["foreignExecTarget", "tier-1 refuses to act on a foreign execution target"];
function bash(command: string): HookContext {
  return { hook_event: "PreToolUse", tool_name: "Bash", tool_input: { command } };
}

let workspace: string;
let trash: string;
let originalCwd: string;
const SAVED = {
  TERMINAL_ENV: process.env.TERMINAL_ENV,
  BACKUPPER_EXEC_TARGET: process.env.BACKUPPER_EXEC_TARGET,
  BACKUPPER_REMOTE_EXEC: process.env.BACKUPPER_REMOTE_EXEC,
};

function restoreEnv(): void {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(onlyIn(SUITES_EXEC_TARGET_GUARD, () => {
  originalCwd = process.cwd();
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "backupper-exec-"));
  process.chdir(workspace);
  // .backupper/backups/action_001/trash — the shape strategies.ts passes,
  // so the refusal log lands in .backupper/tier1-skipped.log.
  trash = path.join(workspace, ".backupper", "backups", "action_001", "trash");
  restoreEnv();
  delete process.env.TERMINAL_ENV;
  delete process.env.BACKUPPER_EXEC_TARGET;
  delete process.env.BACKUPPER_REMOTE_EXEC;
}));

afterEach(onlyIn(SUITES_EXEC_TARGET_GUARD, () => {
  restoreEnv();
  process.chdir(originalCwd);
  try {
    fs.rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}));

describe("foreignExecTarget", () => {
  it("reports local when nothing says otherwise", () => {
    assert.equal(foreignExecTarget(), null);
    assert.equal(execTargetIsSelf(), true);
  });

  it("treats hermes TERMINAL_ENV=local as this filesystem", () => {
    process.env.TERMINAL_ENV = "local";
    assert.equal(foreignExecTarget(), null);
  });

  it("flags every non-local hermes terminal backend", () => {
    for (const backend of ["docker", "ssh", "modal", "singularity", "daytona"]) {
      process.env.TERMINAL_ENV = backend;
      const f = foreignExecTarget();
      assert.ok(f, `${backend} must be reported as foreign`);
      assert.equal(f.backend, backend);
      assert.equal(f.source, "TERMINAL_ENV");
    }
  });

  it("honours the explicit override in both directions", () => {
    process.env.TERMINAL_ENV = "docker";
    process.env.BACKUPPER_EXEC_TARGET = "local";
    assert.equal(foreignExecTarget(), null, "explicit 'local' wins over TERMINAL_ENV");
    process.env.BACKUPPER_EXEC_TARGET = "k8s-pod";
    assert.equal(foreignExecTarget()?.backend, "k8s-pod");
  });

  it("honours the generic remote-exec flag", () => {
    process.env.BACKUPPER_REMOTE_EXEC = "1";
    assert.equal(foreignExecTarget()?.source, "BACKUPPER_REMOTE_EXEC");
  });
});

describe("tier-1 refuses to act on a foreign execution target", () => {
  it("rm-to-trash DELETES the local file when execution is local (control)", () => {
    fs.writeFileSync("victim.txt", "host data\n");
    const r = applyPolicyRules(bash("rm -rf victim.txt"), trash);
    assert.ok(r, "control: the rule is expected to fire when exec is local");
    assert.equal(fs.existsSync("victim.txt"), false, "control: file was moved to trash");
  });

  it("rm-to-trash leaves the HOST file alone under TERMINAL_ENV=docker", () => {
    process.env.TERMINAL_ENV = "docker";
    fs.writeFileSync("victim.txt", "host data\n");
    const r = applyPolicyRules(bash("rm -rf victim.txt"), trash);
    assert.equal(r, null, "must return null so the command passes through unmodified");
    assert.equal(fs.readFileSync("victim.txt", "utf8"), "host data\n",
      "the hook must NOT have touched the host filesystem");
    assert.equal(fs.existsSync(trash), false, "no trash dir may be created");
  });

  it("logs the refusal durably (stderr is DEVNULL'd by the hermes bridge)", () => {
    process.env.TERMINAL_ENV = "docker";
    fs.writeFileSync("victim.txt", "host data\n");
    applyPolicyRules(bash("rm -rf victim.txt"), trash);
    const logPath = path.join(workspace, ".backupper", "tier1-skipped.log");
    assert.ok(fs.existsSync(logPath), "tier1-skipped.log must exist");
    const log = fs.readFileSync(logPath, "utf8");
    assert.match(log, /TIER-1 DISABLED/);
    assert.match(log, /docker/);
    assert.match(log, /rm-to-trash/);
  });

  it("blocks the self-executing rules from policy_rules_extra too", () => {
    process.env.TERMINAL_ENV = "docker";

    fs.writeFileSync("a.txt", "hello world\n");
    assert.equal(applyPolicyRules(bash("sed -i 's/hello/goodbye/' a.txt"), trash), null);
    assert.equal(fs.readFileSync("a.txt", "utf8"), "hello world\n",
      "sed-in-place must not have run on the host");

    fs.writeFileSync("b.txt", "keep me\n");
    assert.equal(applyPolicyRules(bash("truncate -s 0 b.txt"), trash), null);
    assert.equal(fs.readFileSync("b.txt", "utf8"), "keep me\n",
      "truncate must not have run on the host");

    fs.writeFileSync("src.txt", "source\n");
    fs.writeFileSync("dst.txt", "destination\n");
    assert.equal(applyPolicyRules(bash("mv src.txt dst.txt"), trash), null);
    assert.equal(fs.readFileSync("src.txt", "utf8"), "source\n",
      "mv-overwrite must not have run on the host");
    assert.equal(fs.readFileSync("dst.txt", "utf8"), "destination\n");
  });

  it("re-arms as soon as the plugin runs where the agent runs", () => {
    process.env.TERMINAL_ENV = "local";
    fs.writeFileSync("victim.txt", "container data\n");
    const r = applyPolicyRules(bash("rm -rf victim.txt"), trash);
    assert.ok(r, "tier 1 must work normally once hook and agent share a filesystem");
    assert.equal(fs.existsSync("victim.txt"), false);
  });
});
}
