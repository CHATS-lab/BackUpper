/**
 * Regressions for bugs found while consolidating shared helpers: action ordering past
 * action_999, shell quoting in isCommandAvailable, and the reflection runner's environment.
 *
 * Modules are loaded from BACKUPPER_TEST_DIST (default: this build's dist/), so the same
 * file can be run against an older build.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
      const { reflectAfterBackup } = load("self-improving/reflection.js");
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
