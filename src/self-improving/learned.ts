/**
 * The self-improving loop (see README.md here): the learned backup rule table, its
 * matching and execution, then the reflection and generalize model turns that write it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { BackupArtifact, HookContext, SandboxConfig } from "../types.js";
import { parseDeclaration } from "../backup/declaration.js";
import { extractJsonObject } from "../util.js";
import { GENERALIZE, REFLECTION, render } from "../prompts.generated.js";
import { buildSubagentInvocation, cleanupSubagentInvocation, runInvocation } from "../backup/subagent.js";

// =============================================================================
// ── learned backup ──
// =============================================================================

/**
 * Learned backup rules.
 *
 * Reflection writes rules into a versioned JSON table (`learnedBackupRulesPath`).
 * A rule matches one raw tool-input field with a regex, binds the captures into
 * the argv of a few programs, runs them with no shell, and checks that the
 * expected artifacts appeared inside the action directory. `tryLearnedBackup`
 * applies the table to a pending action.
 */

export type ReflectionDecision = "UPDATE_EXISTING" | "ADD_NEW" | "DO_NOTHING";
/** One piece of an argv entry or artifact path: exactly one of the four sources. */
type Part = { literal?: string; capture?: string; binding?: "actionDir" | "workdir"; env?: string };
/** An argv entry: a plain literal, one part, or parts concatenated. */
type Arg = string | Part | Part[];
export interface LearnedBackupRule {
  id: string;
  revision: number;
  enabled: boolean;
  testOnly: boolean;
  toolName: string;
  /** Tool-input field whose RAW text actionRegex is tested against (Bash: "command"). */
  matchField: string;
  actionRegex: string;
  captures: Array<{ name: string; group: number; type: "string" | "absolute_path" | "path" | "http_url" }>;
  steps: Array<{ program: string; args: Arg[]; stdoutBinding?: string; stdoutMode?: "raw" | "line" }>;
  expectedArtifacts: Array<{ path: Part[]; kind: "file" | "directory"; nonEmpty: boolean }>;
  inputPattern: string;
  outputPattern: string;
  learnedFrom: { action: string; actionDir: string; reflectedAt: string };
  /** Host-maintained: raw matchField texts this rule was learned/updated from (all, untruncated).
   *  Shown back in TABLE so a later UPDATE_EXISTING can widen without losing them. */
  matchedExamples?: string[];
  /** Host-maintained. "observed": written by a reflection over a real backup.
   *  "generalized": inferred from another rule, never demonstrated. */
  provenance?: "observed" | "generalized";
  derivedFromRuleId?: string;
  /** Host-maintained: which generalization axis produced it (A action, B1 entry point, B2 other store). */
  generalizedAxis?: string;
}
export interface LearnedBackupTable {
  schemaVersion: 3;
  version: number;
  testOnly: boolean;
  rules: LearnedBackupRule[];
  history: Array<Record<string, unknown>>;
}
export interface ReflectionUpdate {
  decision: ReflectionDecision;
  baseVersion: number;
  rule?: LearnedBackupRule;
  reason: string;
  inputPattern: string;
  outputPattern: string;
}

const DECISIONS = ["ADD_NEW", "UPDATE_EXISTING", "DO_NOTHING"];
const BINDINGS = ["actionDir", "workdir"];
const CAPTURE_TYPES = ["string", "absolute_path", "path", "http_url"];
const STDOUT_MODES = ["raw", "line"];
const ARTIFACT_KINDS = ["file", "directory"];
const RULE_ID = /^[a-z0-9][a-z0-9._-]{2,80}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A new, empty rule table. */
export const emptyTable = (testOnly = false): LearnedBackupTable => ({
  schemaVersion: 3,
  version: 0,
  testOnly,
  rules: [],
  history: [],
});

/** Absolute path of the rule table file. */
export const tablePath = (config: SandboxConfig) => path.resolve(config.learnedBackupRulesPath);

/** Throw unless the part names exactly one valid source. */
function validatePart(part: Part) {
  const sources = [part.literal, part.capture, part.binding, part.env].filter(x => x !== undefined);
  if (sources.length !== 1) throw new Error("one argv binding required");
  if (part.binding !== undefined && !BINDINGS.includes(part.binding)) throw new Error("bad binding");
  if (part.env && !ENV_NAME.test(part.env)) throw new Error("bad env name");
}

/** The parts of an argv entry that is not a plain literal. */
function partsOf(arg: Part | Part[]): Part[] {
  return Array.isArray(arg) ? arg : [arg];
}

/** Throw unless the rule is well-formed: id, regex, captures, steps, artifacts and patterns. */
function validateRule(rule: LearnedBackupRule) {
  if (!rule || !RULE_ID.test(rule.id) || !Number.isInteger(rule.revision) || rule.enabled !== true) {
    throw new Error("bad rule");
  }
  if (typeof rule.matchField !== "string" || !rule.matchField) throw new Error("bad matchField");
  try {
    new RegExp(rule.actionRegex);
  } catch {
    throw new Error("bad regex");
  }
  const badCapture = (x: LearnedBackupRule["captures"][number]) =>
    !x || typeof x.name !== "string" || !x.name || !Number.isInteger(x.group) || x.group < 1
    || !CAPTURE_TYPES.includes(x.type);
  if (!Array.isArray(rule.captures) || rule.captures.some(badCapture)) throw new Error("bad captures");
  if (!rule.steps?.length || !rule.expectedArtifacts?.length) throw new Error("empty rule");

  for (const step of rule.steps) {
    if (typeof step.program !== "string" || !step.program || step.program.includes("\0")
        || !Array.isArray(step.args) || (step.stdoutMode && !STDOUT_MODES.includes(step.stdoutMode))) {
      throw new Error("bad program");
    }
    step.args.forEach(arg => {
      if (typeof arg === "string") {
        if (arg.includes("\0")) throw new Error("bad literal argv");
        return;
      }
      const parts = partsOf(arg);
      if (!parts.length) throw new Error("empty argv");
      parts.forEach(validatePart);
    });
  }

  for (const artifact of rule.expectedArtifacts) {
    if (!Array.isArray(artifact.path) || !artifact.path.length || !ARTIFACT_KINDS.includes(artifact.kind)
        || typeof artifact.nonEmpty !== "boolean") {
      throw new Error("bad artifact");
    }
    artifact.path.forEach(validatePart);
  }

  // A rule has to write into the action directory, or its backup lands nowhere we track.
  const usesActionDir = rule.steps.some(step => step.args.some(arg =>
    typeof arg !== "string" && partsOf(arg).some(part => part.binding === "actionDir")));
  if (!usesActionDir) throw new Error("steps never reference actionDir");
  if (!rule.inputPattern?.trim() || !rule.outputPattern?.trim() || !rule.learnedFrom) throw new Error("missing pattern");
}

/** Read and validate the rule table; a missing file is an empty table. */
export function loadLearnedBackupTable(config: SandboxConfig) {
  const file = tablePath(config);
  if (!fs.existsSync(file)) return emptyTable(false);
  const table = JSON.parse(fs.readFileSync(file, "utf8")) as LearnedBackupTable;
  if (table.schemaVersion !== 3 || !Array.isArray(table.rules) || !Array.isArray(table.history)) {
    throw new Error("bad table");
  }
  table.rules.forEach(validateRule);
  return table;
}

/**
 * Take the lock file (O_EXCL create holding our pid), retrying every 10 ms up to
 * 100 times. A lock whose owner pid no longer exists is removed.
 */
function acquireLock(lockFile: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const fd = fs.openSync(lockFile, "wx", 0o600);
      fs.writeFileSync(fd, String(process.pid));
      return fd;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let owner = 0;
      try {
        owner = Number(fs.readFileSync(lockFile, "utf8"));
      } catch {}
      if (owner > 0) {
        try {
          process.kill(owner, 0);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ESRCH") {
            try {
              fs.unlinkSync(lockFile);
            } catch {}
          }
        }
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  throw new Error("lock timeout");
}

/** Run `update` on the table file path while holding the table's lock file. */
function withTableLock<T>(config: SandboxConfig, update: (file: string) => T): T {
  const file = tablePath(config);
  const lockFile = file + ".lock";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = acquireLock(lockFile);
  try {
    return update(file);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
    try {
      fs.unlinkSync(lockFile);
    } catch {}
  }
}

/** Replace the table file atomically (write a temp file, then rename). */
function writeTable(file: string, table: LearnedBackupTable) {
  const temp = file + `.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(table, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, file);
}

/**
 * Apply one reflection decision to the table under its lock: DO_NOTHING only adds
 * history; ADD_NEW / UPDATE_EXISTING validate the rule, bump its revision, merge its
 * matched examples and bump the table version. Throws on a stale baseVersion.
 */
export function applyReflectionUpdate(config: SandboxConfig, update: ReflectionUpdate) {
  return withTableLock(config, file => {
    const table = loadLearnedBackupTable(config);
    if (update.baseVersion !== table.version || !DECISIONS.includes(update.decision)
        || !update.inputPattern?.trim() || !update.outputPattern?.trim()) {
      throw new Error("bad update");
    }
    if (update.decision === "DO_NOTHING") {
      if (update.rule) throw new Error("unexpected rule");
      table.history.push({ at: new Date().toISOString(), version: table.version, ...update });
    } else {
      if (!update.rule) throw new Error("missing rule");
      validateRule(update.rule);
      if (update.rule.testOnly !== table.testOnly) throw new Error("testOnly mismatch");
      const index = table.rules.findIndex(r => r.id === update.rule!.id);
      if (update.decision === "ADD_NEW" && index >= 0) throw new Error("id exists");
      if (update.decision === "UPDATE_EXISTING" && index < 0) throw new Error("id absent");
      const previous = index >= 0 ? table.rules[index] : undefined;
      const examples = [...(previous?.matchedExamples ?? []), ...(update.rule.matchedExamples ?? [])];
      const next = {
        ...update.rule,
        revision: previous ? previous.revision + 1 : 1,
        matchedExamples: Array.from(new Set(examples)),
      };
      if (index < 0) table.rules.push(next);
      else table.rules[index] = next;
      table.version++;
      table.history.push({
        at: new Date().toISOString(),
        version: table.version,
        decision: update.decision,
        ruleId: next.id,
        previousRule: previous,
        inputPattern: update.inputPattern,
        outputPattern: update.outputPattern,
        reason: update.reason,
      });
    }
    writeTable(file, table);
    return { applied: update.decision !== "DO_NOTHING", reason: update.reason, version: table.version };
  });
}

/** Note in history that a built-in source was already asked to generalize, so it
 *  is asked once per table. No version bump: the rules did not change. */
export function recordGeneralizedSource(
  config: SandboxConfig,
  sourceId: string,
  key: "generalizedSource" | "generalizeFailedSource" = "generalizedSource",
) {
  withTableLock(config, file => {
    const table = loadLearnedBackupTable(config);
    table.history.push({ at: new Date().toISOString(), version: table.version, [key]: sourceId });
    writeTable(file, table);
  });
}

/**
 * Resolve each part to its value: a literal, a regex capture (or an earlier step's
 * stdout), the action dir / workdir, or an environment variable.
 */
function bind(
  parts: Part[],
  captures: Record<string, string>,
  outputs: Record<string, string>,
  actionDir: string,
  workdir = actionDir,
) {
  return parts.map(part => {
    const value = part.literal
      ?? (part.capture ? (captures[part.capture] ?? outputs[part.capture]) : undefined)
      ?? (part.binding ? (part.binding === "workdir" ? workdir : actionDir) : undefined)
      ?? (part.env ? process.env[part.env] : undefined);
    if (value === undefined) throw new Error("missing binding");
    return value;
  });
}

/** Build a step's argv: literals as-is, bound parts concatenated into one argument. */
function bindArgs(
  args: Arg[],
  captures: Record<string, string>,
  outputs: Record<string, string>,
  actionDir: string,
  workdir: string,
) {
  return args.map(arg => typeof arg === "string" ? arg : bind(partsOf(arg), captures, outputs, actionDir, workdir).join(""));
}

/** The action as `Tool({...input})`, with any "[BACKUP NEEDED]" marker removed from its description. */
export function canonicalAction(ctx: HookContext) {
  const input = { ...ctx.tool_input } as Record<string, unknown>;
  if (typeof input.description === "string") {
    input.description = input.description.replace(/\s*\[BACKUP NEEDED\]\s*/gi, " ").trim();
  }
  return `${ctx.tool_name}(${JSON.stringify(input)})`;
}

/**
 * The text a rule is matched against: each top-level tool-input field as raw
 * text (a rule matches one, `matchField`), with any backup declaration removed.
 */
export interface ActionView { toolName: string; fields: Record<string, string>; workdir: string }

/** Remove a backup declaration from a field; if it ended its line, also drop a trailing `#` before it. */
function dropDeclaration(text: string): string {
  const declaration = parseDeclaration(text);
  if (!declaration) return text;
  const at = text.indexOf(declaration.raw);
  if (at < 0) return text;
  const after = text.slice(at + declaration.raw.length);
  const eol = after.search(/[\r\n]/);
  const restOfLine = eol < 0 ? after : after.slice(0, eol);
  let before = text.slice(0, at);
  if (!restOfLine.trim()) {
    before = before.replace(/[ \t]*#?[ \t]*$/, "");
    return before + after.slice(restOfLine.length);
  }
  return before + after;
}

/** The action as a rule sees it: string fields raw (minus declaration), others as JSON, plus its workdir. */
export function actionView(ctx: HookContext): ActionView {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(ctx.tool_input ?? {})) {
    fields[key] = typeof value === "string" ? dropDeclaration(value) : JSON.stringify(value);
  }
  // Execution context for relative paths: the call's own workdir when the
  // harness sends one, else the hook's cwd field, else this process's cwd.
  const candidates = [ctx.tool_input?.workdir, ctx.tool_input?.cwd, ctx.cwd];
  const workdir = candidates.find(x => typeof x === "string" && path.isAbsolute(x)) as string | undefined;
  return { toolName: ctx.tool_name, fields, workdir: workdir ?? process.cwd() };
}

/** Return the captures a rule extracts from an action, or null on no match;
 *  throws when a typed capture is unusable. */
export function matchLearnedRule(rule: LearnedBackupRule, view: ActionView): Record<string, string> | null {
  if (!rule.enabled || rule.toolName !== view.toolName) return null;
  const text = view.fields[rule.matchField];
  if (text === undefined) return null;
  const match = new RegExp(rule.actionRegex).exec(text);
  if (!match) return null;
  const captures: Record<string, string> = {};
  for (const spec of rule.captures) {
    let value = match[spec.group];
    if (value === undefined) throw new Error("capture");
    if (spec.type === "absolute_path" && !path.isAbsolute(value)) throw new Error("path");
    if (spec.type === "path") value = path.resolve(view.workdir, value);
    if (spec.type === "http_url") {
      const url = new URL(value);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("url");
    }
    captures[spec.name] = value;
  }
  return captures;
}

/** Throw unless the expected artifact exists inside the action dir with the right kind (and is non-empty if required). */
function checkArtifact(artifact: string, actionRoot: string, expected: LearnedBackupRule["expectedArtifacts"][number]) {
  if (artifact === actionRoot || !artifact.startsWith(actionRoot + path.sep)) {
    throw new Error("artifact must be a concrete child of actionDir");
  }
  const stat = fs.statSync(artifact);
  const empty = expected.kind === "directory" ? fs.readdirSync(artifact).length === 0 : stat.size === 0;
  const wrongKind = (expected.kind === "file" && !stat.isFile()) || (expected.kind === "directory" && !stat.isDirectory());
  if (wrongKind || (expected.nonEmpty && empty)) throw new Error("artifact check");
}

/**
 * Back up the pending action with the first learned rule that matches it and
 * produces its expected artifacts under `actionDir`. Every failed matching rule is
 * logged to learned-rule-failures.jsonl. Returns null when no rule succeeds.
 */
export function tryLearnedBackup(ctx: HookContext, actionDir: string, config: SandboxConfig): BackupArtifact | null {
  let table: LearnedBackupTable;
  try {
    table = loadLearnedBackupTable(config);
  } catch {
    return null;
  }
  const view = actionView(ctx);
  let stepCwd = process.cwd();
  try {
    if (fs.statSync(view.workdir).isDirectory()) stepCwd = view.workdir;
  } catch {}
  // Demonstrated rules get first refusal; an inferred sibling only ever fills a gap.
  const ordered = [...table.rules].sort((a, b) =>
    Number(a.provenance === "generalized") - Number(b.provenance === "generalized"));

  for (const rule of ordered) {
    const outputs: Record<string, string> = {};
    const workRoot = path.join(actionDir, "learned_rule", rule.id);
    try {
      const captures = matchLearnedRule(rule, view);
      if (!captures) continue;
      fs.mkdirSync(workRoot, { recursive: true });

      for (const step of rule.steps) {
        const argv = bindArgs(step.args, captures, outputs, actionDir, view.workdir);
        const run = spawnSync(step.program, argv, {
          encoding: "utf8",
          cwd: stepCwd,
          timeout: config.subagentTimeoutSeconds * 1000,
          maxBuffer: 2e6,
          shell: false,
        });
        if (run.error || run.status !== 0) throw new Error(`step ${step.program} rc=${run.status}`);
        if (step.stdoutBinding) {
          outputs[step.stdoutBinding] = step.stdoutMode === "line" ? run.stdout.replace(/\r?\n$/, "") : run.stdout;
        }
      }

      const artifacts: string[] = [];
      for (const expected of rule.expectedArtifacts) {
        const artifact = path.resolve(actionDir, ...bind(expected.path, captures, outputs, actionDir, view.workdir));
        const actionRoot = path.resolve(actionDir);
        checkArtifact(artifact, actionRoot, expected);
        artifacts.push(artifact);
      }

      return {
        id: Math.random().toString(36).slice(2, 10),
        timestamp: new Date().toISOString(),
        trigger: "rule",
        toolName: ctx.tool_name,
        description: `Learned rule ${rule.id} created expected artifacts: ${artifacts.join(", ")}`,
        strategy: "learned_rule",
        artifactPath: artifacts[0],
        originalAction: canonicalAction(ctx),
        policyRuleId: rule.id,
      };
    } catch (error) {
      fs.mkdirSync(actionDir, { recursive: true });
      const failure = {
        recordedAt: new Date().toISOString(),
        ruleId: rule.id,
        matched: true,
        steps: rule.steps,
        error: String(error),
      };
      fs.appendFileSync(path.join(actionDir, "learned-rule-failures.jsonl"), JSON.stringify(failure) + "\n");
      continue;
    }
  }
  return null;
}

// =============================================================================
// ── reflection ──
// =============================================================================

/**
 * Self-improving turns.
 *
 * Reflection: after a tier-4 backup, one no-tools model call reads the backup's
 * evidence and decides whether to add or update a learned rule (or do nothing).
 * Generalize: after a rule is written (or a built-in rule handled an action), one
 * more call proposes sibling rules. Each turn writes a receipt JSON into the action dir.
 */

/** Mask values that follow credential-looking keys before text is written to a receipt. */
function redact(text: string): string {
  return text.replace(/(api[_-]?key|authorization|bearer|token|password|secret)(["'\s:=]+)[^\s,"']+/gi, "$1$2[REDACTED]");
}

/** Every regular file under `dir`, recursively, with its path relative to `dir` and its size. */
function listFiles(dir: string) {
  const inventory: Array<{ path: string; bytes: number }> = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else if (entry.isFile()) inventory.push({ path: path.relative(dir, entryPath), bytes: fs.statSync(entryPath).size });
    }
  };
  try {
    walk(dir);
  } catch {}
  return inventory;
}

/**
 * What the backup in `dir` left behind: the subagent's result, the file inventory,
 * the subagent transcripts (or run logs when there is no transcript), redacted,
 * and any learned-rule failures.
 */
function evidence(dir: string) {
  let result: unknown = null;
  try {
    result = JSON.parse(fs.readFileSync(path.join(dir, "subagent_result.json"), "utf8"));
  } catch {}
  const inventory = listFiles(dir);
  const transcripts = inventory.filter(x => /subagent.*\.transcript\.(?:json|jsonl)$/.test(x.path));
  const selected = transcripts.length ? transcripts : inventory.filter(x => /subagent.*\.run\.json$/.test(x.path));
  const toolCallsAndResults = selected.map(x => ({
    path: x.path,
    content: redact(fs.readFileSync(path.join(dir, x.path), "utf8")),
  }));
  let learnedRuleFailures = "";
  try {
    learnedRuleFailures = fs.readFileSync(path.join(dir, "learned-rule-failures.jsonl"), "utf8");
  } catch {}
  return {
    backupResult: result,
    artifactInventory: inventory,
    backupToolCallsAndResults: toolCallsAndResults,
    learnedRuleFailures,
  };
}

/** The backup subagent's config with the reflection-only runner and model overrides applied. */
function reflectionConfig(config: SandboxConfig): SandboxConfig {
  const overridden = { ...config };
  if (config.reflectionSubagentRunner) overridden.subagentRunner = config.reflectionSubagentRunner;
  if (config.reflectionSubagentModel) overridden.subagentModel = config.reflectionSubagentModel;
  return overridden;
}

// Matcher and rule-format sections shared by the reflection and generalize prompts.
const MATCH_SECTION = REFLECTION.sections["match-section"];
const FORMAT_SECTION = REFLECTION.sections["format-section"];
// A single task- and tool-agnostic reflection prompt, so learned rules transfer.
export const REFLECTION_INSTRUCTIONS: string[] = [render(REFLECTION.body, { MATCH_SECTION, FORMAT_SECTION })];

/** The argv and stdin for a reflection call. */
export function reflectionTransport(inv: { runner: string; args: string[] }, prompt: string): { args: string[]; input: string } {
  const args = [...inv.args];
  if (inv.runner === "codex") {
    // On codex the last argv entry ends with the prompt; pass it via stdin instead.
    const last = args.length - 1;
    if (last < 0 || !args[last].endsWith(prompt)) throw new Error("codex prompt argument missing");
    const input = args[last];
    args[last] = "-";
    return { args, input };
  }
  return { args, input: "" };
}

// The generalize turn: a no-tools call that only writes rules, given the action
// with or without the backup subagent's trail.
export const GENERALIZE_INSTRUCTIONS: string[] = [render(GENERALIZE.body, { MATCH_SECTION, FORMAT_SECTION })];

/** One no-tools, single-turn call to the reflection runner; returns its stdout. */
function callModel(prompt: string, config: SandboxConfig): string {
  const runnerConfig = reflectionConfig(config);
  const invocation = buildSubagentInvocation(prompt, runnerConfig, {
    noTools: true,
    maxTurns: 1,
    systemPrompt: REFLECTION.sections["system-prompt"],
  });
  if (!invocation) throw new Error("reflection runner unavailable");
  const transport = reflectionTransport(invocation, prompt);
  let run;
  try {
    // Shared subagent environment (IS_SANDBOX as root, MCP_TIMEOUT, BACKUPPER_NO_HOOK).
    run = runInvocation({ bin: invocation.bin, args: transport.args, env: invocation.env }, {
      timeoutMs: config.subagentTimeoutSeconds * 1000,
      maxBuffer: 2 * 1024 * 1024,
      input: transport.input,
    });
  } finally {
    cleanupSubagentInvocation(invocation);
  }
  if (!run.ok) throw new Error(`reflection exit: ${run.error?.message ?? "failed"}`);
  return run.stdout;
}

interface Sibling {
  decision?: "ADD_NEW" | "UPDATE_EXISTING";
  axis?: string;
  reason?: string;
  targetSource?: string;
  inputPattern: string;
  outputPattern: string;
  rule: LearnedBackupRule;
}

/** The generalize answer: a principle, the proposed sibling rules, and what was not extended. */
type GeneralizeAnswer = { principle?: string; siblings?: Sibling[]; notExtended?: unknown };

/** The table as shown to the model. */
function tableForPrompt(table: LearnedBackupTable) {
  return JSON.stringify({
    schemaVersion: table.schemaVersion,
    version: table.version,
    testOnly: table.testOnly,
    rules: table.rules,
  });
}

/** The ONLY difference between the two forms is the trail block. */
export function generalizePrompt(
  view: ActionView,
  table: LearnedBackupTable,
  trail?: { evidence: unknown; writtenRuleId?: string },
): string {
  const vars = {
    INSTRUCTIONS: GENERALIZE_INSTRUCTIONS.join("\n"),
    ACTION: JSON.stringify({ toolName: view.toolName, fields: view.fields, workdir: view.workdir }),
    TEST_ONLY: table.testOnly,
    TABLE: tableForPrompt(table),
  };
  if (!trail) return render(GENERALIZE.sections["without-trail"], vars);
  const ruleClause = trail.writtenRuleId
    ? render(GENERALIZE.sections["trail-rule-clause"], { RULE_ID: JSON.stringify(trail.writtenRuleId) })
    : "";
  return render(GENERALIZE.sections["with-trail"], { ...vars, RULE_CLAUSE: ruleClause, TRAIL: JSON.stringify(trail.evidence) });
}

/** Format-parse the generalize answer and add/update inferred siblings. No judge: a sibling
 *  that fails the same basic parsing as any rule is recorded and skipped. */
export function applyGeneralization(
  config: SandboxConfig,
  sourceId: string,
  answer: { siblings?: Sibling[]; rule?: LearnedBackupRule; inputPattern?: string; outputPattern?: string },
  actionDir: string,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  // Seen from the model: the action's own rule returned beside siblings instead of in it.
  const stray: Sibling[] = answer.rule && typeof answer.rule === "object"
    ? [{
      axis: "self",
      decision: "UPDATE_EXISTING",
      inputPattern: answer.inputPattern ?? answer.rule.inputPattern,
      outputPattern: answer.outputPattern ?? answer.rule.outputPattern,
      rule: answer.rule,
    }]
    : [];
  const siblings = Array.isArray(answer.siblings) ? answer.siblings : [];

  for (const sib of [...siblings, ...stray]) {
    const id = sib?.rule?.id;
    try {
      if (!sib?.rule) throw new Error("missing rule");
      const decision = sib.decision ?? "ADD_NEW";
      const current = loadLearnedBackupTable(config);
      const previous = current.rules.find(r => r.id === id);
      if (decision !== "ADD_NEW" && decision !== "UPDATE_EXISTING") throw new Error("bad generalization decision");
      // An update of nothing is an add.
      let effective: "ADD_NEW" | "UPDATE_EXISTING" = decision === "UPDATE_EXISTING" && !previous ? "ADD_NEW" : decision;
      // An update of the observed source rule is stored as a separate inferred rule,
      // so the demonstrated rule is never rewritten.
      if (previous && previous.provenance !== "generalized") {
        if (decision !== "UPDATE_EXISTING") throw new Error("id exists");
        sib.rule.id = `${previous.id}-gen`;
        effective = current.rules.some(r => r.id === sib.rule.id) ? "UPDATE_EXISTING" : "ADD_NEW";
      }
      sib.rule.provenance = "generalized";
      sib.rule.derivedFromRuleId = sourceId;
      if (typeof sib.axis === "string") sib.rule.generalizedAxis = sib.axis;
      sib.rule.matchedExamples = [];
      sib.rule.learnedFrom = { action: `generalized from ${sourceId}`, actionDir, reflectedAt: new Date().toISOString() };
      const applied = applyReflectionUpdate(config, {
        decision: effective,
        baseVersion: current.version,
        reason: sib.reason ?? `generalized from ${sourceId}`,
        inputPattern: sib.inputPattern,
        outputPattern: sib.outputPattern,
        rule: sib.rule,
      });
      out.push({ id: sib.rule.id, ok: true, version: applied.version });
    } catch (e) {
      out.push({ id, ok: false, error: String(e) });
    }
  }
  return out;
}

/** The generalize turn for an action that did NOT go through a backup subagent (a
 *  built-in handled it). Same prompt, without the trail block. Asked once per
 *  source family per table (recorded in history), not once per matching action. */
export function nativeGeneralizationSource(ctx: HookContext, artifact: BackupArtifact): string {
  const base = `native:${artifact.strategy}`;
  if (artifact.strategy !== "git_snapshot" && artifact.strategy !== "file_copy") return base;
  const view = actionView(ctx);
  const command = view.fields.command ?? "";
  let family: string;
  if (view.toolName === "Edit") {
    family = command.includes("*** Begin Patch") ? "patch" : "edit";
  } else if (view.toolName === "Write") {
    family = "write";
  } else if (view.toolName === "Bash") {
    // The program name, after any leading VAR=value assignments.
    const program = command.trim().match(/^(?:[A-Za-z_][A-Za-z_0-9]*=\S+\s+)*([^\s]+)/)?.[1] ?? "unknown";
    family = `shell:${program}`;
  } else {
    family = view.toolName;
  }
  // The key includes the prompt version, so a new prompt re-asks each family.
  return `${base}:v10:${family}`;
}

/** A generalize answer counts when it lists siblings and either proposes none or at least one applied. */
export function generalizationAccepted(answer: { siblings?: unknown[] }, applied: Array<Record<string, unknown>>): boolean {
  return Array.isArray(answer.siblings) && (answer.siblings.length === 0 || applied.some(x => x.ok === true));
}

/** A built-in source that keeps failing (runner down, unparseable answers) is given
 *  up on after this many tries per table; otherwise every later action of that
 *  family would block its hook on another model call. */
const MAX_NATIVE_GENERALIZE_FAILURES = 2;
// Queue only: runBackup flushes the queue after all backup tiers have run.
const deferred: Array<() => void> = [];

/** Queue a generalize turn for an action a built-in rule backed up. */
export function generalizeAfterNativeRule(ctx: HookContext, dir: string, artifact: BackupArtifact, config: SandboxConfig): void {
  if (!config.selfImproving || !config.selfImprovingGeneralize) return;
  deferred.push(() => generalizeNativeNow(ctx, dir, artifact, config));
}

/** Run every queued generalize turn; each one writes its own receipt. */
export function flushDeferredGeneralizations(): void {
  for (const job of deferred.splice(0)) {
    try {
      job();
    } catch { /* receipts carry the error */ }
  }
}

/** Parse a generalize reply: the first JSON object with a `siblings` array. */
function parseGeneralizeAnswer(raw: string) {
  const parsed = extractJsonObject<GeneralizeAnswer>(
    raw,
    o => !!o && typeof o === "object" && Array.isArray((o as { siblings?: unknown }).siblings),
  );
  if (!parsed) throw new Error("generalize returned no JSON");
  return parsed;
}

/** Write a receipt as pretty-printed JSON. */
function writeReceipt(file: string, receipt: Record<string, unknown>) {
  fs.writeFileSync(file, JSON.stringify(receipt, null, 2) + "\n");
}

/**
 * Run the generalize turn for a built-in source now, unless this source was already
 * generalized or has failed too often. Writes generalization-<source>.json.
 */
export function generalizeNativeNow(ctx: HookContext, dir: string, artifact: BackupArtifact, config: SandboxConfig): void {
  if (!config.selfImproving || !config.selfImprovingGeneralize) return;
  const sourceId = nativeGeneralizationSource(ctx, artifact);
  const receipt = path.join(dir, `generalization-${sourceId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
  let promptAudit = "";
  let responseAudit = "";
  let attempted = false;
  try {
    const table = loadLearnedBackupTable(config);
    if (table.history.some(h => h.generalizedSource === sourceId)) return;
    const failures = table.history.filter(h => h.generalizeFailedSource === sourceId).length;
    if (failures >= MAX_NATIVE_GENERALIZE_FAILURES) return;
    attempted = true;
    const prompt = generalizePrompt(actionView(ctx), table);
    promptAudit = redact(prompt);
    const raw = callModel(prompt, config);
    responseAudit = redact(raw);
    const parsed = parseGeneralizeAnswer(raw);
    const applied = applyGeneralization(config, sourceId, parsed, dir);
    if (!generalizationAccepted(parsed, applied)) throw new Error("all generalized candidates failed format/update parsing");
    recordGeneralizedSource(config, sourceId);
    writeReceipt(receipt, {
      ok: true,
      sourceRuleId: sourceId,
      principle: parsed.principle,
      notExtended: parsed.notExtended,
      applied,
      parsed,
      promptRedacted: promptAudit,
      responseRedacted: responseAudit,
      recordedAt: new Date().toISOString(),
    });
  } catch (e) {
    if (attempted) {
      try {
        recordGeneralizedSource(config, sourceId, "generalizeFailedSource");
      } catch {}
    }
    try {
      writeReceipt(receipt, {
        ok: false,
        sourceRuleId: sourceId,
        error: String(e),
        promptRedacted: promptAudit,
        responseRedacted: responseAudit,
        recordedAt: new Date().toISOString(),
      });
    } catch {}
  }
}

/** Run the generalize turn for a rule the reflection just wrote, with the backup's trail. Writes generalization.json. */
export function generalizeAfterReflection(ctx: HookContext, dir: string, sourceId: string, config: SandboxConfig): void {
  if (!config.selfImproving || !config.selfImprovingGeneralize) return;
  const receipt = path.join(dir, "generalization.json");
  let promptAudit = "";
  let responseAudit = "";
  try {
    const table = loadLearnedBackupTable(config);
    if (!table.rules.some(r => r.id === sourceId)) throw new Error("source rule absent");
    const prompt = generalizePrompt(actionView(ctx), table, { evidence: evidence(dir), writtenRuleId: sourceId });
    promptAudit = redact(prompt);
    const raw = callModel(prompt, config);
    responseAudit = redact(raw);
    const parsed = parseGeneralizeAnswer(raw);
    const applied = applyGeneralization(config, sourceId, parsed, dir);
    writeReceipt(receipt, {
      ok: true,
      sourceRuleId: sourceId,
      principle: parsed.principle,
      notExtended: parsed.notExtended,
      applied,
      parsed,
      promptRedacted: promptAudit,
      responseRedacted: responseAudit,
      recordedAt: new Date().toISOString(),
    });
  } catch (e) {
    try {
      writeReceipt(receipt, {
        ok: false,
        sourceRuleId: sourceId,
        error: String(e),
        promptRedacted: promptAudit,
        responseRedacted: responseAudit,
        recordedAt: new Date().toISOString(),
      });
    } catch {}
  }
}

/**
 * The reflection turn after a tier-4 backup: ask the model for one table update,
 * stamp the rule with where it was learned, apply it, write reflection.json and,
 * if a rule was written, run the generalize turn.
 */
export function reflectAfterBackup(ctx: HookContext, dir: string, artifact: BackupArtifact, config: SandboxConfig): void {
  if (!config.selfImproving) return;
  const receipt = path.join(dir, "reflection.json");
  let promptAudit = "";
  let responseAudit = "";
  try {
    const table = loadLearnedBackupTable(config);
    const action = canonicalAction(ctx);
    const view = actionView(ctx);
    const request = render(REFLECTION.sections["request"], {
      TABLE_VERSION: table.version,
      TEST_ONLY: table.testOnly,
      TOOL_NAME: JSON.stringify(view.toolName),
      MATCH_FIELDS: JSON.stringify(view.fields),
      WORKDIR: JSON.stringify(view.workdir),
      ATTEMPT: JSON.stringify(artifact),
      EVIDENCE: JSON.stringify(evidence(dir)),
      TABLE: tableForPrompt(table),
    });
    const prompt = [...REFLECTION_INSTRUCTIONS, request].join("\n");
    promptAudit = redact(prompt);

    const raw = callModel(prompt, config);
    responseAudit = redact(raw);
    const parsed = extractJsonObject<ReflectionUpdate>(
      raw,
      o => !!o && typeof o === "object" && typeof (o as { decision?: unknown }).decision === "string",
    );
    if (!parsed) throw new Error("reflection returned no JSON");
    // The host, not the model, records where the rule was learned from.
    if (parsed.rule) {
      parsed.rule.learnedFrom = { action, actionDir: dir, reflectedAt: new Date().toISOString() };
      const example = view.fields[parsed.rule.matchField];
      parsed.rule.matchedExamples = typeof example === "string" ? [example] : [];
      parsed.rule.provenance = "observed";
      delete parsed.rule.derivedFromRuleId;
    }
    const applied = applyReflectionUpdate(config, parsed);
    writeReceipt(receipt, {
      ok: true,
      decision: parsed.decision,
      parsed,
      applied,
      promptRedacted: promptAudit,
      responseRedacted: responseAudit,
      recordedAt: new Date().toISOString(),
    });
    // Own receipt, own try: a failed generalize turn never touches the reflection's outcome.
    if (applied.applied && parsed.rule) generalizeAfterReflection(ctx, dir, parsed.rule.id, config);
  } catch (e) {
    try {
      writeReceipt(receipt, {
        ok: false,
        error: String(e),
        promptRedacted: promptAudit,
        responseRedacted: responseAudit,
        recordedAt: new Date().toISOString(),
      });
    } catch {}
  }
}
