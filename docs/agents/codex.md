# Codex

```bash
backupper install codex
```

This writes `.codex/hooks.json`. Codex runs a new hook only after you trust it: open `codex` once in the project and approve the hooks, or pass `--dangerously-bypass-hook-trust` for vetted automation.

**Tier 1 under Codex.** Codex takes the same Tier-1 path as Claude Code: the hook hands back a rewritten command (for example `rm notes.txt` becomes a move into the action's trash) and Codex runs that instead of the original. Codex applies a rewritten `updatedInput` only when the same hook output also says `"permissionDecision": "allow"`, so for Codex (and only Codex) the hook adds it. In Codex this does not bypass anything: its approval policy, exec policy and sandbox still run on the rewritten command. Without it Codex would discard the rewrite and run the original command after the hook had already performed it, so the effect would happen twice. `BACKUPPER_NO_REWRITE=1` selects copy-only behaviour instead: Tier 1 copies what the command is about to destroy and lets Codex run the original command once; restore uses the copy.

The backup subagent runs `codex exec` with your existing Codex login. It uses `gpt-6-luna` by default; pick another model with `backupper config set subagentModel <model>`.

## Side panel

Type `!backupper panel` (or `!backupper panel on|off`) in Codex. Codex runs a `!`-prefixed line as a local shell command without starting a turn. Codex has no plugin slash commands: it answers `/backupper-panel` with "Unrecognized command" before any hook runs. You can also run `backupper panel` in another terminal.
