/**
 * File metadata that git does not keep: permission bits beyond the executable bit, owners,
 * and empty directories. A manifest is recorded next to a snapshot when it is taken and
 * reapplied after the snapshot is checked out, so a restore puts back 0600/0640 files,
 * foreign owners and empty directories as they were.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";

/** One entry: path relative to the manifest root (or absolute), type, mode bits, owner. */
export interface MetaEntry {
  p: string;
  /** f = file, d = directory, l = symlink (mode not applied). */
  t: "f" | "d" | "l";
  mode: number;
  uid: number;
  gid: number;
}

export interface TreeMeta {
  version: 1;
  /** Directory the relative paths resolve against. */
  root: string;
  entries: MetaEntry[];
  /** Directories that were empty at snapshot time (relative), recreated on restore. */
  emptyDirs: string[];
  /** The project's own `git stash list` (commit ids, newest first), when the root is a git repo. */
  stash?: string[];
}

/** Largest manifest recorded; bigger trees keep git's default modes on restore. */
const MAX_META_ENTRIES = 100_000;

function entryFor(abs: string, rel: string): MetaEntry | null {
  try {
    const st = fs.lstatSync(abs);
    const t = st.isSymbolicLink() ? "l" : st.isDirectory() ? "d" : "f";
    return { p: rel, t, mode: st.mode & 0o7777, uid: st.uid, gid: st.gid };
  } catch {
    return null;
  }
}

/**
 * Record modes and owners of `files` (relative to `root`) and of every directory that holds
 * them, plus the listed empty directories. Returns null past the size cap.
 */
export function recordTreeMeta(root: string, files: string[], emptyDirs: string[]): TreeMeta | null {
  if (files.length + emptyDirs.length > MAX_META_ENTRIES) return null;
  const entries: MetaEntry[] = [];
  const dirs = new Set<string>();
  for (const rel of files) {
    const e = entryFor(path.join(root, rel), rel);
    if (e) entries.push(e);
    let d = path.dirname(rel);
    while (d && d !== "." && !dirs.has(d)) {
      dirs.add(d);
      d = path.dirname(d);
    }
  }
  const empties: string[] = [];
  for (const raw of emptyDirs) {
    const rel = raw.replace(/\/+$/, "");
    if (!rel) continue;
    empties.push(rel);
    let d: string = rel;
    while (d && d !== "." && !dirs.has(d)) {
      dirs.add(d);
      d = path.dirname(d);
    }
  }
  for (const d of dirs) {
    const e = entryFor(path.join(root, d), d);
    if (e && e.t === "d") entries.push(e);
  }
  return { version: 1, root, entries, emptyDirs: empties };
}

/**
 * Put back the recorded modes and owners (and recreate recorded empty directories) for the
 * entries whose path passes `only`. Symlinks are left alone: chmod would follow them.
 * Returns the number of entries changed and the paths that could not be changed.
 */
export function applyTreeMeta(
  meta: TreeMeta,
  only?: (rel: string) => boolean,
): { changed: number; failed: string[] } {
  let changed = 0;
  const failed: string[] = [];
  for (const rel of meta.emptyDirs ?? []) {
    if (only && !only(rel)) continue;
    const abs = path.resolve(meta.root, rel);
    try {
      if (!fs.existsSync(abs)) { fs.mkdirSync(abs, { recursive: true }); changed++; }
    } catch { failed.push(rel); }
  }
  // Files first, then directories deepest first, so a directory made read-only last does not
  // block the entries inside it.
  const ordered = [...meta.entries].sort((a, b) =>
    (a.t === "d" ? 1 : 0) - (b.t === "d" ? 1 : 0) || b.p.length - a.p.length);
  for (const e of ordered) {
    if (e.t === "l") continue;
    if (only && !only(e.p)) continue;
    const abs = path.resolve(meta.root, e.p);
    let st: fs.Stats;
    try { st = fs.lstatSync(abs); } catch { continue; }   // gone: nothing to fix
    if (st.isSymbolicLink()) continue;
    if ((st.isDirectory() ? "d" : "f") !== e.t) continue;
    try {
      if (st.uid !== e.uid || st.gid !== e.gid) { fs.chownSync(abs, e.uid, e.gid); changed++; }
    } catch { failed.push(e.p); }
    try {
      // chown may clear setuid/setgid bits, so the mode is applied after it.
      const cur = fs.lstatSync(abs).mode & 0o7777;
      if (cur !== e.mode) { fs.chmodSync(abs, e.mode); changed++; }
    } catch { failed.push(e.p); }
  }
  return { changed, failed: [...new Set(failed)] };
}

export function writeTreeMeta(file: string, meta: TreeMeta): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(meta) + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}

export function readTreeMeta(file: string | undefined): TreeMeta | null {
  if (!file) return null;
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf-8"));
    return v && Array.isArray(v.entries) && typeof v.root === "string" ? (v as TreeMeta) : null;
  } catch {
    return null;
  }
}

/** Short stable hash of a string, used to keep generated file names distinct per target. */
export function shortHash(s: string, n = 10): string {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, n);
}

/** Process-wide counter appended to generated names, so two captures in one call never meet. */
let nameSeq = 0;
export function nextNameSeq(): number {
  return ++nameSeq;
}

/**
 * A capture file name that is unique per target path: a readable, sanitised tail of the path
 * plus a hash of the full path and a per-process sequence number. Sanitising (`a b` vs `a_b`)
 * or truncating long paths can no longer make two targets share a name.
 */
export function uniqueCaptureName(prefix: string, target: string, maxReadable = 80): string {
  const readable = target.replace(/^\/+/, "").replace(/[^A-Za-z0-9._-]/g, "_").slice(-maxReadable) || "item";
  return `${prefix}-${shortHash(target)}-${Date.now().toString(36)}${nextNameSeq()}-${readable}`;
}

// ── Tier-4 external-shadow repositories ─────────────────────────────

export interface ExternalShadowSpec {
  gitDir: string;
  workTree: string;
  commit: string;
}

/** Strip one level of shell quoting from a word. */
function unquote(w: string): string {
  if ((w.startsWith("'") && w.endsWith("'")) || (w.startsWith('"') && w.endsWith('"'))) {
    return w.slice(1, -1).replace(/'\\''/g, "'");
  }
  return w;
}

/**
 * Find the external-shadow repository a tier-4 capture restores from: the
 * `GIT_DIR=<…external-shadow…> GIT_WORK_TREE=<root> git read-tree <hash>` recovery the backup
 * prompt prescribes. Returns every distinct (repo, root, commit) found.
 */
export function externalShadowSpecs(commands: string[] | undefined): ExternalShadowSpec[] {
  const out: ExternalShadowSpec[] = [];
  const W = `('(?:[^']|'\\\\'')*'|"[^"]*"|\\S+)`;
  const re = new RegExp(`GIT_DIR=${W}\\s+GIT_WORK_TREE=${W}\\s+git\\s+read-tree\\s+([0-9a-f]{7,64})`, "g");
  for (const c of commands ?? []) {
    for (const m of c.matchAll(re)) {
      const gitDir = unquote(m[1]);
      const workTree = unquote(m[2]);
      if (!/external-shadow/.test(gitDir)) continue;
      if (!out.some((s) => s.gitDir === gitDir && s.workTree === workTree && s.commit === m[3])) {
        out.push({ gitDir, workTree, commit: m[3] });
      }
    }
  }
  return out;
}

/** Files (relative to the work tree) held by an external-shadow commit. */
export function externalShadowFiles(spec: ExternalShadowSpec): string[] {
  try {
    return execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", spec.commit], {
      encoding: "utf-8", timeout: 30_000, stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_DIR: spec.gitDir, GIT_WORK_TREE: spec.workTree },
    }).split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

/** Record the modes/owners of every file each external-shadow commit holds (absolute paths). */
export function recordExternalShadowMeta(commands: string[] | undefined): TreeMeta | null {
  const specs = externalShadowSpecs(commands);
  if (specs.length === 0) return null;
  const entries: MetaEntry[] = [];
  for (const s of specs) {
    for (const rel of externalShadowFiles(s)) {
      const abs = path.resolve(s.workTree, rel);
      const e = entryFor(abs, abs);
      if (e) entries.push(e);
    }
  }
  return entries.length ? { version: 1, root: "/", entries, emptyDirs: [] } : null;
}

/** Current modes/owners of the files the external-shadow commits hold, taken just before a restore. */
export function currentExternalShadowMeta(commands: string[] | undefined): TreeMeta | null {
  return recordExternalShadowMeta(commands);
}
