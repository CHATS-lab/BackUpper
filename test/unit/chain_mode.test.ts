/**
 * Tier 1 by permission mode: bypass keeps the in-hook rewrite (output identical to the
 * pre-change hook); any other mode returns `<copies> && <original>` and executes nothing.
 * The bypass comparison needs the pre-change dist in BACKUPPER_ORIG_DIST; it is skipped
 * without it.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const PRE_HOOK = path.join(PROJECT_ROOT, "dist/hooks/pre-tool.js");
const POST_HOOK = path.join(PROJECT_ROOT, "dist/hooks/post-tool.js");
const CLI = path.join(PROJECT_ROOT, "dist/cli.js");
const ORIG = process.env.BACKUPPER_ORIG_DIST ?? "";

let workspace: string;
let originalCwd: string;
beforeEach(() => {
  originalCwd = process.cwd();
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backupper-chain-")));
  process.chdir(workspace);
});
afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(workspace, { recursive: true, force: true });
});

function setup(dir: string): void {
  execSync("git init -q && git config user.email t@t && git config user.name t && git config commit.gpgsign false" +
    " && printf 'v0\\n' > tracked.txt && git add tracked.txt && git commit -q -m init" +
    " && printf 'stash\\n' > tracked.txt && git stash -q", { cwd: dir });
  fs.writeFileSync(path.join(dir, "notes.txt"), "keep me\n");
  fs.writeFileSync(path.join(dir, "conf.txt"), "a=1\n");
  fs.mkdirSync(path.join(dir, ".backupper"));
  fs.writeFileSync(path.join(dir, ".backupper/config.json"), JSON.stringify({ mode: "checker", subagentEnabled: false }));
}

function hook(script: string, cwd: string, agent: string, command: string, mode?: string, event = "PreToolUse") {
  const env: NodeJS.ProcessEnv = { ...process.env, BACKUPPER_READONLY_CHECKER: "0" };
  for (const k of ["BACKUPPER_NO_HOOK", "BACKUPPER_STORE_DIR", "BACKUPPER_NO_REWRITE", "TERMINAL_ENV", "BACKUPPER_EXEC_TARGET"]) delete env[k];
  return spawnSync(process.execPath, [script, "--agent", agent], {
    cwd, env, encoding: "utf-8",
    input: JSON.stringify({
      hook_event_name: event, tool_name: "Bash", tool_input: { command }, cwd, session_id: "s1",
      ...(mode ? { permission_mode: mode } : {}),
    }),
  });
}

const CMDS = ["rm notes.txt", "sed -i s/a/b/ conf.txt", "git stash drop"];

describe("bypass mode is unchanged", { skip: !ORIG && "BACKUPPER_ORIG_DIST not set" }, () => {
  for (const agent of ["claude-code", "codex"]) {
    for (const cmd of CMDS) {
      it(`${agent}: ${cmd}`, () => {
        const a = path.join(workspace, "a"), b = path.join(workspace, "b");
        fs.mkdirSync(a); fs.mkdirSync(b);
        setup(a); setup(b);
        const now = hook(PRE_HOOK, a, agent, cmd, "bypassPermissions");
        const old = hook(path.join(ORIG, "hooks/pre-tool.js"), b, agent, cmd, "bypassPermissions");
        // The stash commit's sha differs between the two repos (commit time); the rest must match.
        const norm = (s: string) => s.replace(/stash-\d+-[0-9a-f]+/g, "stash-N").replace(/\([0-9a-f]{12}\)/g, "(SHA)");
        assert.equal(now.status, old.status);
        assert.equal(norm(now.stdout), norm(old.stdout));
        assert.ok(now.stdout.length > 0);
      });
    }
  }
});

describe("non-bypass mode: copies && original, nothing executed in the hook", () => {
  it("claude-code default: rm returns cp ... && rm notes.txt and leaves the file alone", () => {
    setup(workspace);
    const r = hook(PRE_HOOK, workspace, "claude-code", "rm notes.txt", "default");
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, undefined);
    assert.match(out.updatedInput.command, /^node \S+\/hooks\/capture\.js \S+\/notes\.txt \S+\/trash\/\S+ && rm notes\.txt$/);
    assert.equal(fs.readFileSync("notes.txt", "utf8"), "keep me\n");
    const dir = fs.readdirSync(".backupper/backups").map((d) => path.join(".backupper/backups", d))[0];
    assert.ok(!fs.existsSync(path.join(dir, "trash")), "the hook must not copy anything");
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "metadata.json"), "utf8"));
    assert.equal(meta[0].backupOnly, true);
    assert.equal(meta[0].deferredCopies.length, 1);

    // The copy helper refuses a destination the hook did not record.
    const helper = out.updatedInput.command.split(" ").slice(0, 2).join(" ");
    assert.notEqual(spawnSync("sh", ["-c", `${helper} /etc/hostname ${path.join(workspace, dir, "trash", "x")}`]).status, 0);
    assert.ok(!fs.existsSync(path.join(dir, "trash", "x")));

    // Host runs the chain; restore brings the file back.
    execSync(out.updatedInput.command, { shell: "/bin/bash" });
    assert.ok(!fs.existsSync("notes.txt"));
    hook(POST_HOOK, workspace, "claude-code", out.updatedInput.command, "default", "PostToolUse");
    const rr = spawnSync(process.execPath, [CLI, "restore", "last"], { cwd: workspace, encoding: "utf-8" });
    assert.equal(rr.status, 0, rr.stdout + rr.stderr);
    assert.equal(fs.readFileSync("notes.txt", "utf8"), "keep me\n");
  });

  it("a denied call (no copies ran) drops the action's claim", () => {
    setup(workspace);
    const r = hook(PRE_HOOK, workspace, "claude-code", "sed -i s/a/b/ conf.txt", "acceptEdits");
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.match(out.updatedInput.command, /&& sed -i s\/a\/b\/ conf\.txt$/);
    assert.equal(fs.readFileSync("conf.txt", "utf8"), "a=1\n");
    hook(POST_HOOK, workspace, "claude-code", "sed -i s/a/b/ conf.txt", "acceptEdits", "PostToolUse");
    assert.deepEqual(fs.readdirSync(".backupper/backups"), []);
  });

  it("codex default: carries permissionDecision allow with the chained command", () => {
    setup(workspace);
    const r = hook(PRE_HOOK, workspace, "codex", "rm notes.txt", "default");
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "allow");
    assert.match(out.updatedInput.command, /&& rm notes\.txt$/);
    assert.ok(fs.existsSync("notes.txt"));
  });
});
