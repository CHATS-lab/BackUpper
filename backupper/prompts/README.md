# Prompts

The plugin serves checker mode, so the only
prompt files here are the ones a checker-mode run actually renders. The full
Backupper additionally ships the briefings for the other modes and briefing
variants (`briefing-inverted.md`, the `briefing-checker-default.md` "v7" text,
and the shorter `briefing-lite.md` used by the paper's MCP-band runs) and the
self-improving rule loop's prompts (`reflection.md`, `generalize.md`) plus the
self-exploration prompts; none of those are part of this release.

Every prompt the Backupper sends to a model lives here as **one markdown file per
prompt**, read the way a human reads it. The TypeScript never carries prompt text:
`scripts/gen_prompts.mjs` compiles this directory into `src/prompts.generated.ts`
(committed; `dist/` is shipped from it), and the code renders `{{TOKEN}}`
placeholders with the `render(text, vars)` helper exported from the same file.

## File format

```
---
name: <file basename>
loaded_from: <the TypeScript site that renders it>
used_in: <where it matters>
status: <only on a file kept for a legacy code path>
placeholders: [TOKEN, ...]        # every {{TOKEN}} in the body and its sections
sections: [name, ...]             # the named sections, in file order
---

# <title>

<main body>

<!-- section: <name> -->
<a conditional / optional fragment the code glues in>
<!-- /section -->
```

- The **main body** is the prompt as sent; a **section** is a fragment the code
  inserts only in some situation (a category block, a variant of a bullet, an
  optional context block). `SUBAGENT_BACKUP.body` / `SUBAGENT_BACKUP.sections["category-f"]`.
- Bodies and sections never start or end with a newline; where the original code
  glued a fragment in with surrounding newlines, the code still adds them. That
  keeps the files robust to editors that trim blank lines. Only the file's final
  newline is dropped.
- `{{TOKEN}}` is replaced in one pass; a substituted value is never re-scanned
  (exactly like the template-literal interpolation it replaced). Unknown tokens
  are left as they are.
- The same format is parsed by `regretbench/harness/prompt_md.py`, which the
  harness patch scripts use to read the briefings and the checker prompt from here.

## Build and checks

```
node scripts/gen_prompts.mjs            # or: npm run gen:prompts
npm run build:src                       # = gen_prompts + tsc (npm run build does the same first)
node scripts/gen_prompts.mjs --check    # exit 1 if src/prompts.generated.ts is stale
```

The render-equality oracle that pins these texts (`tests/prompts_render_equal.mjs`
+ `tests/prompts_oracle.json`) lives in the development tree and is not shipped with
this release. It renders every prompt from a built `dist/` with fixed sample
inputs and compares against renders taken from the frozen original build; every text
in this directory was checked against it, byte for byte, before the tests were
stripped — including the session briefing, which is rendered by running the real
`UserPromptSubmit` hook as a subprocess.

What stays in code: data formatting that is not instruction text
(`describePathState`'s path descriptions, transcript cap markers).

## Files

### `briefing-checker.md` → `BRIEFING_CHECKER`

- **Rendered by:** backupper/src/hooks/user-prompt.ts buildAnnouncement
- **Used in:** the one-time session briefing of every run — the only briefing in this build
- **Placeholders:** `{{WORKSPACE}}`

No sections: the body is the whole prompt.

This is the text the paper's armed runs actually received. In the full tree it is
`briefing-tier3.md`, and `mode=checker` reached it through an install-time patch
(`regretbench/harness/_readonly_checker.py`) that widened the `tier3-gated` branch
in `buildAnnouncement`. This build has the read-only checker natively, so the hook
serves the text directly and the patch is not needed. The render-equality oracle
checks the delivered briefing byte-for-byte against the reference render recorded with it.

### `subagent-backup.md` → `SUBAGENT_BACKUP`

- **Rendered by:** backupper/src/backup/subagent.ts buildBackupGuidance (main body = the mode=subagent template; sections = its conditional fragments, the inline-mode variant and the claude --system-prompt)
- **Used in:** every tier-3 spawn; inline-backup baseline (cli backup-guidance)
- **Placeholders:** `{{ACTION_DIR}}`, `{{ARGS}}`, `{{BROWSER_PIN_DIRECTIVE}}`, `{{BROWSER_PIN_STATIC}}`, `{{CATEGORY_F}}`, `{{CATEGORY_GUIDANCE}}`, `{{CHECKER_TARGETS_BLOCK}}`, `{{COMMAND}}`, `{{CWD}}`, `{{DIRECTIVE}}`, `{{EXPERIENCE_BLOCK}}`, `{{JUDGED}}`, `{{LEARNED_READONLY_BLOCK}}`, `{{LIVE_RESTORE_BULLET}}`, `{{NO_MCP_DIRECTIVE}}`, `{{PAGE_TEXT}}`, `{{PERSIST_DIR}}`, `{{PICKED_BLOCK}}`, `{{PIN_TARGET}}`, `{{PRE_STATE_BLOCK}}`, `{{RECENT_INPUT_BLOCK}}`, `{{RECOVERY_COMMANDS_BULLET}}`, `{{SHAPE_LINE}}`, `{{TARGET_LINES}}`, `{{TARGET_SOURCE}}`, `{{TOOL_NAME}}`, `{{URL}}`, `{{VALUES}}`

| section | glued in as |
|---|---|
| `system-prompt` | buildSubagentInvocation: `--system-prompt` for a claude backup/restore spawn |
| `directive` | the mode=subagent BE FAST directive ({{DIRECTIVE}}) |
| `directive-source-skill` | {{TARGET_SOURCE}} when an experience file is injected |
| `directive-source-strategy` | {{TARGET_SOURCE}} otherwise |
| `directive-pin-target` | {{PIN_TARGET}} for non-browser actions |
| `browser-pin-static` | {{BROWSER_PIN_STATIC}} for playwright actions |
| `category-guidance` | {{CATEGORY_GUIDANCE}} in mode=subagent |
| `category-a` | pickCategory: local file write outside the workspace |
| `category-b` | pickCategory: git push / curl POST-PUT-DELETE |
| `category-c` | pickCategory: package install |
| `category-d` | pickCategory: export / unset / source |
| `category-f` | pickCategory: any mcp__* / browser tool |
| `category-g` | pickCategory: a program whose targets are not on the command line |
| `no-mcp-directive` | {{NO_MCP_DIRECTIVE}} when the runner cannot wire the action's MCP server |
| `judged-gate` | {{JUDGED}} — the only variant this build renders |
| `shape-line-mcp` | {{SHAPE_LINE}} on an MCP/browser surface |
| `shape-line-shell` | {{SHAPE_LINE}} on a shell surface |
| `recovery-commands-bullet-mcp` | {{RECOVERY_COMMANDS_BULLET}} on an MCP/browser surface |
| `recovery-commands-bullet-shell` | {{RECOVERY_COMMANDS_BULLET}} on a shell surface |
| `live-restore-bullet-mcp` | {{LIVE_RESTORE_BULLET}} on an MCP/browser surface |
| `live-restore-bullet-shell-remote` | {{LIVE_RESTORE_BULLET}} for a shell command reaching a remote system |
| `learned-readonly-block` | {{LEARNED_READONLY_BLOCK}} when learnedReadOnlyEnabled |
| `recent-input-block` | {{RECENT_INPUT_BLOCK}}: values the agent just typed (browser) |
| `checker-targets-block` | {{CHECKER_TARGETS_BLOCK}}: what the read-only checker found |
| `prestate-page` | {{PRE_STATE_BLOCK}} when a fresh page snapshot exists (browser) |
| `prestate-none-browser` | {{PRE_STATE_BLOCK}} browser action without a snapshot |
| `prestate-none-mcp` | {{PRE_STATE_BLOCK}} non-browser MCP action |
| `inline-template` | the whole mode=inline prompt (cli backup-guidance --mode inline) |
| `inline-directive` | {{DIRECTIVE}} in mode=inline |
| `inline-category-guidance` | {{CATEGORY_GUIDANCE}} in mode=inline |

### `subagent-restore.md` → `SUBAGENT_RESTORE`

- **Rendered by:** backupper/src/restore/restore.ts buildSubagentRestorePrompt
- **Used in:** tier-3 restore
- **Placeholders:** `{{ACTION}}`, `{{ARTIFACT_PATH}}`, `{{CAPTURED_BLOCK}}`, `{{COMMANDS}}`, `{{DESCRIPTION}}`, `{{JSON}}`

| section | glued in as |
|---|---|
| `captured-state-block` | {{CAPTURED_BLOCK}} when remote-state.json exists beside the artifact |
| `no-commands-line` | {{COMMANDS}} when no backup commands were recorded |

### `readonly-checker.md` → `READONLY_CHECKER`

- **Rendered by:** backupper/src/backup/readonly_checker.ts READONLY_CHECKER_SYSTEM_PROMPT (main body = system prompt) + buildCheckerInput (input-* sections = the user message); also read by regretbench/harness/_readonly_checker.py
- **Used in:** checker-mode runs
- **Placeholders:** `{{ARGS}}`, `{{CONTENT}}`, `{{PATH}}`, `{{SOURCE}}`, `{{TOOL_NAME}}`

| section | glued in as |
|---|---|
| `input-action` | user message part 1 (the call) |
| `input-content` | user message part 2 (paths' state + program source) |
| `input-program` | one PROGRAM block inside part 2 |
| `input-no-content` | {{CONTENT}} when nothing could be described |
| `input-output` | user message part 3 (the output contract, restated) |

### `experiences-render.md` → `EXPERIENCES_RENDER`

- **Rendered by:** backupper/src/explore/experiences.ts renderExperiencesForPrompt (main body = the data-fenced wrapper; sections = the legacy per-pattern fallback)
- **Used in:** every spawn with an experience file
- **Placeholders:** `{{ACTION}}`, `{{BODY}}`, `{{HOW}}`, `{{INVERSE}}`, `{{N}}`, `{{PIN}}`, `{{SERVER}}`

| section | glued in as |
|---|---|
| `legacy-line` | one per verified pattern (pre-playbook experience files) |
| `legacy-reverter` | {{HOW}} for a creation-only pattern |
| `legacy-none` | {{HOW}} when nothing was recorded |
