# Hermes

```bash
backupper install hermes
```

This writes a plugin to `.hermes/plugins/backupper/`. Hermes loads project plugins only when `HERMES_ENABLE_PROJECT_PLUGINS=1` is set in its environment.

The backup subagent runs `hermes chat` with your configured provider and its default model; pick another with `backupper config set subagentModel <model>`.

## Side panel

Type `/backupper-panel [on|off|status]` in a Hermes session. The plugin registers it as a Hermes slash command, so Hermes runs it locally and it never reaches the model. On a Hermes build without plugin slash commands, run `backupper panel` in another terminal instead.
