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

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { applyPolicyRules } from "../../src/backup/policy_rules.js";
import { foreignExecTarget, execTargetIsSelf } from "../../src/backup/exec_target.js";
import type { HookContext } from "../../src/types.js";

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

beforeEach(() => {
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
});

afterEach(() => {
  restoreEnv();
  process.chdir(originalCwd);
  try {
    fs.rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

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
