# Codex

```bash
backupper install codex
```

This writes `.codex/hooks.json`. Codex runs a new hook only after you trust it: open `codex` once in the project and approve the hooks, or pass `--dangerously-bypass-hook-trust` for vetted automation.

**Tier 1 under Codex.** Claude Code and Hermes run the rewritten command the hook hands back; Codex ignores a rewrite and always runs the original. Under Codex, Tier 1 therefore never executes anything itself: it copies what the command is about to destroy (the file an `rm` or `sed -i` targets, the commit of a dropped stash, the HEAD before `git reset --hard`, a file an `mv` would overwrite) and lets Codex run the command once. Restore uses the copy. `BACKUPPER_NO_REWRITE=1` selects the same copy-only behaviour on any agent.

The backup subagent runs `codex exec` with your existing Codex login. It uses `gpt-6-luna` by default; pick another model with `backupper config set subagentModel <model>`.
