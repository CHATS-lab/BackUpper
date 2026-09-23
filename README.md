# RegretBench + Backupper

Two things live here:

- **RegretBench** — a benchmark of tasks in which a *legitimate* instruction destroys state that cannot be
  recovered. The question a task asks is not "will the agent refuse?" but "will it preserve what the step is
  about to destroy, before taking it?" Twenty tasks ship here across five environments (terminal, PostgreSQL,
  browser/Playwright, e-mail, Kubernetes), each with a container image, a seeded environment, and a judge.
- **Backupper** — the defense: a `PreToolUse` hook that runs *before* each tool call and captures whatever that
  call is about to overwrite or delete, so the action becomes undoable instead of refused. Cheap mechanical
  tiers (policy rewrite → targeted manifest → workspace snapshot → external file copy) run on every mutating
  call; the one expensive tier, a backup subagent, runs when the agent marks the step `[Backup needed]` **or**
  a tool-less read-only checker judges the call to be not read-only.

The release exists to reproduce **one comparison**: the same task, same agent, with and without the Backupper.

## Run it

```bash
cd backupper && npm ci && npm run build && cd ..          # build the plugin once

./run_regretbench.sh --task imgfold-scan-review --harness claude --backupper off --judge
./run_regretbench.sh --task imgfold-scan-review --harness claude --backupper on  --judge
```

`run_regretbench.sh` is the only entry point (`--help` lists the flags and the 20 task slugs). It stands up the
task container, the sibling service an MCP task needs (forum / ownCloud / GitLab / mail / k3s), runs the agent,
and — with `--judge` — prints the verdict: did the agent destroy the protected state, and did it back it up first.
Prerequisites, credentials and the environment variables for the runtimes that are **not** shipped are in
[`QUICKSTART.md`](QUICKSTART.md); what has been checked and how to re-check it is in [`VERIFICATION.md`](VERIFICATION.md).

## What is in the zip

```
run_regretbench.sh        the only entry point
QUICKSTART.md             prerequisites, the two arms, how to read a verdict
SELECTION.md              the 20 tasks included here
VERIFICATION.md           what was verified, and the commands to re-run those checks
backupper/                the plugin: src/, prompts/ (5 markdown files), experiences/, README.md
regretbench/
  tasks/                  20 tasks: task.yaml (turns + grading), Dockerfile, seed, checker
  envs/                   the sibling services the MCP tasks need
  harness/                container setup, the agent adapters, the two judges
  prompts/                judge-main.md, judge-subagent-quality.md
scripts/                  check_prompts.py, check_references.py
```

## Notes

- **20 of the benchmark's 205 tasks are included here due to size limit**
