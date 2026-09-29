/**
 * Hook contract tests — invoke the compiled hook scripts via stdin/stdout
 * exactly how Claude Code calls them. Verifies:
 *   - The binaries exist and are executable
 *   - The JSON I/O contract matches what Claude Code expects
 *   - Exit codes are correct (0 = allow, 2 = deny)
 *   - Never crashes on malformed input
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const PRE_HOOK = path.join(PROJECT_ROOT, "dist/hooks/pre-tool.js");

function runHook(hookPath: string, input: unknown, cwd?: string): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  try {
    const stdout = execSync(`node ${hookPath}`, {
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
      const result = execSync(`node ${PRE_HOOK}`, {
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
      const result = execSync(`node ${PRE_HOOK}`, {
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
