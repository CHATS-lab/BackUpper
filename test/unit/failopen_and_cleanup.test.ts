/**
 * Fail-open rule evaluation and subagent temp-file cleanup.
 *
 * Deny rules are exercised by feeding command strings to the rule engine and to the hook
 * binary; the hook only decides, it never runs the command.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { evaluate, evaluateFailOpen } from "../../src/engine/rules.js";
import {
  buildSubagentInvocation,
  cleanupSubagentInvocation,
  runSubagentBackup,
} from "../../src/backup/subagent.js";
import { resetAction } from "../../src/backup/strategies.js";
import { subagentModelFor } from "../../src/backup/runner_caps.js";
import { DEFAULT_CONFIG, DEFAULT_DENY_RULES, type HookContext, type SandboxConfig } from "../../src/types.js";

const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const PRE_HOOK = path.join(PROJECT_ROOT, "dist/hooks/pre-tool.js");

function bash(command: string): HookContext {
  return { hook_event: "PreToolUse", tool_name: "Bash", tool_input: { command } };
}

/** One command string per shipped deny rule, in DEFAULT_DENY_RULES order. */
const DENY_SAMPLES = [
  "mkfs.ext4 /dev/sdz1",
  "wipefs -a /dev/sdz",
  "dd if=/dev/zero of=/dev/sdz bs=1M",
  "shred -u secrets.txt",
  "lvremove -f vg0/data",
  "rm -rf /",
  "rm -rf ~",
  "rm -rf .backupper",
];

const throwing = (): never => { throw new Error("boom"); };

describe("rule evaluation fails open", () => {
  it("every shipped deny rule has a sample, and each sample is denied by evaluate", () => {
    assert.equal(DENY_SAMPLES.length, DEFAULT_DENY_RULES.length);
    DENY_SAMPLES.forEach((cmd, i) => {
      const r = evaluate(bash(cmd), { ...DEFAULT_CONFIG });
      assert.equal(r.decision, "deny", cmd);
      assert.equal(r.reason, DEFAULT_DENY_RULES[i].why, `${cmd} should hit rule ${i}`);
    });
  });

  it("an engine error allows the call and reports the error", () => {
    const r = evaluateFailOpen(bash("ls -la"), { ...DEFAULT_CONFIG }, throwing);
    assert.equal(r.decision, "pass");
    assert.equal(r.error, "boom");
  });

  it("the deny list still applies when the engine errors", () => {
    for (const cmd of DENY_SAMPLES) {
      const r = evaluateFailOpen(bash(cmd), { ...DEFAULT_CONFIG }, throwing);
      assert.equal(r.decision, "deny", cmd);
      assert.equal(r.error, "boom");
    }
  });

  it("falls back to the shipped deny list when denyPatterns is malformed", () => {
    const config = { ...DEFAULT_CONFIG, denyPatterns: null as unknown as string[] };
    const r = evaluateFailOpen(bash("mkfs.ext4 /dev/sdz1"), config);
    assert.equal(r.decision, "deny");
    assert.ok(r.error, "the engine itself should have thrown");
  });

  it("mode=off stays a pass even on the error path", () => {
    const r = evaluateFailOpen(bash("mkfs.ext4 /dev/sdz1"), { ...DEFAULT_CONFIG, mode: "off" }, throwing);
    assert.equal(r.decision, "pass");
  });

  describe("pre-tool hook binary", () => {
    let dir = "";
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "backupper-failopen-"));
      fs.mkdirSync(path.join(dir, ".backupper"));
      // A config the engine cannot evaluate: alwaysBackupPatterns must be a list.
      fs.writeFileSync(path.join(dir, ".backupper", "config.json"),
        JSON.stringify({ mode: "checker", subagentEnabled: false, alwaysBackupPatterns: null }));
    });
    after(() => { /* per-test dirs removed below */ });

    function runHook(command: string) {
      const env: NodeJS.ProcessEnv = { ...process.env, BACKUPPER_READONLY_CHECKER: "0" };
      delete env.BACKUPPER_NO_HOOK;
      delete env.BACKUPPER_STORE_DIR;
      return spawnSync(process.execPath, [PRE_HOOK, "--agent", "claude-code"], {
        cwd: dir, env, encoding: "utf-8",
        input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: dir }),
      });
    }

    it("allows the call, warns on stderr and logs to .backupper/hook-errors.log", () => {
      try {
        const r = runHook("ls -la");
        assert.equal(r.status, 0, r.stderr);
        assert.doesNotMatch(r.stdout, /"deny"/);
        assert.match(r.stderr, /rule evaluation failed, allowing the call/);
        const lines = fs.readFileSync(path.join(dir, ".backupper", "hook-errors.log"), "utf-8").trim().split("\n");
        // The invalid value is also reported as a config warning (once per version of the file).
        const warnings = lines.filter((l) => /config warning: .*alwaysBackupPatterns/.test(l));
        assert.equal(warnings.length, 1);
        assert.match(r.stderr, /config warning: .*alwaysBackupPatterns should be JSON array/);
        const log = lines.filter((l) => /rule evaluation failed/.test(l));
        assert.equal(log.length, 1);
        const entry = JSON.parse(log[0]);
        assert.equal(entry.hook, "PreToolUse");
        assert.equal(entry.tool, "Bash");
        assert.match(entry.message, /rule evaluation failed/);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("still denies a deny-list command under the same broken config", () => {
      try {
        const r = runHook("mkfs.ext4 /dev/sdz1");
        assert.equal(r.status, 2);
        assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

// ── Temp-file cleanup ─────────────────────────────────────────────────

const MOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "backupper-cleanup-bin-"));
let originalPath = "";

/** A fake runner CLI: reads stdin, prints `stdout`, exits with `code`. */
function installMock(name: string, stdout: string, code = 0): void {
  const out = path.join(MOCK_DIR, `${name}.out`);
  fs.writeFileSync(out, stdout);
  fs.writeFileSync(path.join(MOCK_DIR, name), `#!/bin/sh\ncat > /dev/null\ncat "${out}"\nexit ${code}\n`);
  fs.chmodSync(path.join(MOCK_DIR, name), 0o755);
}

/** Temp files this process could have left: backupper-sub-*-<pid>*. */
function leftovers(): string[] {
  const tag = `-${process.pid}`;
  return fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("backupper-sub-") && f.includes(tag));
}

function workspace(): { ws: string; config: SandboxConfig; cwd: string } {
  const cwd = process.cwd();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "backupper-cleanup-ws-"));
  process.chdir(ws);
  const profile = path.join(ws, "profile");
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, "Cookies"), "x");
  fs.writeFileSync(path.join(ws, ".mcp.json"), JSON.stringify({
    mcpServers: {
      shop: { command: "node", args: ["server.js", "--user-data-dir", profile] },
      other: { command: "node", args: ["other.js"] },
    },
  }));
  const config: SandboxConfig = {
    ...DEFAULT_CONFIG,
    backupDir: path.join(ws, ".backupper", "backups"),
    subagentEnabled: true,
    subagentRunner: "claude",
    subagentTimeoutSeconds: 10,
  };
  fs.mkdirSync(config.backupDir, { recursive: true });
  return { ws, config, cwd };
}

describe("subagent temp files are removed after the spawn", () => {
  before(() => {
    originalPath = process.env.PATH ?? "";
    process.env.PATH = `${MOCK_DIR}:${originalPath}`;
  });
  after(() => {
    process.env.PATH = originalPath;
    fs.rmSync(MOCK_DIR, { recursive: true, force: true });
  });
  beforeEach(() => resetAction());

  it("claude: the invocation lists its filtered/isolated MCP configs, and cleanup removes them", () => {
    installMock("claude", "{}");
    const { ws, config, cwd } = workspace();
    try {
      const inv = buildSubagentInvocation("p", config, { withMcp: true, neededServer: "shop", isolateBrowserProfile: true });
      assert.ok(inv);
      const names = (inv.tempPaths ?? []).map((p) => path.basename(p));
      assert.ok(names.includes(`backupper-sub-filtered-${process.pid}.json`), names.join(","));
      assert.ok(names.includes(`backupper-sub-mcp-${process.pid}.json`), names.join(","));
      assert.ok(names.includes(`backupper-sub-profile-${process.pid}-shop`), names.join(","));
      for (const p of inv.tempPaths!) assert.ok(fs.existsSync(p), p);
      cleanupSubagentInvocation(inv);
      for (const p of inv.tempPaths!) assert.ok(!fs.existsSync(p), `${p} left behind`);
    } finally {
      process.chdir(cwd);
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  for (const [label, code] of [["a successful", 0], ["a failed", 1]] as const) {
    it(`runSubagentBackup leaves nothing in the temp dir after ${label} spawn`, () => {
      installMock("claude", JSON.stringify({ type: "result", result: "done" }), code);
      const { ws, config, cwd } = workspace();
      try {
        const actionDir = path.join(config.backupDir, "action_001");
        fs.mkdirSync(actionDir, { recursive: true });
        runSubagentBackup(
          { hook_event: "PreToolUse", tool_name: "mcp__shop__delete_order", tool_input: { id: 7 } },
          actionDir, config,
        );
        assert.deepEqual(leftovers(), []);
      } finally {
        process.chdir(cwd);
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });
  }

  it("hermes: the filtered HOME copy (which holds the user's keys) is removed", () => {
    installMock("hermes", "ok");
    const { ws, config, cwd } = workspace();
    const hermesHome = path.join(ws, "hermes-home");
    fs.mkdirSync(hermesHome);
    fs.writeFileSync(path.join(hermesHome, "config.yaml"), "mcp_servers:\n  shop:\n    command: node\n");
    fs.writeFileSync(path.join(hermesHome, ".env"), "SOME_API_KEY=secret\n");
    const saved = process.env.HERMES_HOME;
    process.env.HERMES_HOME = hermesHome;
    try {
      const inv = buildSubagentInvocation("p", { ...config, subagentRunner: "hermes" }, { withMcp: true, neededServer: "shop" });
      assert.ok(inv?.env?.HOME, "expected a filtered HOME");
      assert.deepEqual(inv.tempPaths, [inv.env.HOME]);
      assert.ok(fs.existsSync(path.join(inv.env.HOME, ".hermes", ".env")));
      cleanupSubagentInvocation(inv);
      assert.ok(!fs.existsSync(inv.env.HOME));
    } finally {
      if (saved === undefined) delete process.env.HERMES_HOME; else process.env.HERMES_HOME = saved;
      process.chdir(cwd);
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it("codex: no temp files are created", () => {
    installMock("codex", "ok");
    const inv = buildSubagentInvocation("p", { ...DEFAULT_CONFIG, subagentRunner: "codex" }, { withMcp: true, neededServer: "shop" });
    assert.ok(inv);
    assert.equal(inv.tempPaths, undefined);
  });
});

// ── Default tier-4 model per runner ───────────────────────────────────

describe("tier-4 model defaults", () => {
  it("uses the cheap per-runner default, and subagentModel overrides every runner", () => {
    assert.equal(subagentModelFor(DEFAULT_CONFIG, "claude"), "haiku");
    assert.equal(subagentModelFor(DEFAULT_CONFIG, "codex"), "gpt-6-luna");
    assert.equal(subagentModelFor(DEFAULT_CONFIG, "hermes"), "");
    const pinned = { ...DEFAULT_CONFIG, subagentModel: "sonnet" };
    assert.equal(subagentModelFor(pinned, "claude"), "sonnet");
    assert.equal(subagentModelFor({ ...DEFAULT_CONFIG, subagentModels: {} }, "claude"), "");
  });

  it("the resolved model reaches each runner's command line", () => {
    const saved = process.env.PATH;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backupper-model-bin-"));
    for (const b of ["claude", "codex", "hermes"]) {
      fs.writeFileSync(path.join(dir, b), "#!/bin/sh\n");
      fs.chmodSync(path.join(dir, b), 0o755);
    }
    process.env.PATH = `${dir}:${saved}`;
    try {
      const claude = buildSubagentInvocation("p", { ...DEFAULT_CONFIG, subagentRunner: "claude" })!;
      assert.equal(claude.args[claude.args.indexOf("--model") + 1], "haiku");
      const codex = buildSubagentInvocation("p", { ...DEFAULT_CONFIG, subagentRunner: "codex" })!;
      assert.equal(codex.args[codex.args.indexOf("-m") + 1], "gpt-6-luna");
      const hermes = buildSubagentInvocation("p", { ...DEFAULT_CONFIG, subagentRunner: "hermes" })!;
      assert.ok(!hermes.args.includes("-m"));
      const pinned = buildSubagentInvocation("p", { ...DEFAULT_CONFIG, subagentRunner: "hermes", subagentModel: "x/y" })!;
      assert.equal(pinned.args[pinned.args.indexOf("-m") + 1], "x/y");
    } finally {
      process.env.PATH = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
