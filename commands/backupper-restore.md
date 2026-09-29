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

`restore N` undoes action N and every action after it. `--file <path>` restores a single workspace file from action N's snapshot. If a step prints a restore prompt for state outside the workspace, carry out that prompt's instructions. Report each step's result to the user.
