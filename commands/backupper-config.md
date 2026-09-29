---
description: Show or change BackUpper configuration
argument-hint: "[set <key> <value>]"
---

Show the configuration:

```bash
backupper config
```

Change a setting:

```bash
backupper config set $ARGUMENTS
```

Common keys: `mode` (checker | off), `subagentEnabled` (true | false), `subagentRunner` (auto | claude | codex | hermes), `subagentModel` (empty = the runner's default), `maxActions` (0 = unlimited), `verbose`.
