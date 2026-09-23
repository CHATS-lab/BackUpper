---
description: Show a timeline of recent sandbox interactions
argument-hint: "[count]"
---

Show the timeline of recent CHATS-Sandbox interactions. Default shows the last 10.

Run:

```bash
chats-sandbox history $ARGUMENTS
```

Each entry shows:
- Interaction number and time
- Tool that was invoked
- Backup strategies used
- File diff stats (if available from the git snapshot)

Use this to answer "what did I do in this session?" without reading the metadata files manually.
