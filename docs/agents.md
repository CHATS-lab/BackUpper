# Agents

Per-agent setup: [Claude Code](#claude-code), [Codex](#codex), [Hermes](#hermes).

## Claude Code

```bash
backupper install claude-code
```

This writes BackUpper's hooks to `.claude/settings.local.json` (the per-user, uncommitted settings file, since hook commands carry absolute paths), together with permission rules that keep the agent's file tools out of `.backupper/`, and an allow rule for the capture helper used outside bypass mode (see [Permission modes](how-it-works.md#permission-modes)).

It also adds slash commands: `/backupper-list`, `/backupper-show`, `/backupper-diff`, `/backupper-restore`, `/backupper-status`, `/backupper-config` and `/backupper-clear`.

It also installs the side-panel plugin `backupper@backupper` at local scope (`claude plugin marketplace add <package> --scope local`, then `claude plugin install backupper@backupper --scope local`; `backupper uninstall` removes both). The plugin adds `/backupper-panel`, which toggles a pane beside the transcript without a model turn, even while Claude is working. The pane docks on the right in Claude Code's fullscreen layout from 110 columns and sits above the prompt otherwise. Press `ctrl+x tab` to use its keys (`j`/`k`, `r` then `y` to restore, `d` for the diff, `x` to close) and `esc` to return to the prompt. With `backupper config set panel true` it opens with every session. If `claude` is not on PATH during install, the two commands are printed for you to run.

The backup subagent runs `claude -p` with your existing Claude Code login. It uses `haiku` by default; pick another model with `backupper config set subagentModel <model>`.

## Codex

```bash
backupper install codex
```

This writes `.codex/hooks.json`. Codex runs a new hook only after you trust it: open `codex` once in the project and approve the hooks, or pass `--dangerously-bypass-hook-trust` for vetted automation.

**Tier 1 under Codex.** Codex takes the same Tier-1 path as Claude Code: the hook hands back a rewritten command (for example `rm notes.txt` becomes a move into the action's trash) and Codex runs that instead of the original. Codex applies a rewritten `updatedInput` only when the same hook output also says `"permissionDecision": "allow"`, so for Codex (and only Codex) the hook adds it. In Codex this does not bypass anything: its approval policy, exec policy and sandbox still run on the rewritten command. Without it Codex would discard the rewrite and run the original command after the hook had already performed it, so the effect would happen twice. `BACKUPPER_NO_REWRITE=1` selects copy-only behaviour instead: Tier 1 copies what the command is about to destroy and lets Codex run the original command once; restore uses the copy.

The backup subagent runs `codex exec` with your existing Codex login. It uses `gpt-6-luna` by default; pick another model with `backupper config set subagentModel <model>`.

### Side panel

Type `!backupper panel` (or `!backupper panel on|off`) in Codex. Codex runs a `!`-prefixed line as a local shell command without starting a turn. Codex has no plugin slash commands: it answers `/backupper-panel` with "Unrecognized command" before any hook runs. You can also run `backupper panel` in another terminal.

## Hermes

```bash
backupper install hermes
```

This writes a plugin to `.hermes/plugins/backupper/`. Hermes loads project plugins only when `HERMES_ENABLE_PROJECT_PLUGINS=1` is set in its environment.

The backup subagent runs `hermes chat` with your configured provider and its default model; pick another with `backupper config set subagentModel <model>`.

### Side panel

Type `/backupper-panel [on|off|status]` in a Hermes session. The plugin registers it as a Hermes slash command, so Hermes runs it locally and it never reaches the model. On a Hermes build without plugin slash commands, run `backupper panel` in another terminal instead.
