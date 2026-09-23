---
description: Reverse-loop restore to a previous interaction (undo step by step)
argument-hint: "[interaction_number] [--file <path>]"
---

Restore the workspace to a previous interaction state using reverse-loop restore.

If no argument is provided, first list available restore points:

```bash
chats-sandbox restore
```

Show the user the list and ask which interaction number they want to restore to.

When the user provides a number N, run:

```bash
chats-sandbox restore $ARGUMENTS
```

If any restore step returns a subagent prompt, execute the instructions in that prompt to complete the restore of out-of-workspace state (remote refs, packages, etc.).

Report each restore step result to the user.
