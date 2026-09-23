/**
 * Config loader — reads .chats-sandbox/config.json, merges with defaults.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_CONFIG, storeDirOverride, type SandboxConfig, type SandboxMode } from "../types.js";

const CONFIG_DIR = ".chats-sandbox";
const CONFIG_FILE = "config.json";

export function getConfigDir(projectRoot: string = process.cwd()): string {
  // CHATS_SANDBOX_STORE_DIR moves the WHOLE store, config.json included —
  // see storeDirOverride() in ../types.js. `projectRoot` is then ignored on
  // purpose: a config read from the workspace while the backups live outside
  // it would be two stores, and `config set` would write to the one nothing
  // reads. Unset: the path this always returned.
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
    return {
      ...DEFAULT_CONFIG,
      ...(userConfig as Partial<SandboxConfig>),
      mode: migrated ?? DEFAULT_CONFIG.mode,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(
  config: Partial<SandboxConfig>,
  projectRoot: string = process.cwd()
): void {
  const dir = getConfigDir(projectRoot);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const current = loadConfig(projectRoot);
  const merged = { ...current, ...config };
  fs.writeFileSync(
    getConfigPath(projectRoot),
    JSON.stringify(merged, null, 2) + "\n",
    "utf-8"
  );
}
