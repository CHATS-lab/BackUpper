---
description: Delete all recorded BackUpper backups (keeps hooks and config)
argument-hint: "[--yes]"
---

Without `--yes` this only lists what would be deleted:

```bash
backupper clear
```

Deleting backups is permanent. Only run `backupper clear --yes` after the user explicitly confirms.
