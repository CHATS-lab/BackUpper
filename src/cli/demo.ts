/**
 * `backupper demo`: an offline walk-through in a temporary project. It feeds two tool calls to
 * the real PreToolUse hook (an `rm` of a file and an in-workspace edit), carries them out and
 * reports them to the PostToolUse hook as an agent would, lists what tiers 0-2 captured, then
 * restores and checks both files.
 * No agent, model or key is involved: the tier-3 subagent and the checker are disabled.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { loadConfig, saveConfig } from "../config/load.js";
import { listActionSummaries } from "../view/actions.js";

const NOTES = "Meeting notes\n- ship the parser on Friday\n- ask about the budget\n";
const SETTINGS = "retries = 3\ntimeout = 30\n";
const EDITED = "retries = 0\n";

interface HookReply {
  hookSpecificOutput?: { updatedInput?: Record<string, unknown>; additionalContext?: string };
}

export function demo(pkgRoot: string, opts: { keep: boolean; json: boolean }): number {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backupper-demo-")));
  const log: string[] = [];
  const say = (s = "") => { if (!opts.json) console.log(s); log.push(s); };
  const env = {
    ...process.env,
    BACKUPPER_READONLY_CHECKER: "0",
    BACKUPPER_STORE_DIR: "",
    BACKUPPER_NO_HOOK: "",
  };
  const hook = (payload: Record<string, unknown>, script = "pre-tool"): HookReply => {
    const r = spawnSync(process.execPath, [path.join(pkgRoot, "hooks", `${script}.js`), "--agent", "claude-code"], {
      cwd: dir, env, input: JSON.stringify({ ...payload, cwd: dir, session_id: "demo" }), encoding: "utf-8", timeout: 60_000,
    });
    if (r.status !== 0) throw new Error(`hook exited ${r.status}: ${r.stderr}`);
    return r.stdout.trim() ? JSON.parse(r.stdout) as HookReply : {};
  };
  const results: Array<{ step: string; ok: boolean }> = [];
  const check = (step: string, ok: boolean) => { results.push({ step, ok }); say(`  ${ok ? "[ok]  " : "[FAIL]"} ${step}`); };

  try {
    fs.writeFileSync(path.join(dir, "notes.txt"), NOTES);
    fs.writeFileSync(path.join(dir, "settings.toml"), SETTINGS);
    // Offline configuration: tiers 0-2 only.
    saveConfig({ enabled: true, mode: "checker", subagentEnabled: false, announceOnce: false }, dir);

    say(`BackUpper demo, in a scratch project: ${dir}`);
    say("It contains notes.txt and settings.toml. Two tool calls follow, each sent to the");
    say("real PreToolUse hook first, exactly as Claude Code would send them.\n");

    say("1. The agent runs `rm notes.txt`.");
    const r1 = hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm notes.txt" } });
    const cmd = String(r1.hookSpecificOutput?.updatedInput?.command ?? "rm notes.txt");
    say(`   The hook moved the file into its trash and rewrote the command to: ${cmd}`);
    execFileSync("sh", ["-c", cmd], { cwd: dir, env });
    hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: cmd }, tool_response: "" }, "post-tool");
    check("notes.txt is gone from the workspace, as the agent asked", !fs.existsSync(path.join(dir, "notes.txt")));

    say("\n2. The agent overwrites settings.toml with a Write call.");
    hook({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: path.join(dir, "settings.toml"), content: EDITED } });
    fs.writeFileSync(path.join(dir, "settings.toml"), EDITED);
    hook({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: path.join(dir, "settings.toml"), content: EDITED }, tool_response: "" }, "post-tool");
    say("   The hook snapshotted the workspace into its shadow git repo; then the write ran.");
    check("settings.toml now holds the new content", fs.readFileSync(path.join(dir, "settings.toml"), "utf-8") === EDITED);

    say("\n3. What BackUpper recorded (`backupper list`):");
    const cfg = loadConfig(dir);
    const prev = process.cwd();
    process.chdir(dir);
    let actions;
    try { actions = listActionSummaries(cfg, dir); } finally { process.chdir(prev); }
    for (const a of actions) {
      say(`   #${a.seq}  tier ${a.tiers.join(",") || "-"}  ${a.originalAction || a.toolName}  (${a.strategies.join(" + ")})`);
    }
    check("two actions were recorded", actions.length === 2);
    check("the rm was captured by tier 0 (move to trash)", actions[0]?.strategies.includes("policy_rewrite") ?? false);
    check("the edit was captured by tier 2 (workspace snapshot)", actions[1]?.strategies.includes("git_snapshot") ?? false);

    const first = actions[0]?.seq ?? 1;
    say(`\n4. Undo both steps: \`backupper restore ${first}\` (undo action #${first} and everything after it).`);
    const rr = spawnSync(process.execPath, [path.join(pkgRoot, "cli.js"), "restore", String(first)], {
      cwd: dir, env, encoding: "utf-8", timeout: 120_000,
    });
    for (const line of (rr.stdout ?? "").split("\n").filter((l) => l.trim())) say(`   ${line}`);
    check("notes.txt is back with its original content",
      fs.existsSync(path.join(dir, "notes.txt")) && fs.readFileSync(path.join(dir, "notes.txt"), "utf-8") === NOTES);
    check("settings.toml has its original content again", fs.readFileSync(path.join(dir, "settings.toml"), "utf-8") === SETTINGS);
  } catch (e) {
    check(`demo step failed: ${e instanceof Error ? e.message : String(e)}`, false);
  } finally {
    if (opts.keep) say(`\nScratch project kept at ${dir}`);
    else fs.rmSync(dir, { recursive: true, force: true });
  }

  const ok = results.every((r) => r.ok);
  if (opts.json) {
    // `project` is the scratch directory the demo ran in; `kept` says whether it still exists.
    console.log(JSON.stringify({ ok, project: dir, kept: opts.keep, checks: results, transcript: log }, null, 2));
  } else {
    say(ok
      ? "\nDemo passed. In a real project: backupper init && backupper install <agent>."
      : "\nDemo FAILED; see the steps marked [FAIL] above.");
  }
  return ok ? 0 : 1;
}
