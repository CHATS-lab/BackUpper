---
description: Toggle the BackUpper side panel (live captures, restore with r)
argument-hint: "[on|off|toggle|status]"
---

BackUpper's prompt hook normally answers this command itself, so it never reaches you. If you are reading this, the hook did not run; toggle the panel directly:

```bash
backupper panel $ARGUMENTS
```

Relay the command's output to the user in one or two lines. Do nothing else.
