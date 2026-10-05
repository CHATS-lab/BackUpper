/**
 * Restore, capture and shared-helper regressions.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { restoreActionDirect, restoreActionLoop, restoreArtifact, fileCopyTarget } from "../../src/restore/restore.js";
import { configWarnings, loadConfig } from "../../src/config/load.js";
import type { BackupArtifact } from "../../src/types.js";

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
// ── restore round2 regressions ──
// =============================================================================

/**
 * Regression tests for restore-side data-loss bugs and compound-command capture.
 *
 * Black-box: every test drives the built hooks (dist/hook.js pre / post) the way an
 * agent host does — pre-hook, run the (possibly rewritten) call, post-hook — and then the
 * `backupper` CLI, so the same file runs unchanged against an older build.
 */

const SUITES_RESTORE_ROUND2_REGRESSIONS = ["restore N --direct", "a failed command keeps its backup when it changed files", "recovery onto a path that is now a directory", "capture file names are unique per target", "snapshot restores keep what git does not", "chmod on a symlink", "git restores", "restore N --file", "out-of-workspace Write/Edit: one copy per step", "compound commands", "sed -i.SUFFIX"];
const ROOT = path.resolve(__dirname, "../../..");
const HOOK = path.join(ROOT, "dist/hook.js");
const CLI = path.join(ROOT, "dist/cli.js");

let ws = "";
let out = "";

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, BACKUPPER_READONLY_CHECKER: "0", ...extra };
  for (const k of ["BACKUPPER_NO_HOOK", "BACKUPPER_STORE_DIR", "BACKUPPER_NO_REWRITE", "TERMINAL_ENV", "BACKUPPER_EXEC_TARGET", "GIT_DIR", "GIT_WORK_TREE"]) {
    if (!(k in extra)) delete e[k];
  }
  return e;
}

beforeEach(onlyIn(SUITES_RESTORE_ROUND2_REGRESSIONS, () => {
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bu-r2-ws-")));
  // Outside the workspace and outside /tmp (which the scope check treats as scratch space).
  out = fs.realpathSync(fs.mkdtempSync(path.join("/var/tmp", "bu-r2-out-")));
  const g = "git -c user.email=t@t -c user.name=t";
  execSync(`git init -q && ${g} commit -q --allow-empty -m root`, { cwd: ws });
  fs.mkdirSync(path.join(ws, ".backupper"));
  fs.writeFileSync(path.join(ws, ".backupper", "config.json"), JSON.stringify({ mode: "checker", subagentEnabled: false }));
  fs.writeFileSync(path.join(ws, "a.txt"), "alpha\n");
  fs.writeFileSync(path.join(ws, "b.txt"), "bravo\n");
  fs.mkdirSync(path.join(ws, "data", "sub"), { recursive: true });
  fs.writeFileSync(path.join(ws, "data", "users.csv"), "id,name\n1,ada\n");
  fs.writeFileSync(path.join(ws, "data", "sub", "deep.txt"), "deep\n");
}));

afterEach(onlyIn(SUITES_RESTORE_ROUND2_REGRESSIONS, () => {
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
}));

const W = (rel: string) => path.join(ws, rel);
const read = (p: string) => fs.readFileSync(p, "utf-8");
const mode = (p: string) => (fs.statSync(p).mode & 0o7777).toString(8);
const git = (args: string, cwd = ws) =>
  execSync(`git -c user.email=t@t -c user.name=t ${args}`, { cwd, encoding: "utf-8", env: env() }).trim();

/** One tool call through the hooks: pre-hook, the call itself (rewritten if the hook says so), post-hook. */
function step(tool: "Bash" | "Write" | "Edit", input: Record<string, unknown>, opts: { agent?: string; cwd?: string; extraEnv?: NodeJS.ProcessEnv } = {}) {
  const agent = opts.agent ?? "claude-code";
  const cwd = opts.cwd ?? ws;
  const e = env(opts.extraEnv);
  const payload = { hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, cwd, session_id: "r2" };
  const pre = spawnSync(process.execPath, [HOOK, "pre", "--agent", agent], { cwd: ws, env: e, encoding: "utf-8", input: JSON.stringify(payload) });
  let hso: Record<string, unknown> = {};
  try { hso = pre.stdout ? JSON.parse(pre.stdout).hookSpecificOutput ?? {} : {}; } catch { /* no output */ }
  const denied = pre.status === 2 || hso.permissionDecision === "deny";
  const eff = (hso.updatedInput as Record<string, unknown> | undefined) ?? input;
  let code = 0;
  let output = "";
  if (!denied) {
    if (tool === "Bash") {
      const r = spawnSync("bash", ["-c", String(eff.command)], { cwd, env: env(), encoding: "utf-8" });
      code = r.status ?? 1;
      output = (r.stdout ?? "") + (r.stderr ?? "");
    } else {
      const f = path.resolve(cwd, String(eff.file_path));
      try {
        if (tool === "Write") { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, String(eff.content)); }
        else {
          const t = read(f);
          if (!t.includes(String(eff.old_string))) throw new Error("old_string not found");
          fs.writeFileSync(f, t.replace(String(eff.old_string), String(eff.new_string)));
        }
      } catch (err) { code = 1; output = String(err); }
    }
    spawnSync(process.execPath, [HOOK, "post", "--agent", agent], {
      cwd: ws, env: e, encoding: "utf-8",
      input: JSON.stringify({
        hook_event_name: code === 0 ? "PostToolUse" : "PostToolUseFailure",
        tool_name: tool, tool_input: input, cwd, session_id: "r2",
        tool_response: tool === "Bash" ? { stdout: output, stderr: "", exit_code: code } : { success: code === 0 },
        ...(code ? { error: output } : {}),
      }),
    });
  }
  return { pre, hso, denied, code, output };
}

function cli(args: string[], cwd = ws) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: env(), encoding: "utf-8" });
  return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

function actions(): string[] {
  try {
    return fs.readdirSync(W(".backupper/backups")).filter((d) => /^action_\d+_/.test(d)).sort();
  } catch { return []; }
}

describe("restore N --direct", () => {
  it("undoes only action N and keeps every later action and its backup", () => {
    step("Bash", { command: "rm a.txt" });                                         // #1
    step("Edit", { file_path: W("b.txt"), old_string: "bravo", new_string: "B2" }); // #2
    assert.equal(actions().length, 2);
    const r = cli(["restore", "1", "--direct"]);
    assert.equal(r.status, 0, r.out);
    assert.equal(read(W("a.txt")), "alpha\n");
    assert.equal(read(W("b.txt")), "B2\n", "action 2 was not undone");
    assert.equal(actions().length, 2, "later actions must not be pruned: " + r.out);
    const r2 = cli(["restore", "2", "--direct"]);
    assert.equal(r2.status, 0, r2.out);
    assert.equal(read(W("b.txt")), "bravo\n");
  });

  it("a snapshot action restored directly reverts only the paths that action changed", () => {
    step("Edit", { file_path: W("a.txt"), old_string: "alpha", new_string: "A2" });  // #1
    step("Edit", { file_path: W("b.txt"), old_string: "bravo", new_string: "B2" });  // #2
    const r = cli(["restore", "1", "--direct"]);
    assert.equal(r.status, 0, r.out);
    assert.equal(read(W("a.txt")), "alpha\n");
    assert.equal(read(W("b.txt")), "B2\n");
  });
});

describe("a failed command keeps its backup when it changed files", () => {
  it("keeps the snapshot of `printf … > a.txt; false` and restore brings a.txt back", () => {
    const s = step("Bash", { command: "printf 'CLOBBERED\\n' > a.txt; false" });
    assert.notEqual(s.code, 0);
    assert.equal(read(W("a.txt")), "CLOBBERED\n");
    assert.equal(actions().length, 1, "the backup of a failed call that changed a file must survive");
    const r = cli(["restore", "1"]);
    assert.equal(r.status, 0, r.out);
    assert.equal(read(W("a.txt")), "alpha\n");
  });

  it("keeps the copy of a backup-only `rm a.txt missing.txt` that failed after deleting a.txt", () => {
    const s = step("Bash", { command: "rm a.txt missing.txt" }, { agent: "codex", extraEnv: { BACKUPPER_NO_REWRITE: "1" } });
    assert.notEqual(s.code, 0);
    assert.ok(!fs.existsSync(W("a.txt")));
    assert.equal(actions().length, 1);
    const r = cli(["restore", "1"]);
    assert.equal(r.status, 0, r.out);
    assert.equal(read(W("a.txt")), "alpha\n");
  });

  it("still drops the backup of a failed call that changed nothing", () => {
    const s = step("Bash", { command: "cp a.txt a.tmp && rm a.tmp && false" });
    assert.notEqual(s.code, 0);
    assert.equal(actions().length, 0);
  });
});

describe("recovery onto a path that is now a directory", () => {
  it("merges the trashed directory into the re-created one instead of nesting it", () => {
    step("Bash", { command: "rm -r data" });                                       // #1 (moved to trash)
    step("Write", { file_path: W("data/new.txt"), content: "new\n" });             // #2 re-creates data/
    const r = cli(["restore", "1", "--direct"]);
    assert.equal(r.status, 0, r.out);
    assert.equal(read(W("data/users.csv")), "id,name\n1,ada\n");
    assert.equal(read(W("data/sub/deep.txt")), "deep\n");
    assert.equal(read(W("data/new.txt")), "new\n", "the newer file is kept");
    const nested = fs.readdirSync(W("data")).filter((n) => !["users.csv", "sub", "new.txt"].includes(n));
    assert.deepEqual(nested, [], "nothing may be nested inside data/");
    assert.match(r.out, /merged/i);
  });

  it("a file that now collides with a directory is reported, not nested", () => {
    step("Bash", { command: "rm a.txt" });                                         // #1
    fs.mkdirSync(W("a.txt"));
    fs.writeFileSync(W("a.txt/x"), "x\n");
    const r = cli(["restore", "1", "--direct"]);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /now a directory/);
    assert.deepEqual(fs.readdirSync(W("a.txt")), ["x"]);
  });
});

describe("capture file names are unique per target", () => {
  it("`x y.txt` and `x_y.txt` in one sed -i keep separate copies", () => {
    fs.writeFileSync(W("x y.txt"), "one\n");
    fs.writeFileSync(W("x_y.txt"), "two\n");
    step("Bash", { command: "sed -i 's/o/0/' 'x y.txt' x_y.txt" });
    assert.equal(read(W("x y.txt")), "0ne\n");
    const r = cli(["restore", "1"]);
    assert.equal(r.status, 0, r.out);
    assert.equal(read(W("x y.txt")), "one\n");
    assert.equal(read(W("x_y.txt")), "two\n");
  });

  it("two long paths that share a 200-character prefix keep separate copies", () => {
    const d = "d".repeat(70) + "/" + "e".repeat(70) + "/" + "f".repeat(70);
    fs.mkdirSync(W(d), { recursive: true });
    fs.writeFileSync(W(`${d}/one.txt`), "one\n");
    fs.writeFileSync(W(`${d}/two.txt`), "two\n");
    step("Bash", { command: `sed -i 's/o/0/' ${d}/one.txt ${d}/two.txt` });
    const r = cli(["restore", "1"]);
    assert.equal(r.status, 0, r.out);
    assert.equal(read(W(`${d}/one.txt`)), "one\n");
    assert.equal(read(W(`${d}/two.txt`)), "two\n");
  });
});

describe("snapshot restores keep what git does not", () => {
  it("restores 0600/0750 modes and a foreign owner", () => {
    fs.writeFileSync(W("id_key"), "PRIVATE\n", { mode: 0o600 });
    fs.chmodSync(W("id_key"), 0o600);
    fs.writeFileSync(W("run.sh"), "#!/bin/sh\n");
    fs.chmodSync(W("run.sh"), 0o750);
    const canChown = process.getuid?.() === 0;
    if (canChown) fs.chownSync(W("b.txt"), 1234, 1234);
    step("Edit", { file_path: W("id_key"), old_string: "PRIVATE", new_string: "PRIV2" });  // #1
    step("Edit", { file_path: W("run.sh"), old_string: "sh", new_string: "bash" });       // #2
    const r = cli(["restore", "1"]);
    assert.equal(r.status, 0, r.out);
    assert.equal(read(W("id_key")), "PRIVATE\n");
    assert.equal(mode(W("id_key")), "600");
    assert.equal(mode(W("run.sh")), "750");
    if (canChown) assert.equal(fs.statSync(W("b.txt")).uid, 1234);
  });

  it("recreates an empty directory that existed before step N", () => {
    fs.mkdirSync(W("empty"));
    step("Edit", { file_path: W("a.txt"), old_string: "alpha", new_string: "A2" });  // #1
    step("Bash", { command: "rmdir empty" });                                         // #2
    assert.ok(!fs.existsSync(W("empty")));
    const r = cli(["restore", "1"]);
    assert.equal(r.status, 0, r.out);
    assert.ok(fs.statSync(W("empty")).isDirectory(), "empty directory must come back: " + r.out);
    assert.equal(read(W("a.txt")), "alpha\n");
  });

  it("a tier-4 external-shadow restore keeps the file's 0640 mode", () => {
    const file = path.join(out, "settings.ini");
    fs.writeFileSync(file, "retention_days = 30\n");
    fs.chmodSync(file, 0o640);
    // What a tier-4 capture leaves behind: a shadow repo holding the file, and recovery commands.
    const shadow = W(".backupper/external-shadow");
    const genv = { ...env(), GIT_DIR: shadow, GIT_WORK_TREE: out };
    execSync("git init -q && git add -- settings.ini && git -c user.email=t@t -c user.name=t commit -qm pre", { cwd: out, env: genv });
    const hash = execSync("git rev-parse HEAD", { cwd: out, env: genv, encoding: "utf-8" }).trim();
    const dir = W(".backupper/backups/action_001_20260101000000");
    fs.mkdirSync(dir, { recursive: true });
    const q = (s: string) => `'${s}'`;
    fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify([{
      id: "sub1", timestamp: new Date().toISOString(), trigger: "rule", toolName: "Bash",
      description: "Subagent backup: shadowed settings.ini", strategy: "subagent", artifactPath: path.join(dir, "subagent_x.json"),
      subagentCommands: [
        `GIT_DIR=${q(shadow)} GIT_WORK_TREE=${q(out)} git read-tree ${hash}`,
        `GIT_DIR=${q(shadow)} GIT_WORK_TREE=${q(out)} git checkout-index -f -a`,
      ],
      liveRestore: false, originalAction: "Bash(sed -i s/30/7/ settings.ini)",
    }]));
    execSync(`sed -i 's/30/7/' ${file}`);
    assert.equal(mode(file), "640");
    const r = cli(["restore", "1"]);
    assert.equal(r.status, 0, r.out);
    assert.equal(read(file), "retention_days = 30\n");
    assert.equal(mode(file), "640");
  });
});

describe("chmod on a symlink", () => {
  it("restore puts back the link target's mode, not 777", () => {
    fs.chmodSync(W("a.txt"), 0o600);
    fs.symlinkSync("a.txt", W("lnk"));
    step("Bash", { command: "chmod 640 lnk" });
    assert.equal(mode(W("a.txt")), "640");
    const r = cli(["restore", "1"]);
    assert.equal(r.status, 0, r.out);
    assert.equal(mode(W("a.txt")), "600");
  });
});

describe("git restores", () => {
  it("git reset --hard: saved uncommitted changes survive the restore, and the pre-bash tag is removed", () => {
    git("add -A && git -c user.email=t@t -c user.name=t commit -qm c1");
    fs.writeFileSync(W("a.txt"), "c2\n");
    git("commit -qam c2");
    const c2 = git("rev-parse HEAD");
    fs.writeFileSync(W("a.txt"), "dirty\n");
    step("Bash", { command: "git reset --hard HEAD~1" });
    assert.equal(read(W("a.txt")), "alpha\n");
    const r = cli(["restore", "1"]);
    assert.equal(r.status, 0, r.out);
    assert.equal(git("rev-parse HEAD"), c2);
    assert.equal(read(W("a.txt")), "dirty\n", "uncommitted edit must come back: " + r.out);
    assert.equal(git("tag -l 'backupper/*'"), "", "the backupper/pre-* tag must be removed");
  });

  it("git stash drop: the restored stash keeps its original message", () => {
    git("add -A && git -c user.email=t@t -c user.name=t commit -qm c1");
    fs.writeFileSync(W("a.txt"), "stashme\n");
    git("stash push -q -m 'my experiment'");
    const before = git("stash list --format=%gs");
    step("Bash", { command: "git stash drop" });
    assert.equal(git("stash list"), "");
    const r = cli(["restore", "1"]);
    assert.equal(r.status, 0, r.out);
    assert.equal(git("stash list --format=%gs"), before);
  });

  it("restoring to before a `git stash` drops the stash entry created after N", () => {
    git("add -A && git -c user.email=t@t -c user.name=t commit -qm c1");
    step("Edit", { file_path: W("a.txt"), old_string: "alpha", new_string: "A2" }); // #1
    step("Bash", { command: "git stash" });                                          // #2
    assert.notEqual(git("stash list"), "");
    const r = cli(["restore", "1"]);
    assert.doesNotMatch(r.out, /\[FAIL\]/);
    assert.equal(git("stash list"), "", r.out);
    assert.equal(read(W("a.txt")), "alpha\n");
  });
});

describe("restore N --file", () => {
  it("finds the tier-1 trash copy of a removed workspace file", () => {
    step("Bash", { command: "rm a.txt" });
    const r = cli(["restore", "1", "--file", "a.txt"]);
    assert.equal(r.status, 0, r.out);
    assert.equal(read(W("a.txt")), "alpha\n");
  });

  it("finds the tier-1 copy of a removed file outside the workspace", () => {
    // Same filesystem as the store, so the rm is moved to trash rather than left to tier 4.
    const near = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(ws), "bu-r2-near-")));
    try {
      fs.writeFileSync(path.join(near, "keep.db"), "DB\n");
      step("Bash", { command: `rm ${path.join(near, "keep.db")}` });
      assert.ok(!fs.existsSync(path.join(near, "keep.db")));
      const r = cli(["restore", "1", "--file", path.join(near, "keep.db")]);
      assert.equal(r.status, 0, r.out);
      assert.equal(read(path.join(near, "keep.db")), "DB\n");
    } finally {
      fs.rmSync(near, { recursive: true, force: true });
    }
  });

  it("resolves a relative path against the directory the CLI runs in", () => {
    fs.writeFileSync(W("users.csv"), "ROOT COPY\n");
    step("Bash", { command: "rm data/users.csv" });
    const r = cli(["restore", "1", "--file", "users.csv"], W("data"));
    assert.equal(r.status, 0, r.out);
    assert.equal(read(W("data/users.csv")), "id,name\n1,ada\n");
    assert.equal(read(W("users.csv")), "ROOT COPY\n");
  });

  it("on failure points to --direct and the full restore", () => {
    step("Bash", { command: "rm a.txt" });
    const r = cli(["restore", "1", "--file", "b.txt"]);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /restore 1 --direct/);
  });
});

describe("out-of-workspace Write/Edit: one copy per step", () => {
  function replay(): string {
    const file = path.join(out, "conf.ini");
    fs.writeFileSync(file, "v1\n");
    fs.chmodSync(file, 0o640);
    step("Write", { file_path: file, content: "v2\n" });                           // #1
    step("Edit", { file_path: file, old_string: "v2", new_string: "v3" });         // #2
    assert.equal(read(file), "v3\n");
    return file;
  }

  it("restore 2 lands on v2 and restore 1 on v1", () => {
    const file = replay();
    let r = cli(["restore", "2"]);
    assert.equal(r.status, 0, r.out);
    assert.equal(read(file), "v2\n", "restore 2 must give the state before step 2");
    r = cli(["restore", "1"]);
    assert.equal(r.status, 0, r.out);
    assert.equal(read(file), "v1\n");
    assert.equal(mode(file), "640");
  });

  it("restore 2 --file lands on v2", () => {
    const file = replay();
    const r = cli(["restore", "2", "--file", file]);
    assert.equal(r.status, 0, r.out);
    assert.equal(read(file), "v2\n");
  });
});

describe("compound commands", () => {
  it("captures a sed -i on an outside file inside `… && echo done`", () => {
    const f = path.join(out, "settings.ini");
    fs.writeFileSync(f, "retention_days = 30\n");
    step("Bash", { command: `sed -i 's/30/7/' ${f} && echo done` });
    assert.equal(read(f), "retention_days = 7\n");
    const r = cli(["restore", "1"]);
    assert.equal(r.status, 0, r.out);
    assert.equal(read(f), "retention_days = 30\n");
  });

  it("follows `cd DIR &&` for a later rm", () => {
    fs.mkdirSync(path.join(out, "exports"));
    fs.writeFileSync(path.join(out, "exports", "q1.csv"), "1,99.5\n");
    fs.writeFileSync(W("exports-decoy"), "x\n");
    step("Bash", { command: `cd ${out} && rm exports/q1.csv` });
    assert.ok(!fs.existsSync(path.join(out, "exports", "q1.csv")));
    const r = cli(["restore", "1"]);
    assert.equal(r.status, 0, r.out);
    assert.equal(read(path.join(out, "exports", "q1.csv")), "1,99.5\n");
  });

  it("unwraps bash -c and a heredoc fed to a shell", () => {
    fs.writeFileSync(path.join(out, "x.txt"), "x\n");
    fs.writeFileSync(path.join(out, "y.txt"), "y\n");
    step("Bash", { command: `bash -c 'rm ${path.join(out, "x.txt")}'` });             // #1
    step("Bash", { command: `bash <<'EOF'\nrm ${path.join(out, "y.txt")}\nEOF` });     // #2
    assert.ok(!fs.existsSync(path.join(out, "x.txt")));
    assert.ok(!fs.existsSync(path.join(out, "y.txt")));
    const r = cli(["restore", "1"]);
    assert.equal(r.status, 0, r.out);
    assert.equal(read(path.join(out, "x.txt")), "x\n");
    assert.equal(read(path.join(out, "y.txt")), "y\n");
  });

  it("an uncovered destructive segment is flagged INCOMPLETE and restore warns instead of a silent OK", () => {
    const f = path.join(out, "conf.ini");
    fs.writeFileSync(f, "orig\n");
    step("Bash", { command: `cp a.txt ${f} && echo ok` });
    assert.equal(read(f), "alpha\n");
    const list = cli(["list"]);
    assert.match(list.out, /INCOMPLETE/);
    assert.ok(list.out.includes(f), list.out);
    const show = cli(["show", "1"]);
    assert.match(show.out, /INCOMPLETE/);
    const r = cli(["restore", "1"]);
    assert.match(r.out, /\[WARN\].*INCOMPLETELY captured/);
    assert.ok(r.out.includes(f), r.out);
    assert.equal(r.status, 3, "warnings exit 3, distinct from success and from a failed step");
  });

  it("a query-only sqlite3 call is not flagged as an uncaptured change", () => {
    const pre = spawnSync(process.execPath, [HOOK, "pre", "--agent", "claude-code"], {
      cwd: ws, env: env(), encoding: "utf-8",
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "sqlite3 data/app.db 'SELECT count(*) FROM events;' && echo ok" }, cwd: ws }),
    });
    assert.equal(pre.status, 0, pre.stderr);
    for (const a of actions()) assert.ok(!fs.existsSync(W(`.backupper/backups/${a}/incomplete.json`)), a);
  });
});

describe("sed -i.SUFFIX", () => {
  it("restore removes the FILE.SUFFIX copy sed created", () => {
    const f = path.join(out, "settings.ini");
    fs.writeFileSync(f, "retention_days = 30\n");
    step("Bash", { command: `sed -i.bak 's/30/7/' ${f}` });
    assert.ok(fs.existsSync(f + ".bak"));
    const r = cli(["restore", "1"]);
    assert.equal(r.status, 0, r.out);
    assert.equal(read(f), "retention_days = 30\n");
    assert.ok(!fs.existsSync(f + ".bak"), "the .bak sed created must be removed: " + r.out);
  });
});

// =============================================================================
// ── restore file copy and config ──
// =============================================================================

/**
 * Restore of tier-3 `file_copy` artifacts (a file edited outside the workspace), the shadow
 * repo's exclusion of BackUpper's own install files, and config.json warnings.
 */

{
const SUITES_RESTORE_FILE_COPY_AND_CONFIG = ["restore of a tier-3 file_copy (file outside the workspace)", "tier-3 snapshot leaves BackUpper's install files alone", "config.json warnings"];
const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const PRE_HOOK = path.join(PROJECT_ROOT, "dist/hook.js"); // run as `hook.js pre`
const CLI = path.join(PROJECT_ROOT, "dist/cli.js");

let ws: string;
let outside: string;
let originalCwd: string;

function hook(tool: string, input: Record<string, unknown>, agent = "claude-code") {
  const env: NodeJS.ProcessEnv = { ...process.env, BACKUPPER_READONLY_CHECKER: "0" };
  delete env.BACKUPPER_NO_HOOK;
  delete env.BACKUPPER_STORE_DIR;
  return spawnSync(process.execPath, [PRE_HOOK, "pre", "--agent", agent], {
    cwd: ws, env, encoding: "utf-8",
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, cwd: ws }),
  });
}

beforeEach(onlyIn(SUITES_RESTORE_FILE_COPY_AND_CONFIG, () => {
  originalCwd = process.cwd();
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backupper-fc-ws-")));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backupper-fc-out-")));
  execSync("git init -q", { cwd: ws });
  fs.writeFileSync(path.join(ws, "app.py"), "x = 1\n");
  fs.mkdirSync(path.join(ws, ".backupper"));
  fs.writeFileSync(path.join(ws, ".backupper", "config.json"), JSON.stringify({ mode: "checker", subagentEnabled: false }));
  process.chdir(ws);
}));

afterEach(onlyIn(SUITES_RESTORE_FILE_COPY_AND_CONFIG, () => {
  process.chdir(originalCwd);
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}));

function onlyAction(): string {
  const names = fs.readdirSync(path.join(ws, ".backupper", "backups")).filter((n) => n.startsWith("action_"));
  assert.equal(names.length, 1);
  return names[0];
}

describe("restore of a tier-3 file_copy (file outside the workspace)", () => {
  function captureOutsideEdit(): { file: string; action: string } {
    const file = path.join(outside, "cfg.ini");
    fs.writeFileSync(file, "port=80\n");
    fs.chmodSync(file, 0o640);
    const r = hook("Edit", { file_path: file, old_string: "80", new_string: "81" });
    assert.equal(r.status, 0, r.stderr);
    fs.writeFileSync(file, "port=81\n");
    fs.chmodSync(file, 0o600);
    return { file, action: onlyAction() };
  }

  it("records the target path on the artifact", () => {
    const { file, action } = captureOutsideEdit();
    const meta: BackupArtifact[] = JSON.parse(fs.readFileSync(path.join(ws, ".backupper", "backups", action, "metadata.json"), "utf-8"));
    const fc = meta.find((a) => a.strategy === "file_copy");
    assert.ok(fc, "expected a file_copy artifact");
    assert.equal(fc!.targetPath, file);
    assert.equal(fileCopyTarget(fc!), file);
  });

  it("restore N (loop) puts the file back with its mode", async () => {
    const { file, action } = captureOutsideEdit();
    const results = await restoreActionLoop(action, loadConfig(ws));
    assert.ok(results.every((r) => r.success), JSON.stringify(results));
    assert.equal(fs.readFileSync(file, "utf-8"), "port=80\n");
    assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  });

  it("restore N --file /abs/outside/path restores just that file", async () => {
    const { file, action } = captureOutsideEdit();
    fs.writeFileSync(path.join(ws, "app.py"), "x = 2\n");
    const results = await restoreActionDirect(action, loadConfig(ws), { fileOnly: file });
    assert.equal(results.length, 1);
    assert.ok(results[0].success, results[0].description);
    assert.equal(fs.readFileSync(file, "utf-8"), "port=80\n");
    assert.equal(fs.readFileSync(path.join(ws, "app.py"), "utf-8"), "x = 2\n", "--file touches nothing else");
  });

  it("the CLI accepts an absolute outside path with --file", () => {
    const { file } = captureOutsideEdit();
    const r = spawnSync(process.execPath, [CLI, "restore", "1", "--file", file], { cwd: ws, encoding: "utf-8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /outside repository/);
    assert.equal(fs.readFileSync(file, "utf-8"), "port=80\n");
  });

  it("--file on an outside path the action did not copy says so", async () => {
    const { action } = captureOutsideEdit();
    const results = await restoreActionDirect(action, loadConfig(ws), { fileOnly: path.join(outside, "nope.txt") });
    assert.equal(results[0].success, false);
    assert.match(results[0].description, /holds no copy/);
  });

  it("older metadata without targetPath is still restorable (path read from the description)", async () => {
    const file = path.join(outside, "legacy.txt");
    const copy = path.join(outside, "legacy.pre-action");
    fs.writeFileSync(copy, "before\n");
    fs.writeFileSync(file, "after\n");
    const artifact: BackupArtifact = {
      id: "abc123", timestamp: new Date().toISOString(), trigger: "rule", toolName: "Edit",
      description: `external file snapshot → legacy.pre-action (${file}, 7 bytes, mode 0644)`,
      strategy: "file_copy", artifactPath: copy,
    };
    const r = await restoreArtifact(artifact);
    assert.ok(r.success, r.description);
    assert.equal(fs.readFileSync(file, "utf-8"), "before\n");
  });
});

describe("tier-3 snapshot leaves BackUpper's install files alone", () => {
  function install(): void {
    fs.mkdirSync(path.join(ws, ".claude", "commands"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".claude", "settings.local.json"), "{\"hooks\":{}}\n");
    fs.writeFileSync(path.join(ws, ".claude", "commands", "backupper-list.md"), "list\n");
    fs.writeFileSync(path.join(ws, ".claude", "commands", "mine.md"), "user command\n");
    fs.mkdirSync(path.join(ws, ".codex"));
    fs.writeFileSync(path.join(ws, ".codex", "hooks.json"), "{}\n");
  }
  const shadow = () => path.join(ws, ".backupper", "shadow-repo");
  const tracked = () => execSync("git ls-tree -r --name-only HEAD", {
    env: { ...process.env, GIT_DIR: shadow() }, encoding: "utf-8",
  }).split("\n").filter(Boolean);

  it("does not snapshot hook registration or backupper-* slash commands", () => {
    install();
    const r = hook("Write", { file_path: path.join(ws, "app.py"), content: "x = 3\n" });
    assert.equal(r.status, 0, r.stderr);
    const files = tracked();
    assert.ok(files.includes("app.py"));
    assert.ok(files.includes(".claude/commands/mine.md"), "the user's own files are still captured");
    for (const f of [".claude/settings.local.json", ".claude/commands/backupper-list.md", ".codex/hooks.json"]) {
      assert.ok(!files.includes(f), `${f} must not be snapshotted`);
    }
  });

  it("untracks install files an older shadow repo already held", () => {
    install();
    const env = { ...process.env, GIT_DIR: shadow(), GIT_WORK_TREE: ws };
    execSync("git init -q && git config user.email b@l && git config user.name b", { cwd: ws, env });
    execSync("git add -A -- .claude .codex app.py && git commit -qm old", { cwd: ws, env });
    assert.ok(tracked().includes(".claude/settings.local.json"));
    fs.writeFileSync(path.join(ws, "app.py"), "x = 4\n");
    hook("Write", { file_path: path.join(ws, "app.py"), content: "x = 5\n" });
    const files = tracked();
    assert.ok(!files.includes(".claude/settings.local.json"));
    assert.ok(!files.includes(".codex/hooks.json"));
    assert.ok(files.includes("app.py"));
  });
});

describe("config.json warnings", () => {
  const cfg = () => path.join(ws, ".backupper", "config.json");

  it("an unparseable file is reported, not silently defaulted", () => {
    fs.writeFileSync(cfg(), "{broken");
    const w = configWarnings(ws);
    assert.equal(w.length, 1);
    assert.match(w[0], /does not parse/);
  });

  it("wrong types and invalid regexes are reported", () => {
    fs.writeFileSync(cfg(), JSON.stringify({ maxActions: "ten", alwaysBackupPatterns: ["rm\\s", "(unclosed"] }));
    const w = configWarnings(ws).join("\n");
    assert.match(w, /maxActions should be integer/);
    assert.match(w, /\/\(unclosed\/ is not a valid regex/);
  });

  it("a valid file has no warnings", () => {
    assert.deepEqual(configWarnings(ws), []);
  });

  it("the hook warns on stderr and logs once per version of the file", () => {
    fs.writeFileSync(cfg(), "{broken");
    const a = hook("Bash", { command: "ls" });
    const b = hook("Bash", { command: "ls" });
    assert.equal(a.status, 0);
    assert.match(a.stderr, /config warning: .*does not parse/);
    assert.doesNotMatch(b.stderr, /config warning/, "the same problem is not repeated on every call");
    const log = fs.readFileSync(path.join(ws, ".backupper", "hook-errors.log"), "utf-8").trim().split("\n");
    assert.equal(log.filter((l) => /config warning/.test(l)).length, 1);
  });

  it("`config` and `status` print the warning on stderr", () => {
    fs.writeFileSync(cfg(), "{broken");
    for (const cmd of ["config", "status"]) {
      const r = spawnSync(process.execPath, [CLI, cmd], { cwd: ws, encoding: "utf-8" });
      assert.equal(r.status, 0);
      assert.match(r.stderr, /warning: .*does not parse/, cmd);
    }
  });
});
}

// =============================================================================
// ── shared helpers regressions ──
// =============================================================================

/**
 * Regressions for bugs found while consolidating shared helpers: action ordering past
 * action_999, shell quoting in isCommandAvailable, and the reflection runner's environment.
 *
 * Modules are loaded from BACKUPPER_TEST_DIST (default: this build's dist/), so the same
 * file can be run against an older build.
 */

const DIST = process.env.BACKUPPER_TEST_DIST || path.resolve(__dirname, "../../../dist");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const load = (m: string) => require(path.join(DIST, m));

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("shared helper regressions", () => {
  it("lists action folders in numeric order past action_999", () => {
    const store = tmp("bu-order-");
    const backups = path.join(store, "backups");
    for (const n of ["action_998_20260101000000", "action_999_20260101000001", "action_1000_20260101000002"]) {
      fs.mkdirSync(path.join(backups, n), { recursive: true });
    }
    const { listActions } = load("backup/manifest.js");
    assert.deepEqual(listActions({ backupDir: backups }), [
      "action_998_20260101000000", "action_999_20260101000001", "action_1000_20260101000002",
    ]);
    fs.rmSync(store, { recursive: true, force: true });
  });

  it("isCommandAvailable does not run shell syntax in its argument", () => {
    const dir = tmp("bu-quote-");
    const marker = path.join(dir, "ran");
    const { isCommandAvailable } = load("backup/subagent.js");
    isCommandAvailable(`definitely-not-a-command; touch ${marker}`);
    assert.equal(fs.existsSync(marker), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the reflection runner gets the shared subagent environment", { skip: process.getuid?.() !== 0 }, () => {
    const dir = tmp("bu-reflenv-");
    const bin = path.join(dir, "bin");
    const envOut = path.join(dir, "env.txt");
    fs.mkdirSync(bin);
    // A stand-in `claude` that records the variables it was started with.
    fs.writeFileSync(path.join(bin, "claude"),
      `#!/bin/sh\necho "IS_SANDBOX=$IS_SANDBOX MCP_TIMEOUT=$MCP_TIMEOUT" > ${JSON.stringify(envOut)}\necho '{"result":"{}"}'\n`,
      { mode: 0o755 });
    const actionDir = path.join(dir, ".backupper", "backups", "action_001_20260101000000");
    fs.mkdirSync(actionDir, { recursive: true });
    const saved = { PATH: process.env.PATH, IS_SANDBOX: process.env.IS_SANDBOX, MCP_TIMEOUT: process.env.MCP_TIMEOUT };
    process.env.PATH = `${bin}:${saved.PATH}`;
    delete process.env.IS_SANDBOX;
    delete process.env.MCP_TIMEOUT;
    try {
      const { DEFAULT_CONFIG } = load("types.js");
      const { reflectAfterBackup } = load("self-improving/learned.js");
      const config = {
        ...DEFAULT_CONFIG,
        backupDir: path.join(dir, ".backupper", "backups"),
        selfImproving: true,
        subagentRunner: "claude",
        learnedBackupRulesPath: path.join(dir, ".backupper", "learned-backup-rules.json"),
      };
      const ctx = { tool_name: "Bash", tool_input: { command: "rm x" }, session_id: "s", cwd: dir };
      reflectAfterBackup(ctx, actionDir, { id: "a", strategy: "subagent", description: "", toolName: "Bash" }, config);
      assert.match(fs.readFileSync(envOut, "utf-8"), /IS_SANDBOX=1 MCP_TIMEOUT=60000/);
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.IS_SANDBOX !== undefined) process.env.IS_SANDBOX = saved.IS_SANDBOX;
      if (saved.MCP_TIMEOUT !== undefined) process.env.MCP_TIMEOUT = saved.MCP_TIMEOUT;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
