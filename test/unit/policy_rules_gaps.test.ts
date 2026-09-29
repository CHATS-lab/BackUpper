/**
 * Tier-0 rules for further destructive commands:
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
 * Same shape as policy_rules_extra.test.ts.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { applyPolicyRules } from "../../src/backup/policy_rules.js";
import { isDangerousRecoveryCommand } from "../../src/restore/restore.js";
import type { HookContext } from "../../src/types.js";

function bash(command: string): HookContext {
  return { hook_event: "PreToolUse", tool_name: "Bash", tool_input: { command } };
}

let workspace: string;
let trash: string;
let originalCwd: string;
let originalPath: string;

beforeEach(() => {
  originalCwd = process.cwd();
  originalPath = process.env.PATH ?? "";
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "backupper-gap-"));
  process.chdir(workspace);
  trash = path.join(workspace, ".trash");
});

afterEach(() => {
  process.chdir(originalCwd);
  process.env.PATH = originalPath;
  try {
    fs.rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

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

  it("ignores a remote destination (tier 3's job, not ours)", () => {
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
