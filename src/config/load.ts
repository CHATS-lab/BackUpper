/**
 * Config loader — reads .backupper/config.json, merges with defaults.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_CONFIG, storeDirOverride, type SandboxConfig, type SandboxMode } from "../types.js";
import { PERSONALIZATION_ALIASES, validateConfig } from "./schema.js";

const CONFIG_DIR = ".backupper";
const CONFIG_FILE = "config.json";

export function getConfigDir(projectRoot: string = process.cwd()): string {
  // BACKUPPER_STORE_DIR relocates the whole store, config.json included,
  // and then overrides `projectRoot`.
  const override = storeDirOverride();
  if (override) return override;
  return path.join(projectRoot, CONFIG_DIR);
}

export function getConfigPath(projectRoot: string = process.cwd()): string {
  return path.join(getConfigDir(projectRoot), CONFIG_FILE);
}

/** The mode from the config file, if it names one this build knows. */
function readMode(raw: Record<string, unknown>): SandboxMode | undefined {
  const mode = raw.mode;
  if (mode === "checker" || mode === "off") return mode;
  return undefined;
}

export function loadConfig(projectRoot: string = process.cwd()): SandboxConfig {
  const configPath = getConfigPath(projectRoot);
  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const migrated = readMode(parsed);
    const userConfig = { ...parsed } as Partial<SandboxConfig> &
      Record<string, unknown>;
    delete userConfig.mode;
    const legacy = typeof userConfig.personalization === "string" ? PERSONALIZATION_ALIASES[userConfig.personalization] : undefined;
    if (legacy) userConfig.personalization = legacy;
    // Writing your own preference text turns on custom personalization.
    const ownPolicy = typeof userConfig.personalizationPolicy === "string" ? userConfig.personalizationPolicy.trim() : "";
    if (ownPolicy && !userConfig.personalization) userConfig.personalization = "custom";
    return {
      ...DEFAULT_CONFIG,
      ...(userConfig as Partial<SandboxConfig>),
      mode: migrated ?? DEFAULT_CONFIG.mode,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** The config file as written, without defaults; empty when absent or unparseable. */
function readRawConfig(projectRoot: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(getConfigPath(projectRoot), "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Merge `config` into the file; keys not given keep their written value or stay defaulted. */
export function saveConfig(
  config: Partial<SandboxConfig>,
  projectRoot: string = process.cwd()
): void {
  const dir = getConfigDir(projectRoot);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const merged = { ...readRawConfig(projectRoot), ...config };
  fs.writeFileSync(
    getConfigPath(projectRoot),
    JSON.stringify(merged, null, 2) + "\n",
    "utf-8"
  );
}

/** The keys `backupper init` writes, so the file shows the settings users normally change. */
const STARTER_KEYS = [
  "enabled", "mode", "subagentEnabled", "subagentRunner", "subagentModel",
  "subagentModels",
  "subagentTimeoutSeconds", "maxActions", "selfImproving", "notifyOnSuccess", "verbose",
] as const;

/** Create config.json with the starter keys unless one exists. Returns true when written. */
export function ensureConfig(projectRoot: string = process.cwd()): boolean {
  if (fs.existsSync(getConfigPath(projectRoot))) return false;
  const starter: Record<string, unknown> = {};
  for (const k of STARTER_KEYS) starter[k] = DEFAULT_CONFIG[k];
  saveConfig(starter as Partial<SandboxConfig>, projectRoot);
  return true;
}

/**
 * Problems with config.json that loadConfig() silently works around: a file that does not
 * parse (all defaults are used), values of the wrong type, and pattern entries that are not
 * valid regexes (skipped when matching). One line per problem; empty when the file is absent
 * or fine.
 */
export function configWarnings(projectRoot: string = process.cwd()): string[] {
  const file = getConfigPath(projectRoot);
  if (!fs.existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (e) {
    return [`${file} does not parse (${e instanceof Error ? e.message : String(e)}); every setting falls back to its default`];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [`${file} is not a JSON object; every setting falls back to its default`];
  }
  const raw = parsed as Record<string, unknown>;
  const out = validateConfig(raw).map((p) => `${file}: ${p}`);
  for (const key of ["denyPatterns", "alwaysBackupPatterns"]) {
    const list = raw[key];
    if (!Array.isArray(list)) continue;
    for (const pat of list) {
      if (typeof pat !== "string") {
        out.push(`${file}: ${key} entry ${JSON.stringify(pat)} is not a string; it is ignored`);
        continue;
      }
      try {
        new RegExp(pat, "i");
      } catch {
        out.push(`${file}: ${key} entry /${pat}/ is not a valid regex; it is ignored`);
      }
    }
  }
  return out;
}
