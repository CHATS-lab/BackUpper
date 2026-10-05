---
description: Undo recorded actions with BackUpper
argument-hint: "<N | last> [--file <path>] [--direct]"
---

Restore state captured by BackUpper.

If no argument is given, list the actions first and ask the user which one to undo:

```bash
backupper list
```

Then run:

```bash
backupper restore $ARGUMENTS
```

`restore N` undoes action N and every action after it. `--file <path>` restores a single path as it was before action N (from its snapshot, trash copy or outside-workspace copy). `--direct` undoes only action N. A `[WARN]` line names state that was never captured and so was not restored. If a step prints a restore prompt for state outside the workspace, carry out that prompt's instructions. Report each step's result to the user.
