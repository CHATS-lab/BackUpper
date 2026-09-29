/**
 * Tier 0 in backup-only mode (hosts that ignore a rewritten tool input, e.g. Codex).
 *
 * For each rule: applyPolicyRules(..., { rewrite: false }) must capture a restorable copy,
 * execute NOTHING the command targets and return no updatedInput. The test then runs the
 * original command exactly once, as the host would, and checks that the recorded recovery
 * commands bring the pre-state back.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { applyPolicyRules, type PolicyRuleResult } from "../../src/backup/policy_rules.js";
import { tier0CanRewrite, CAN_REWRITE } from "../../src/agents/capabilities.js";
import { ALL_ADAPTERS } from "../../src/agents/index.js";
import type { HookContext } from "../../src/types.js";

const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const PRE_HOOK = path.join(PROJECT_ROOT, "dist/hooks/pre-tool.js");
const CLI = path.join(PROJECT_ROOT, "dist/cli.js");

function bash(command: string): HookContext {
  return { hook_event: "PreToolUse", tool_name: "Bash", tool_input: { command } };
}

let workspace: string;
let trash: string;
let store: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backupper-bo-")));
  process.chdir(workspace);
  store = path.join(workspace, ".backupper");
  trash = path.join(store, "backups", "action_001_x", "trash");
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(workspace, { recursive: true, force: true });
});

/** Apply in backup-only mode and check the shape every backup-only result must have. */
function capture(command: string): PolicyRuleResult {
  const r = applyPolicyRules(bash(command), trash, store, { rewrite: false });
  assert.ok(r, `a rule should fire for: ${command}`);
  assert.equal(r!.updatedInput, undefined, "backup-only mode must not rewrite the call");
  assert.equal(r!.backupOnly, true);
  assert.equal(r!.deny, undefined);
  return r!;
}

/** Run the original command once, as the host does after the hook. */
function hostRuns(command: string): void {
  execSync(command, { stdio: "pipe", shell: "/bin/bash" });
}

function recover(r: { recoveryCommands: string[] }): void {
  for (const c of r.recoveryCommands) execSync(c, { stdio: "pipe" });
}

function read(p: string): string {
  return fs.readFileSync(p, "utf8");
}

function git(args: string): string {
  return execSync(`git ${args}`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function initRepo(): void {
  execSync("git init -q && git config user.email t@t && git config user.name t && git config commit.gpgsign false");
  fs.writeFileSync("tracked.txt", "v0\n");
  execSync("git add tracked.txt && git commit -q -m init");
}

describe("backup-only mode: host capability", () => {
  it("codex cannot rewrite; claude-code and hermes can", () => {
    assert.equal(CAN_REWRITE.codex, false);
    assert.equal(CAN_REWRITE["claude-code"], true);
    assert.equal(CAN_REWRITE.hermes, true);
    for (const a of ALL_ADAPTERS) assert.equal(a.canRewrite, CAN_REWRITE[a.name], a.name);
  });

  it("follows the host tag, with BACKUPPER_NO_REWRITE as an override", () => {
    assert.equal(tier0CanRewrite({ BACKUPPER_HOST_AGENT: "codex" }), false);
    assert.equal(tier0CanRewrite({ BACKUPPER_HOST_AGENT: "claude-code" }), true);
    assert.equal(tier0CanRewrite({ BACKUPPER_HOST_AGENT: "hermes" }), true);
    assert.equal(tier0CanRewrite({}), false, "an unknown host gets the mode that is safe everywhere");
    assert.equal(tier0CanRewrite({ BACKUPPER_HOST_AGENT: "claude-code", BACKUPPER_NO_REWRITE: "1" }), false);
    assert.equal(tier0CanRewrite({ BACKUPPER_HOST_AGENT: "codex", BACKUPPER_NO_REWRITE: "0" }), true);
  });
});

describe("backup-only mode: file rules", () => {
  it("rm: copies instead of moving; the host's rm runs without error; restore brings it back", () => {
    fs.writeFileSync("notes.txt", "important\n");
    const r = capture("rm notes.txt");
    assert.equal(r.ruleId, "rm-to-trash");
    assert.equal(read("notes.txt"), "important\n", "the hook must not delete anything");
    hostRuns("rm notes.txt");                      // would fail if the hook had moved it
    assert.ok(!fs.existsSync("notes.txt"));
    recover(r);
    assert.equal(read("notes.txt"), "important\n");
  });

  it("rm -r of a directory tree", () => {
    fs.mkdirSync("dir/sub", { recursive: true });
    fs.writeFileSync("dir/a.txt", "A\n");
    fs.writeFileSync("dir/sub/b.txt", "B\n");
    const r = capture("rm -rf dir");
    assert.ok(fs.existsSync("dir/sub/b.txt"));
    hostRuns("rm -rf dir");
    recover(r);
    assert.equal(read("dir/a.txt"), "A\n");
    assert.equal(read("dir/sub/b.txt"), "B\n");
  });

  it("rm that reaches the backup store is denied, not rewritten", () => {
    fs.mkdirSync(path.join(store, "backups"), { recursive: true });
    fs.writeFileSync(path.join(store, "config.json"), "{}");
    fs.writeFileSync("other.txt", "x\n");
    const r = applyPolicyRules(bash("rm -rf .backupper other.txt"), trash, store, { rewrite: false });
    assert.ok(r && r.deny, "expected a deny");
    assert.equal(r!.updatedInput, undefined);
    assert.ok(fs.existsSync(path.join(store, "config.json")));
    assert.ok(fs.existsSync("other.txt"));
  });

  it("sed -i: the file changes exactly once, and restore brings back the pre-image", () => {
    fs.writeFileSync("notes.txt", "a\nb\n");
    const r = capture("sed -i 's/$/!/' notes.txt");
    assert.equal(r.ruleId, "sed-in-place");
    assert.equal(read("notes.txt"), "a\nb\n", "the hook must not run the sed");
    hostRuns("sed -i 's/$/!/' notes.txt");
    assert.equal(read("notes.txt"), "a!\nb!\n");
    recover(r);
    assert.equal(read("notes.txt"), "a\nb\n");
  });

  it("truncate", () => {
    fs.writeFileSync("log.txt", "lots of data\n");
    const r = capture("truncate -s 0 log.txt");
    assert.equal(read("log.txt"), "lots of data\n");
    hostRuns("truncate -s 0 log.txt");
    recover(r);
    assert.equal(read("log.txt"), "lots of data\n");
  });

  it("shell truncate (> file)", () => {
    fs.writeFileSync("out.txt", "keep\n");
    const r = capture("> out.txt");
    assert.equal(r.ruleId, "shell-truncate");
    assert.equal(read("out.txt"), "keep\n");
    hostRuns("> out.txt");
    recover(r);
    assert.equal(read("out.txt"), "keep\n");
  });

  it("mv without clobber", () => {
    fs.writeFileSync("src.txt", "movable\n");
    const r = capture("mv src.txt dst.txt");
    assert.ok(fs.existsSync("src.txt") && !fs.existsSync("dst.txt"), "the hook must not move");
    hostRuns("mv src.txt dst.txt");
    recover(r);
    assert.ok(fs.existsSync("src.txt") && !fs.existsSync("dst.txt"));
  });

  it("mv over an existing file keeps a copy of the clobbered destination", () => {
    fs.writeFileSync("s.txt", "new\n");
    fs.writeFileSync("d.txt", "OLD\n");
    const r = capture("mv s.txt d.txt");
    assert.equal(read("d.txt"), "OLD\n");
    hostRuns("mv s.txt d.txt");
    assert.equal(read("d.txt"), "new\n");
    recover(r);
    assert.equal(read("s.txt"), "new\n");
    assert.equal(read("d.txt"), "OLD\n");
  });

  it("find -delete: victims are copied, the host's find deletes them", () => {
    fs.mkdirSync("logs");
    fs.writeFileSync("logs/a.log", "a\n");
    fs.writeFileSync("logs/b.log", "b\n");
    fs.writeFileSync("logs/keep.txt", "k\n");
    const r = capture("find logs -name '*.log' -delete");
    assert.equal(r.ruleId, "find-delete");
    assert.ok(fs.existsSync("logs/a.log"));
    hostRuns("find logs -name '*.log' -delete");
    assert.ok(!fs.existsSync("logs/a.log"));
    recover(r);
    assert.equal(read("logs/a.log"), "a\n");
    assert.equal(read("logs/b.log"), "b\n");
    assert.equal(read("logs/keep.txt"), "k\n");
  });

  it("chmod / chown pass through unchanged", () => {
    fs.writeFileSync("f.txt", "x\n");
    fs.chmodSync("f.txt", 0o644);
    const r = capture("chmod 600 f.txt");
    assert.equal(fs.statSync("f.txt").mode & 0o777, 0o644);
    hostRuns("chmod 600 f.txt");
    recover(r);
    assert.equal(fs.statSync("f.txt").mode & 0o777, 0o644);
  });

  it("rsync --delete snapshots the destination", { skip: spawnSync("sh", ["-c", "command -v rsync"]).status !== 0 }, () => {
    fs.mkdirSync("src");
    fs.mkdirSync("dst");
    fs.writeFileSync("src/a.txt", "a\n");
    fs.writeFileSync("dst/only-here.txt", "precious\n");
    const r = capture("rsync -a --delete src/ dst/");
    assert.ok(fs.existsSync("dst/only-here.txt"));
    hostRuns("rsync -a --delete src/ dst/");
    assert.ok(!fs.existsSync("dst/only-here.txt"));
    recover(r);
    assert.equal(read("dst/only-here.txt"), "precious\n");
  });
});

describe("backup-only mode: git rules", () => {
  it("git stash drop with two stashes: only one is dropped, and restore re-stores it", () => {
    initRepo();
    fs.writeFileSync("tracked.txt", "stashA\n");
    execSync("git stash -q");
    fs.writeFileSync("tracked.txt", "stashB\n");
    execSync("git stash -q");
    const top = git("rev-parse stash@{0}");
    const r = capture("git stash drop");
    assert.equal(r.ruleId, "git-stash-drop");
    assert.equal(git("stash list").split("\n").length, 2, "the hook must not drop anything");
    hostRuns("git stash drop");
    assert.equal(git("stash list").split("\n").length, 1, "exactly one stash dropped");
    recover(r);
    const list = git("stash list").split("\n");
    assert.equal(list.length, 2);
    assert.equal(git("rev-parse stash@{0}"), top, "the dropped stash commit is back on top");
    assert.equal(git("for-each-ref refs/backupper"), "", "the temporary backup ref is removed");
  });

  it("git reset --hard: records HEAD and executes nothing (tier 2 snapshots the worktree)", () => {
    initRepo();
    fs.writeFileSync("tracked.txt", "v1\n");
    execSync("git commit -qam v1");
    const head = git("rev-parse HEAD");
    const r = capture("git reset --hard HEAD~1");
    assert.equal(r.preserveLowerTiers, true);
    assert.equal(git("rev-parse HEAD"), head);
    hostRuns("git reset --hard HEAD~1");
    assert.notEqual(git("rev-parse HEAD"), head);
    recover(r);
    assert.equal(git("rev-parse HEAD"), head);
    assert.equal(read("tracked.txt"), "v1\n");
  });

  it("git reset --hard is record-and-pass in rewrite mode too", () => {
    initRepo();
    fs.writeFileSync("tracked.txt", "dirty\n");
    const r = applyPolicyRules(bash("git reset --hard"), trash, store);
    assert.ok(r && r.ruleId === "git-reset-hard");
    assert.equal(r!.updatedInput, undefined, "no rewrite: tier 2 must snapshot before the reset runs");
    assert.equal(read("tracked.txt"), "dirty\n");
  });

  it("git branch -D", () => {
    initRepo();
    execSync("git branch feature");
    const sha = git("rev-parse feature");
    const r = capture("git branch -D feature");
    assert.equal(git("rev-parse feature"), sha);
    hostRuns("git branch -D feature");
    recover(r);
    assert.equal(git("rev-parse feature"), sha);
  });

  it("git clean -fd: untracked files are copied, the host's clean removes them", () => {
    initRepo();
    // The store exists (untracked, not in .gitignore) before the agent's call.
    fs.mkdirSync(path.join(store, "backups"), { recursive: true });
    fs.writeFileSync(path.join(store, "config.json"), "{}");
    fs.writeFileSync("junk.log", "scratch\n");
    fs.mkdirSync("build");
    fs.writeFileSync("build/out.bin", "artifact\n");
    const r = capture("git clean -fd");
    assert.ok(fs.existsSync("junk.log") && fs.existsSync("build/out.bin"));
    hostRuns("git clean -fd");
    assert.ok(!fs.existsSync("junk.log") && !fs.existsSync("build"));
    assert.ok(fs.existsSync(path.join(store, "config.json")), "the store was kept out of git clean");
    assert.match(read(".git/info/exclude"), /^\/\.backupper\/$/m);
    recover(r);
    assert.equal(read("junk.log"), "scratch\n");
    assert.equal(read("build/out.bin"), "artifact\n");
  });

  it("git clean -fdx, which would remove the store even when ignored, is denied", () => {
    initRepo();
    fs.mkdirSync(path.join(store, "backups"), { recursive: true });
    fs.writeFileSync(path.join(store, "config.json"), "{}");
    fs.writeFileSync("junk.log", "scratch\n");
    const r = applyPolicyRules(bash("git clean -fdx"), trash, store, { rewrite: false });
    assert.ok(r && r.deny, "expected a deny");
    assert.ok(fs.existsSync("junk.log"));
  });

  it("git restore <path> (discard worktree edits)", () => {
    initRepo();
    fs.writeFileSync("tracked.txt", "uncommitted\n");
    const r = capture("git restore tracked.txt");
    assert.equal(read("tracked.txt"), "uncommitted\n");
    hostRuns("git restore tracked.txt");
    assert.equal(read("tracked.txt"), "v0\n");
    recover(r);
    assert.equal(read("tracked.txt"), "uncommitted\n");
  });

  it("git worktree remove --force", () => {
    initRepo();
    execSync("git worktree add -q ../wt-bo-test -b wtb");
    const wt = path.resolve("../wt-bo-test");
    try {
      fs.writeFileSync(path.join(wt, "untracked.txt"), "wip\n");
      const r = capture(`git worktree remove --force ${wt}`);
      assert.ok(fs.existsSync(path.join(wt, "untracked.txt")));
      hostRuns(`git worktree remove --force ${wt}`);
      assert.ok(!fs.existsSync(wt));
      recover(r);
      assert.equal(read(path.join(wt, "untracked.txt")), "wip\n");
    } finally {
      fs.rmSync(wt, { recursive: true, force: true });
    }
  });
});

describe("a trailing `# [Backup needed]` marker does not defeat tier 0", () => {
  it("git stash drop # [Backup needed] (backup-only)", () => {
    initRepo();
    fs.writeFileSync("tracked.txt", "s1\n");
    execSync("git stash -q");
    fs.writeFileSync("tracked.txt", "s2\n");
    execSync("git stash -q");
    const r = capture("git stash drop # [Backup needed]");
    assert.equal(r.ruleId, "git-stash-drop");
    hostRuns("git stash drop # [Backup needed]");
    recover(r);
    assert.equal(git("stash list").split("\n").length, 2);
  });

  it("sed -i ... # [Backup needed] (rewrite mode) and a quoted # is not a comment", () => {
    fs.writeFileSync("f.txt", "a#b\n");
    const r = applyPolicyRules(bash("sed -i 's/#/-/' f.txt # [Backup needed]"), trash, store);
    assert.ok(r && r.ruleId === "sed-in-place");
    assert.equal(read("f.txt"), "a-b\n");
    recover(r!);
    assert.equal(read("f.txt"), "a#b\n");
  });
});

describe("backup-only mode: docker / kubectl (mocked CLIs)", () => {
  let binDir: string;
  let callLog: string;
  let savedPath: string | undefined;
  beforeEach(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "backupper-bo-bin-"));
    callLog = path.join(binDir, "calls.log");
    // docker: inspect prints an id, save -o writes a file, everything else just logs.
    fs.writeFileSync(path.join(binDir, "docker"), `#!/bin/sh
echo "docker $*" >> ${callLog}
case "$1" in
  inspect) echo 0123456789abcdef0123 ;;
  save) out=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done; echo tar > "$out" ;;
esac
exit 0
`);
    fs.writeFileSync(path.join(binDir, "kubectl"), `#!/bin/sh
echo "kubectl $*" >> ${callLog}
[ "$1" = "get" ] && echo "kind: ConfigMap"
exit 0
`);
    fs.chmodSync(path.join(binDir, "docker"), 0o755);
    fs.chmodSync(path.join(binDir, "kubectl"), 0o755);
    savedPath = process.env.PATH;
    process.env.PATH = `${binDir}:${savedPath}`;
  });
  afterEach(() => {
    process.env.PATH = savedPath;
    fs.rmSync(binDir, { recursive: true, force: true });
  });
  const calls = () => (fs.existsSync(callLog) ? read(callLog) : "");

  it("docker rm: commits the container but never removes it", () => {
    const r = capture("docker rm web");
    assert.equal(r.ruleId, "docker-rm");
    assert.match(calls(), /docker commit/);
    assert.doesNotMatch(calls(), /docker rm web/);
    assert.match(r.recoveryCommands[0], /^docker create --name web /);
  });

  it("docker rmi: saves the image but never removes it", () => {
    const r = capture("docker rmi app:1");
    assert.equal(r.ruleId, "docker-image-rm");
    assert.match(calls(), /docker save/);
    assert.doesNotMatch(calls(), /docker rmi/);
  });

  it("kubectl delete: dumps the object but never deletes it", () => {
    const r = capture("kubectl delete configmap app-cfg -n prod");
    assert.equal(r.ruleId, "kubectl-delete");
    assert.match(calls(), /kubectl get configmap\/app-cfg/);
    assert.doesNotMatch(calls(), /kubectl delete/);
    assert.match(r.recoveryCommands[0], /^kubectl apply -f /);
  });
});

describe("backup-only mode through the installed hook (--agent codex)", () => {
  function runHook(cwd: string, agent: string, command: string, extraEnv: NodeJS.ProcessEnv = {}) {
    const env: NodeJS.ProcessEnv = { ...process.env, BACKUPPER_READONLY_CHECKER: "0", ...extraEnv };
    delete env.BACKUPPER_NO_HOOK;
    delete env.BACKUPPER_STORE_DIR;
    delete env.BACKUPPER_NO_REWRITE;
    delete env.TERMINAL_ENV;
    delete env.BACKUPPER_EXEC_TARGET;
    Object.assign(env, extraEnv);
    return spawnSync(process.execPath, [PRE_HOOK, "--agent", agent], {
      cwd, env, encoding: "utf-8",
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd }),
    });
  }
  function setup(): void {
    initRepo();
    fs.mkdirSync(".backupper");
    fs.writeFileSync(".backupper/config.json", JSON.stringify({ mode: "checker", subagentEnabled: false }));
  }

  it("codex: rm is captured without a rewrite, and `backupper restore` brings it back", () => {
    setup();
    fs.writeFileSync("notes.txt", "keep me\n");
    const r = runHook(workspace, "codex", "rm notes.txt");
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /updatedInput/);
    assert.equal(read("notes.txt"), "keep me\n");
    hostRuns("rm notes.txt");
    const meta = JSON.parse(read(path.join(fs.readdirSync(".backupper/backups").map((d) => path.join(".backupper/backups", d))[0], "metadata.json")));
    assert.equal(meta[0].strategy, "policy_rewrite");
    assert.equal(meta[0].backupOnly, true);
    const rr = spawnSync(process.execPath, [CLI, "restore", "1"], { cwd: workspace, encoding: "utf-8" });
    assert.equal(rr.status, 0, rr.stdout + rr.stderr);
    assert.equal(read("notes.txt"), "keep me\n");
  });

  it("claude-code: rm is still rewritten into a move to trash", () => {
    setup();
    fs.writeFileSync("notes.txt", "keep me\n");
    const r = runHook(workspace, "claude-code", "rm notes.txt");
    assert.equal(r.status, 0, r.stderr);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.updatedInput.command, /^true/);
    assert.ok(!fs.existsSync("notes.txt"));
  });

  it("BACKUPPER_NO_REWRITE=1 forces backup-only mode on a rewriting host", () => {
    setup();
    fs.writeFileSync("notes.txt", "a\n");
    const r = runHook(workspace, "claude-code", "sed -i 's/a/b/' notes.txt", { BACKUPPER_NO_REWRITE: "1" });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /updatedInput/);
    assert.equal(read("notes.txt"), "a\n");
  });

  it("codex: a command whose victims include the store is denied", () => {
    setup();
    fs.mkdirSync("sub");
    const r = runHook(workspace, "codex", "find . -name config.json -delete");
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
    assert.ok(fs.existsSync(".backupper/config.json"));
  });
});
