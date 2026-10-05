# Claude Code

```bash
backupper install claude-code
```

This writes BackUpper's hooks to `.claude/settings.local.json` (the per-user, uncommitted settings file, since hook commands carry absolute paths), together with permission rules that keep the agent's file tools out of `.backupper/`, and an allow rule for the capture helper used outside bypass mode (see [Permission modes](../how-it-works.md#permission-modes)).

It also adds slash commands: `/backupper-list`, `/backupper-show`, `/backupper-diff`, `/backupper-restore`, `/backupper-status`, `/backupper-config` and `/backupper-clear`.

It also installs the side-panel plugin `backupper@backupper` at local scope (`claude plugin marketplace add <package> --scope local`, then `claude plugin install backupper@backupper --scope local`; `backupper uninstall` removes both). The plugin adds `/backupper-panel`, which toggles a pane beside the transcript without a model turn, even while Claude is working. The pane docks on the right in Claude Code's fullscreen layout from 110 columns and sits above the prompt otherwise. Press `ctrl+x tab` to use its keys (`j`/`k`, `r` then `y` to restore, `d` for the diff, `x` to close) and `esc` to return to the prompt. With `backupper config set panel true` it opens with every session. If `claude` is not on PATH during install, the two commands are printed for you to run.

The backup subagent runs `claude -p` with your existing Claude Code login. It uses `haiku` by default; pick another model with `backupper config set subagentModel <model>`.
