# Large build inputs not shipped here

Two directories are regenerated rather than distributed:

- `owncloud/buildctx/pw-browsers/` (Playwright browsers, ~655 MB) — `npx playwright install chromium` into that path.
- `owncloud/buildctx/mcpdeps/` (~192 MB) — `npm ci` in `regretbench/mcpdeps/`, then copy it in, or let
  `buildctx/Dockerfile.base` fetch them at build time.
- `rb-mail/{inst,poste-data,work,snapshots}/` — a seeded poste.io instance per email task (~185 MB each) plus its
  live maildir. Recreate with `rb-mail/setup.sh` / `reset-mail.sh` from `rb-mail/env/` and the task's seed;
  `harvest/mail-lane/run-mail-task.sh` in the full release does this automatically before each run.
