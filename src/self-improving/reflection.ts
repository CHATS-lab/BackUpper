/**
 * Self-improving turns.
 *
 * Reflection: after a tier-4 backup, one no-tools model call reads the backup's
 * evidence and decides whether to add or update a learned rule (or do nothing).
 * Generalize: after a rule is written (or a built-in rule handled an action), one
 * more call proposes sibling rules. Each turn writes a receipt JSON into the action dir.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { BackupArtifact, HookContext, SandboxConfig } from "../types.js";
import { extractJsonObject } from "../util/extract_json.js";
import { GENERALIZE, REFLECTION, render } from "../prompts.generated.js";
import { buildSubagentInvocation, cleanupSubagentInvocation, runInvocation } from "../backup/subagent.js";
import {
  actionView,
  applyReflectionUpdate,
  canonicalAction,
  loadLearnedBackupTable,
  recordGeneralizedSource,
  type ActionView,
  type LearnedBackupRule,
  type LearnedBackupTable,
  type ReflectionUpdate,
} from "./learned_backup.js";

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
