/**
 * Local dashboard: serves a single page and a JSON API over the project's `.backupper/` store.
 * Built on node:http with no dependencies; listens on 127.0.0.1 only and refuses requests whose
 * Host or Origin is not the loopback address it serves.
 *
 *   GET  /api/actions                 action summaries
 *   GET  /api/actions/:seq/diff       snapshot of :seq vs the current workspace
 *   GET  /api/actions/:a/diff/:b      snapshot :a vs snapshot :b
 *   GET  /api/status                  counts and effective settings
 *   GET  /api/config, POST /api/config
 *   GET  /api/storage-by-file         backed-up bytes per file
 *   GET  /api/file?path=<rel>         current content of a workspace file
 *   GET  /api/experiences             per-MCP-server capture playbooks
 *   GET  /api/restore-history         restore ledger
 *   GET  /api/restore/:seq/preview    dry run of a restore
 *   POST /api/restore/:seq            restore ({mode: "direct" | "loop", file?})
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { SandboxConfig } from "../types.js";
import { loadConfig, saveConfig } from "../config/load.js";
import { checkConfigValue, CONFIG_SCHEMA } from "../config/schema.js";
import { experiencesDir } from "../explore/experiences.js";
import { resolveRunner, subagentModelFor } from "../backup/runner_caps.js";
import { dirSize } from "../backup/strategies.js";
import { installedAdapters } from "../agents/index.js";
import { listActionSummaries, resolveAction } from "../view/actions.js";

const DEFAULT_PORT = 7321;

function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pkgRoot: string,
): boolean {
  // Map / → index.html
  let reqPath = req.url ?? "/";
  if (reqPath === "/") reqPath = "/index.html";

  // Security: strip query, reject path traversal
  reqPath = reqPath.split("?")[0];
  if (reqPath.includes("..")) {
    res.writeHead(400);
    res.end("bad request");
    return true;
  }

  const staticDir = path.join(pkgRoot, "dashboard", "static");
  const filePath = path.join(staticDir, reqPath);

  if (!filePath.startsWith(staticDir)) {
    res.writeHead(400);
    res.end("bad request");
    return true;
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return false;
  }

  const ext = path.extname(filePath);
  const ctype = ext === ".html" ? "text/html; charset=utf-8"
    : ext === ".js" ? "application/javascript; charset=utf-8"
      : ext === ".css" ? "text/css; charset=utf-8"
        : "application/octet-stream";

  res.writeHead(200, { "content-type": ctype });
  res.end(fs.readFileSync(filePath));
  return true;
}

// ── API handlers ─────────────────────────────────────────────────────

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function handleGetActions(res: http.ServerResponse, config: SandboxConfig, projectRoot: string): void {
  jsonResponse(res, 200, { actions: listActionSummaries(config, projectRoot) });
}

function handleGetConfig(res: http.ServerResponse, config: SandboxConfig): void {
  jsonResponse(res, 200, config);
}

function handlePostConfig(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  projectRoot: string,
): void {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf-8");
    let updates: Record<string, unknown>;
    try {
      updates = JSON.parse(raw);
    } catch {
      jsonResponse(res, 400, { error: "invalid JSON" });
      return;
    }

    if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
      jsonResponse(res, 400, { error: "expected a JSON object" });
      return;
    }
    for (const [k, v] of Object.entries(updates)) {
      const problem = k in CONFIG_SCHEMA ? checkConfigValue(k, v) : `${k} is not a settable key`;
      if (problem) {
        jsonResponse(res, 400, { error: problem });
        return;
      }
    }
    try {
      saveConfig(updates as Partial<SandboxConfig>, projectRoot);
      jsonResponse(res, 200, { saved: true, config: loadConfig(projectRoot) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      jsonResponse(res, 500, { error: `save failed: ${msg}` });
    }
  });
}

function handleGetStatus(res: http.ServerResponse, config: SandboxConfig, projectRoot: string): void {
  const root = path.resolve(config.backupDir);
  let actionCount = 0;
  let totalBytes = 0;
  if (fs.existsSync(root)) {
    const dirs = fs.readdirSync(root).filter((d: string) => d.startsWith("action_"));
    actionCount = dirs.length;
    for (const d of dirs) totalBytes += dirSize(path.join(root, d));
  }
  let session: { id: string | null; prompt: string | null; ts: string | null } | null = null;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(path.dirname(root), "session.json"), "utf-8"));
    session = {
      id: typeof j.session_id === "string" ? j.session_id : null,
      prompt: typeof j.prompt === "string" ? j.prompt : null,
      ts: typeof j.ts === "string" ? j.ts : null,
    };
  } catch { /* no session recorded */ }
  jsonResponse(res, 200, {
    enabled: config.enabled,
    mode: config.mode,
    actionCount,
    maxActions: config.maxActions,
    maxTotalSizeMB: config.maxTotalSizeMB,
    maxAgeHours: config.maxAgeHours,
    totalSizeBytes: totalBytes,
    subagentEnabled: config.subagentEnabled,
    subagentRunner: resolveRunner(config),
    subagentModel: subagentModelFor(config, resolveRunner(config)),
    subagentPermissionMode: config.subagentPermissionMode,
    projectName: path.basename(projectRoot),
    projectRoot,
    agents: installedAdapters(projectRoot).map((a) => a.name),
    session,
  });
}

/**
 * GET /api/storage-by-file — a reference table of how much backup space
 * each backed-up file occupies, sorted by size descending.
 *
 * Honest accounting: the per-action folder is tiny metadata, so the
 * real bytes live in (a) the shared git shadow repo as blobs — queried
 * with `git ls-tree -l` for the latest snapshot, and (b) per-action
 * trash/ dirs for tier-1 rm→trash files. We report the logical
 * (uncompressed) blob size per file — what one snapshot of that file
 * costs — plus how many actions touched it.
 */
function handleGetStorageByFile(
  res: http.ServerResponse,
  config: SandboxConfig,
): void {
  const backupRoot = path.resolve(config.backupDir);
  // file path (workspace-relative) → { bytes, kind, actions:Set<seq> }
  const files = new Map<string, { bytes: number; kind: string; actions: Set<number> }>();

  const bump = (p: string, bytes: number, kind: string, seq?: number): void => {
    const cur = files.get(p) ?? { bytes: 0, kind, actions: new Set<number>() };
    // Keep the largest observed size for the file (its heaviest snapshot).
    if (bytes > cur.bytes) { cur.bytes = bytes; cur.kind = kind; }
    if (typeof seq === "number") cur.actions.add(seq);
    files.set(p, cur);
  };

  if (!fs.existsSync(backupRoot)) {
    jsonResponse(res, 200, { files: [], totalBytes: 0, shadowOnDiskBytes: 0 });
    return;
  }

  // (a) Latest snapshot blob sizes from the shared shadow repo.
  const shadowDir = path.join(path.dirname(backupRoot), "shadow-repo");
  let shadowOnDiskBytes = 0;
  if (fs.existsSync(shadowDir)) {
    try {
      shadowOnDiskBytes = dirSize(shadowDir);
    } catch { /* */ }
    try {
      const env = { ...process.env, GIT_DIR: shadowDir };
      const opts = { encoding: "utf-8" as const, timeout: 10_000, env, stdio: "pipe" as const };
      // `git ls-tree -r -l HEAD` → lines: "<mode> blob <hash> <size>\t<path>"
      const out = execSync("git ls-tree -r -l HEAD", opts).toString();
      for (const line of out.split("\n")) {
        const m = line.match(/^\S+\s+blob\s+\S+\s+(\d+)\t(.+)$/);
        if (m) bump(m[2], parseInt(m[1], 10), "snapshot");
      }
    } catch { /* no HEAD yet / empty repo */ }
  }

  // (b) tier-1 trash files (rm→trash) — these were deleted from the
  //     workspace so they're not in the snapshot tree.
  const walk = (dir: string, rel: string, cb: (relPath: string, bytes: number) => void): void => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r, cb);
      else {
        try { cb(r, fs.statSync(abs).size); } catch { /* */ }
      }
    }
  };
  // Trash filenames are encoded as `<id>_<abspath with / → __>`
  // (see policy_rules.ts). Decode back to a readable path.
  const decodeTrashName = (name: string): string => {
    const stripped = name.replace(/^[0-9a-f]+_/, "");      // drop id prefix
    return "/" + stripped.replace(/__/g, "/");             // __ → /
  };
  for (const d of fs.readdirSync(backupRoot).filter((x) => x.startsWith("action_"))) {
    const seq = parseInt(d.split("_")[1] ?? "0", 10);
    const trash = path.join(backupRoot, d, "trash");
    if (fs.existsSync(trash)) {
      walk(trash, "", (relPath, bytes) => bump(decodeTrashName(relPath), bytes, "deleted", seq));
    }
  }

  const list = [...files.entries()]
    .map(([file, v]) => ({ file, bytes: v.bytes, kind: v.kind, actionCount: v.actions.size }))
    .sort((a, b) => b.bytes - a.bytes);
  const totalBytes = list.reduce((s, x) => s + x.bytes, 0);

  jsonResponse(res, 200, { files: list, totalBytes, shadowOnDiskBytes });
}

function handlePostRestore(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: SandboxConfig,
  projectRoot: string,
  seq: number,
): void {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", async () => {
    const raw = Buffer.concat(chunks).toString("utf-8");
    let body: { mode?: string; file?: string } = {};
    if (raw.trim()) {
      try { body = JSON.parse(raw); }
      catch { jsonResponse(res, 400, { error: "invalid JSON" }); return; }
    }
    const mode = body.mode === "loop" ? "loop" : "direct";
    // Optional single-file restore (direct mode only). Reject path
    // traversal — the path must be workspace-relative.
    let fileOnly: string | undefined;
    if (typeof body.file === "string" && body.file.trim()) {
      const f = body.file.trim();
      if (path.isAbsolute(f) || f.split(/[/\\]/).includes("..")) {
        jsonResponse(res, 400, { error: "file must be a workspace-relative path" });
        return;
      }
      fileOnly = f;
    }

    // Find the action folder with this seq.
    const backupRoot = path.resolve(config.backupDir);
    if (!fs.existsSync(backupRoot)) {
      jsonResponse(res, 404, { error: "no backups directory" });
      return;
    }
    const seqStr = String(seq).padStart(3, "0");
    const match = fs.readdirSync(backupRoot)
      .find((d: string) => d.startsWith(`action_${seqStr}_`));
    if (!match) {
      jsonResponse(res, 404, { error: `action #${seq} not found` });
      return;
    }

    try {
      // Lazy import — restore depends on subagent which depends on
      // child_process, keep it out of the dashboard hot path.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const restore = require("../restore/restore.js");
      // Run restore from projectRoot — chdir for the duration of the call.
      const prevCwd = process.cwd();
      process.chdir(projectRoot);
      let results;
      try {
        results = fileOnly
          ? await restore.restoreActionDirect(match, config, { fileOnly })
          : mode === "loop"
            ? await restore.restoreActionLoop(match, config)
            : await restore.restoreActionDirect(match, config);
      } finally {
        process.chdir(prevCwd);
      }
      jsonResponse(res, 200, { ok: true, mode: fileOnly ? "file" : mode, action: match, results });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      jsonResponse(res, 500, { error: `restore failed: ${msg.slice(0, 500)}` });
    }
  });
}

function handleGetDiff(
  res: http.ServerResponse,
  config: SandboxConfig,
  projectRoot: string,
  seq: number,
): void {
  const backupRoot = path.resolve(config.backupDir);
  const seqStr = String(seq).padStart(3, "0");
  const match = fs.existsSync(backupRoot)
    ? fs.readdirSync(backupRoot).find((d: string) => d.startsWith(`action_${seqStr}_`))
    : undefined;
  if (!match) {
    jsonResponse(res, 404, { error: `action #${seq} not found` });
    return;
  }
  const actionDir = path.join(backupRoot, match);
  const meta = path.join(actionDir, "metadata.json");
  if (!fs.existsSync(meta)) {
    jsonResponse(res, 200, { diff: "", stat: "", note: "no metadata.json" });
    return;
  }
  let artifacts: Array<Record<string, unknown>> = [];
  try {
    artifacts = JSON.parse(fs.readFileSync(meta, "utf-8")) as Array<Record<string, unknown>>;
  } catch { /* */ }

  // ── Remote state (tier-4 subagent for MCP writes) ──────────────────
  // Surface remote-state.json + the subagent's recorded recovery plan
  // so MCP-write actions don't look empty in the dashboard.
  let remoteState: unknown = undefined;
  let subagent: { description?: string; recovery: string[]; liveRestore?: boolean } | undefined;
  try {
    const remotePath = path.join(actionDir, "remote-state.json");
    if (fs.existsSync(remotePath)) {
      remoteState = JSON.parse(fs.readFileSync(remotePath, "utf-8"));
    }
  } catch { /* */ }
  try {
    const subFile = fs.existsSync(actionDir)
      ? fs.readdirSync(actionDir).find((f: string) => /^subagent_.*\.json$/.test(f))
      : undefined;
    if (subFile) {
      const j = JSON.parse(fs.readFileSync(path.join(actionDir, subFile), "utf-8")) as Record<string, unknown>;
      subagent = {
        description: typeof j.description === "string" ? j.description : undefined,
        recovery: Array.isArray(j.recovery_commands) ? (j.recovery_commands as string[]) : [],
        liveRestore: j.live_restore === true,
      };
    } else {
      // Fall back to subagent artifact embedded in metadata.json
      const subMeta = artifacts.find((a) => a.strategy === "subagent");
      if (subMeta) {
        subagent = {
          description: typeof subMeta.description === "string" ? subMeta.description : undefined,
          recovery: Array.isArray(subMeta.subagentCommands) ? (subMeta.subagentCommands as string[]) : [],
          liveRestore: subMeta.liveRestore === true,
        };
      }
    }
  } catch { /* */ }

  // ── Workspace diff (tier-3 git_snapshot) ──────────────────────────
  // MCP-only actions may have no git_snapshot — that's expected, just
  // return empty diff and let the frontend render subagent/remote
  // sections instead.
  const snapshot = artifacts.find((a) => a.strategy === "git_snapshot");
  let diff = "";
  let stat = "";
  let diffNote: string | undefined;
  if (snapshot) {
    const commit = String(snapshot.commitHash ?? snapshot.id ?? "");
    const shadowDir = String(snapshot.artifactPath ?? "");
    if (commit && fs.existsSync(shadowDir)) {
      try {
        const env = { ...process.env, GIT_DIR: shadowDir, GIT_WORK_TREE: projectRoot };
        const opts = { encoding: "utf-8" as const, timeout: 10_000, env, cwd: projectRoot, stdio: "pipe" as const };
        execSync("git add -A", opts);
        stat = execSync(`git diff --cached --stat ${commit}`, opts).toString().trim();
        diff = execSync(`git diff --cached --no-color ${commit}`, opts).toString().slice(0, 200_000);
        execSync("git reset --quiet", opts);
      } catch (e: unknown) {
        diffNote = `diff failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`;
      }
    } else {
      diffNote = "shadow repo missing";
    }
  } else {
    diffNote = "no git_snapshot (remote-only action)";
  }

  // ── Tier-1 command rewriting: original vs revised action ──────────────
  // Surface what the rm/chmod was rewritten to (the reversible
  // equivalent) and how restore reverses it.
  let policyRewrite:
    | { original: string; description: string; recovery: string[]; trashPath: string; backupOnly: boolean }
    | undefined;
  const pr = artifacts.find((a) => a.strategy === "policy_rewrite");
  if (pr) {
    policyRewrite = {
      original: typeof pr.originalAction === "string" ? pr.originalAction : "",
      description: typeof pr.description === "string" ? pr.description : "",
      recovery: Array.isArray(pr.recoveryCommands) ? (pr.recoveryCommands as string[]) : [],
      trashPath: typeof pr.artifactPath === "string" ? pr.artifactPath : "",
      backupOnly: pr.backupOnly === true,
    };
  }

  jsonResponse(res, 200, { diff, stat, note: diffNote, remoteState, subagent, policyRewrite });
}

// ── Server ───────────────────────────────────────────────────────────

/** Find an action folder by sequence number, or null. */
function findActionDir(config: SandboxConfig, seq: number): string | null {
  return resolveAction(config, String(seq));
}

function readArtifacts(config: SandboxConfig, dirName: string): Array<Record<string, unknown>> {
  try {
    const meta = path.join(path.resolve(config.backupDir), dirName, "metadata.json");
    const parsed = JSON.parse(fs.readFileSync(meta, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Recovery commands recorded on an action's artifacts (T1 + T4). */
function artifactCommands(artifacts: Array<Record<string, unknown>>): string[] {
  const out: string[] = [];
  for (const a of artifacts) {
    if (Array.isArray(a.recoveryCommands)) out.push(...(a.recoveryCommands as string[]));
    if (Array.isArray(a.subagentCommands)) out.push(...(a.subagentCommands as string[]));
  }
  return out;
}

/**
 * GET /api/restore/:seq/preview — dry-run: what WOULD a restore touch?
 *   direct: files that differ between the action's snapshot and the
 *           current workspace (numstat), plus recorded recovery commands.
 *   loop:   the chain of actions that would be undone, newest → target,
 *           with each step's strategies and command count.
 * Nothing is mutated.
 */
function handleGetRestorePreview(
  res: http.ServerResponse,
  config: SandboxConfig,
  projectRoot: string,
  seq: number,
): void {
  const match = findActionDir(config, seq);
  if (!match) {
    jsonResponse(res, 404, { error: `action #${seq} not found` });
    return;
  }
  const artifacts = readArtifacts(config, match);

  // Direct: numstat vs the snapshot commit.
  const files: Array<{ file: string; plus: number; minus: number }> = [];
  let directNote: string | undefined;
  const snapshot = artifacts.find((a) => a.strategy === "git_snapshot");
  if (snapshot) {
    const commit = String(snapshot.commitHash ?? snapshot.id ?? "");
    const shadowDir = String(snapshot.artifactPath ?? "");
    if (commit && fs.existsSync(shadowDir)) {
      try {
        const env = { ...process.env, GIT_DIR: shadowDir, GIT_WORK_TREE: projectRoot };
        const opts = { encoding: "utf-8" as const, timeout: 10_000, env, cwd: projectRoot, stdio: "pipe" as const };
        execSync("git add -A", opts);
        const numstat = execSync(`git diff --cached --numstat ${commit}`, opts).toString();
        execSync("git reset --quiet", opts);
        for (const line of numstat.split("\n")) {
          const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
          if (m) files.push({ file: m[3], plus: m[1] === "-" ? 0 : parseInt(m[1], 10), minus: m[2] === "-" ? 0 : parseInt(m[2], 10) });
        }
      } catch (e: unknown) {
        directNote = `preview failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`;
      }
    } else {
      directNote = "shadow repo missing";
    }
  } else {
    directNote = "no workspace snapshot (remote/T1-only action)";
  }
  const directCommands = artifactCommands(artifacts);

  // Loop: every action from the newest down to the target, in undo order.
  const backupRoot = path.resolve(config.backupDir);
  const dirs = fs.existsSync(backupRoot)
    ? fs.readdirSync(backupRoot).filter((d: string) => /^action_\d+_/.test(d)).sort().reverse()
    : [];
  const steps: Array<{ seq: number; name: string; strategies: string[]; commands: number }> = [];
  for (const d of dirs) {
    const m = d.match(/^action_(\d+)_/);
    const dSeq = m ? parseInt(m[1], 10) : -1;
    if (dSeq < seq) break;
    const arts = readArtifacts(config, d);
    steps.push({
      seq: dSeq,
      name: d,
      strategies: [...new Set(arts.map((a) => String(a.strategy ?? "?")))],
      commands: artifactCommands(arts).length,
    });
  }

  jsonResponse(res, 200, {
    direct: { files, commands: directCommands, note: directNote },
    loop: { steps },
  });
}

/** GET /api/restore-history — the restore ledger, newest first. */
function handleGetRestoreHistory(res: http.ServerResponse, config: SandboxConfig): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readRestoreHistory } = require("../restore/restore.js");
    jsonResponse(res, 200, { entries: readRestoreHistory(config) });
  } catch (e) {
    jsonResponse(res, 500, { error: String(e instanceof Error ? e.message : e) });
  }
}

/**
 * GET /api/actions/:a/diff/:b — diff between two actions' snapshots
 * (older → newer), i.e. "what changed between #a and #b".
 */
function handleGetCompare(
  res: http.ServerResponse,
  config: SandboxConfig,
  projectRoot: string,
  seqA: number,
  seqB: number,
): void {
  const [lo, hi] = seqA <= seqB ? [seqA, seqB] : [seqB, seqA];
  const dirA = findActionDir(config, lo);
  const dirB = findActionDir(config, hi);
  if (!dirA || !dirB) {
    jsonResponse(res, 404, { error: `action #${!dirA ? lo : hi} not found` });
    return;
  }
  const snapA = readArtifacts(config, dirA).find((a) => a.strategy === "git_snapshot");
  const snapB = readArtifacts(config, dirB).find((a) => a.strategy === "git_snapshot");
  if (!snapA || !snapB) {
    jsonResponse(res, 200, { diff: "", stat: "", a: lo, b: hi, note: `action #${!snapA ? lo : hi} has no workspace snapshot to compare` });
    return;
  }
  const commitA = String(snapA.commitHash ?? snapA.id ?? "");
  const commitB = String(snapB.commitHash ?? snapB.id ?? "");
  const shadowDir = String(snapA.artifactPath ?? "");
  if (!commitA || !commitB || !fs.existsSync(shadowDir)) {
    jsonResponse(res, 200, { diff: "", stat: "", a: lo, b: hi, note: "shadow repo or commit missing" });
    return;
  }
  try {
    const env = { ...process.env, GIT_DIR: shadowDir, GIT_WORK_TREE: projectRoot };
    const opts = { encoding: "utf-8" as const, timeout: 10_000, env, cwd: projectRoot, stdio: "pipe" as const };
    const stat = execSync(`git diff --stat --no-color ${commitA} ${commitB}`, opts).toString().trim();
    const diff = execSync(`git diff --no-color ${commitA} ${commitB}`, opts).toString().slice(0, 200_000);
    jsonResponse(res, 200, { diff, stat, a: lo, b: hi });
  } catch (e: unknown) {
    jsonResponse(res, 200, { diff: "", stat: "", a: lo, b: hi, note: `compare failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}` });
  }
}

/**
 * GET /api/file?path=<rel> — current content of a workspace file, for
 * the dashboard's click-to-view. Path must stay inside the project
 * root; binary-ish files and oversize content are handled gracefully.
 */
function handleGetFile(
  res: http.ServerResponse,
  projectRoot: string,
  relPath: string,
): void {
  if (!relPath || path.isAbsolute(relPath) || relPath.split(/[/\\]/).includes("..")) {
    jsonResponse(res, 400, { error: "path must be workspace-relative" });
    return;
  }
  const abs = path.resolve(projectRoot, relPath);
  if (!abs.startsWith(path.resolve(projectRoot) + path.sep)) {
    jsonResponse(res, 400, { error: "path escapes the workspace" });
    return;
  }
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) {
      jsonResponse(res, 400, { error: "not a regular file" });
      return;
    }
    const CAP = 256 * 1024;
    const fd = fs.openSync(abs, "r");
    const buf = Buffer.alloc(Math.min(st.size, CAP));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    // Crude binary sniff: NUL byte in the first 8KB.
    if (buf.subarray(0, 8192).includes(0)) {
      jsonResponse(res, 200, { path: relPath, content: `(binary file, ${st.size} bytes — not displayed)`, size: st.size, truncated: false });
      return;
    }
    jsonResponse(res, 200, {
      path: relPath,
      content: buf.toString("utf-8"),
      size: st.size,
      truncated: st.size > CAP,
    });
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException).code;
    jsonResponse(res, 404, {
      error: code === "ENOENT"
        ? "file not found in the current workspace (it may have been deleted — restore the action to bring it back)"
        : `read failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

/** GET /api/experiences: the capture playbooks in `.backupper/experiences/`. */
function handleGetExperiences(res: http.ServerResponse, config: SandboxConfig): void {
  const dir = experiencesDir(config);
  const servers: unknown[] = [];
  try {
    for (const f of fs.readdirSync(dir).filter((x: string) => x.endsWith(".json"))) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
        if (data && Array.isArray(data.patterns)) servers.push(data);
      } catch { /* skip a corrupt file */ }
    }
  } catch { /* no experiences directory */ }
  jsonResponse(res, 200, { servers });
}

/** Loopback host names the server answers to. */
function isLoopbackHost(value: string | undefined, port: number): boolean {
  if (!value) return false;
  let host = value;
  try { host = new URL(value.includes("://") ? value : `http://${value}`).host; } catch { return false; }
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host);
}

export function startDashboard(options: {
  projectRoot: string;
  port?: number;
  pkgRoot: string;
  /** If true, try subsequent ports when the preferred one is busy. Default: true when no explicit port. */
  autoPort?: boolean;
  /** Max number of port candidates to try when autoPort is on. Default: 10. */
  maxPortAttempts?: number;
}): Promise<{ port: number; close: () => void }> {
  const requestedPort = options.port ?? DEFAULT_PORT;
  const autoPort = options.autoPort ?? options.port === undefined;
  const maxAttempts = options.maxPortAttempts ?? 10;
  const projectRoot = options.projectRoot;

  const server = http.createServer((req, res) => {
    // Only allow local connections for safety
    const remote = req.socket.remoteAddress ?? "";
    if (!remote.includes("127.0.0.1") && !remote.includes("::1") && remote !== "::ffff:127.0.0.1") {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }

    // Reject DNS-rebinding and cross-site requests.
    const port = (server.address() as { port?: number } | null)?.port ?? 0;
    const origin = req.headers.origin;
    if (!isLoopbackHost(req.headers.host, port) || (origin && !isLoopbackHost(origin, port))) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }

    const url = req.url ?? "/";
    const method = req.method ?? "GET";
    if (method === "POST" && !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
      res.writeHead(415);
      res.end("expected application/json");
      return;
    }
    const config = loadConfig(projectRoot);

    // API routes
    if (url === "/api/actions" && method === "GET") {
      handleGetActions(res, config, projectRoot);
      return;
    }
    if (url === "/api/config" && method === "GET") {
      handleGetConfig(res, config);
      return;
    }
    if (url === "/api/config" && method === "POST") {
      handlePostConfig(req, res, projectRoot);
      return;
    }
    if (url === "/api/status" && method === "GET") {
      handleGetStatus(res, config, projectRoot);
      return;
    }
    if (url === "/api/storage-by-file" && method === "GET") {
      handleGetStorageByFile(res, config);
      return;
    }
    const fileMatch = url.match(/^\/api\/file\?path=(.+)$/);
    if (fileMatch && method === "GET") {
      handleGetFile(res, projectRoot, decodeURIComponent(fileMatch[1]));
      return;
    }
    if (url === "/api/experiences" && method === "GET") {
      handleGetExperiences(res, config);
      return;
    }

    if (url === "/api/restore-history" && method === "GET") {
      handleGetRestoreHistory(res, config);
      return;
    }

    // POST /api/restore/:seq — body: { "mode": "direct" | "loop", "file"?: string }
    const restoreMatch = url.match(/^\/api\/restore\/(\d+)$/);
    if (restoreMatch && method === "POST") {
      handlePostRestore(req, res, config, projectRoot, parseInt(restoreMatch[1], 10));
      return;
    }

    // GET /api/restore/:seq/preview — dry-run, nothing mutated
    const previewMatch = url.match(/^\/api\/restore\/(\d+)\/preview$/);
    if (previewMatch && method === "GET") {
      handleGetRestorePreview(res, config, projectRoot, parseInt(previewMatch[1], 10));
      return;
    }

    // GET /api/actions/:seq/diff  — return git diff against current state
    const diffMatch = url.match(/^\/api\/actions\/(\d+)\/diff$/);
    if (diffMatch && method === "GET") {
      handleGetDiff(res, config, projectRoot, parseInt(diffMatch[1], 10));
      return;
    }

    // GET /api/actions/:a/diff/:b — diff between two snapshots
    const cmpMatch = url.match(/^\/api\/actions\/(\d+)\/diff\/(\d+)$/);
    if (cmpMatch && method === "GET") {
      handleGetCompare(res, config, projectRoot, parseInt(cmpMatch[1], 10), parseInt(cmpMatch[2], 10));
      return;
    }

    // Static files
    if (method === "GET") {
      if (serveStatic(req, res, options.pkgRoot)) return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryListen = (port: number): void => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener("listening", onListening);
        if (err.code === "EADDRINUSE" && autoPort && attempt < maxAttempts - 1) {
          attempt++;
          tryListen(port + 1);
          return;
        }
        if (err.code === "EADDRINUSE") {
          const hint = autoPort
            ? `tried ${requestedPort}–${requestedPort + attempt}, all busy`
            : `port ${port} is already in use (another dashboard, or a different process)`;
          reject(new Error(`Could not start dashboard: ${hint}. ` +
            `Pass --port <N> to pick a different port, or stop the other process.`));
          return;
        }
        reject(err);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve({
          port,
          close: () => server.close(),
        });
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    };
    tryListen(requestedPort);
  });
}
