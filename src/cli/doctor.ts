/**
 * `backupper doctor`: checks that an agent, its hooks, the config, git and the tier-4 runner
 * are ready. Every failed check carries a one-line fix. `--probe` makes one small model call
 * through the invocation the tier-4 subagent uses.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { AgentAdapter } from "../agents/index.js";
import { getConfigPath, loadConfig } from "../config/load.js";
import { validateConfig } from "../config/schema.js";
import { resolveRunner, subagentModelFor } from "../backup/runner_caps.js";
import { buildSubagentInvocation, cleanupSubagentInvocation, isCommandAvailable, subagentEnv } from "../backup/subagent.js";
import type { SandboxConfig, SubagentRunnerName } from "../types.js";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface Check {
  id: string;
  status: CheckStatus;
  summary: string;
  fix?: string;
}

function run(bin: string, args: string[], timeoutMs = 20_000, cwd?: string): { ok: boolean; out: string; err: string } {
  const r = spawnSync(bin, args, { encoding: "utf-8", timeout: timeoutMs, cwd, input: "" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() || (r.error?.message ?? "") };
}

function firstLine(s: string): string {
  return s.split("\n").find((l) => l.trim())?.trim() ?? "";
}

function checkNode(): Check {
  const major = parseInt(process.versions.node.split(".")[0], 10);
  return major >= 18
    ? { id: "node", status: "ok", summary: `node ${process.versions.node}` }
    : { id: "node", status: "fail", summary: `node ${process.versions.node} is too old`, fix: "install Node.js 18 or newer" };
}

function checkAgentCli(adapter: AgentAdapter): Check {
  const id = "agent.cli";
  if (!isCommandAvailable(adapter.bin)) {
    const fix = {
      claude: "install Claude Code: npm install -g @anthropic-ai/claude-code",
      codex: "install Codex: npm install -g @openai/codex",
      hermes: "install Hermes and make sure `hermes` is on PATH",
    }[adapter.runner];
    return { id, status: "fail", summary: `${adapter.bin} not found on PATH`, fix };
  }
  const v = firstLine(run(adapter.bin, ["--version"]).out) || "(version unknown)";
  return { id, status: "ok", summary: v.toLowerCase().includes(adapter.bin) ? v : `${adapter.bin} ${v}` };
}

function checkHooks(adapter: AgentAdapter, projectRoot: string, pkgRoot: string): Check[] {
  const st = adapter.hookStatus(projectRoot);
  if (!st.installed) {
    return [{
      id: "hooks", status: "fail",
      summary: `hooks not installed in ${st.location}`,
      fix: `backupper install ${adapter.name}`,
    }];
  }
  const checks: Check[] = [];
  const ours = path.join(pkgRoot, "hooks");
  const foreign = st.hookScripts.filter((s) => path.dirname(path.resolve(s)) !== ours);
  const missing = st.hookScripts.filter((s) => !fs.existsSync(s));
  if (missing.length) {
    checks.push({ id: "hooks", status: "fail", summary: `hook script missing: ${missing[0]}`, fix: `backupper install ${adapter.name}` });
  } else if (foreign.length) {
    checks.push({
      id: "hooks", status: "warn",
      summary: `hooks in ${st.location} point at another BackUpper install (${path.dirname(path.dirname(foreign[0]))})`,
      fix: `backupper install ${adapter.name}   # re-point them at this install`,
    });
  } else {
    checks.push({ id: "hooks", status: "ok", summary: `hooks installed in ${st.location}, pointing at this install` });
  }
  if (adapter.name === "codex" && isCommandAvailable("codex")) {
    const f = run("codex", ["features", "list"]);
    const line = f.out.split("\n").find((l) => /^hooks\s/.test(l));
    if (line && !/\btrue\b/.test(line)) {
      checks.push({ id: "hooks.feature", status: "fail", summary: "the codex `hooks` feature is disabled", fix: "codex --enable hooks  (or set features.hooks = true in ~/.codex/config.toml)" });
    }
    checks.push({
      id: "hooks.trust", status: "warn",
      summary: "codex runs new hooks only after they are trusted",
      fix: "open `codex` in this project once and approve the hooks, or pass --dangerously-bypass-hook-trust",
    });
  }
  if (adapter.name === "hermes") {
    const on = /^(1|true|yes|on)$/i.test(String(process.env.HERMES_ENABLE_PROJECT_PLUGINS ?? ""));
    checks.push(on
      ? { id: "hooks.enabled", status: "ok", summary: "HERMES_ENABLE_PROJECT_PLUGINS is set" }
      : {
        id: "hooks.enabled", status: "fail",
        summary: "Hermes ignores project plugins unless HERMES_ENABLE_PROJECT_PLUGINS=1",
        fix: "export HERMES_ENABLE_PROJECT_PLUGINS=1   # in the shell that runs hermes",
      });
  }
  return checks;
}

function checkConfig(projectRoot: string): Check {
  const p = getConfigPath(projectRoot);
  if (!fs.existsSync(p)) {
    return { id: "config", status: "fail", summary: "no .backupper/config.json in this project", fix: "backupper init" };
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (e) {
    return { id: "config", status: "fail", summary: `config.json does not parse: ${(e as Error).message}`, fix: `fix or delete ${p}, then: backupper init` };
  }
  const problems = validateConfig(raw);
  if (problems.length) {
    return { id: "config", status: "fail", summary: `config.json: ${problems.join("; ")}`, fix: "backupper config set <key> <value>" };
  }
  const c = loadConfig(projectRoot);
  if (!c.enabled || c.mode === "off") {
    return { id: "config", status: "warn", summary: `config valid, but BackUpper is ${c.enabled ? "in mode off" : "disabled"}`, fix: "backupper config set enabled true && backupper config set mode checker" };
  }
  return { id: "config", status: "ok", summary: `config valid (mode ${c.mode})` };
}

function checkGit(): Check {
  const v = run("git", ["--version"]);
  return v.ok
    ? { id: "git", status: "ok", summary: `${firstLine(v.out)} (tier 3 snapshots)` }
    : { id: "git", status: "fail", summary: "git not found; tier 3 snapshots are disabled", fix: "install git" };
}

function presentEnv(names: string[]): string[] {
  return names.filter((n) => String(process.env[n] ?? "").trim() !== "");
}

/** Whether the runner CLI is installed and has credentials, without calling a model. */
function checkRunnerAuth(runner: string, config: SandboxConfig): Check[] {
  const id = "tier4.runner";
  if (!isCommandAvailable(runner)) {
    return [{ id, status: "fail", summary: `tier-4 runner \`${runner}\` not found on PATH`, fix: `install ${runner}, or: backupper config set subagentRunner <claude|codex|hermes>` }];
  }
  const chosen = subagentModelFor(config, runner as SubagentRunnerName);
  const model = chosen ? ` with model ${chosen}` : " with its default model";
  const checks: Check[] = [{ id, status: "ok", summary: `tier-4 subagent runs \`${runner}\`${model}` }];

  if (runner === "claude") {
    const env = presentEnv(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]);
    const st = run("claude", ["auth", "status"], 20_000);
    let loggedIn = false;
    let method = "";
    try {
      const j = JSON.parse(st.out);
      loggedIn = j.loggedIn === true;
      method = String(j.authMethod ?? "");
    } catch { /* older CLI without `auth status` */ }
    if (loggedIn) checks.push({ id: "tier4.auth", status: "ok", summary: `claude is logged in (${method || "login"})` });
    else if (env.length) checks.push({ id: "tier4.auth", status: "ok", summary: `claude credentials from ${env.join(", ")}` });
    else checks.push({ id: "tier4.auth", status: "fail", summary: "claude is not logged in and no API key is set", fix: "run `claude` and /login, or export ANTHROPIC_API_KEY=..." });
  } else if (runner === "codex") {
    const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    const env = presentEnv(["OPENAI_API_KEY", "CODEX_API_KEY"]);
    if (fs.existsSync(path.join(home, "auth.json"))) checks.push({ id: "tier4.auth", status: "ok", summary: `codex login found (${path.join(home, "auth.json")})` });
    else if (env.length) checks.push({ id: "tier4.auth", status: "ok", summary: `codex credentials from ${env.join(", ")}` });
    else checks.push({ id: "tier4.auth", status: "fail", summary: "codex has no login and no API key is set", fix: "codex login   (or export OPENAI_API_KEY=...)" });
  } else if (runner === "hermes") {
    const home = process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
    const cfg = path.join(home, "config.yaml");
    let provider = config.subagentProvider;
    let modelName = chosen;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const yaml = require("js-yaml");
      const doc = yaml.load(fs.readFileSync(cfg, "utf-8")) as Record<string, unknown> | undefined;
      const m = doc?.model;
      if (m && typeof m === "object") {
        provider ||= String((m as Record<string, unknown>).provider ?? "");
        modelName ||= String((m as Record<string, unknown>).default ?? (m as Record<string, unknown>).model ?? "");
      } else if (typeof m === "string") {
        modelName ||= m;
      }
    } catch { /* no hermes config */ }
    if (!provider && !modelName) {
      checks.push({ id: "tier4.auth", status: "fail", summary: `no hermes model/provider configured (${cfg})`, fix: "hermes setup   (or: backupper config set subagentProvider <name> && backupper config set subagentModel <id>)" });
    } else {
      const keyVars = Object.keys(process.env).filter((k) => /_API_KEY$|_TOKEN$/.test(k) && process.env[k]);
      const envFile = path.join(home, ".env");
      const hasEnvFile = fs.existsSync(envFile);
      checks.push(keyVars.length || hasEnvFile
        ? { id: "tier4.auth", status: "ok", summary: `hermes provider ${provider || "(default)"}${modelName ? `, model ${modelName}` : ""}; credentials ${hasEnvFile ? `in ${envFile}` : "in the environment"}` }
        : { id: "tier4.auth", status: "warn", summary: `hermes provider ${provider || "(default)"} configured, but no API key found in the environment or ${envFile}`, fix: "hermes setup   (or export the provider's API key)" });
    }
  }
  return checks;
}

/** One real, tiny model call through the tier-4 invocation (tools disabled). */
function probe(config: SandboxConfig, runner: string, projectRoot: string): Check {
  const cfg = { ...config, subagentRunner: runner as SandboxConfig["subagentRunner"] };
  const inv = buildSubagentInvocation("Reply with exactly the word READY and nothing else.", cfg, {
    noTools: true,
    systemPrompt: "You are a connectivity probe. Answer with one word.",
  });
  if (!inv) return { id: "tier4.probe", status: "fail", summary: `${runner} not found on PATH`, fix: `install ${runner}` };
  const t0 = Date.now();
  let r;
  try {
    r = spawnSync(inv.bin, inv.args, {
      encoding: "utf-8",
      timeout: Math.max(30, config.subagentTimeoutSeconds) * 1000,
      cwd: projectRoot,
      env: { ...subagentEnv(), ...(inv.env ?? {}) },
      input: "",
      maxBuffer: 8 * 1024 * 1024,
    });
  } finally {
    cleanupSubagentInvocation(inv);
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const out = `${r.stdout ?? ""}`;
  if (r.status === 0 && /READY/i.test(out)) {
    return { id: "tier4.probe", status: "ok", summary: `probe call through ${runner} answered in ${secs}s` };
  }
  const why = firstLine(`${r.stderr ?? ""}`.split("\n").reverse().join("\n")) || firstLine(out) || r.error?.message || `exit ${r.status}`;
  return {
    id: "tier4.probe", status: "fail",
    summary: `probe call through ${runner} failed after ${secs}s: ${why.slice(0, 200)}`,
    fix: runner === "claude" ? "check `claude -p hi` works in this shell (login, network, org policy)"
      : runner === "codex" ? "check `codex exec hi` works in this shell (login, network)"
        : "check `hermes chat -q hi` works in this shell (provider and key)",
  };
}

export function doctor(adapter: AgentAdapter, projectRoot: string, pkgRoot: string, opts: { probe: boolean }): Check[] {
  const config = loadConfig(projectRoot);
  const runner = resolveRunner(config, adapter.name);
  const checks: Check[] = [checkNode(), checkAgentCli(adapter), ...checkHooks(adapter, projectRoot, pkgRoot), checkConfig(projectRoot), checkGit()];
  if (!config.subagentEnabled) {
    checks.push({ id: "tier4.runner", status: "skip", summary: "tier-4 subagent disabled (subagentEnabled=false)" });
    return checks;
  }
  const runnerChecks = checkRunnerAuth(runner, config);
  checks.push(...runnerChecks);
  if (opts.probe) {
    checks.push(runnerChecks.some((c) => c.status === "fail")
      ? { id: "tier4.probe", status: "skip", summary: "probe skipped: the runner is not ready" }
      : probe(config, runner, projectRoot));
  }
  return checks;
}
