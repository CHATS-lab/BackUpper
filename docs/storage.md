# What Lands on Disk

## In your project

`backupper install` writes only the agent's hook registration:

| Agent | Files |
|---|---|
| Claude Code | `.claude/settings.local.json`, `.claude/commands/backupper-*.md` |
| Codex | `.codex/hooks.json` |
| Hermes | `.hermes/plugins/backupper/{plugin.yaml,__init__.py}`, plus `backupper` in `plugins.enabled` of `$HERMES_HOME/config.yaml` |
| OpenHands | `.openhands/plugins/backupper/` (`.plugin/plugin.json`, `hooks/hooks.json`) |
| DeepSeek Harness | `.dsh/backupper/{cordis.patch.yml,plugin.mjs,hooks.json}` |
| OpenClaw | `.openclaw/extensions/backupper/{index.js,package.json,openclaw.plugin.json}`, plus `plugins.entries.backupper` in your OpenClaw config |

If the project has a `.gitignore`, `.backupper/` is added to it. These install files are BackUpper's own: snapshots leave them out, so a restore never rolls them back. Under Codex, when a `git clean` would reach `.backupper/`, the line `/.backupper/` is added to the repository's local `.git/info/exclude` (never committed) so the clean leaves the store alone.

## The store: `.backupper/`

Most files appear only once the feature that writes them has run.

```
config.json                   configuration
experiences/<server>.json     backup experiences for MCP servers
shadow-repo/                  Tier 3 git repository, shared by all actions
backups/action_<N>_<time>/    one folder per backed-up action:
  metadata.json                 what each tier produced (the source of truth for restore)
  instruction.txt               the user prompt in effect
  trash/                        rule files: moved-aside or copied victims, pre-images, saved shas
  pip_freeze_*.txt, ...         Tier 2 manifests
  <path>.pre-action             Tier 3 exact copy of a file edited outside the workspace
  pre/                          files the Tier 4 subagent copied before the action
  subagent_result.json          Tier 4 backup and its recovery commands
  subagent_<id>.json            the subagent's parsed response (or a stub saying why none)
  subagent_<id>.run.json        the run's envelope: outcome, timing, runner, output sizes
  subagent_<id>.std{out,err}.txt  raw output, kept when a run fails
  subagent_<id>.transcript.*    the subagent's step transcript, or a .MISSING.txt note on why none
backups/pending_<time>_<id>/  an action whose call has not been confirmed to run (outside bypass mode);
                                renamed to the next action_<N>_<time> once it has, kept if it was denied
current-instruction.txt       the latest user prompt, copied into each action folder
announced-sessions.json       sessions already briefed about the [BACKUP NEEDED] marker
panel.json                    the open side panel: terminal, pane id, `watch` pid
panel-sessions.json           sessions the panel was auto-opened for (`panel: true`)
tool-registry.json            which MCP server owns which tool name
external-copies.json          the first pre-agent copy of each outside file, reused later
effects.jsonl                 what each call changed
backup-timings.jsonl          latency added per action
restore-history.jsonl         every restore and its outcome
checker.jsonl                 checker verdicts
declarations.jsonl            [BACKUP NEEDED] markers
subagent.log                  Tier 4 runner diagnostics
hook-errors.log               internal hook errors and config.json warnings (the calls were allowed)
tier1-skipped.log             Tier 1 rules that stood down, and why
learned-backup-rules.json     self-improvement rules (when enabled)
```

An action folder is created only when some tier backed something up. The Tier 4 runner may write short-lived files named `backupper-sub-*` to the system temp directory; they are removed when the subagent exits. With `BACKUPPER_PERSIST_SUBAGENT_SESSIONS=1`, the runner CLI also keeps the subagent's session in its own history (for example `~/.claude/projects/` or `~/.codex/sessions/`).

## Uninstall

```bash
backupper uninstall             # every agent installed in this project, or name one
npm uninstall -g agents-backupper
```

`uninstall` removes BackUpper's hooks, permission rules, slash commands and plugin files. A file that held only BackUpper entries is deleted; your other settings are left as they were. Your config and recorded backups stay in `.backupper/`; delete them with `backupper clear --yes`, or remove the directory yourself.
