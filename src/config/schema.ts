/**
 * User-settable configuration keys: their value kind, for `config set` and
 * `doctor`. Keys absent here are internal and set by the tiers themselves.
 */

import { DEFAULT_CONFIG, type SandboxConfig } from "../types.js";

type Kind =
  | { type: "boolean" }
  | { type: "integer" }
  | { type: "string" }
  | { type: "enum"; values: readonly string[] }
  | { type: "json"; shape: "object" | "array" };

const RUNNERS = ["claude", "codex", "hermes"] as const;

/** Personalization modes, named as in the paper. */
export const PERSONALIZATION_MODES = ["high-impact", "beyond-request", "human-work"] as const;
/** Earlier names for the same modes; still accepted and mapped on load and on `config set`. */
export const PERSONALIZATION_ALIASES: Record<string, (typeof PERSONALIZATION_MODES)[number]> = {
  "hard-to-reverse-only": "high-impact",
  "unrequested-effects-only": "beyond-request",
  "human-authored-only": "human-work",
};

export const CONFIG_SCHEMA: Record<string, Kind> = {
  enabled: { type: "boolean" },
  mode: { type: "enum", values: ["checker", "off"] },
  subagentEnabled: { type: "boolean" },
  subagentRunner: { type: "enum", values: ["auto", ...RUNNERS] },
  subagentModel: { type: "string" },
  subagentModels: { type: "json", shape: "object" },
  subagentProvider: { type: "string" },
  subagentTimeoutSeconds: { type: "integer" },
  subagentPermissionMode: { type: "enum", values: ["bypassPermissions", "acceptEdits"] },
  subagentMcpConfig: { type: "string" },
  subagentRestoreModel: { type: "string" },
  maxActions: { type: "integer" },
  maxTotalSizeMB: { type: "integer" },
  maxAgeHours: { type: "integer" },
  denyPatterns: { type: "json", shape: "array" },
  alwaysBackupPatterns: { type: "json", shape: "array" },
  effectManifest: { type: "boolean" },
  learnedReadOnlyEnabled: { type: "boolean" },
  personalization: {
    type: "enum",
    values: ["", ...PERSONALIZATION_MODES, "custom", ...Object.keys(PERSONALIZATION_ALIASES)],
  },
  personalizationPolicy: { type: "string" },
  personalizationUserRequests: { type: "json", shape: "array" },
  selfImproving: { type: "boolean" },
  selfImprovingGeneralize: { type: "boolean" },
  learnedBackupRulesPath: { type: "string" },
  reflectionSubagentRunner: { type: "enum", values: ["", ...RUNNERS] },
  reflectionSubagentModel: { type: "string" },
  experienceForServer: { type: "json", shape: "object" },
  notifyOnSuccess: { type: "boolean" },
  announceOnce: { type: "boolean" },
  panel: { type: "boolean" },
  verbose: { type: "boolean" },
};

/**
 * One-line description of each settable key. README's configuration table is generated from
 * this, CONFIG_SCHEMA and DEFAULT_CONFIG by `scripts/build.mjs config-doc` (`npm run docs`).
 */
export const CONFIG_DOCS: Record<keyof typeof CONFIG_SCHEMA, string> = {
  enabled: "Master switch.",
  mode: "`checker` runs tiers 1-3 on every mutating call and tier 4 on a `[BACKUP NEEDED]` marker or a checker verdict. `off` disables everything.",
  subagentEnabled: "Turns tier 4 (and the checker) on or off.",
  subagentRunner: "CLI for tier 4 and the checker. `auto` follows the agent whose hook fired.",
  subagentModel: "Model for tier 4 and the checker, on every runner. Empty uses `subagentModels`.",
  subagentModels: "Per-runner model used when `subagentModel` is empty. A runner without an entry uses its CLI's default model.",
  subagentProvider: "Hermes only: provider for `hermes chat`. Empty uses Hermes's configured provider.",
  subagentTimeoutSeconds: "Time limit for one tier-4 capture.",
  subagentPermissionMode: "Claude runner only. `acceptEdits` restricts the subagent to file edits.",
  subagentMcpConfig: "MCP config file the subagent may use. Empty uses the project's `.mcp.json`.",
  subagentRestoreModel: "A different model for live restores. Empty reuses the tier-4 model.",
  maxActions: "Action folders kept; the oldest are pruned first. `0` means unlimited.",
  maxTotalSizeMB: "Size cap on action folders. `0` means unlimited.",
  maxAgeHours: "Age cap on action folders. `0` means unlimited.",
  denyPatterns: "Regexes for commands that are blocked outright. Setting it replaces the whole list.",
  alwaysBackupPatterns: "Regexes for commands that are always treated as mutating.",
  effectManifest: "Logs each call's effects to `.backupper/effects.jsonl`.",
  learnedReadOnlyEnabled: "Lets read-only patterns learned in a session skip later checker calls.",
  personalization: "Limits tier 4 to one preference: `high-impact`, `beyond-request`, `human-work`, or `custom` for your own text in `personalizationPolicy` (the older names `hard-to-reverse-only`, `unrequested-effects-only` and `human-authored-only` still work).",
  personalizationPolicy: "Your own backup preference in plain words, e.g. `Only back up the customer database and anything under docs/`. Setting it turns on `custom` personalization.",
  personalizationUserRequests: "User turns given to the personalization checker as evidence.",
  selfImproving: "After each tier-4 capture, one reflection turn writes a deterministic rule for similar calls.",
  selfImprovingGeneralize: "Extends each learned rule to sibling operations. Needs `selfImproving`.",
  learnedBackupRulesPath: "Where learned rules are stored.",
  reflectionSubagentRunner: "Runner for reflection turns. Empty reuses the tier-4 runner.",
  reflectionSubagentModel: "Model for reflection turns. Empty reuses the tier-4 model.",
  experienceForServer: "Maps an MCP server to an experience file, e.g. `{\"playwright\": \"shop\"}`.",
  notifyOnSuccess: "Tells the agent about every successful backup. Failures and unverified backups are always reported.",
  announceOnce: "Briefs the agent once per session about the `[BACKUP NEEDED]` marker.",
  panel: "Opens the `backupper watch` side panel once at the start of each agent session. Off by default; `backupper panel on` opens it on demand.",
  verbose: "Writes hook decisions to stderr.",
};

/** Keys the store layout owns; accepted in the file but not settable from the CLI. */
const INTERNAL_KEYS = new Set<string>(["backupDir", "effectLogPath"]);

function describe(kind: Kind): string {
  switch (kind.type) {
    case "enum": return kind.values.map((v) => (v === "" ? '""' : v)).join(" | ");
    case "json": return `JSON ${kind.shape}`;
    default: return kind.type;
  }
}

/** Parse a command-line value for `key`; throws with a one-line reason when it does not fit. */
export function parseConfigValue(key: string, raw: string): unknown {
  const kind = CONFIG_SCHEMA[key];
  if (!kind) {
    throw new Error(`Unknown key: ${key}. Settable keys: ${Object.keys(CONFIG_SCHEMA).join(", ")}`);
  }
  switch (kind.type) {
    case "boolean":
      if (raw === "true" || raw === "false") return raw === "true";
      throw new Error(`${key} must be true or false`);
    case "integer": {
      const n = Number(raw);
      if (Number.isInteger(n) && n >= 0) return n;
      throw new Error(`${key} must be a non-negative integer (0 disables a limit)`);
    }
    case "enum": {
      const v0 = raw === '""' ? "" : raw;
      const v = key === "personalization" ? (PERSONALIZATION_ALIASES[v0] ?? v0) : v0;
      if (kind.values.includes(v)) return v;
      throw new Error(`${key} must be one of: ${describe(kind)}`);
    }
    case "string":
      return raw === '""' ? "" : raw;
    case "json": {
      let v: unknown;
      try { v = JSON.parse(raw); } catch { throw new Error(`${key} must be ${describe(kind)}`); }
      const ok = kind.shape === "array" ? Array.isArray(v) : !!v && typeof v === "object" && !Array.isArray(v);
      if (!ok) throw new Error(`${key} must be ${describe(kind)}`);
      return v;
    }
  }
}

/** Check a value already in the file; returns the problem or null. */
export function checkConfigValue(key: string, value: unknown): string | null {
  const kind = CONFIG_SCHEMA[key];
  if (!kind) return INTERNAL_KEYS.has(key) || key in DEFAULT_CONFIG ? null : `unknown key "${key}"`;
  const ok =
    kind.type === "boolean" ? typeof value === "boolean"
    : kind.type === "integer" ? Number.isInteger(value) && (value as number) >= 0
    : kind.type === "string" ? typeof value === "string"
    : kind.type === "enum" ? typeof value === "string" && kind.values.includes(value)
    : kind.shape === "array" ? Array.isArray(value)
    : !!value && typeof value === "object" && !Array.isArray(value);
  return ok ? null : `${key} should be ${describe(kind)}, found ${JSON.stringify(value)}`;
}

/** Validate a parsed config file; returns one line per problem. */
export function validateConfig(raw: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    const p = checkConfigValue(k, v);
    if (p) problems.push(p);
  }
  return problems;
}

