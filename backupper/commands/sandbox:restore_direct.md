---
description: Direct jump restore to an interaction's snapshot (fast, workspace only)
argument-hint: "[interaction_number]"
---

Directly jump to an interaction's snapshot (fast workspace restore).

If no argument is provided, list available restore points:

```bash
chats-sandbox restore_direct
```

When the user provides a number N, run:

```bash
chats-sandbox restore_direct $ARGUMENTS
```

This is faster than `/sandbox:restore` but only covers workspace files. Use this when you only need to roll back file changes, not packages or remote state.
