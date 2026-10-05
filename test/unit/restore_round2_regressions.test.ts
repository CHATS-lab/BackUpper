/**
 * Regression tests for restore-side data-loss bugs and compound-command capture.
 *
 * Black-box: every test drives the built hooks (dist/hooks/pre-tool.js, post-tool.js) the way an
 * agent host does — pre-hook, run the (possibly rewritten) call, post-hook — and then the
 * `backupper` CLI, so the same file runs unchanged against an older build.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");
const PRE = path.join(ROOT, "dist/hooks/pre-tool.js");
const POST = path.join(ROOT, "dist/hooks/post-tool.js");
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

beforeEach(() => {
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
});

afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
});

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
  const pre = spawnSync(process.execPath, [PRE, "--agent", agent], { cwd: ws, env: e, encoding: "utf-8", input: JSON.stringify(payload) });
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
    spawnSync(process.execPath, [POST, "--agent", agent], {
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
    const pre = spawnSync(process.execPath, [PRE, "--agent", "claude-code"], {
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
