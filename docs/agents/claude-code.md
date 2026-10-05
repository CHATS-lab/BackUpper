# Claude Code

```bash
backupper install claude-code
```

This writes BackUpper's hooks to `.claude/settings.local.json` (the per-user, uncommitted settings file, since hook commands carry absolute paths), together with permission rules that keep the agent's file tools out of `.backupper/`.

It also adds slash commands: `/backupper-list`, `/backupper-show`, `/backupper-diff`, `/backupper-restore`, `/backupper-status`, `/backupper-config` and `/backupper-clear`.

`/backupper-panel [on|off|status]` toggles the side panel. The UserPromptSubmit hook answers it and blocks the prompt, so it never reaches the model and costs no turn.

The backup subagent runs `claude -p` with your existing Claude Code login. It uses `haiku` by default; pick another model with `backupper config set subagentModel <model>`.
