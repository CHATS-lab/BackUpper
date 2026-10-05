/**
 * Personalization provenance.
 *
 * For every tool call, the pre-tool hook records what the call is about to touch
 * (`<key>.pending.json`) and the post-tool hook records what actually happened
 * (`<key>.event.json`). Records live in a per-session directory next to the backup
 * store. From that history the checker can tell, per path, whether content existed
 * before the session, where it came from, and which session changes were verified.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {createHash} from 'node:crypto';
import type {HookContext, SandboxConfig} from '../types.js';
import {collectArgumentPaths} from './readonly_checker.js';
import { storeRoot } from "../util.js";

type Ctx = HookContext & {provenance_action_id?: string};

/** Largest file (8 MB) whose content is hashed when observed. */
const MAX_HASHED_FILE_BYTES = 8388608;
/** Largest file (128 KB) an Edit is replayed against to predict its result. */
const MAX_EDIT_EVIDENCE_BYTES = 131072;

const WRITE_TOOLS = ['write', 'writefile', 'filewrite'];
const EDIT_TOOLS = ['edit', 'fileedit'];
const READ_TOOLS = ['read', 'readfile', 'glob', 'grep', 'list'];
const SHELL_TOOLS = ['bash', 'shell'];

/** Only exact argument-only cp/mv forms; no options, quoting, expansion, pipelines or shell wrappers. */
const SIMPLE_COPY_OR_MOVE = /^(cp|mv) ([A-Za-z0-9_./-]+) ([A-Za-z0-9_./-]+)$/;
/** Paths that are known automatic outputs (Python bytecode and pytest caches). */
const KNOWN_AUTOMATIC_PATH = /(?:^|\/)__pycache__\/[^/]+\.pyc$|(?:^|\/)\.pytest_cache\//;

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** The session's provenance directory, or null when the hook carries no session id. */
function provenanceDir(ctx: Ctx, config: SandboxConfig) {
  if (!ctx.session_id) return null;
  return path.join(storeRoot(config), 'provenance', sha256(ctx.session_id));
}

/** The id that pairs a pre-tool record with its post-tool record (the tool_use id). */
function actionId(ctx: Ctx) {
  return ctx.provenance_action_id;
}

/** Existence, size and (for regular files up to 8 MB) content hash of a path. */
function observe(targetPath: string) {
  try {
    const stat = fs.lstatSync(targetPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return {exists: true, hash: null, bytes: stat.size, kind: 'non_regular'};
    }
    const contentHash = stat.size <= MAX_HASHED_FILE_BYTES ? sha256(fs.readFileSync(targetPath)) : null;
    return {exists: true, hash: contentHash, bytes: stat.size, kind: 'file'};
  } catch (e: any) {
    return {exists: e.code === 'ENOENT' ? false : 'unknown', hash: null, bytes: null, kind: 'unknown'};
  }
}

/** All completed action records (`*.event.json`) of the session, oldest first. */
function loadEvents(dir: string) {
  try {
    return fs.readdirSync(dir)
      .filter(name => name.endsWith('.event.json'))
      .map(name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')))
      .sort((a, b) => a.at.localeCompare(b.at));
  } catch {
    return [];
  }
}

/** A non-empty string argument resolved against the call's cwd, else null. */
function resolveArgPath(ctx: Ctx, value: unknown) {
  if (typeof value === 'string' && value) return path.resolve(ctx.cwd ?? process.cwd(), value);
  return null;
}

/**
 * Classify the pending call: which operation it is, which paths it targets and,
 * for cp/mv, its source. `known: false` means its effects cannot be verified.
 */
function planAction(ctx: Ctx) {
  const input: any = ctx.tool_input;
  const filePath = resolveArgPath(ctx, input.file_path ?? input.path);
  const tool = ctx.tool_name.toLowerCase();

  if (WRITE_TOOLS.includes(tool) && filePath) {
    return {operation: 'write', targets: [filePath], source: null, known: true};
  }
  if (EDIT_TOOLS.includes(tool) && filePath
      && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    return {operation: 'edit', targets: [filePath], source: null, known: true};
  }
  if (READ_TOOLS.includes(tool)) {
    return {operation: 'read', targets: filePath ? [filePath] : [], source: null, known: true};
  }

  const command = typeof input.command === 'string' ? input.command.trim() : '';
  if (SHELL_TOOLS.includes(tool) && require('./strategies.js').isReadOnlyBash(command)) {
    return {operation: 'read', targets: [], source: null, known: true};
  }

  // A plain `cp src dest` / `mv src dest` of a regular file onto a regular file or a new path.
  const copyOrMove = SIMPLE_COPY_OR_MOVE.exec(command);
  if (copyOrMove) {
    const isCopy = copyOrMove[1] === 'cp';
    const source = resolveArgPath(ctx, copyOrMove[2])!;
    const dest = resolveArgPath(ctx, copyOrMove[3])!;
    const sourceState = observe(source);
    const destState = observe(dest);
    if (sourceState.kind === 'file' && (destState.exists === false || destState.kind === 'file')) {
      return {
        operation: isCopy ? 'copy' : 'move',
        targets: isCopy ? [dest] : [dest, source],
        source,
        known: true,
      };
    }
  }

  const argumentPaths = collectArgumentPaths(input, ctx.cwd).map(p => path.resolve(p));
  return {operation: 'unknown', targets: argumentPaths, source: null, known: false};
}

/**
 * The latest recorded provenance state of a path, or null if no event recorded one.
 * A later opaque action makes the remaining original content unknown.
 */
function latestState(targetPath: string, events: any[]) {
  const relevant = events.filter(e => e.targets?.includes(targetPath));
  let current: any = null;
  for (const event of relevant) {
    if (event.states?.[targetPath]) current = event.states[targetPath];
  }
  if (current) {
    const last = relevant[relevant.length - 1];
    if (events.some(e => e.opaque && e.at > last.at)) {
      current = {
        ...current,
        original_content_remaining: 'unknown',
        uncertainty: 'A later opaque action may have changed this path; no slice attribution claimed',
      };
    }
  }
  return current;
}

/** Where content at a path that already existed is assumed to come from. */
function originOfExisting(targetPath: string) {
  return KNOWN_AUTOMATIC_PATH.test(targetPath) ? 'known_automatic' : 'assumed_human';
}

/**
 * The provenance state of a path no event has recorded yet, inferred from what is
 * on disk now. Any earlier opaque action makes session-start existence unknown.
 */
function initialState(targetPath: string, events: any[], observed: any) {
  const opaque = events.some(e => e.opaque);
  let origin;
  if (opaque) origin = 'unknown';
  else if (observed.exists === true) origin = originOfExisting(targetPath);
  else if (observed.exists === false) origin = 'agent_generated';
  else origin = 'unknown';
  return {
    path: targetPath,
    existed_at_session_start: opaque ? 'unknown' : observed.exists,
    initial_origin: origin,
    original_content_remaining: opaque ? 'unknown' : observed.exists === true,
    successful_session_changes: [],
    uncertainty: opaque ? 'Earlier opaque action prevents inferring session-start existence' : null,
  };
}

/** Apply an Edit's old_string -> replacement the way the Edit tool does (first match, or all). */
function applyEdit(text: string, input: any, replacement: string) {
  return input.replace_all ? text.split(input.old_string).join(replacement) : text.replace(input.old_string, replacement);
}

/** Pre-tool: record the pending call, its targets' current state and the expected result. */
export function provenancePre(ctx: Ctx, config: SandboxConfig) {
  if (!config.personalization) return;
  const dir = provenanceDir(ctx, config);
  const id = actionId(ctx);
  if (!dir || !id) return;
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  const key = sha256(id);
  const pendingFile = path.join(dir, key + '.pending.json');
  // Record each action once.
  if (fs.existsSync(pendingFile) || fs.existsSync(path.join(dir, key + '.event.json'))) return;

  const plan = planAction(ctx);
  const events = loadEvents(dir);
  const before: any = {};
  const states: any = {};
  for (const p of [...plan.targets, ...(plan.source ? [plan.source] : [])]) {
    before[p] = observe(p);
    states[p] = latestState(p, events) ?? initialState(p, events, before[p]);
  }

  // For an Edit, replay it on the current file (up to 128 KB) to predict the result
  // hash and whether any of the file's content survives the removal of old_string.
  let expectedHash: any = null;
  let editRemaining: any = 'unknown';
  const input: any = ctx.tool_input;
  if (plan.operation === 'edit') {
    try {
      if (fs.statSync(plan.targets[0]).size > MAX_EDIT_EVIDENCE_BYTES) throw new Error('edit evidence exceeds bound');
      const text = fs.readFileSync(plan.targets[0], 'utf8');
      if (text.length <= MAX_EDIT_EVIDENCE_BYTES && text.includes(input.old_string)) {
        const removed = applyEdit(text, input, '');
        editRemaining = removed.length > 0;
        expectedHash = sha256(applyEdit(text, input, input.new_string));
      }
    } catch {}
  }
  if (plan.operation === 'write' && typeof input.content === 'string') expectedHash = sha256(input.content);

  const change = plan.operation === 'edit'
    ? {old_string: input.old_string, new_string: input.new_string, replace_all: !!input.replace_all}
    : null;
  const record = {
    action_id: id,
    at: new Date().toISOString(),
    ...plan,
    before,
    states,
    editRemaining,
    expectedHash,
    change,
    raw_tool_input: input,
    input_sha256: sha256(JSON.stringify(input)),
  };
  fs.writeFileSync(pendingFile, JSON.stringify(record), {mode: 0o600, flag: 'wx'});
}

/** How the call ended, as reported by the post-tool hook payload. */
function hookOutcome(ctx: Ctx): 'success' | 'failure' | 'unknown' {
  if (ctx.hook_event === 'PostToolUseFailure') return 'failure';
  if (ctx.hook_event !== 'PostToolUse') return 'unknown';
  let output: any = ctx.tool_output;
  if (typeof output === 'string') {
    try {
      output = JSON.parse(output);
    } catch {
      output = null;
    }
  }
  if (output?.is_error === true
      || output?.error
      || (output?.exit_code && output.exit_code !== 0)
      || (output?.exitCode && output.exitCode !== 0)) {
    return 'failure';
  }
  // A shell call only counts as a success with an explicit zero exit code.
  if (['Bash', 'bash', 'Shell', 'shell'].includes(ctx.tool_name)) {
    return output?.exit_code === 0 || output?.exitCode === 0 ? 'success' : 'unknown';
  }
  return 'success';
}

/**
 * Whether a target's state after the call matches what the recorded plan predicts
 * (edit/write hash, copied content, moved-away source).
 */
function targetMatchesPlan(pre: any, targetPath: string, after: any) {
  if (after.exists === 'unknown' || (after.hash === null && after.exists === true)) return false;
  if (['edit', 'write'].includes(pre.operation) && (!pre.expectedHash || after.hash !== pre.expectedHash)) return false;
  if ((pre.operation === 'copy' || pre.operation === 'move') && targetPath !== pre.source
      && after.hash !== pre.before[pre.source]?.hash) return false;
  if (pre.operation === 'move' && targetPath === pre.source && after.exists !== false) return false;
  return true;
}

/** The provenance state of a target after a verified successful change. */
function stateAfterVerifiedChange(pre: any, targetPath: string, state: any, id: string, result: string) {
  let next = state;
  const unchangedEditOrWrite = pre.before[targetPath]?.hash
    && pre.before[targetPath].hash === observe(targetPath).hash
    && ['edit', 'write'].includes(pre.operation);
  if (unchangedEditOrWrite) {
    next = {...next};
  } else if (pre.operation === 'copy' || pre.operation === 'move') {
    if (targetPath !== pre.source) {
      // The destination inherits the source's provenance.
      const sourceState = pre.states[pre.source];
      next = {
        ...next,
        initial_origin: sourceState.initial_origin,
        original_content_remaining: sourceState.original_content_remaining,
        source: pre.source,
      };
    } else {
      next = {...next, original_content_remaining: false};
    }
  } else if (pre.operation === 'write') {
    next = {
      ...next,
      initial_origin: pre.before[targetPath].exists === false ? 'agent_generated' : next.initial_origin,
      original_content_remaining: false,
    };
  } else if (pre.operation === 'edit') {
    let remaining;
    if (next.original_content_remaining === false) remaining = false;
    else if (next.successful_session_changes.length) remaining = 'unknown';
    else remaining = pre.editRemaining;
    next = {...next, original_content_remaining: remaining};
  }
  const change = {
    action_id: id,
    operation: pre.operation,
    change: pre.change,
    source: pre.source,
    evidence: {before: pre.before[targetPath], after: observe(targetPath), hook_outcome: result},
  };
  return {...next, successful_session_changes: [...next.successful_session_changes, change]};
}

/** Post-tool: verify the pending call's effect on disk and record the completed event. */
export function provenancePost(ctx: Ctx, config: SandboxConfig) {
  if (!config.personalization) return;
  const dir = provenanceDir(ctx, config);
  const id = actionId(ctx);
  if (!dir || !id) return;
  const key = sha256(id);
  const pendingFile = path.join(dir, key + '.pending.json');
  if (!fs.existsSync(pendingFile) || fs.existsSync(path.join(dir, key + '.event.json'))) return;

  const pre = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  const result = hookOutcome(ctx);
  const states: any = {};
  const events = loadEvents(dir);
  let success = result === 'success' && pre.known;

  // Pass 1: current state of every target; the change counts only if every target matches the plan.
  for (const p of pre.targets) {
    const after = observe(p);
    const state = latestState(p, events) ?? pre.states[p];
    if (success && pre.operation !== 'read' && !targetMatchesPlan(pre, p, after)) success = false;
    states[p] = state;
  }

  // Pass 2: fold the verified change (or the uncertainty of an unverified one) into each state.
  for (const p of pre.targets) {
    let state = states[p];
    if (success && pre.operation !== 'read') {
      state = stateAfterVerifiedChange(pre, p, state, id, result);
    } else if (pre.operation !== 'read') {
      state = {
        ...state,
        original_content_remaining: 'unknown',
        uncertainty: 'Failed/opaque/unverified action may have partial effects; no successful change asserted',
      };
    }
    states[p] = state;
  }

  const opaque = !pre.known || result !== 'success';
  const event = {
    ...pre,
    at: new Date().toISOString(),
    outcome: result,
    successful_change_recorded: success && pre.operation !== 'read',
    opaque,
    states,
  };
  fs.writeFileSync(path.join(dir, key + '.event.json'), JSON.stringify(event), {mode: 0o600, flag: 'wx'});
}

/** Maximum number of entries listed for a directory target. */
const MAX_DIRECTORY_ENTRIES = 32;
/** Total bytes of file previews for one directory target. */
const DIRECTORY_PREVIEW_BUDGET = 8192;
/** Bytes previewed per file. */
const FILE_PREVIEW_BYTES = 512;

/**
 * For a directory target: its entries (two levels deep, at most 32) with short
 * content previews of the files. Undefined for anything that is not a directory.
 */
function directoryEvidence(target: string) {
  try {
    if (!fs.lstatSync(target).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  const entries: any[] = [];
  let budget = DIRECTORY_PREVIEW_BUDGET;
  let truncated = false;

  function visit(dir: string, depth: number) {
    let names: string[];
    try {
      names = fs.readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (entries.length >= MAX_DIRECTORY_ENTRIES || budget <= 0) {
        truncated = true;
        return;
      }
      const entryPath = path.join(dir, name);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(entryPath);
      } catch {
        continue;
      }
      const kind = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file';
      const entry: any = {path: entryPath, kind, bytes: stat.size};
      if (stat.isFile()) {
        const fd = fs.openSync(entryPath, 'r');
        try {
          const buffer = Buffer.alloc(Math.min(FILE_PREVIEW_BYTES, budget, stat.size));
          const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
          const prefix = buffer.subarray(0, bytesRead);
          // Binary content (any NUL byte) gets no text preview.
          entry.content_prefix = prefix.includes(0) ? null : prefix.toString('utf8');
          entry.content_prefix_bytes = bytesRead;
          budget -= bytesRead;
          entry.content_truncated = stat.size > bytesRead;
        } finally {
          fs.closeSync(fd);
        }
      }
      entries.push(entry);
      if (stat.isDirectory() && depth < 1) visit(entryPath, depth + 1);
      else if (stat.isDirectory()) truncated = true;
    }
  }

  visit(target, 0);
  return {entries, truncated, scope: 'bounded target directory only; previews are evidence, not provenance attribution'};
}

/** True when one path equals, contains, or is contained in the other. */
function pathsOverlap(recorded: string, targetPath: string) {
  return recorded === targetPath
    || targetPath.startsWith(recorded + path.sep)
    || recorded.startsWith(targetPath + path.sep);
}

/** The paths to report on: the pending call's own targets when known, else the given paths plus them. */
function reportTargets(pre: any, paths: string[]) {
  return [...new Set<string>(pre?.known ? pre.targets : [...paths, ...(pre?.targets ?? [])])];
}

/**
 * Derived provenance for each target of the pending call: its state, directory
 * previews, unverified earlier changes, and whether untargeted opaque actions exist.
 */
export function provenanceSummary(ctx: Ctx, config: SandboxConfig, paths: string[]) {
  if (!config.personalization) return undefined;
  const dir = provenanceDir(ctx, config);
  if (!dir || !actionId(ctx)) {
    return paths.map(p => ({
      path: p,
      existed_at_session_start: 'unknown',
      initial_origin: 'unknown',
      successful_session_changes: [],
      original_content_remaining: 'unknown',
      uncertainty: 'Missing session or original action identity',
    }));
  }
  const events = loadEvents(dir);
  const id = actionId(ctx);
  let pre: any = null;
  try {
    if (id) pre = JSON.parse(fs.readFileSync(path.join(dir, sha256(id) + '.pending.json'), 'utf8'));
  } catch {}

  return reportTargets(pre, paths).map(p => ({
    ...(latestState(p, events) ?? pre?.states[p] ?? initialState(p, events, observe(p))),
    target_contents_evidence: directoryEvidence(p),
    unverified_session_changes: events
      .filter(e => !e.successful_change_recorded && e.operation !== 'read'
        && e.targets.some((t: string) => pathsOverlap(t, p)))
      .map(e => ({
        action_id: e.action_id,
        operation: e.operation,
        tool_input: e.raw_tool_input,
        post_outcome: e.outcome,
        suboperation_success: 'unknown',
        evidence: e.before,
      })),
    unknown_untargeted_actions_exist: events.some(e => e.opaque && !e.targets.length),
  }));
}

// Checker-facing history: prior relevant actions only, no derived provenance state.
export function targetActionLog(ctx: Ctx, config: SandboxConfig, paths: string[]) {
  if (!config.personalization) return undefined;
  const dir = provenanceDir(ctx, config);
  const id = actionId(ctx);
  if (!dir || !id) return "Target action history unavailable: missing session/action identity.";
  const events = loadEvents(dir);
  let pre: any = null;
  try {
    pre = JSON.parse(fs.readFileSync(path.join(dir, sha256(id) + '.pending.json'), 'utf8'));
  } catch {}

  return reportTargets(pre, paths).map(p => {
    const relevant = events.filter(e => e.action_id !== id && e.operation !== 'read'
      && e.targets?.some((t: string) => pathsOverlap(t, p)));
    const lines = relevant.map((e, i) =>
      `Action ${i + 1} (id: ${JSON.stringify(e.action_id)}):\n`
      + `${JSON.stringify(e.raw_tool_input)}\n`
      + `Execution outcome: ${e.outcome}; individual change verified: ${e.successful_change_recorded === true}.`);
    const log = lines.join('\n')
      || 'No recorded prior related actions. This does not establish authorship or absence of unobserved changes.';
    return `For file or directory ${JSON.stringify(p)}, below is its change log:\n${log}`;
  }).join('\n\n');
}
