/**
 * Backup manifest: lists backup artifacts from each action folder's metadata.json.
 */

import * as path from "node:path";
import type { BackupArtifact, SandboxConfig } from "../types.js";
import { actionDirs, backupRoot, readActionArtifacts } from "../util.js";

/**
 * List all action folders (sorted oldest → newest).
 */
export function listActions(config: SandboxConfig): string[] {
  return actionDirs(config);
}

/**
 * Load all backup artifacts across all action folders.
 */
export function loadManifest(config: SandboxConfig): BackupArtifact[] {
  const root = backupRoot(config);
  return actionDirs(config).flatMap((dir) => readActionArtifacts(path.join(root, dir)));
}

/** No-op: strategies.ts writes artifacts into each folder's metadata.json. */
export function appendToManifest(
  _artifact: BackupArtifact,
  _config: SandboxConfig
): void {
  // Handled by writeMetadata() in strategies.ts
}
