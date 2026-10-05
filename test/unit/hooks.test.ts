/**
 * Hooks and agents: the hook contract, tier 1 by permission mode and in backup-only mode, the side panel and the watch renderer.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync, spawnSync, execFileSync } from "node:child_process";
import { evaluate, evaluateFailOpen } from "../../src/engine.js";
import { buildSubagentInvocation, cleanupSubagentInvocation, runSubagentBackup } from "../../src/backup/subagent.js";
import { resetAction } from "../../src/backup/strategies.js";
import { subagentModelFor } from "../../src/backup/runner_caps.js";
import { DEFAULT_CONFIG, DEFAULT_DENY_RULES, type HookContext, type SandboxConfig } from "../../src/types.js";
import { applyPolicyRules, type PolicyRuleResult } from "../../src/backup/policy_rules.js";
import { tier1CanRewrite, CAN_REWRITE, ALL_ADAPTERS, hermesAdapter } from "../../src/agents.js";
import { closeCommand, detectTerminal, parsePanelPrompt, splitCommand } from "../../src/cli.js";
import type { ActionDetail, ActionSummary } from "../../src/view.js";
import { actionRow, clip, emptyState, headlineTier, renderWatch, type WatchState } from "../../src/view.js";

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
// ── hook contract ──
// =============================================================================

/**
 * Hook contract tests — invoke the compiled hook scripts via stdin/stdout
 * exactly how Claude Code calls them. Verifies:
 *   - The binaries exist and are executable
 *   - The JSON I/O contract matches what Claude Code expects
 *   - Exit codes are correct (0 = allow, 2 = deny)
 *   - Never crashes on malformed input
 */

const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const PRE_HOOK = path.join(PROJECT_ROOT, "dist/hook.js"); // run as `hook.js pre`

function runHook(hookPath: string, input: unknown, cwd?: string): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  try {
    const stdout = execSync(`node ${hookPath} pre`, {
      input: JSON.stringify(input),
      encoding: "utf-8",
      cwd: cwd ?? process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (e: unknown) {
    // execSync throws on non-zero exit
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      exitCode: err.status ?? 1,
    };
  }
}

function isolatedCwd(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backupper-hook-contract-"));
  return {
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

describe("hook contract: pre-tool.js binary", () => {
  it("binary exists and is executable", () => {
    assert.ok(fs.existsSync(PRE_HOOK), `Expected ${PRE_HOOK} to exist — run npm run build`);
    const stat = fs.statSync(PRE_HOOK);
    // On some systems permissions bits aren't meaningful; just check we can read it
    assert.ok(stat.size > 0);
  });

  it("handles read-only action with exit 0 and no output", () => {
    const { dir, cleanup } = isolatedCwd();
    try {
      const result = runHook(PRE_HOOK, {
        hook_event: "PreToolUse",
        tool_name: "Read",
        tool_input: { path: "/tmp/foo" },
      }, dir);
      assert.equal(result.exitCode, 0);
      // Read-only tools pass through with no stdout
      assert.equal(result.stdout.trim(), "");
    } finally {
      cleanup();
    }
  });

  it("handles malformed JSON without crashing", () => {
    try {
      const result = execSync(`node ${PRE_HOOK} pre`, {
        input: "THIS IS NOT JSON",
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      // Exit 0 is acceptable (silent pass-through on parse error)
      assert.ok(result !== undefined);
    } catch (e: unknown) {
      // Should NOT crash — should exit 0 silently
      const err = e as { status?: number };
      assert.equal(err.status, 0, "Malformed JSON should not cause non-zero exit");
    }
  });

  it("handles empty stdin without crashing", () => {
    try {
      const result = execSync(`node ${PRE_HOOK} pre`, {
        input: "",
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      assert.ok(result !== undefined);
    } catch (e: unknown) {
      const err = e as { status?: number };
      assert.equal(err.status, 0, "Empty stdin should not cause non-zero exit");
    }
  });

  it("respects user-configured deny patterns", () => {
    const { dir, cleanup } = isolatedCwd();
    try {
      // Write a config with a deny pattern
      const configDir = path.join(dir, ".backupper");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, "config.json"),
        JSON.stringify({
          enabled: true,
          mode: "checker",
          backupDir: path.join(configDir, "backups"),
          maxActions: 10,
          effectManifest: false,
          effectLogPath: path.join(configDir, "effects.jsonl"),
          denyPatterns: ["rm\\s+-rf\\s+/"],
          alwaysBackupPatterns: [],
          verbose: false,
        }),
      );

      const result = runHook(PRE_HOOK, {
        hook_event: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /" },
      }, dir);

      assert.equal(result.exitCode, 2, "deny should exit 2");
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
      assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
    } finally {
      cleanup();
    }
  });

  it('respects mode="off" (no hook output)', () => {
    const { dir, cleanup } = isolatedCwd();
    try {
      const configDir = path.join(dir, ".backupper");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, "config.json"),
        JSON.stringify({
          enabled: true,
          mode: "off",
          backupDir: path.join(configDir, "backups"),
          maxActions: 10,
          effectManifest: false,
          effectLogPath: path.join(configDir, "effects.jsonl"),
          denyPatterns: [],
          alwaysBackupPatterns: [],
          verbose: false,
        }),
      );

      const result = runHook(PRE_HOOK, {
        hook_event: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "rm important.txt" },
      }, dir);

      assert.equal(result.exitCode, 0);
      // mode="off" should produce no output
      assert.equal(result.stdout.trim(), "");
    } finally {
      cleanup();
    }
  });

  it("respects enabled=false (no hook output)", () => {
    const { dir, cleanup } = isolatedCwd();
    try {
      const configDir = path.join(dir, ".backupper");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, "config.json"),
        JSON.stringify({
          enabled: false,
          mode: "checker",
          backupDir: path.join(configDir, "backups"),
          maxActions: 10,
          effectManifest: false,
          effectLogPath: path.join(configDir, "effects.jsonl"),
          denyPatterns: [],
          alwaysBackupPatterns: [],
          verbose: false,
        }),
      );

      const result = runHook(PRE_HOOK, {
        hook_event: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "pip install flask" },
      }, dir);

      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout.trim(), "");
    } finally {
      cleanup();
    }
  });
});

// =============================================================================
// ── failopen and cleanup ──
// =============================================================================

/**
 * Fail-open rule evaluation and subagent temp-file cleanup.
 *
 * Deny rules are exercised by feeding command strings to the rule engine and to the hook
 * binary; the hook only decides, it never runs the command.
 */

{
const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const PRE_HOOK = path.join(PROJECT_ROOT, "dist/hook.js"); // run as `hook.js pre`

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
      return spawnSync(process.execPath, [PRE_HOOK, "pre", "--agent", "claude-code"], {
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
}

// =============================================================================
// ── chain mode ──
// =============================================================================

/**
 * Tier 1 by permission mode: bypass keeps the in-hook rewrite (output identical to the
 * pre-change hook); any other mode returns `<copies> && <original>` and executes nothing.
 * The bypass comparison needs the pre-change dist (its hooks/pre-tool.js layout) in BACKUPPER_ORIG_DIST; it is skipped
 * without it.
 */

{
const SUITES_CHAIN_MODE = ["bypass mode is unchanged", "non-bypass mode: copies && original, nothing executed in the hook"];
const PROJECT_ROOT = path.resolve(__dirname, "../../..");
// argv of the built hooks: `hook.js pre` / `hook.js post`.
const PRE_HOOK = [path.join(PROJECT_ROOT, "dist/hook.js"), "pre"];
const POST_HOOK = [path.join(PROJECT_ROOT, "dist/hook.js"), "post"];
const CLI = path.join(PROJECT_ROOT, "dist/cli.js");
const ORIG = process.env.BACKUPPER_ORIG_DIST ?? "";

let workspace: string;
let originalCwd: string;
beforeEach(onlyIn(SUITES_CHAIN_MODE, () => {
  originalCwd = process.cwd();
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backupper-chain-")));
  process.chdir(workspace);
}));
afterEach(onlyIn(SUITES_CHAIN_MODE, () => {
  process.chdir(originalCwd);
  fs.rmSync(workspace, { recursive: true, force: true });
}));

function setup(dir: string): void {
  execSync("git init -q && git config user.email t@t && git config user.name t && git config commit.gpgsign false" +
    " && printf 'v0\\n' > tracked.txt && git add tracked.txt && git commit -q -m init" +
    " && printf 'stash\\n' > tracked.txt && git stash -q", { cwd: dir });
  fs.writeFileSync(path.join(dir, "notes.txt"), "keep me\n");
  fs.writeFileSync(path.join(dir, "conf.txt"), "a=1\n");
  fs.mkdirSync(path.join(dir, ".backupper"));
  fs.writeFileSync(path.join(dir, ".backupper/config.json"), JSON.stringify({ mode: "checker", subagentEnabled: false }));
}

function hook(script: string[], cwd: string, agent: string, command: string, mode?: string, event = "PreToolUse") {
  const env: NodeJS.ProcessEnv = { ...process.env, BACKUPPER_READONLY_CHECKER: "0" };
  for (const k of ["BACKUPPER_NO_HOOK", "BACKUPPER_STORE_DIR", "BACKUPPER_NO_REWRITE", "TERMINAL_ENV", "BACKUPPER_EXEC_TARGET"]) delete env[k];
  return spawnSync(process.execPath, [...script, "--agent", agent], {
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
        const old = hook([path.join(ORIG, "hooks/pre-tool.js")], b, agent, cmd, "bypassPermissions");
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
    assert.match(out.updatedInput.command, /^node \S+\/hook\.js capture \S+\/notes\.txt \S+\/trash\/\S+ && rm notes\.txt$/);
    assert.equal(fs.readFileSync("notes.txt", "utf8"), "keep me\n");
    const dir = fs.readdirSync(".backupper/backups").map((d) => path.join(".backupper/backups", d))[0];
    assert.ok(!fs.existsSync(path.join(dir, "trash")), "the hook must not copy anything");
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "metadata.json"), "utf8"));
    assert.equal(meta[0].backupOnly, true);
    assert.equal(meta[0].deferredCopies.length, 1);

    // The copy helper refuses a destination the hook did not record.
    const helper = out.updatedInput.command.split(" ").slice(0, 3).join(" ");
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
}

// =============================================================================
// ── backup only mode ──
// =============================================================================

/**
 * Tier 1 in backup-only mode (hosts that ignore a rewritten tool input, e.g. Codex).
 *
 * For each rule: applyPolicyRules(..., { rewrite: false }) must capture a restorable copy,
 * execute NOTHING the command targets and return no updatedInput. The test then runs the
 * original command exactly once, as the host would, and checks that the recorded recovery
 * commands bring the pre-state back.
 */

{
const SUITES_BACKUP_ONLY_MODE = ["backup-only mode: host capability", "backup-only mode: file rules", "backup-only mode: git rules", "a trailing `# [BACKUP NEEDED]` marker does not defeat tier 1", "backup-only mode: docker / kubectl (mocked CLIs)", "backup-only mode through the installed hook (--agent codex)"];
const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const PRE_HOOK = path.join(PROJECT_ROOT, "dist/hook.js"); // run as `hook.js pre`
const CLI = path.join(PROJECT_ROOT, "dist/cli.js");

function bash(command: string): HookContext {
  return { hook_event: "PreToolUse", tool_name: "Bash", tool_input: { command } };
}

let workspace: string;
let trash: string;
let store: string;
let originalCwd: string;

beforeEach(onlyIn(SUITES_BACKUP_ONLY_MODE, () => {
  originalCwd = process.cwd();
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backupper-bo-")));
  process.chdir(workspace);
  store = path.join(workspace, ".backupper");
  trash = path.join(store, "backups", "action_001_x", "trash");
}));

afterEach(onlyIn(SUITES_BACKUP_ONLY_MODE, () => {
  process.chdir(originalCwd);
  fs.rmSync(workspace, { recursive: true, force: true });
}));

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
  it("codex, claude-code and hermes can all rewrite", () => {
    assert.equal(CAN_REWRITE.codex, true);
    assert.equal(CAN_REWRITE["claude-code"], true);
    assert.equal(CAN_REWRITE.hermes, true);
    for (const a of ALL_ADAPTERS) assert.equal(a.canRewrite, CAN_REWRITE[a.name], a.name);
  });

  it("follows the host tag, with BACKUPPER_NO_REWRITE as an override", () => {
    assert.equal(tier1CanRewrite({ BACKUPPER_HOST_AGENT: "codex" }), true);
    assert.equal(tier1CanRewrite({ BACKUPPER_HOST_AGENT: "codex", BACKUPPER_NO_REWRITE: "1" }), false);
    assert.equal(tier1CanRewrite({ BACKUPPER_HOST_AGENT: "claude-code" }), true);
    assert.equal(tier1CanRewrite({ BACKUPPER_HOST_AGENT: "hermes" }), true);
    assert.equal(tier1CanRewrite({}), false, "an unknown host gets the mode that is safe everywhere");
    assert.equal(tier1CanRewrite({ BACKUPPER_HOST_AGENT: "claude-code", BACKUPPER_NO_REWRITE: "1" }), false);
    assert.equal(tier1CanRewrite({ BACKUPPER_HOST_AGENT: "codex", BACKUPPER_NO_REWRITE: "0" }), true);
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

  it("git reset --hard: records HEAD and executes nothing (tier 3 snapshots the worktree)", () => {
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
    assert.equal(r!.updatedInput, undefined, "no rewrite: tier 3 must snapshot before the reset runs");
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

describe("a trailing `# [BACKUP NEEDED]` marker does not defeat tier 1", () => {
  it("git stash drop # [BACKUP NEEDED] (backup-only)", () => {
    initRepo();
    fs.writeFileSync("tracked.txt", "s1\n");
    execSync("git stash -q");
    fs.writeFileSync("tracked.txt", "s2\n");
    execSync("git stash -q");
    const r = capture("git stash drop # [BACKUP NEEDED]");
    assert.equal(r.ruleId, "git-stash-drop");
    hostRuns("git stash drop # [BACKUP NEEDED]");
    recover(r);
    assert.equal(git("stash list").split("\n").length, 2);
  });

  it("sed -i ... # [BACKUP NEEDED] (rewrite mode) and a quoted # is not a comment", () => {
    fs.writeFileSync("f.txt", "a#b\n");
    const r = applyPolicyRules(bash("sed -i 's/#/-/' f.txt # [BACKUP NEEDED]"), trash, store);
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
    return spawnSync(process.execPath, [PRE_HOOK, "pre", "--agent", agent], {
      cwd, env, encoding: "utf-8",
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd }),
    });
  }
  function setup(): void {
    initRepo();
    fs.mkdirSync(".backupper");
    fs.writeFileSync(".backupper/config.json", JSON.stringify({ mode: "checker", subagentEnabled: false }));
  }

  it("codex: rm is rewritten with permissionDecision allow (Codex applies updatedInput only then)", () => {
    setup();
    fs.writeFileSync("notes.txt", "keep me\n");
    const r = runHook(workspace, "codex", "rm notes.txt");
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "allow");
    assert.equal(typeof out.updatedInput.command, "string");
    assert.match(out.updatedInput.command, /^true/);
    assert.ok(!fs.existsSync("notes.txt"));
    const meta = JSON.parse(read(path.join(fs.readdirSync(".backupper/backups").map((d) => path.join(".backupper/backups", d))[0], "metadata.json")));
    assert.equal(meta[0].strategy, "policy_rewrite");
    assert.notEqual(meta[0].backupOnly, true);
    const rr = spawnSync(process.execPath, [CLI, "restore", "1"], { cwd: workspace, encoding: "utf-8" });
    assert.equal(rr.status, 0, rr.stdout + rr.stderr);
    assert.equal(read("notes.txt"), "keep me\n");
  });

  it("codex with BACKUPPER_NO_REWRITE=1: rm is captured without a rewrite, and `backupper restore` brings it back", () => {
    setup();
    fs.writeFileSync("notes.txt", "keep me\n");
    const r = runHook(workspace, "codex", "rm notes.txt", { BACKUPPER_NO_REWRITE: "1" });
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
    // Claude Code is never told "allow": that would skip its own permission check.
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, undefined);
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
    const r = runHook(workspace, "codex", "find . -name config.json -delete", { BACKUPPER_NO_REWRITE: "1" });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
    assert.ok(fs.existsSync(".backupper/config.json"));
  });
});
}

// =============================================================================
// ── panel ──
// =============================================================================

/**
 * Tests for `backupper panel` (the panel section of cli.ts): terminal detection, the split/close commands and
 * the VS Code task merge. Nothing is spawned.
 */

const W = ["/usr/bin/node", "/opt/bu/dist/cli.js", "watch"];

describe("detectTerminal", () => {
  it("prefers multiplexers over the host app", () => {
    assert.equal(detectTerminal({ TMUX: "/tmp/tmux-1/default,1,0", TERM_PROGRAM: "vscode" }), "tmux");
    assert.equal(detectTerminal({ ZELLIJ: "0", TERM_PROGRAM: "iTerm.app" }), "zellij");
  });
  it("recognises each terminal", () => {
    assert.equal(detectTerminal({ TERM_PROGRAM: "vscode" }), "vscode");
    assert.equal(detectTerminal({ WEZTERM_PANE: "3" }), "wezterm");
    assert.equal(detectTerminal({ KITTY_WINDOW_ID: "1" }), "kitty");
    assert.equal(detectTerminal({ TERM_PROGRAM: "iTerm.app" }), "iterm2");
    assert.equal(detectTerminal({ TERM_PROGRAM: "Apple_Terminal" }), "unknown");
    assert.equal(detectTerminal({}), "unknown");
  });
});

describe("splitCommand", () => {
  it("tmux splits right, keeps focus and prints the pane id", () => {
    const l = splitCommand("tmux", "/work/my proj", W)!;
    assert.equal(l.cmd, "tmux");
    assert.deepEqual(l.args.slice(0, 8), ["split-window", "-h", "-d", "-P", "-F", "#{pane_id}", "-c", "/work/my proj"]);
    assert.equal(l.args[8], "/usr/bin/node /opt/bu/dist/cli.js watch");
    assert.ok(l.printsPaneId);
  });
  it("zellij, wezterm and kitty pass the argv through", () => {
    assert.deepEqual(splitCommand("zellij", "/w", W)!.args, ["run", "--direction", "right", "--close-on-exit", "--cwd", "/w", "--", ...W]);
    assert.deepEqual(splitCommand("wezterm", "/w", W)!.args, ["cli", "split-pane", "--right", "--cwd", "/w", "--", ...W]);
    assert.deepEqual(splitCommand("kitty", "/w", W)!.args, ["@", "launch", "--location=vsplit", "--keep-focus", "--cwd", "/w", ...W]);
  });
  it("iTerm2 splits vertically through AppleScript with quoted paths", () => {
    const l = splitCommand("iterm2", `/w/it's "here"`, W)!;
    assert.equal(l.cmd, "osascript");
    assert.match(l.args[1], /split vertically with default profile/);
    assert.match(l.args[1], /exec \/usr\/bin\/node \/opt\/bu\/dist\/cli\.js watch/);
    assert.match(l.args[1], /\\"here\\"/);
  });
  it("no scripted split for VS Code or unknown terminals", () => {
    assert.equal(splitCommand("vscode", "/w", W), null);
    assert.equal(splitCommand("unknown", "/w", W), null);
  });
  it("close targets exactly the recorded pane", () => {
    assert.deepEqual(closeCommand("tmux", "%7")!.args, ["kill-pane", "-t", "%7"]);
    assert.deepEqual(closeCommand("wezterm", "12")!.args, ["cli", "kill-pane", "--pane-id", "12"]);
    assert.deepEqual(closeCommand("kitty", "4")!.args, ["@", "close-window", "--match=id:4"]);
    assert.equal(closeCommand("tmux", undefined), null);
    assert.equal(closeCommand("zellij", "1"), null);
  });
});

describe("parsePanelPrompt", () => {
  it("matches only a bare panel command", () => {
    assert.equal(parsePanelPrompt("/backupper-panel"), "toggle");
    assert.equal(parsePanelPrompt("  /backupper-panel off "), "off");
    assert.equal(parsePanelPrompt("/bu panel on"), "on");
    assert.equal(parsePanelPrompt("/backupper-panel status"), "status");
    assert.equal(parsePanelPrompt("/backupper-panel please and also delete x"), null);
    assert.equal(parsePanelPrompt("open /backupper-panel"), null);
    assert.equal(parsePanelPrompt("/backupper-list"), null);
  });
});

// =============================================================================
// ── hermes panel command ──
// =============================================================================

/**
 * The Hermes plugin registers /backupper-panel as a plugin slash command, so Hermes answers it
 * without a model turn. Loads the generated plugin in Python with a stand-in ctx.
 */

function hasPython(): boolean {
  try { execFileSync("python3", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

const PROBE = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("bp", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
class Ctx:
    def __init__(self): self.cmds = {}
    def register_hook(self, *a): pass
    def register_command(self, name, handler, description="", args_hint=""): self.cmds[name] = (handler, args_hint)
class Old:
    def register_hook(self, *a): pass
c = Ctx(); m.register(c); m.register(Old())
h, hint = c.cmds["backupper-panel"]
print(json.dumps({"names": list(c.cmds), "hint": hint, "bad": h("sideways")}))
`;

describe("Hermes /backupper-panel", { skip: !hasPython() && "python3 not available" }, () => {
  it("registers the command, rejects unknown actions, and tolerates Hermes without register_command", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bu-hermes-"));
    try {
      hermesAdapter.install(dir, "/opt/bu/dist");
      const init = path.join(dir, ".hermes", "plugins", "backupper", "__init__.py");
      assert.match(fs.readFileSync(init, "utf-8"), /^_CLI = "\/opt\/bu\/dist\/cli\.js"$/m);
      const out = JSON.parse(execFileSync("python3", ["-c", PROBE, init], { encoding: "utf-8" }));
      assert.deepEqual(out.names, ["backupper-panel"]);
      assert.equal(out.hint, "[on|off|toggle|status]");
      assert.equal(out.bad, "Usage: /backupper-panel [on|off|toggle|status]");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// ── watch render ──
// =============================================================================

/**
 * Tests for the `backupper watch` renderer (view.ts): store snapshot in, lines out.
 */

function action(seq: number, over: Partial<ActionSummary> = {}): ActionSummary {
  return {
    name: `action_${String(seq).padStart(3, "0")}_20261004120000`,
    seq,
    timestamp: "2026-10-04T12:00:00.000Z",
    timeFormatted: "2026-10-04 12:00:00",
    instruction: "",
    strategies: ["git_snapshot"],
    tiers: [3],
    files: ["a.txt", "b.txt"],
    stats: "",
    toolName: "Bash",
    originalAction: `echo step ${seq}`,
    sizeBytes: 0,
    ageMs: 0,
    storage: [{ strategy: "git_snapshot", path: "/s/shadow.git" }],
    ...over,
  };
}

function state(actions: ActionSummary[], over: Partial<WatchState> = {}): WatchState {
  return { ...emptyState(), project: "/work/demo", mode: "checker", storeBytes: 2048, actions, selected: actions.length - 1, ...over };
}

const plain = (s: WatchState, w = 100, h?: number) => renderWatch(s, w, h, false);

describe("watch renderer", () => {
  it("header shows project, mode, scope and store size", () => {
    const head = plain(state([]))[0];
    assert.match(head, /BackUpper · demo/);
    assert.match(head, /mode checker · Full · 2\.0 KB/);
    assert.match(plain(state([], { personalization: "high-impact" }))[0], /personalized \(high-impact\)/);
  });

  it("empty store says so", () => {
    assert.ok(plain(state([])).some((l) => /No actions recorded yet/.test(l)));
  });

  it("rows read #N <call> → Tier K <name> <artifact>, newest at the bottom", () => {
    const lines = plain(state([action(1), action(2, { strategies: ["policy_rewrite"], tiers: [1], files: [], originalAction: "rm notes.txt", storage: [{ strategy: "policy_rewrite", path: "/s/trash/notes.txt" }] })], { expanded: false }));
    const rows = lines.filter((l) => /#\d/.test(l));
    assert.match(rows[0], /#1 echo step 1 → Tier 3 snapshot 2 files$/);
    assert.match(rows[1], /^› #2 rm notes\.txt → Tier 1 command rewriting notes\.txt$/);
  });

  it("the headline tier is the most specific capture", () => {
    assert.deepEqual(headlineTier(action(1, { strategies: ["git_snapshot", "subagent"] })), { tier: 4, strategy: "subagent" });
    assert.equal(headlineTier(action(1, { strategies: [] })), null);
  });

  it("long calls are truncated to the width, colour codes excluded", () => {
    const row = actionRow(action(7, { originalAction: "x".repeat(300) }), 60, false, false);
    assert.equal(row.length, 60);
    assert.match(row, /… → Tier 3 snapshot 2 files$/);
    const colored = actionRow(action(7), 60, false, true);
    assert.match(colored, /\x1b\[33mTier 3 snapshot\x1b\[0m/);
  });

  it("detail block has MATCHED, RUNS and how to restore", () => {
    const detail: ActionDetail = {
      ...action(2),
      artifacts: [{ id: "c", timestamp: "", trigger: "rule", toolName: "Bash", description: "Snapshot of the workspace", strategy: "git_snapshot", artifactPath: "/s" }],
    };
    const lines = plain(state([action(1), action(2)], { selected: 1, detail }));
    assert.ok(!plain(state([action(1), action(2)], { selected: 0, detail })).join("\n").includes("Snapshot of the workspace"), "stale detail is ignored");
    const text = lines.join("\n");
    assert.match(text, /MATCHED\s+Tier 3 snapshot · Snapshot of the workspace/);
    assert.match(text, /RUNS\s+echo step 2/);
    assert.match(text, /RESTORE\s+press r to undo #2, or run: backupper restore 2/);
  });

  it("restore scope counts the later actions", () => {
    const text = plain(state([action(1), action(2), action(3)], { selected: 0 })).join("\n");
    assert.match(text, /press r to undo #1 and the 2 later actions/);
  });

  it("fills exactly the terminal height and keeps the selection visible", () => {
    const many = Array.from({ length: 50 }, (_, i) => action(i + 1));
    for (const selected of [0, 25, 49]) {
      const lines = plain(state(many, { selected, expanded: false }), 80, 12);
      assert.equal(lines.length, 12);
      assert.ok(lines.some((l) => l.startsWith(`› #${selected + 1} `)), `selection ${selected} visible`);
    }
    const tail = plain(state(many, { expanded: false }), 80, 12);
    assert.match(tail[1], /↑ \d+ older/);
  });

  it("confirm prompt and messages sit above the footer", () => {
    const lines = plain(state([action(1)], { confirm: "Undo #1?", message: ["[OK] restored"] }), 80, 20);
    assert.match(lines[18], /\[OK\] restored/);
    assert.match(lines[19], /Undo #1\? y = yes · n = no/);
  });

  it("diff view replaces the list and scrolls", () => {
    const diff = Array.from({ length: 40 }, (_, i) => `+line ${i}`);
    const lines = plain(state([action(1)], { diff, diffScroll: 5 }), 80, 10);
    assert.equal(lines.length, 10);
    assert.equal(lines[1], "+line 5");
    assert.match(lines[9], /d back/);
  });

  it("non-TTY snapshot prints every action", () => {
    const many = Array.from({ length: 30 }, (_, i) => action(i + 1));
    const lines = plain(state(many, { expanded: false }), 80);
    assert.equal(lines.filter((l) => /#\d+ echo/.test(l)).length, 30);
  });

  it("clip collapses whitespace", () => {
    assert.equal(clip("a\n  b", 10), "a b");
    assert.equal(clip("abcdef", 4), "abc…");
  });
});
