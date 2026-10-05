# Self-improving BackUpper (reflection + learned rules)

`learned.ts` holds the rule table and matches, executes and writes it (its first half),
and runs the two model turns (its second half). The prompts are the `reflection` and
`generalize` sections of the top-level `prompts.md`; the wiring is in
`src/backup/strategies.ts` (tier 4).

Everything the model can do is write rules. Runtime matching and execution never call a model.

## Flow

```
PreToolUse hook (one process per tool call)
  tier 1-3   built-ins (command rewriting, command pairing, snapshot, external file copy)
  tier 4     only when the action needs a backup beyond the built-ins:
             1. learned rules: observed rules first, then generalized; first match whose steps
                succeed and produce the expected artifacts wins  ->  done, no model call
             2. miss / step failure / artifact missing  ->  backup subagent
                subagent done  ->  reflection (1 model call)  ->  table updated
                                    -> rule written?  ->  generalize, WITH trail (1 model call)
  after every tier has run (never in between):
             generalize, WITHOUT trail, for actions a built-in handled
             (command pairing, snapshot, file copy) — once per source family per table
```

Switches: `selfImproving`, `selfImprovingGeneralize`, `learnedBackupRulesPath`, `reflectionSubagentRunner` /
`reflectionSubagentModel` (see the top-level README).

## Rule matching and execution (learned.ts)

- A rule names `toolName`, `matchField`, `actionRegex`. The regex (JavaScript, no flags) runs on the
  raw text of that one tool-input field; the backup-declaration marker is removed from the text.
  Other fields are context only.
- `workdir` (tool input `workdir`/`cwd`, else hook cwd) is the steps' cwd; capture type `path`
  resolves against it; `binding:"workdir"` passes it.
- Steps run via `spawnSync` with `shell:false`; non-zero exit, missing capture, or an expected
  artifact not beneath `actionDir` → that rule fails, the next rule is tried, then the subagent.
- Observed rules are tried before generalized ones.
- Parse-time format checks only: id, regex compiles, captures typed, args well formed, artifacts
  under `actionDir`, steps reference `actionDir` at least once. No judge, no execution test.

## Reflection (learned.ts, `REFLECTION_INSTRUCTIONS`)

- Trigger: after every subagent attempt (artifact, read-only verdict, failure).
- Input: the action (raw fields + workdir), the subagent's trail (its result, artifact inventory,
  tool calls and results from its transcript, and any learned-rule failures on this action), and the
  current table (rules only).
- Output: `inputPattern`, `outputPattern`, `UPDATE_EXISTING | ADD_NEW | DO_NOTHING`, optional rule.
- Written rules get `provenance:"observed"` and keep their `matchedExamples`.

## Generalize (learned.ts, `GENERALIZE_INSTRUCTIONS`)

- One body, two forms; the only difference is the trail block. It is told nothing about how the
  backup system runs.
- Generalization happens per action, as each rule is written. The rule table is context for the
  ADD/UPDATE decision, never the subject of a table-wide pass.
- Writing: ADD_NEW, or UPDATE_EXISTING of a generalized rule. An update aimed at an observed rule is
  stored beside it as `<id>-gen`; observed rules are never rewritten. Rules get
  `provenance:"generalized"`, `derivedFromRuleId`, `generalizedAxis`, empty `matchedExamples`.
- Built-in sources are asked once per source family per table (`history[].generalizedSource`); after
  two failed turns the family is not asked again (`history[].generalizeFailedSource`). All
  built-in-triggered turns are deferred to the end of `runBackup`, so no model call sits between an
  action and its backup.
