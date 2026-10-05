/**
 * Store layout: where the store lives, how action folders are named and listed,
 * and how an action's metadata.json is read.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { BackupArtifact, SandboxConfig } from "../types.js";

/** Absolute directory holding the action folders (`config.backupDir`). */
export function backupRoot(config: Pick<SandboxConfig, "backupDir">): string {
  return path.resolve(config.backupDir);
}

/** Absolute store root: the parent of the backups directory (normally `.backupper/`). */
export function storeRoot(config: Pick<SandboxConfig, "backupDir">): string {
  return path.dirname(backupRoot(config));
}

/** Sequence number of an action folder name (`action_<seq>_<ts>`), or -1. */
export function actionSeq(name: string): number {
  const n = parseInt(name.split("_")[1] ?? "", 10);
  return Number.isNaN(n) ? -1 : n;
}

/**
 * Action folder names under a backups directory, oldest first: sorted numerically by
 * sequence number, ties broken on the full name (the timestamp suffix).
 */
export function actionDirsIn(root: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  return names
    .filter((d) => /^action_\d+(_|$)/.test(d))
    .sort((a, b) => actionSeq(a) - actionSeq(b) || a.localeCompare(b));
}

/** Action folder names for a config, oldest first (see actionDirsIn). */
export function actionDirs(config: Pick<SandboxConfig, "backupDir">): string[] {
  return actionDirsIn(backupRoot(config));
}

/**
 * The artifacts recorded in an action folder's metadata.json. A single object is read as a
 * one-element list; a missing, unreadable or non-object file gives [].
 */
export function readActionArtifacts(actionDir: string): BackupArtifact[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(actionDir, "metadata.json"), "utf-8"));
    if (Array.isArray(parsed)) return parsed as BackupArtifact[];
    return parsed && typeof parsed === "object" ? [parsed as BackupArtifact] : [];
  } catch {
    return [];
  }
}
