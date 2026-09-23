---
description: Show what changed between an interaction and the current state
argument-hint: "<interaction_number>"
---

Show what changed between an interaction snapshot and the current workspace state.

If no argument is provided, ask the user which interaction number to diff against.

Run:

```bash
chats-sandbox diff $ARGUMENTS
```

Show the stat summary first (files changed, insertions, deletions). Then show the full diff if the user wants details.
