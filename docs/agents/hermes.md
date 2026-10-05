# Hermes

```bash
backupper install hermes
```

This writes a plugin to `.hermes/plugins/backupper/`. Hermes loads project plugins only when `HERMES_ENABLE_PROJECT_PLUGINS=1` is set in its environment.

The backup subagent runs `hermes chat` with your configured provider and its default model; pick another with `backupper config set subagentModel <model>`.
