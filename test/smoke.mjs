#!/usr/bin/env node
/**
 * Smoke test over the built CLI: offline, keyless, in temporary directories with a temporary
 * HOME. Runs `dist/cli.js` from this checkout, or the command in BACKUPPER_BIN (e.g. a globally
 * installed `backupper`).
 *
 *   node test/smoke.mjs
 *   BACKUPPER_BIN=backupper node test/smoke.mjs
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = process.env.BACKUPPER_BIN ? [process.env.BACKUPPER_BIN] : [process.execPath, path.join(ROOT, "dist", "cli.js")];
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backupper-smoke-")));
const HOME = path.join(tmp, "home");
fs.mkdirSync(HOME);
// BACKUPPER_SKIP_CLAUDE_PLUGIN: `install claude-code` would otherwise run `claude plugin install`.
const ENV = { ...process.env, HOME, BACKUPPER_READONLY_CHECKER: "0", BACKUPPER_SKIP_CLAUDE_PLUGIN: "1" };
delete ENV.BACKUPPER_STORE_DIR;
delete ENV.BACKUPPER_NO_HOOK;

function cli(cwd, ...args) {
  const r = spawnSync(BIN[0], [...BIN.slice(1), ...args], { cwd, env: ENV, encoding: "utf-8", timeout: 120_000 });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}
function project(name) {
  const d = path.join(tmp, name);
  fs.mkdirSync(d);
  spawnSync("git", ["init", "-q"], { cwd: d });
  fs.writeFileSync(path.join(d, ".gitignore"), "node_modules/\n");
  return d;
}
/** Every file below `dir`, relative, sorted. */
function tree(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r); else out.push(r);
    }
  };
  walk(dir, "");
  return out.sort();
}

const results = [];
async function test(name, fn) {
  try { await fn(); results.push([name, true]); console.log(`ok    ${name}`); }
  catch (e) { results.push([name, false]); console.log(`FAIL  ${name}\n      ${String(e?.message ?? e).split("\n").join("\n      ")}`); }
}

await test("--help lists the commands", () => {
  const r = cli(tmp, "--help");
  assert.equal(r.code, 0);
  for (const c of ["init", "install", "doctor", "demo", "list", "show", "restore", "panel", "watch"]) assert.match(r.out, new RegExp(`\\b${c}\\b`));
});

await test("init writes a checker config and seeds experiences", () => {
  const p = project("init");
  const r = cli(p, "init");
  assert.equal(r.code, 0, r.err);
  const cfg = JSON.parse(fs.readFileSync(path.join(p, ".backupper", "config.json"), "utf-8"));
  assert.equal(cfg.mode, "checker");
  assert.equal(cfg.subagentRunner, "auto");
  assert.deepEqual(cfg.subagentModels, { claude: "haiku", codex: "gpt-6-luna" });
  assert.equal(cfg.subagentModel, "");
  assert.ok(fs.readdirSync(path.join(p, ".backupper", "experiences")).length > 0);
  assert.match(fs.readFileSync(path.join(p, ".gitignore"), "utf-8"), /^\.backupper\/$/m);
});

await test("config set validates keys and values", () => {
  const p = project("config");
  cli(p, "init");
  assert.notEqual(cli(p, "config", "set", "mode", "smart").code, 0);
  assert.notEqual(cli(p, "config", "set", "noSuchKey", "1").code, 0);
  assert.equal(cli(p, "config", "set", "maxActions", "7").code, 0);
  assert.equal(JSON.parse(cli(p, "config", "--json").out).maxActions, 7);
  assert.equal(cli(p, "config", "set", "subagentModel", "sonnet").code, 0);
  assert.equal(JSON.parse(cli(p, "status", "--json").out).subagent.model, "sonnet");
  assert.notEqual(cli(p, "config", "set", "subagentModels", "haiku").code, 0);
});

await test("config and config --json show every documented key, internals apart", () => {
  const p = project("config-all");
  cli(p, "init");
  const ref = path.join(ROOT, "src", "config", "README.md");
  const readme = fs.existsSync(ref) ? fs.readFileSync(ref, "utf-8") : "";
  const j = JSON.parse(cli(p, "config", "--json").out);
  // The configuration reference table when this runs from a checkout; the JSON's own keys otherwise.
  const fromReadme = [...readme.matchAll(/^\| `([A-Za-z]+)` \|/gm)].map((m) => m[1]);
  const documented = fromReadme.length ? fromReadme : Object.keys(j).filter((k) => k !== "internal");
  assert.ok(documented.length >= 28);
  for (const k of documented) assert.ok(k in j, `config --json lacks ${k}`);
  assert.equal(j.subagentMcpConfig, null, "an unset key is shown as null");
  assert.ok(!("backupDir" in j) && !("denyPatterns" in j), "internals are not mixed into the settings");
  assert.ok(j.internal && "backupDir" in j.internal && "denyPatterns" in j.internal);
  const human = cli(p, "config").out;
  for (const k of documented) assert.match(human, new RegExp(`^  ${k}\\b`, "m"), `config lacks ${k}`);
  assert.doesNotMatch(human, /backupDir|effectLogPath|denyPatterns/);
  assert.equal(cli(p, "config", "get", "maxActions").out.trim(), "50");
});

await test("<command> --help prints usage and does not act", () => {
  const p = project("subhelp");
  cli(p, "init");
  for (const c of ["list", "restore", "show", "clear", "panel", "watch", "config", "status", "install"]) {
    const r = cli(p, c, "--help");
    assert.equal(r.code, 0, `${c} --help: ${r.err}`);
    assert.match(r.out, new RegExp(`Usage: backupper ${c}`), c);
  }
  assert.ok(fs.existsSync(path.join(p, ".backupper", "config.json")), "clear --help must not clear");
  assert.ok(!fs.existsSync(path.join(p, ".claude")), "install --help must not install");
  assert.match(cli(p, "--version").out.trim(), /^\d+\.\d+\.\d+/);
});

await test("demo passes offline", () => {
  const r = cli(tmp, "demo", "--json");
  assert.equal(r.code, 0, r.out + r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.ok, true);
  assert.equal(typeof j.project, "string", "demo --json names its scratch project");
  assert.equal(j.kept, false);
});

for (const [agent, residue] of [["claude-code", ".claude"], ["codex", ".codex"], ["hermes", ".hermes"]]) {
  await test(`install/uninstall ${agent} leaves no residue`, () => {
    const p = project(`inst-${agent}`);
    const before = tree(p);
    assert.equal(cli(p, "install", agent).code, 0);
    const st = JSON.parse(cli(p, "status", "--json").out);
    assert.deepEqual(st.hooks.map((h) => h.agent), [agent]);
    const text = tree(p).filter((f) => f.startsWith(residue)).map((f) => fs.readFileSync(path.join(p, f), "utf-8")).join("\n");
    assert.match(text, new RegExp(`--agent ${agent}|"--agent", "hermes"`));
    assert.equal(cli(p, "uninstall", agent).code, 0);
    const after = tree(p).filter((f) => !f.startsWith(".backupper/"));
    assert.deepEqual(after, before.filter((f) => f !== ".gitignore").concat(".gitignore").sort());
    assert.ok(!fs.existsSync(path.join(p, residue)), `${residue} left behind`);
  });
}

await test("uninstall keeps foreign hooks and settings", () => {
  const p = project("foreign");
  const settings = { model: "x", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] } };
  fs.mkdirSync(path.join(p, ".claude"));
  fs.writeFileSync(path.join(p, ".claude", "settings.local.json"), JSON.stringify(settings));
  cli(p, "install", "claude-code");
  cli(p, "install", "claude-code");
  const mid = JSON.parse(fs.readFileSync(path.join(p, ".claude", "settings.local.json"), "utf-8"));
  assert.equal(mid.hooks.PreToolUse.length, 2, "re-install must not duplicate hooks");
  cli(p, "uninstall");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(p, ".claude", "settings.local.json"), "utf-8")), settings);
});

await test("hook capture, list/show --json, restore", () => {
  const p = project("hook");
  cli(p, "install", "claude-code");
  cli(p, "config", "set", "subagentEnabled", "false");
  fs.writeFileSync(path.join(p, "notes.txt"), "keep me\n");
  const settings = JSON.parse(fs.readFileSync(path.join(p, ".claude", "settings.local.json"), "utf-8"));
  const cmd = settings.hooks.PreToolUse[0].hooks[0].command;
  const r = spawnSync("sh", ["-c", cmd], {
    cwd: p, env: ENV, encoding: "utf-8",
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm notes.txt" }, cwd: p }),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.updatedInput.command, /^true/);
  const post = settings.hooks.PostToolUse[0].hooks[0].command;
  spawnSync("sh", ["-c", post], {
    cwd: p, env: ENV,
    input: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "rm notes.txt" }, tool_response: "", cwd: p }),
  });
  assert.ok(!fs.existsSync(path.join(p, "notes.txt")));
  const list = JSON.parse(cli(p, "list", "--json").out);
  assert.equal(list.total, 1);
  assert.deepEqual(list.actions[0].tiers, [1]);
  const show = JSON.parse(cli(p, "show", "--latest", "--json").out);
  assert.equal(show.artifacts[0].strategy, "policy_rewrite");
  const snap = cli(p, "watch");
  assert.equal(snap.code, 0, snap.err);
  assert.match(snap.out, /#1 Bash\(rm notes\.txt\) → Tier 1 command rewriting/);
  assert.match(snap.out, /RESTORE\s+press r to undo #1/);
  assert.equal(cli(path.join(p), "restore", "last").code, 0);
  assert.equal(fs.readFileSync(path.join(p, "notes.txt"), "utf-8"), "keep me\n");
});

await test("restore brings back a file whose folder a later snapshot dropped", () => {
  // rm empties data/ (tier 1); a later edit takes a workspace snapshot, and restoring that
  // snapshot removes the now-empty data/ before the rm is undone.
  const p = project("parentdir");
  cli(p, "install", "claude-code");
  cli(p, "config", "set", "subagentEnabled", "false");
  fs.mkdirSync(path.join(p, "data"));
  fs.writeFileSync(path.join(p, "data", "users.csv"), "id,name\n1,ada\n");
  fs.writeFileSync(path.join(p, "requirements.txt"), "requests==2.0\n");
  const settings = JSON.parse(fs.readFileSync(path.join(p, ".claude", "settings.local.json"), "utf-8"));
  const pre = settings.hooks.PreToolUse[0].hooks[0].command;
  const hook = (tool_name, tool_input) => {
    const r = spawnSync("sh", ["-c", pre], {
      cwd: p, env: ENV, encoding: "utf-8",
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input, cwd: p }),
    });
    assert.equal(r.status, 0, r.stderr);
  };
  hook("Bash", { command: "rm data/users.csv" });
  assert.ok(!fs.existsSync(path.join(p, "data", "users.csv")));
  const req = path.join(p, "requirements.txt");
  hook("Edit", { file_path: req, old_string: "requests==2.0", new_string: "requests==3.0" });
  fs.writeFileSync(req, "requests==3.0\n");
  const r = cli(p, "restore", "1");
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(fs.readFileSync(path.join(p, "data", "users.csv"), "utf-8"), "id,name\n1,ada\n");
  assert.equal(fs.readFileSync(req, "utf-8"), "requests==2.0\n");
});

await test("doctor reports and exits non-zero on a missing install", () => {
  const p = project("doctor");
  const r = cli(p, "doctor", "claude-code", "--json");
  const j = JSON.parse(r.out);
  assert.equal(r.code, 1);
  const hooks = j.reports[0].checks.find((c) => c.id === "hooks");
  assert.equal(hooks.status, "fail");
  assert.match(hooks.fix, /backupper install claude-code/);
});

await test("/backupper-panel is answered by the prompt hook (Codex) and left to the plugin (Claude Code)", () => {
  const p = project("panel");
  cli(p, "install", "claude-code");
  assert.ok(!fs.existsSync(path.join(p, ".claude", "commands", "backupper-panel.md")), "the plugin owns /backupper-panel");
  const settings = JSON.parse(fs.readFileSync(path.join(p, ".claude", "settings.local.json"), "utf-8"));
  const ccCmd = settings.hooks.UserPromptSubmit[0].hooks[0].command;
  const cc = spawnSync("sh", ["-c", ccCmd], {
    cwd: p, env: ENV, encoding: "utf-8", input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "/backupper-panel", session_id: "s", cwd: p }),
  });
  assert.ok(!/"decision"/.test(cc.stdout), "Claude Code's prompt hook leaves /backupper-panel to the plugin");
  fs.rmSync(path.join(p, ".backupper", "current-instruction.txt"), { force: true });
  const cmd = ccCmd.replace("--agent claude-code", "--agent codex");
  const env = { ...ENV };
  for (const k of ["TMUX", "ZELLIJ", "TERM_PROGRAM", "WEZTERM_PANE", "KITTY_WINDOW_ID", "ITERM_SESSION_ID"]) delete env[k];
  const send = (prompt) => spawnSync("sh", ["-c", cmd], {
    cwd: p, env, encoding: "utf-8", input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt, session_id: "s", cwd: p }),
  });
  const r = send("/backupper-panel status");
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.decision, "block");
  assert.match(j.reason, /panel is off/);
  assert.match(JSON.parse(send("/backupper-panel").stdout).reason, /No scriptable terminal split/);
  assert.ok(!fs.existsSync(path.join(p, ".backupper", "current-instruction.txt")), "panel prompts are not recorded as instructions");
  const normal = send("please tidy the repo");
  assert.ok(!/"decision"/.test(normal.stdout));
  assert.equal(cli(p, "panel", "status").code, 0);
});

fs.rmSync(tmp, { recursive: true, force: true });
const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
