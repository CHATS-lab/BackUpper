/**
 * Restore of tier-2 `file_copy` artifacts (a file edited outside the workspace), the shadow
 * repo's exclusion of BackUpper's own install files, and config.json warnings.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { restoreActionDirect, restoreActionLoop, restoreArtifact, fileCopyTarget } from "../../src/restore/restore.js";
import { configWarnings, loadConfig } from "../../src/config/load.js";
import type { BackupArtifact } from "../../src/types.js";

const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const PRE_HOOK = path.join(PROJECT_ROOT, "dist/hooks/pre-tool.js");
const CLI = path.join(PROJECT_ROOT, "dist/cli.js");

let ws: string;
let outside: string;
let originalCwd: string;

function hook(tool: string, input: Record<string, unknown>, agent = "claude-code") {
  const env: NodeJS.ProcessEnv = { ...process.env, BACKUPPER_READONLY_CHECKER: "0" };
  delete env.BACKUPPER_NO_HOOK;
  delete env.BACKUPPER_STORE_DIR;
  return spawnSync(process.execPath, [PRE_HOOK, "--agent", agent], {
    cwd: ws, env, encoding: "utf-8",
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, cwd: ws }),
  });
}

beforeEach(() => {
  originalCwd = process.cwd();
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backupper-fc-ws-")));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backupper-fc-out-")));
  execSync("git init -q", { cwd: ws });
  fs.writeFileSync(path.join(ws, "app.py"), "x = 1\n");
  fs.mkdirSync(path.join(ws, ".backupper"));
  fs.writeFileSync(path.join(ws, ".backupper", "config.json"), JSON.stringify({ mode: "checker", subagentEnabled: false }));
  process.chdir(ws);
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

function onlyAction(): string {
  const names = fs.readdirSync(path.join(ws, ".backupper", "backups")).filter((n) => n.startsWith("action_"));
  assert.equal(names.length, 1);
  return names[0];
}

describe("restore of a tier-2 file_copy (file outside the workspace)", () => {
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

describe("tier-2 snapshot leaves BackUpper's install files alone", () => {
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
