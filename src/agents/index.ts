/**
 * Agent adapter registry: each supported agent (Claude Code, Codex, Hermes) provides its own
 * install/uninstall recipe and reports whether its hooks are in place.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { SubagentRunnerName } from "../types.js";

export interface AgentInstallResult {
  /** Lines printed by the CLI. */
  log: string[];
}

export interface HookStatus {
  /** True when at least one BackUpper hook is registered for this agent in the project. */
  installed: boolean;
  /** The agent config file (or plugin directory) the hooks live in, project-relative. */
  location: string;
  /** Script paths the registered hook commands point at. */
  hookScripts: string[];
}

export interface AgentAdapter {
  /** Canonical name, used by `backupper install <name>`. */
  name: string;
  /** Short description for --help. */
  description: string;
  /** The agent's CLI executable. */
  bin: string;
  /** The CLI that runs the tier-3 subagent when this agent is the host. */
  runner: SubagentRunnerName;
  /**
   * The host applies a hook's rewritten tool input (`updatedInput`). When false, tier 0 runs
   * in backup-only mode (see agents/capabilities.ts).
   */
  canRewrite: boolean;
  hookStatus(projectRoot: string): HookStatus;
  /** Wire hooks for this agent; `pkgRoot` is the installed dist/ directory. */
  install(projectRoot: string, pkgRoot: string): AgentInstallResult;
  /** Remove everything install() wrote into the agent's configuration. */
  uninstall(projectRoot: string): AgentInstallResult;
}

import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter } from "./codex.js";
import { hermesAdapter } from "./hermes.js";

export const ALL_ADAPTERS: AgentAdapter[] = [claudeCodeAdapter, codexAdapter, hermesAdapter];

/** Accepted spellings for each agent on the command line. */
const ALIASES: Record<string, string> = { claude: "claude-code", "claude-code": "claude-code", codex: "codex", hermes: "hermes" };

export function findAdapter(name: string): AgentAdapter | undefined {
  const canonical = ALIASES[name] ?? name;
  return ALL_ADAPTERS.find((a) => a.name === canonical);
}

/** Adapters whose hooks are installed in the project. */
export function installedAdapters(projectRoot: string): AgentAdapter[] {
  return ALL_ADAPTERS.filter((a) => a.hookStatus(projectRoot).installed);
}

/** The hook command an agent runs: node on an absolute script path, tagged with the host agent. */
export function hookCommand(pkgRoot: string, hook: "pre-tool" | "post-tool" | "user-prompt", agent: string): string {
  return `node "${path.join(pkgRoot, "hooks", `${hook}.js`)}" --agent ${agent}`;
}

/** True for a hook command written by this package. */
export function isOurCommand(cmd: unknown): boolean {
  return typeof cmd === "string" &&
    /[\\/]hooks[\\/](pre-tool|post-tool|user-prompt)\.js"?\s+--agent\s+[a-z-]+/.test(cmd);
}

/** The script path inside one of our hook commands. */
export function scriptOf(cmd: string): string {
  const m = cmd.match(/node\s+"([^"]+)"|node\s+(\S+)/);
  return m ? (m[1] ?? m[2]) : cmd;
}

/** Read a JSON object file; empty object when absent. Throws on a file that does not parse. */
export function readJsonObject(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file} is not a JSON object`);
  return parsed as Record<string, unknown>;
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

/** Remove `dir` and then its parents up to (not including) `stopAt`, while each is empty. */
export function removeEmptyDirs(dir: string, stopAt: string): void {
  let cur = path.resolve(dir);
  const stop = path.resolve(stopAt);
  while (cur.startsWith(stop + path.sep)) {
    try {
      if (fs.readdirSync(cur).length > 0) return;
      fs.rmdirSync(cur);
    } catch {
      return;
    }
    cur = path.dirname(cur);
  }
}

/** Add `.backupper/` to an existing .gitignore (idempotent); never creates the file. */
export function ignoreStore(projectRoot: string): string | null {
  const p = path.join(projectRoot, ".gitignore");
  if (!fs.existsSync(p)) return null;
  const content = fs.readFileSync(p, "utf-8");
  if (/^\s*\/?\.backupper\/?\s*$/m.test(content)) return null;
  const prefix = content && !content.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(p, `${prefix}.backupper/\n`);
  return "Added .backupper/ to .gitignore";
}
