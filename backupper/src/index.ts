/**
 * CHATS-Sandbox — General-purpose sandbox plugin for Claude Code.
 *
 * Provides backup, policy enforcement, and effect tracking for AI agent tool calls.
 * Integrates via Claude Code's hooks system (PreToolUse + PostToolUse).
 *
 * Usage:
 *   npx chats-sandbox install    # Wire hooks into .claude/settings.json
 *   npx chats-sandbox status     # Check sandbox state
 *   npx chats-sandbox config     # View/edit configuration
 */

export { loadConfig, saveConfig } from "./config/load.js";
export { evaluate } from "./engine/rules.js";
export { runBackup } from "./backup/strategies.js";
export { runSubagentBackup } from "./backup/subagent.js";
export { captureEffect, logEffect } from "./engine/effects.js";
export { loadManifest, appendToManifest } from "./backup/manifest.js";
export { restoreArtifact, restoreActionDirect, restoreActionLoop, listRestorableActions } from "./restore/restore.js";
export type {
  SandboxConfig,
  BackupArtifact,
  EffectEntry,
  HookContext,
  SandboxMode,
} from "./types.js";
export { DEFAULT_CONFIG } from "./types.js";
