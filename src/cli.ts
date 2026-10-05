#!/usr/bin/env node
/**
 * BackUpper command-line interface: project setup (init, install, uninstall, doctor, demo),
 * read views over the action store (list, show, diff, status, config), the live side panel
 * (watch, panel) and undo (restore, clear). Read commands accept --json.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { configWarnings, ensureConfig, getConfigDir, getConfigPath, loadConfig, saveConfig } from "./config/load.js";
import { CONFIG_SCHEMA, parseConfigValue } from "./config/schema.js";
import { ALL_ADAPTERS, findAdapter, ignoreStore, installedAdapters, type AgentAdapter } from "./agents/index.js";
import { resolveRunner, subagentModelFor } from "./backup/runner_caps.js";
import { dirSize } from "./backup/strategies.js";
import { actionDetail, actionNames, backupRoot, listActionSummaries, resolveAction, snapshotDiff, tierOf } from "./view/actions.js";
import type { RestoreResult } from "./restore/restore.js";
import { storeDirOverride } from "./types.js";

/** The installed dist/ directory; hook scripts are resolved from it. */
const PKG_DIST = path.resolve(__dirname);
const PKG_ROOT = path.dirname(PKG_DIST);

function version(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf-8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ── Argument helpers ─────────────────────────────────────────────────

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes("--json");

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Positional arguments, skipping flags and the values of flags that take one. */
function positionals(args: string[], valued: string[] = []): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (valued.includes(args[i])) { i++; continue; }
    if (args[i].startsWith("--")) continue;
    out.push(args[i]);
  }
  return out;
}

function fail(msg: string, fix?: string): never {
  console.error(msg);
  if (fix) console.error(`  fix: ${fix}`);
  process.exit(1);
}

function printJson(v: unknown): void {
  console.log(JSON.stringify(v, null, 2));
}

/**
 * The project root: the nearest directory at or above cwd holding `.backupper/`, else cwd.
 * Store-reading commands run from there so relative store paths resolve.
 */
function projectRootFor(cwd: string): string {
  if (storeDirOverride()) return cwd;
  let dir = cwd;
  for (;;) {
    if (fs.existsSync(path.join(dir, ".backupper"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return cwd;
    dir = up;
  }
}

function adapterArg(name: string | undefined, fallback: AgentAdapter[] | null): AgentAdapter[] {
  if (name) {
    const a = findAdapter(name);
    if (!a) fail(`Unknown agent: ${name}`, `use one of: ${ALL_ADAPTERS.map((x) => x.name).join(", ")}`);
    return [a];
  }
  return fallback ?? [];
}

// ── Setup ────────────────────────────────────────────────────────────

/** Copy the bundled experiences into the store, keeping any file already there. */
function seedExperiences(projectRoot: string): number {
  const src = path.join(PKG_ROOT, "experiences");
  const dest = path.join(getConfigDir(projectRoot), "experiences");
  let n = 0;
  try {
    for (const f of fs.readdirSync(src).filter((x) => x.endsWith(".json"))) {
      fs.mkdirSync(dest, { recursive: true });
      const to = path.join(dest, f);
      if (!fs.existsSync(to)) { fs.copyFileSync(path.join(src, f), to); n++; }
    }
  } catch { /* no bundled experiences */ }
  return n;
}

function initProject(projectRoot: string, quiet = false): void {
  const created = ensureConfig(projectRoot);
  const seeded = seedExperiences(projectRoot);
  const ignored = ignoreStore(projectRoot);
  if (quiet) return;
  console.log(created
    ? `Created ${path.relative(projectRoot, getConfigPath(projectRoot)) || getConfigPath(projectRoot)} (mode checker)`
    : `Kept the existing ${getConfigPath(projectRoot)}`);
  if (created) {
    const models = loadConfig(projectRoot).subagentModels ?? {};
    const shown = (["claude", "codex", "hermes"] as const).map((r) => `${r}: ${models[r] || "its default"}`).join(", ");
    console.log(`Tier-4 model per runner (${shown}); override with: backupper config set subagentModel <model>`);
  }
  if (seeded) console.log(`Copied ${seeded} starter experience file(s) to .backupper/experiences/`);
  if (ignored) console.log(ignored);
  console.log("\nNext: backupper install <claude-code|codex|hermes>, then backupper doctor");
}

function install(projectRoot: string, args: string[]): void {
  const name = positionals(args)[0] ?? "claude-code";
  const [adapter] = adapterArg(name, null);
  initProject(projectRoot, true);
  const { log } = adapter.install(projectRoot, PKG_DIST);
  console.log(`BackUpper installed for ${adapter.description.split(" (")[0]}.`);
  for (const l of log) console.log(`  ${l}`);
  console.log(`  Config: ${getConfigPath(projectRoot)}`);
  const config = loadConfig(projectRoot);
  if (config.subagentEnabled) {
    const runner = resolveRunner(config, adapter.name);
    const model = subagentModelFor(config, runner);
    console.log(`  Tier-4 subagent runs \`${runner}\`` +
      (model ? ` with model ${model} and your existing login` : " with its default model and your existing login"));
    console.log("  Change the model: backupper config set subagentModel <model>");
  }
  console.log(`\nCheck it: backupper doctor ${adapter.name}`);
}

function uninstall(projectRoot: string, args: string[]): void {
  const installed = installedAdapters(projectRoot);
  const targets = adapterArg(positionals(args)[0], installed);
  if (!targets.length) {
    console.log("No BackUpper hooks are installed in this project.");
  }
  for (const a of targets) {
    const { log } = a.uninstall(projectRoot);
    console.log(log.length ? `Uninstalled from ${a.name}:` : `Nothing to remove for ${a.name}.`);
    for (const l of log) console.log(`  ${l}`);
  }
  const store = getConfigDir(projectRoot);
  if (fs.existsSync(store)) {
    console.log(`\nYour config and recorded backups remain in ${store}` +
      (fs.existsSync(path.join(projectRoot, ".gitignore")) ? " (still listed in .gitignore)." : "."));
    console.log("Delete the backups with `backupper clear --yes`, or remove that directory yourself.");
  }
}

function doctorCommand(projectRoot: string, args: string[]): void {
  const { doctor } = require("./cli/doctor.js") as typeof import("./cli/doctor.js");
  const installed = installedAdapters(projectRoot);
  const targets = adapterArg(positionals(args)[0], installed.length ? installed : [findAdapter("claude-code")!]);
  const reports = targets.map((a) => ({ agent: a.name, checks: doctor(a, projectRoot, PKG_DIST, { probe: args.includes("--probe") }) }));
  const ok = reports.every((r) => r.checks.every((c) => c.status !== "fail"));
  if (JSON_OUT) {
    printJson({ ok, project: projectRoot, version: version(), reports });
  } else {
    for (const r of reports) {
      console.log(`BackUpper ${version()} doctor: ${r.agent} (project ${projectRoot})`);
      for (const c of r.checks) {
        const tag = { ok: "[ok]  ", warn: "[warn]", fail: "[FAIL]", skip: "[skip]" }[c.status];
        console.log(`  ${tag} ${c.summary}`);
        if (c.fix && c.status !== "ok") console.log(`         fix: ${c.fix}`);
      }
      console.log();
    }
    console.log(ok ? "All required checks passed." : "Some checks failed; apply the fixes above and run doctor again.");
  }
  process.exit(ok ? 0 : 1);
}

// ── Read views ───────────────────────────────────────────────────────

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function listCommand(projectRoot: string, args: string[]): void {
  const config = loadConfig(projectRoot);
  const all = listActionSummaries(config, projectRoot);
  const limitArg = flagValue(args, "--limit") ?? positionals(args, ["--limit"])[0];
  const limit = limitArg ? parseInt(limitArg, 10) : 20;
  if (limitArg && (!Number.isInteger(limit) || limit < 1)) fail(`Invalid limit: ${limitArg}`);
  const shown = all.slice(-limit);
  if (JSON_OUT) {
    printJson({ total: all.length, actions: shown });
    return;
  }
  if (!all.length) {
    console.log("No actions recorded yet. Actions appear once a hooked agent makes a call that can change state.");
    return;
  }
  console.log(`${"#".padStart(4)}  ${"time".padEnd(19)}  ${"tiers".padEnd(7)}  action`);
  for (const a of shown) {
    const call = a.originalAction || a.toolName;
    console.log(`${String(a.seq).padStart(4)}  ${a.timeFormatted.padEnd(19)}  ${(a.tiers.join(",") || "-").padEnd(7)}  ${oneLine(call, 90)}`);
    if (a.instruction) console.log(`${" ".repeat(34)}asked: "${oneLine(a.instruction, 70)}"`);
  }
  if (all.length > shown.length) console.log(`(${all.length - shown.length} older action(s) hidden; use --limit ${all.length})`);
  console.log("\nDetails: backupper show <#>    Undo: backupper restore <#>");
}

const STRATEGY_TEXT: Record<string, string> = {
  policy_rewrite: "command rewritten into a reversible form",
  pip_freeze: "package manifest (pip freeze)",
  npm_list: "package manifest (npm list)",
  env_snapshot: "environment dump",
  git_tag: "git ref pinned",
  git_snapshot: "workspace snapshot (shadow git commit)",
  file_copy: "exact pre-image copy of the file",
  subagent: "backup subagent capture",
  learned_rule: "learned capture rule",
};

function showCommand(projectRoot: string, args: string[]): void {
  const config = loadConfig(projectRoot);
  const ref = args.includes("--latest") ? "latest" : positionals(args)[0] ?? "latest";
  const name = resolveAction(config, ref);
  if (!name) fail(actionNames(config).length ? `No action ${ref}.` : "No actions recorded yet.", "backupper list");
  const d = actionDetail(config, name, projectRoot);
  if (JSON_OUT) {
    printJson(d);
    return;
  }
  console.log(`Action #${d.seq}  ${d.timeFormatted}  (${d.name})`);
  console.log(`  Tool call:   ${oneLine(d.originalAction || d.toolName, 200)}`);
  if (d.instruction) console.log(`  Asked:       "${oneLine(d.instruction, 160)}"`);
  if (d.backupMs !== undefined) console.log(`  Added delay: ${d.backupMs} ms`);
  console.log("  Captured:");
  for (const a of d.artifacts) {
    const t = tierOf(a.strategy);
    const label = a.strategy === "policy_rewrite" && a.backupOnly
      ? "pre-state captured by a tier-1 rule (the command ran unmodified)"
      : STRATEGY_TEXT[a.strategy] ?? a.strategy;
    console.log(`    tier ${t ?? "?"}  ${label}`);
    console.log(`            ${oneLine(a.description ?? "", 160)}`);
    if (a.artifactPath && a.strategy !== "git_tag") console.log(`            stored at ${a.artifactPath}${a.commitHash ? ` @ ${a.commitHash.slice(0, 10)}` : ""}`);
    const undo = [...(a.recoveryCommands ?? []), ...(a.strategy === "subagent" ? (a.subagentCommands ?? []) : [])];
    for (const c of undo.slice(0, 5)) console.log(`            undo: ${oneLine(c, 150)}`);
    if (undo.length > 5) console.log(`            (+${undo.length - 5} more undo commands; see --json)`);
    if (a.liveRestore) console.log("            restore re-derives the reversal with a fresh subagent (live restore)");
    if (a.unverified) console.log("            UNVERIFIED: the pre-state could not be confirmed");
  }
  if (d.files.length) {
    console.log(`  Snapshot:    ${d.files.slice(0, 8).join(", ")}${d.files.length > 8 ? `, +${d.files.length - 8} more` : ""}`);
    if (d.stats) console.log(`               ${d.stats}`);
  }
  console.log(`\n  Undo this action and everything after it:  backupper restore ${d.seq}`);
  if (d.files.length) console.log(`  Restore one file from its snapshot:        backupper restore ${d.seq} --file <path>`);
}

function hookSummary(projectRoot: string): Array<{ agent: string; location: string }> {
  return installedAdapters(projectRoot).map((a) => ({ agent: a.name, location: a.hookStatus(projectRoot).location }));
}

/** Print config.json problems to stderr (the effective values fall back to defaults). */
function printConfigWarnings(projectRoot: string): string[] {
  const warnings = configWarnings(projectRoot);
  for (const w of warnings) console.error(`warning: ${w}`);
  return warnings;
}

function statusCommand(projectRoot: string): void {
  const warnings = printConfigWarnings(projectRoot);
  const config = loadConfig(projectRoot);
  const names = actionNames(config);
  const bytes = names.reduce((s, n) => s + dirSize(path.join(backupRoot(config), n)), 0);
  const hooks = hookSummary(projectRoot);
  const status = {
    version: version(),
    project: projectRoot,
    store: getConfigDir(projectRoot),
    configFile: fs.existsSync(getConfigPath(projectRoot)) ? getConfigPath(projectRoot) : null,
    enabled: config.enabled,
    mode: config.mode,
    hooks,
    subagent: config.subagentEnabled
      ? { runner: resolveRunner(config), configuredRunner: config.subagentRunner, model: subagentModelFor(config, resolveRunner(config)) || null }
      : null,
    actions: names.length,
    maxActions: config.maxActions,
    backupBytes: bytes,
    latest: names.length ? names[names.length - 1] : null,
    configWarnings: warnings,
  };
  if (JSON_OUT) {
    printJson(status);
    return;
  }
  console.log(`BackUpper ${status.version}`);
  console.log(`  Project:   ${projectRoot}`);
  console.log(`  Config:    ${status.configFile ?? "none (defaults; run backupper init)"}`);
  console.log(`  Enabled:   ${config.enabled}   mode: ${config.mode}`);
  console.log(`  Hooks:     ${hooks.length ? hooks.map((h) => `${h.agent} (${h.location})`).join(", ") : "not installed (backupper install <agent>)"}`);
  console.log(`  Tier 4:    ${status.subagent ? `\`${status.subagent.runner}\`${status.subagent.model ? ` model ${status.subagent.model}` : " default model"}${config.subagentRunner === "auto" ? " (auto)" : ""}` : "disabled"}`);
  console.log(`  Actions:   ${names.length}${config.maxActions > 0 ? ` (keeps the newest ${config.maxActions})` : ""}, ${(bytes / 1024).toFixed(1)} KB in action folders`);
}

function configCommand(projectRoot: string, args: string[]): void {
  const pos = positionals(args);
  if (pos[0] === "set") {
    const [key, ...rest] = pos.slice(1);
    if (!key || !rest.length) fail("Usage: backupper config set <key> <value>");
    let value: unknown;
    try { value = parseConfigValue(key, rest.join(" ")); } catch (e) { fail((e as Error).message); }
    saveConfig({ [key]: value } as Record<string, unknown>, projectRoot);
    console.log(`Set ${key} = ${JSON.stringify(value)} in ${getConfigPath(projectRoot)}`);
    return;
  }
  printConfigWarnings(projectRoot);
  const config = loadConfig(projectRoot);
  if (pos[0] === "get" && pos[1]) {
    const v = (config as unknown as Record<string, unknown>)[pos[1]];
    console.log(JSON_OUT ? JSON.stringify(v ?? null) : typeof v === "string" ? v : JSON.stringify(v));
    return;
  }
  const effective = config as unknown as Record<string, unknown>;
  const inFile = rawConfigKeys(projectRoot);
  // Every documented key, in the README table's order; unset keys are shown as null.
  const documented = Object.keys(CONFIG_SCHEMA).filter((k) => !UNDOCUMENTED_KEYS.has(k));
  const settings: Record<string, unknown> = {};
  for (const k of documented) settings[k] = effective[k] ?? null;
  // Internal keys (store layout, deny list) are kept apart from the documented settings.
  const internal: Record<string, unknown> = {};
  for (const k of Object.keys(effective)) if (!documented.includes(k)) internal[k] = effective[k];
  if (JSON_OUT) {
    printJson({ ...settings, internal });
    return;
  }
  const file = fs.existsSync(getConfigPath(projectRoot)) ? getConfigPath(projectRoot) : "no config file; all defaults";
  console.log(`Effective configuration (${file}):\n`);
  const width = Math.max(...documented.map((k) => k.length));
  for (const k of documented) {
    const v = effective[k];
    const shown = v === undefined ? "(unset)" : JSON.stringify(v);
    const note = v === undefined ? "" : inFile.has(k) ? "" : "  (default)";
    console.log(`  ${k.padEnd(width)}  ${oneLine(shown, 100)}${note}`);
  }
  console.log("\nChange a key: backupper config set <key> <value>    Read one: backupper config get <key>");
}

/** Keys in CONFIG_SCHEMA that the README table leaves out (kept in sync with gen_config_doc.mjs). */
const UNDOCUMENTED_KEYS = new Set(["denyPatterns"]);

/** Keys written in config.json (empty when absent or unparseable). */
function rawConfigKeys(projectRoot: string): Set<string> {
  try {
    const raw = JSON.parse(fs.readFileSync(getConfigPath(projectRoot), "utf-8"));
    return new Set(raw && typeof raw === "object" && !Array.isArray(raw) ? Object.keys(raw) : []);
  } catch {
    return new Set();
  }
}

function diffCommand(projectRoot: string, args: string[]): void {
  const config = loadConfig(projectRoot);
  const ref = positionals(args)[0] ?? "latest";
  const name = resolveAction(config, ref);
  if (!name) fail(actionNames(config).length ? `No action ${ref}.` : "No actions recorded yet.", "backupper list");
  let d: ReturnType<typeof snapshotDiff>;
  try {
    d = snapshotDiff(config, name, projectRoot);
  } catch (e) {
    fail(`Diff failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
  }
  if (!d) {
    if (JSON_OUT) printJson({ action: name, stat: "", diff: "", note: "no workspace snapshot in this action" });
    else console.log(`Action ${name} has no workspace snapshot to diff against.`);
    return;
  }
  if (JSON_OUT) { printJson({ action: name, ...d }); return; }
  if (!d.stat) { console.log(`No workspace changes since the snapshot of ${name}.`); return; }
  console.log(`Changes since the snapshot taken before action #${name.split("_")[1].replace(/^0+/, "")} (${d.commit.slice(0, 8)}):\n`);
  console.log(d.stat);
  console.log(`\n${d.diff}`);
}

// ── Undo ─────────────────────────────────────────────────────────────

function printRestoreResults(results: RestoreResult[]): void {
  for (const r of results) {
    console.log(`  [${r.success ? "OK" : "FAIL"}] ${r.description}`);
    if (/UNVERIFIED/i.test(r.description)) {
      console.log("       ^ recovery was re-derived from live state, not a captured snapshot; verify the result.");
    }
    if (r.subagentPrompt) {
      console.log("\n  --- Restore of out-of-workspace state needs an agent ---");
      console.log("  Give this prompt to your agent:\n");
      console.log(r.subagentPrompt.split("\n").map((l) => `    ${l}`).join("\n"));
      console.log();
    }
  }
}

async function restoreCommand(projectRoot: string, args: string[]): Promise<void> {
  const config = loadConfig(projectRoot);
  const ref = positionals(args, ["--file"])[0];
  if (!ref) {
    console.log("Pass the action to undo: backupper restore <#|last>. Recorded actions:\n");
    listCommand(projectRoot, []);
    return;
  }
  const name = resolveAction(config, ref);
  if (!name) fail(actionNames(config).length ? `No action ${ref}.` : "No actions recorded yet.", "backupper list");
  const restore = require("./restore/restore.js") as typeof import("./restore/restore.js");
  const file = flagValue(args, "--file");
  let results: RestoreResult[];
  if (file) {
    console.log(`Restoring ${file} from the snapshot taken before ${name}\n`);
    results = await restore.restoreActionDirect(name, config, { fileOnly: file });
  } else if (args.includes("--direct")) {
    console.log(`Applying only the artifacts of ${name}\n`);
    results = await restore.restoreActionDirect(name, config);
  } else {
    console.log(`Undoing ${name} and every later action, newest first\n`);
    results = await restore.restoreActionLoop(name, config);
  }
  printRestoreResults(results);
  if (results.some((r) => !r.success)) process.exitCode = 1;
}

/** Store entries `clear` keeps: configuration and learned knowledge, not recorded backups. */
const KEEP_ON_CLEAR = new Set(["config.json", "experiences", "learned-backup-rules.json", "tool-registry.json", "panel.json"]);

function clearCommand(projectRoot: string, args: string[]): void {
  const store = getConfigDir(projectRoot);
  const entries = fs.existsSync(store) ? fs.readdirSync(store).filter((f) => !KEEP_ON_CLEAR.has(f)) : [];
  if (!entries.length) {
    console.log("Nothing to clear.");
    return;
  }
  if (!args.includes("--yes") && !args.includes("-y")) {
    console.log(`This permanently deletes the recorded backups and logs in ${store}:`);
    for (const e of entries) console.log(`  - ${e}`);
    console.log(`Kept: ${[...KEEP_ON_CLEAR].join(", ")}.`);
    console.log("\nNothing was deleted. Re-run with --yes to confirm: backupper clear --yes");
    return;
  }
  for (const e of entries) fs.rmSync(path.join(store, e), { recursive: true, force: true });
  console.log(`Removed ${entries.length} item(s) from ${store}. Hooks and config are untouched.`);
}

// ── Side panel ───────────────────────────────────────────────────────

/** argv that starts `backupper watch` from this install, independent of the pane's PATH. */
function watchArgv(): string[] {
  return [process.execPath, path.join(PKG_DIST, "cli.js"), "watch"];
}

function panelCli(projectRoot: string, action: string): void {
  const { panelCommand } = require("./cli/panel.js") as typeof import("./cli/panel.js");
  const r = panelCommand(action, { projectRoot, watch: watchArgv() });
  for (const l of r.lines) console.log(l);
  if (!r.ok) process.exitCode = 1;
}

// ── Main ─────────────────────────────────────────────────────────────

const HELP = `BackUpper ${version()}: captures what an agent's tool call is about to destroy, before it runs.

Usage: backupper <command> [options]

Setup
  init                          Create .backupper/ with the default config in this project
  install <agent>               Register the hooks for claude-code | codex | hermes
  uninstall [agent]             Remove the hooks (every installed agent when none is named)
  doctor [agent] [--probe]      Check the agent, hooks, config, git and the tier-4 runner
  demo [--keep]                 Offline demo in a temporary directory (no agent, no key)

Inspect
  list [--limit N]              Recorded actions, oldest first
  show <N|--latest>             What one action captured and how to undo it
  diff [N]                      Workspace changes since action N's snapshot (default: latest)
  status                        Hooks, settings and store summary
  config                        Effective value of every setting
  config get <key>              One setting's effective value
  config set <key> <value>      Change one setting

Side panel
  panel [on|off|toggle|status]  Live view of captures in a pane to the right (default: toggle)
  split                         Same as panel on
  watch                         The panel itself: live action list, r restores, d diffs

Undo
  restore <N|last>              Undo action N and every action after it
  restore <N> --file <path>     Restore one file from action N (workspace snapshot or outside-file copy)
  restore <N> --direct          Apply only action N's own artifacts
  clear [--yes]                 Delete recorded backups (keeps hooks and config)

Read commands (list, show, diff, status, config, doctor, demo) accept --json.
<command> --help prints that command's usage. --version prints the version.`;

/** The HELP lines for one command, for `<command> --help`. */
function commandHelp(command: string): string {
  const names = command === "history" || command === "backups" ? ["list"] : [command];
  const lines = HELP.split("\n").filter((l) => names.some((n) => l.startsWith(`  ${n} `) || l.trim() === n));
  return lines.length
    ? `Usage: backupper ${command}\n\n${lines.join("\n")}`
    : HELP;
}

async function main(): Promise<void> {
  const [command, ...rest] = argv;
  const cwd = process.cwd();
  const setup = ["init", "install", "demo", "help", "--help", "-h", "--version", "-v", undefined];
  // `<command> --help` prints usage and never acts.
  if (command && (rest.includes("--help") || rest.includes("-h"))) {
    console.log(commandHelp(command));
    return;
  }
  const projectRoot = setup.includes(command) ? cwd : projectRootFor(cwd);
  if (projectRoot !== cwd) process.chdir(projectRoot);

  switch (command) {
    case "init": initProject(projectRoot); break;
    case "install": install(projectRoot, rest); break;
    case "uninstall": uninstall(projectRoot, rest); break;
    case "doctor": doctorCommand(projectRoot, rest); break;
    case "demo": {
      const { demo } = require("./cli/demo.js") as typeof import("./cli/demo.js");
      process.exitCode = demo(PKG_DIST, { keep: rest.includes("--keep"), json: JSON_OUT });
      break;
    }
    case "list": case "history": case "backups": listCommand(projectRoot, rest); break;
    case "show": showCommand(projectRoot, rest); break;
    case "diff": diffCommand(projectRoot, rest); break;
    case "status": statusCommand(projectRoot); break;
    case "config": configCommand(projectRoot, rest); break;
    case "watch": {
      const { watch } = require("./cli/watch.js") as typeof import("./cli/watch.js");
      await watch(projectRoot);
      break;
    }
    case "panel": panelCli(projectRoot, positionals(rest)[0] ?? "toggle"); break;
    case "split": panelCli(projectRoot, "on"); break;
    case "restore": await restoreCommand(projectRoot, rest); break;
    case "restore_direct": await restoreCommand(projectRoot, [...rest, "--direct"]); break;
    case "clear": clearCommand(projectRoot, rest); break;
    case "--version": case "-v": console.log(version()); break;
    case undefined: case "help": case "--help": case "-h": console.log(HELP); break;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));

