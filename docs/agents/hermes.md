# Hermes

```bash
backupper install hermes
```

This writes a plugin to `.hermes/plugins/backupper/`. Hermes loads project plugins only when `HERMES_ENABLE_PROJECT_PLUGINS=1` is set in its environment.

The backup subagent runs `hermes chat` with your configured provider and its default model; pick another with `backupper config set subagentModel <model>`.

## Side panel

BackUpper's Hermes plugin does not intercept prompts, so there is no in-chat toggle. Run `backupper panel` (or `backupper panel on|off`) in another terminal.
