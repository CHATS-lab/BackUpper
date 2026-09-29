---
description: List the actions BackUpper recorded in this project
argument-hint: "[--limit N]"
---

List the actions BackUpper captured before they ran:

```bash
backupper list $ARGUMENTS
```

Show the user the list. Each row is one tool call: its number, time, the tiers that captured it, and the call itself. To see one action in full, use `/backupper-show <N>`.
