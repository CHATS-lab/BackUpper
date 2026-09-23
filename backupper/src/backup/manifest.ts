/**
 * Backup manifest — reads action folders to list all backup artifacts.
 * No separate manifest.json needed — metadata.json inside each action
 * folder is the source of truth.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { BackupArtifact, SandboxConfig } from "../types.js";

/**
 * List all action folders (sorted oldest → newest).
 */
export function listActions(config: SandboxConfig): string[] {
  const backupRoot = path.resolve(config.backupDir);
  if (!fs.existsSync(backupRoot)) return [];
  return fs
    .readdirSync(backupRoot)
    .filter((d) => d.startsWith("action_"))
    .sort();
}

/**
 * Load all backup artifacts across all action folders.
 */
export function loadManifest(config: SandboxConfig): BackupArtifact[] {
  const backupRoot = path.resolve(config.backupDir);
  const dirs = listActions(config);
  const all: BackupArtifact[] = [];

  for (const dir of dirs) {
    const metaPath = path.join(backupRoot, dir, "metadata.json");
    if (fs.existsSync(metaPath)) {
      try {
        const entries = JSON.parse(
          fs.readFileSync(metaPath, "utf-8")
        ) as BackupArtifact[];
        all.push(...entries);
      } catch {
        // skip corrupt metadata
      }
    }
  }

  return all;
}

/**
 * No-op for compatibility — artifacts are now written directly by strategies.ts
 * into the action folder's metadata.json.
 */
export function appendToManifest(
  _artifact: BackupArtifact,
  _config: SandboxConfig
): void {
  // Handled by writeMetadata() in strategies.ts
}
