# Prompts

This directory holds every prompt the BackUpper sends to a model: the session
briefing, the read-only checker, the tier-4 backup and restore subagents, the
injected experience block, and the self-improving rule loop's reflection and
generalize turns.

Every prompt the BackUpper sends to a model lives here as **one markdown file per
prompt**, read the way a human reads it. The TypeScript never carries prompt text:
`scripts/gen_prompts.mjs` compiles this directory into `src/prompts.generated.ts`
(generated at build time, not shipped as source), and the code renders `{{TOKEN}}`
placeholders with the `render(text, vars)` helper exported from the same file.

## File format

```
---
name: <file basename>
loaded_from: <the TypeScript site that renders it>
used_in: <where it matters>
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
- Bodies and sections never start or end with a newline; the code that glues a
  fragment in adds any surrounding newlines. That keeps the files robust to
  editors that trim blank lines. Only the file's final newline is dropped.
- `{{TOKEN}}` is replaced in one pass; a substituted value is never re-scanned.
  Unknown tokens are left as they are.

## Build

`npm run build` runs `scripts/gen_prompts.mjs`, which compiles this directory into `src/prompts.generated.ts`,
and then compiles `src/` into `dist/`. The generator checks that each file's
front-matter `placeholders` and `sections` match its text.

What stays in code: data formatting that is not instruction text
(`describePathState`'s path descriptions, transcript cap markers).

## Files

Each file's front-matter names the code that renders it, its placeholders and its sections.

| file | constant | prompt |
|---|---|---|
| `briefing-checker.md` | `BRIEFING_CHECKER` | one-time session briefing for the main agent |
| `subagent-backup.md` | `SUBAGENT_BACKUP` | tier-4 backup subagent |
| `subagent-restore.md` | `SUBAGENT_RESTORE` | tier-4 restore subagent |
| `readonly-checker.md` | `READONLY_CHECKER` | tool-less read-only checker (system prompt + user message) |
| `experiences-render.md` | `EXPERIENCES_RENDER` | data-fenced wrapper for an injected experience playbook |
| `reflection.md` | `REFLECTION` | self-improving reflection turn |
| `generalize.md` | `GENERALIZE` | self-improving generalize turn |
