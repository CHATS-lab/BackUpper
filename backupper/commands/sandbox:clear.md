---
description: Delete all CHATS-Sandbox backups, shadow repo, and effect log
argument-hint: "[--yes]"
---

Delete all CHATS-Sandbox backup state. Leaves hooks and config intact.

Without `--yes`, shows a dry-run listing of what would be deleted:

```bash
chats-sandbox clear
```

With `--yes`, actually deletes everything:

```bash
chats-sandbox clear --yes
```

This is useful for starting fresh in a long-running session where the backups have accumulated noise. To fully uninstall the plugin (including hooks and config), use `/sandbox:uninstall` or `chats-sandbox uninstall` instead.
