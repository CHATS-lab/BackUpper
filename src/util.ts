/**
 * Small shared helpers: the store layout, shell quoting, JSON/JSONL files and
 * JSON extraction from LLM output.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BackupArtifact, SandboxConfig } from "./types.js";

// =============================================================================
// Store layout
// =============================================================================

/**
 * Store layout: where the store lives, how action folders are named and listed,
 * and how an action's metadata.json is read.
 */


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

// =============================================================================
// Shell
// =============================================================================

/**
 * Shell helpers shared by the rules, the restore path and the CLI.
 */


/**
 * POSIX single-quote one argument. By default a word made only of safe characters is
 * returned unquoted; `always` quotes every word (used where stored recovery commands
 * must keep their historical form).
 */
export function quote(s: string, opts: { always?: boolean } = {}): string {
  if (!opts.always) {
    if (s === "") return "''";
    if (/^[A-Za-z0-9_./:=@%+-]+$/.test(s)) return s;
  }
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Expand a leading `~` or `~/` to the home directory. */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** True for device paths that keep no state: /dev/null, the std streams, the tty and /dev/fd/N. */
export function isNullDevice(target: string): boolean {
  return /^\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)$/.test(target);
}

// =============================================================================
// JSON files
// =============================================================================

/**
 * JSON and JSONL file helpers.
 */


/** Parse a JSON file; `fallback` when it is missing or unreadable. */
export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

/** Parse a JSON object file: {} when missing; throws when it is not valid JSON or not an object. */
export function readJsonObject(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file} is not a JSON object`);
  return parsed as Record<string, unknown>;
}

/** Write pretty-printed JSON with a trailing newline, creating the parent directory. */
export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

/** Append one JSON line, creating the parent directory. */
export function appendJsonl(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(value) + "\n", "utf-8");
}

// =============================================================================
// JSON extraction
// =============================================================================

/**
 * JSON-object extraction from noisy LLM output: walks brace depth (respecting
 * string literals) and returns each balanced top-level object that parses.
 */
export function extractJsonObjects(raw: string): unknown[] {
  const out: unknown[] = [];
  if (!raw) return out;
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
    } else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          try {
            out.push(JSON.parse(raw.slice(start, i + 1)));
          } catch {
            /* not valid JSON — skip this block */
          }
          start = -1;
        }
      }
    }
  }
  return out;
}

/**
 * The LAST extracted object satisfying `pred` (the final verdict usually
 * comes after any echoed proposal), else null.
 */
export function extractJsonObject<T = unknown>(
  raw: string,
  pred: (o: unknown) => boolean,
): T | null {
  const objs = extractJsonObjects(raw);
  for (let i = objs.length - 1; i >= 0; i--) {
    if (pred(objs[i])) return objs[i] as T;
  }
  return null;
}
