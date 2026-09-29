/**
 * Tests for the subagent result-bookkeeping path: a capture the subagent wrote to disk must be
 * registered in metadata.json even when its result file is malformed (e.g. over-escaped quotes)
 * or stdout holds prose instead of JSON, since restore finds artifacts only through metadata.json.
 */

import { describe, it, beforeEach, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  readSubagentResultFile,
  repairOverEscapedQuotes,
  findCapturedArtifacts,
  reportUnregisteredCapture,
  runSubagentBackup,
  UNREGISTERED_MARKER,
} from "../../src/backup/subagent.js";
import { resetAction } from "../../src/backup/strategies.js";
import { DEFAULT_CONFIG, type HookContext, type SandboxConfig } from "../../src/types.js";

// ── Fixtures ─────────────────────────────────────────────────────────

/** An over-escape shape seen in practice: `\\"` inside the
 *  recovery_commands strings, which closes the JSON string early. */
const OVER_ESCAPED_RESULT = `{"description":"Captured /var/lib/appdata allotment store before 'bin/capctl allot release --apply'.",
"backup_commands":["cp -rn /var/lib/appdata/allotments -> store/"],
"recovery_commands":["restore=$(ls -d /srv/x/store*)","for n in *.jsonl; do [ -f \\\\"$restore/allotments/$n\\\\" ] && cp \\\\"$restore/allotments/$n\\\\" /var/lib/appdata/allotments/$n; done"],
"recovery_mcp_calls":[],
"artifact_paths":["ARTIFACT_PATH_PLACEHOLDER"],
"live_restore":false,
"no_backup_needed":false}`;

function makeCtx(toolName: string, toolInput: Record<string, unknown>): HookContext {
  return { hook_event: "PreToolUse", tool_name: toolName, tool_input: toolInput };
}

function tmpActionDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "backupper-bk-"));
}

/** Write a small captured tree (what the subagent's `cp` produced). */
function writeCapturedStore(actionDir: string): string {
  const store = path.join(actionDir, "store", "allotments");
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, "2026-07.jsonl"), '{"id":1}\n{"id":2}\n');
  fs.writeFileSync(path.join(store, "index.tsv"), "1\theld\n2\treleased\n");
  return path.join(actionDir, "store");
}

// ── 1. The malformed canonical file ──────────────────────────────────

describe("subagent bookkeeping: malformed canonical result file", () => {
  it("recovers an over-escaped result via the narrow repair", () => {
    const dir = tmpActionDir();
    try {
      const artifact = writeCapturedStore(dir);
      fs.writeFileSync(
        path.join(dir, "subagent_result.json"),
        OVER_ESCAPED_RESULT.replace("ARTIFACT_PATH_PLACEHOLDER", artifact),
      );

      // Pre-condition: it really is malformed.
      assert.throws(() =>
        JSON.parse(fs.readFileSync(path.join(dir, "subagent_result.json"), "utf-8")));

      const notes: string[] = [];
      const r = readSubagentResultFile(dir, (m) => notes.push(m));
      assert.ok(r, "malformed-but-repairable result file must still be read");
      assert.match(r.description, /Captured \/var\/lib\/appdata/);
      assert.equal(r.recovery_commands.length, 2);
      // The repair must produce USABLE shell — real quotes, not backslashes.
      assert.match(r.recovery_commands[1], /\[ -f "\$restore\/allotments\/\$n" \]/);
      assert.ok(notes.some((n) => /over-escape/.test(n)), "must announce the repair");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs the fallback scan even when the canonical file is malformed", () => {
    // A parse error in the canonical file must not skip the fallback scan.
    const dir = tmpActionDir();
    try {
      fs.writeFileSync(path.join(dir, "subagent_result.json"), "{ this is not json at all ,,,");
      fs.writeFileSync(
        path.join(dir, "backlog_manifest.json"),
        JSON.stringify({
          description: "wrong filename but right shape",
          backup_commands: ["cp a b"],
          recovery_commands: ["cp b a"],
        }),
      );

      const notes: string[] = [];
      const r = readSubagentResultFile(dir, (m) => notes.push(m));
      assert.ok(r, "fallback scan must run despite the malformed canonical file");
      assert.equal(r.description, "wrong filename but right shape");
      assert.ok(notes.some((n) => /backlog_manifest\.json/.test(n)));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when neither the repair nor the scan finds our shape", () => {
    const dir = tmpActionDir();
    try {
      fs.writeFileSync(path.join(dir, "subagent_result.json"), '{"description": "no recovery an');
      fs.writeFileSync(path.join(dir, "other.json"), '{"unrelated": true}');
      assert.equal(readSubagentResultFile(dir), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the repair narrow — it is not a general JSON fixer", () => {
    // No `\\"` sequence → nothing to try.
    assert.equal(repairOverEscapedQuotes('{"a": 1,,}'), null);
    assert.equal(repairOverEscapedQuotes('{"a": "plain"}'), null);
    // Only the `\\"` sequence is rewritten; other content is untouched.
    assert.equal(repairOverEscapedQuotes('{"a":"x \\\\" y"}'), '{"a":"x \\" y"}');

    // A VALID document whose value legitimately ends in a backslash parses
    // on the first attempt, so the repair (which would corrupt it) is
    // never reached.
    const dir = tmpActionDir();
    try {
      fs.writeFileSync(
        path.join(dir, "subagent_result.json"),
        '{"description":"trailing backslash C:\\\\","recovery_commands":["echo ok"]}',
      );
      const r = readSubagentResultFile(dir);
      assert.ok(r);
      assert.equal(r.description, "trailing backslash C:\\");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── 2. Captured-but-unregistered detection ───────────────────────────

describe("subagent bookkeeping: unregistered capture is made visible", () => {
  it("findCapturedArtifacts ignores our own bookkeeping files", () => {
    const dir = tmpActionDir();
    try {
      fs.writeFileSync(path.join(dir, "metadata.json"), "[]");
      fs.writeFileSync(path.join(dir, "instruction.txt"), "do the thing");
      fs.writeFileSync(path.join(dir, "subagent_result.json"), "{}");
      fs.writeFileSync(path.join(dir, "subagent_a1b2c3d4.json"), "{}");
      assert.equal(findCapturedArtifacts(dir), null,
        "a dir with only bookkeeping files holds no capture");

      writeCapturedStore(dir);
      const cap = findCapturedArtifacts(dir);
      assert.ok(cap);
      assert.equal(cap.files, 2);
      assert.ok(cap.bytes > 0);
      assert.ok(cap.sample.some((s) => s.includes("2026-07.jsonl")));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reportUnregisteredCapture stays silent when nothing was captured", () => {
    const dir = tmpActionDir();
    try {
      fs.writeFileSync(path.join(dir, "metadata.json"), "[]");
      const logs: string[] = [];
      reportUnregisteredCapture(dir, "test", (m) => logs.push(m));
      assert.equal(fs.existsSync(path.join(dir, UNREGISTERED_MARKER)), false,
        "'no backup was needed' must not raise a false alarm");
      assert.equal(logs.length, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reportUnregisteredCapture drops a marker file naming the orphaned bytes", () => {
    const dir = tmpActionDir();
    try {
      writeCapturedStore(dir);
      const logs: string[] = [];
      reportUnregisteredCapture(dir, "result file malformed", (m) => logs.push(m));

      const marker = path.join(dir, UNREGISTERED_MARKER);
      assert.ok(fs.existsSync(marker), "a discarded capture must leave a marker");
      const text = fs.readFileSync(marker, "utf-8");
      assert.match(text, /UNREGISTERED CAPTURE/);
      assert.match(text, /result file malformed/);
      assert.match(text, /metadata\.json/);
      assert.match(text, /2026-07\.jsonl/);
      assert.ok(logs.some((l) => /UNREGISTERED CAPTURE/.test(l)), "must also hit the debug log");

      // The marker itself must not be mistaken for a captured artifact.
      const cap = findCapturedArtifacts(dir);
      assert.ok(cap);
      assert.equal(cap.files, 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── 3. End-to-end through runSubagentBackup, with a mock claude ──────

const MOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "backupper-bk-claude-"));
const MOCK_CLAUDE = path.join(MOCK_DIR, "claude");
let originalPath = "";

/** A typical stdout: a claude -p JSON wrapper whose `result` is
 *  PROSE (not our JSON) and which — as every claude -p run does — carries
 *  an EMPTY "permission_denials" array. */
const APPDATA_STDOUT = JSON.stringify({
  is_error: false,
  permission_denials: [],
  subtype: "success",
  result:
    "Backup complete. Captured the appdata allotment store before " +
    "`capctl allot release --apply` rewrites held→released state.",
  type: "result",
});

/** The mock must WRITE the result file itself: subagent_watch.js deletes
 *  any stale subagent_result.json before starting the run, so a file
 *  pre-planted by the test would never survive to be read. */
function installMockClaude(stdout: string, resultFile?: string, resultBody?: string): void {
  const responseFile = path.join(MOCK_DIR, "response.txt");
  fs.writeFileSync(responseFile, stdout, "utf-8");
  let script = `#!/bin/sh\ncat > /dev/null\n`;
  if (resultFile !== undefined && resultBody !== undefined) {
    const bodyFile = path.join(MOCK_DIR, "result_body.txt");
    fs.writeFileSync(bodyFile, resultBody, "utf-8");
    script += `cp "${bodyFile}" "${resultFile}"\n`;
  }
  script += `cat "${responseFile}"\n`;
  fs.writeFileSync(MOCK_CLAUDE, script);
  fs.chmodSync(MOCK_CLAUDE, 0o755);
}

before(() => {
  originalPath = process.env.PATH ?? "";
  process.env.PATH = `${MOCK_DIR}:${originalPath}`;
});

after(() => {
  process.env.PATH = originalPath;
  try { fs.rmSync(MOCK_DIR, { recursive: true, force: true }); } catch { /* */ }
});

function setup(): { workspace: string; config: SandboxConfig; originalCwd: string } {
  const originalCwd = process.cwd();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "backupper-bk-ws-"));
  process.chdir(workspace);
  const config: SandboxConfig = {
    ...DEFAULT_CONFIG,
    backupDir: path.join(workspace, ".backupper", "backups"),
    maxActions: 10,
    subagentEnabled: true,
    subagentTimeoutSeconds: 10,
  };
  fs.mkdirSync(config.backupDir, { recursive: true });
  return { workspace, config, originalCwd };
}

describe("subagent bookkeeping: runSubagentBackup end to end", () => {
  beforeEach(() => resetAction());

  it("registers a capture whose result file is malformed", () => {
    const { workspace, config, originalCwd } = setup();
    try {
      const actionDir = path.join(config.backupDir, "action_001");
      fs.mkdirSync(actionDir, { recursive: true });
      const artifactPath = writeCapturedStore(actionDir);
      installMockClaude(
        APPDATA_STDOUT,
        path.join(actionDir, "subagent_result.json"),
        OVER_ESCAPED_RESULT.replace("ARTIFACT_PATH_PLACEHOLDER", artifactPath),
      );

      const outcome = runSubagentBackup(
        makeCtx("Bash", { command: "bin/capctl allot release --apply" }),
        actionDir,
        config,
      );

      assert.ok(outcome && outcome !== "read_only",
        "a correctly-captured backup must be registered, not dropped");
      assert.equal(outcome.strategy, "subagent");
      assert.equal(outcome.subagentCommands?.length, 2);
      // Nothing was orphaned, so no alarm.
      assert.equal(fs.existsSync(path.join(actionDir, UNREGISTERED_MARKER)), false);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("marks the capture when the result is unrecoverable, and does not misdiagnose", () => {
    const { workspace, config, originalCwd } = setup();
    try {
      const actionDir = path.join(config.backupDir, "action_001");
      fs.mkdirSync(actionDir, { recursive: true });
      writeCapturedStore(actionDir);
      // Beyond any narrow repair, and no sibling file has our shape.
      installMockClaude(APPDATA_STDOUT, path.join(actionDir, "subagent_result.json"), "<<<garbage>>>");

      const outcome = runSubagentBackup(
        makeCtx("Bash", { command: "bin/capctl allot release --apply" }),
        actionDir,
        config,
      );

      assert.equal(outcome, null, "an unreadable result still yields no artifact");
      const marker = path.join(actionDir, UNREGISTERED_MARKER);
      assert.ok(fs.existsSync(marker),
        "a discarded 6.5 MB capture must not look identical to 'no backup needed'");
      assert.match(fs.readFileSync(marker, "utf-8"), /2026-07\.jsonl/);

      // An EMPTY "permission_denials":[] must not be read as a denial —
      // that misdiagnosis told the user to upgrade their CLI while the
      // real problem was the result file.
      const log = fs.readFileSync(
        path.join(path.dirname(path.resolve(config.backupDir)), "subagent.log"),
        "utf-8",
      );
      assert.doesNotMatch(log, /denied tool permissions/,
        "empty permission_denials must not trigger the permission diagnosis");
      assert.match(log, /UNREGISTERED CAPTURE/);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("a read-only verdict is a clean skip, not a BACKUP UNVERIFIED alarm", () => {
    // A read-only verdict legitimately has empty recovery arrays; flagging it UNVERIFIED would
    // bury real warnings among false ones.
    const { workspace, config, originalCwd } = setup();
    try {
      const actionDir = path.join(config.backupDir, "action_001");
      fs.mkdirSync(actionDir, { recursive: true });
      installMockClaude(
        APPDATA_STDOUT,
        path.join(actionDir, "subagent_result.json"),
        JSON.stringify({
          description: "Action bin/capctl status is read-only.",
          backup_commands: [],
          recovery_commands: [],
          no_backup_needed: true,
        }),
      );

      const outcome = runSubagentBackup(
        makeCtx("Bash", { command: "bin/capctl status" }),
        actionDir,
        config,
      );

      assert.equal(outcome, "read_only");
      const log = fs.readFileSync(
        path.join(path.dirname(path.resolve(config.backupDir)), "subagent.log"),
        "utf-8",
      );
      assert.doesNotMatch(log, /BACKUP UNVERIFIED/,
        "a clean read-only skip must not raise the unverified alarm");
      assert.match(log, /verdict: read-only/);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
