<div align="center">
<h1>BackUpper: Undo for Coding Agents</h1>

[![GitHub](https://img.shields.io/badge/GitHub-BackUpper-181717?style=for-the-badge&logo=github&logoColor=white)](https://github.com/xli04/BackUpper) [![Node](https://img.shields.io/badge/Node-%E2%89%A518-339933?style=for-the-badge&logo=node.js&logoColor=white)](#installation) [![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)](LICENSE)

<strong>Supports:</strong>&nbsp;
<a href="#per-agent-notes"><img src="https://img.shields.io/badge/Claude_Code-D97757?style=flat-square&logo=anthropic&logoColor=white" alt="Claude Code"></a>
<a href="#per-agent-notes"><img src="https://img.shields.io/badge/Codex-000000?style=flat-square&logo=data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAABm0lEQVR42rVSK6jCYBj9f7FoG75A0KRNWbDKQAQxGuRHYWCRgWYRLBo0DCwqBrUJLojY7C74aGPJMNGyMIQN8QEKv7pbLj7GhcsN97SP7xy+7xwO1HUd/AUm8EeYDfP9fud5fr/fRyIRm832ywWMMU3T6/UaABCNRlOpVCaTEUXxQ6G/odVqTSaTxWKBEOr3+8fjUVXVZDK5Wq2enJeAYRiSJGVZTiQSmqaVy+VYLMYwzGw2q1QqT9q3h+l06vP5XC4XhFBV1VwudzqdstlsIBCoVqt2u91oervdhkIhnufP57PX6+U47vF4hMNht9vNsmy9Xpdl2ePxvExTFMVxHE3TtVpNURSMMcaYIIhSqTQcDuPx+HK5/Ljg9/vNZnOxWGRZdrPZUBTldDoPh4PFYgEACIKAEDLGShBEoVDodrudTiedTrfbbavVquv6aDSCEAaDQWOskiQhhDRNu16vzWYTISRJ0mAwGI/H79HD9y6Jotjr9W63myAI+Xx+t9spitJoNEym1yPwx/JdLpf5fO5wOEiSNKzgv7f1C7WV+mn4U8OsAAAAAElFTkSuQmCC&logoColor=white" alt="Codex"></a>
<a href="#per-agent-notes"><img src="https://img.shields.io/badge/%E2%9A%95%EF%B8%8F_Hermes-6B4FBB?style=flat-square" alt="Hermes"></a>
</div>

---

<p align="center">
  <a href="#quickstart">Quickstart</a> |
  <a href="#try-it-without-an-agent">Try It Without an Agent</a> |
  <a href="#dashboard">Dashboard</a> |
  <a href="#how-it-works">How It Works</a> |
  <br>
  <a href="#configuration">Configuration</a> |
  <a href="#citation">Citation</a>
</p>

**BackUpper** gives your coding agent an undo button. It sits in front of every tool call and keeps a copy of whatever that call is about to delete or overwrite, so a bad step can be rolled back with one command. Just `npm install -g agents-backupper`, run `backupper install` for your agent, and keep working. Everything it records stays in `.backupper/` inside your project.

## What it does

- **Deleted files** go to a per-action trash instead of disappearing.
- **Workspace edits** are covered by a git snapshot taken before the call.
- **Package installs and environment changes** get a manifest (`pip freeze`, `npm list`, env dump).
- **State outside the workspace** (a database row, a cluster object, a mailbox) is captured by a
  short-lived backup subagent, which also writes down how to restore it.

The capture happens inside the hook, so the agent normally carries on without pausing.

## Installation

Requirements: Node.js 18 or newer, and git (used for workspace snapshots). Tested on Linux;
macOS should work; on Windows use WSL.

```bash
npm install -g agents-backupper
```

This installs the `backupper` command.

To install from source instead:

```bash
git clone https://github.com/xli04/BackUpper.git && cd BackUpper
npm ci && npm link              # npm ci also builds dist/ (the prepare script)
```

## Quickstart

Run these in the project you want to protect:

```bash
backupper init                  # create .backupper/ with the default config
backupper install claude-code   # or: codex | hermes
backupper doctor                # check the agent, hooks, config, git and the backup runner
```

`backupper doctor --probe` also makes one tiny real model call through the backup runner, to
confirm its login works.

Now use your agent as usual. Each call that can change state is captured first. See what was
recorded:

```bash
backupper list                  # recorded actions, oldest first
backupper show --latest         # what the last action captured, and how to undo it
backupper diff 3                # workspace changes since action #3's snapshot
backupper status                # installed hooks, tier-3 runner, number and size of actions
```

And undo:

```bash
backupper restore 3                      # undo action #3 and every action after it
backupper restore last                   # undo only the most recent action
backupper restore 3 --direct             # apply only action #3's own backups, leave later actions alone
backupper restore 3 --file src/app.py    # restore one workspace file from action #3's snapshot
backupper restore 3 --file /etc/app.conf # restore a file outside the workspace from action #3's copy
```

`restore N` first undoes every later action, newest first, so the result is the state just
before action N. `--direct` skips that and applies only action N's backups, which is useful
when later actions touched unrelated state.

Settings and other commands:

```bash
backupper config                # effective value of every setting (--json for machines)
backupper config get maxActions # one setting
backupper config set maxActions 100
backupper --version
backupper <command> --help      # usage of one command; it does nothing else
```

## Try it without an agent

No agent and no API key needed:

```bash
backupper demo
```

The demo creates a scratch project in a temporary directory and sends two tool calls through
the real hook, exactly as Claude Code would: an `rm` of a file and an overwrite of another.
It shows what was recorded, restores both files and checks their contents. Pass `--keep` to
keep the scratch project, or `--json` for a machine-readable result.

## Dashboard

```bash
backupper dashboard             # http://127.0.0.1:7321 (the next free port if taken)
```

A local web page for this project's store: a timeline of actions with their diffs, storage
use, the restore log, the capture playbooks (experiences) and an editable configuration. It
listens on 127.0.0.1 only and rejects requests whose Host or Origin is not that address.

## How it works

The hook runs before each tool call and tries four tiers, cheapest first. Tiers 0 to 2 run
locally in milliseconds. Tier 3 is the only one that makes a model call.

| tier | what it captures | example |
|---|---|---|
| 0 | **Policy rules.** A known destructive command is rewritten into a reversible one, or (on Codex) its target is copied first; the inverse is recorded. | `rm notes.txt` becomes a move into the action's trash |
| 1 | **Targeted manifest.** The state a command is about to change. | `pip freeze` before `pip install`, `npm list` before `npm install` |
| 2 | **Workspace snapshot.** A commit in a private shadow git repo, plus an exact copy of a single file edited outside the workspace. | before an `Edit`, or a script that rewrites files |
| 3 | **Backup subagent.** A one-shot agent captures state no local snapshot can reach, and writes down how to restore it. | a database row, a mailbox, a cluster object, a web page |

**Tier 0 on Codex.** Claude Code and Hermes run the rewritten command the hook hands back;
Codex ignores a rewrite and always runs the original. Under Codex, tier 0 therefore never
executes anything itself: it copies what the command is about to destroy (the file an `rm`
or `sed -i` targets, the commit of a dropped stash, the HEAD before `git reset --hard`, a
file an `mv` would overwrite) and lets Codex run the command once. Restore uses the copy.
`BACKUPPER_NO_REWRITE=1` selects the same copy-only behaviour on any agent.

**When tier 3 runs.** Tiers 0 to 2 run on every mutating call, so their protection never
depends on the agent. Tier 3 runs only when all of these hold:

- the call touches state outside the workspace;
- tiers 0 to 2 did not already capture that state;
- the agent marked the step, or the checker judged the call not read-only.

**The `[Backup needed]` marker.** At the start of each session the agent is told to add the
text `[Backup needed]` to a step that would destroy state the hook cannot see.

**The checker.** A read-only model call with no tools. It judges calls the agent did not
mark, because the common failure is an agent that forgets to mark. The hook never relies on
the agent's own account of what is at risk; it performs its own capture.

**The backup subagent follows your agent.** Under Claude Code it runs `claude -p`, under
Codex `codex exec`, and under Hermes `hermes chat`, each with that CLI's existing login, so
no extra key is needed. By default it uses a cheap model: `haiku` for Claude Code and
`gpt-6-luna` for Codex; Hermes uses its configured provider's default. Pick another with
`backupper config set subagentModel <model>`, or another CLI with `subagentRunner`.

**The backup subagent has full permissions.** A capture may need to run arbitrary commands
(a database dump, a `kubectl get`, a copy outside the project), so the subagent runs without
approval prompts and with your user's access: Claude Code with `--dangerously-skip-permissions`
(`bypassPermissions`; set `subagentPermissionMode` to `acceptEdits` to limit it to file
edits), Codex with `--sandbox danger-full-access`, and Hermes with `--yolo`. It is told to
only read and copy, never to change the target, but nothing enforces that beyond its
instructions. The checker, which only classifies a call, runs with no tools (Claude) or a
read-only sandbox (Codex). Turn tier 3 off with `backupper config set subagentEnabled false`.

**If the hook hits an internal error**, it lets the call through, prints the error to stderr
and appends it to `.backupper/hook-errors.log`.

**Optional features:**

- **Personalization** limits what tier 3 protects to one preference: hard to reverse,
  effects the user did not ask for, or human-authored content.
- **Self-improvement** adds one reflection turn after each tier-3 capture. It writes a
  deterministic rule, so the next similar call is handled without a subagent.
- **Experiences** are per-MCP-server capture playbooks, added to the subagent's prompt.
  `backupper init` copies a starter set for `playwright`, `k8s`, `postgres` and `email`
  servers into `.backupper/experiences/`.

**Undo.** `restore N` undoes action N and every later action, newest first, replaying each
tier's inverse: trashed files move back, packages are reinstalled from manifests, snapshots
are checked out, and tier-3 recovery commands run. When a tier-3 capture needs a live
restore, `restore` prints a prompt to give your agent instead. A file edited outside the
workspace is copied back from its exact pre-action copy. A restore cannot bring back
something that was never captured.

## Per-agent notes

**Claude Code.** `install claude-code` writes hooks to `.claude/settings.local.json` (the
per-user, uncommitted settings file, since hook commands carry absolute paths), with
permission rules that keep the agent's file tools out of `.backupper/`. It also adds slash
commands: `/backupper-list`, `/backupper-show`, `/backupper-diff`, `/backupper-restore`,
`/backupper-status`, `/backupper-config` and `/backupper-clear`.

**Codex.** `install codex` writes `.codex/hooks.json`. Codex runs a new hook only after you
trust it: open `codex` once in the project and approve the hooks, or pass
`--dangerously-bypass-hook-trust` for vetted automation.

**Hermes.** `install hermes` writes a plugin to `.hermes/plugins/backupper/`. Hermes loads
project plugins only when `HERMES_ENABLE_PROJECT_PLUGINS=1` is set in its environment.

## Configuration

Show the effective configuration with `backupper config` (add `--json` for machine-readable
output), and change a key with `backupper config set <key> <value>`. The file is
`.backupper/config.json`; missing keys take their defaults. JSON values are passed as one
argument, e.g. `backupper config set subagentModels '{"claude":"sonnet"}'`.

<!-- config-table:start (generated by `npm run docs` from src/config/schema.ts; do not edit) -->

| key | values | default | meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Master switch. |
| `mode` | `checker`, `off` | `"checker"` | `checker` runs tiers 0-2 on every mutating call and tier 3 on a `[Backup needed]` marker or a checker verdict. `off` disables everything. |
| `subagentEnabled` | boolean | `true` | Turns tier 3 (and the checker) on or off. |
| `subagentRunner` | `auto`, `claude`, `codex`, `hermes` | `"auto"` | CLI for tier 3 and the checker. `auto` follows the agent whose hook fired. |
| `subagentModel` | string | `""` | Model for tier 3 and the checker, on every runner. Empty uses `subagentModels`. |
| `subagentModels` | JSON object | `{"claude":"haiku","codex":"gpt-6-luna"}` | Per-runner model used when `subagentModel` is empty. A runner without an entry uses its CLI's default model. |
| `subagentProvider` | string | `""` | Hermes only: provider for `hermes chat`. Empty uses Hermes's configured provider. |
| `subagentTimeoutSeconds` | integer | `120` | Time limit for one tier-3 capture. |
| `subagentPermissionMode` | `bypassPermissions`, `acceptEdits` | `"bypassPermissions"` | Claude runner only. `acceptEdits` restricts the subagent to file edits. |
| `subagentMcpConfig` | string | unset | MCP config file the subagent may use. Empty uses the project's `.mcp.json`. |
| `subagentRestoreModel` | string | unset | A different model for live restores. Empty reuses the tier-3 model. |
| `maxActions` | integer | `50` | Action folders kept; the oldest are pruned first. `0` means unlimited. |
| `maxTotalSizeMB` | integer | `0` | Size cap on action folders. `0` means unlimited. |
| `maxAgeHours` | integer | `0` | Age cap on action folders. `0` means unlimited. |
| `alwaysBackupPatterns` | JSON array | 15 patterns | Regexes for commands that are always treated as mutating. |
| `effectManifest` | boolean | `true` | Logs each call's effects to `.backupper/effects.jsonl`. |
| `learnedReadOnlyEnabled` | boolean | `false` | Lets read-only patterns learned in a session skip later checker calls. |
| `personalization` | `""`, `hard-to-reverse-only`, `unrequested-effects-only`, `human-authored-only` | unset | Limits tier 3 to one preference: `hard-to-reverse-only`, `unrequested-effects-only` or `human-authored-only`. |
| `personalizationUserRequests` | JSON array | unset | User turns given to the personalization checker as evidence. |
| `selfImproving` | boolean | `false` | After each tier-3 capture, one reflection turn writes a deterministic rule for similar calls. |
| `selfImprovingGeneralize` | boolean | `false` | Extends each learned rule to sibling operations. Needs `selfImproving`. |
| `learnedBackupRulesPath` | string | `".backupper/learned-backup-rules.json"` | Where learned rules are stored. |
| `reflectionSubagentRunner` | `""`, `claude`, `codex`, `hermes` | `""` | Runner for reflection turns. Empty reuses the tier-3 runner. |
| `reflectionSubagentModel` | string | `""` | Model for reflection turns. Empty reuses the tier-3 model. |
| `experienceForServer` | JSON object | unset | Maps an MCP server to an experience file, e.g. `{"playwright": "shop"}`. |
| `notifyOnSuccess` | boolean | `false` | Tells the agent about every successful backup. Failures and unverified backups are always reported. |
| `announceOnce` | boolean | `true` | Briefs the agent once per session about the `[Backup needed]` marker. |
| `verbose` | boolean | `false` | Writes hook decisions to stderr. |

<!-- config-table:end -->

Environment variables:

| variable | effect |
|---|---|
| `BACKUPPER_STORE_DIR=<abs path>` | keeps the store outside the project |
| `BACKUPPER_NO_REWRITE=1` | tier 0 only copies and never rewrites or runs the command (the Codex behaviour, on any agent); `0` forces rewriting |
| `BACKUPPER_PERSIST_SUBAGENT_SESSIONS=1` | keeps the tier-3 subagent's own CLI session (Claude Code otherwise runs it with `--no-session-persistence`), so its full transcript can be copied into the action folder |
| `BACKUPPER_READONLY_CHECKER=0` or `1` | forces the checker off or on |
| `BACKUPPER_NO_HOOK=1` | skips the hooks; set inside BackUpper's own subagents |

## What lands on disk

In your project, `backupper install` writes only the agent's hook registration:

| agent | files |
|---|---|
| Claude Code | `.claude/settings.local.json`, `.claude/commands/backupper-*.md` |
| Codex | `.codex/hooks.json` |
| Hermes | `.hermes/plugins/backupper/plugin.yaml`, `.hermes/plugins/backupper/__init__.py` |

If the project has a `.gitignore`, `.backupper/` is added to it. These install files are
BackUpper's own: workspace snapshots leave them out, so a restore never rolls them back.
Under Codex, when a `git clean` would reach `.backupper/`, the line `/.backupper/` is added
to the repository's local `.git/info/exclude` (never committed) so the clean leaves the
store alone.

The store, `.backupper/`, holds (most files appear only once the feature that writes them
has run):

```
config.json                   configuration
experiences/<server>.json     capture playbooks for MCP servers
shadow-repo/                  tier-2 git repository, shared by all actions
backups/action_<N>_<time>/    one folder per captured action:
  metadata.json                 what each tier produced (the source of truth for restore)
  instruction.txt               the user prompt in effect
  trash/                        tier-0 files: moved-aside or copied victims, pre-images, saved shas
  pip_freeze_*.txt, ...         tier-1 manifests
  <path>.pre-action             tier-2 exact copy of a file edited outside the workspace
  pre/                          files the tier-3 subagent copied before the action
  subagent_result.json          tier-3 capture and its recovery commands
  subagent_<id>.json            the subagent's parsed response (or a stub saying why none)
  subagent_<id>.run.json        the run's envelope: outcome, timing, runner, output sizes
  subagent_<id>.std{out,err}.txt  raw output, kept when a run fails
  subagent_<id>.transcript.*    the subagent's step transcript, or a .MISSING.txt note on why none
current-instruction.txt       the latest user prompt, copied into each action folder
announced-sessions.json       sessions already briefed about the [Backup needed] marker
tool-registry.json            which MCP server owns which tool name
external-copies.json          the first pre-agent copy of each outside file, reused later
effects.jsonl                 what each call changed
backup-timings.jsonl          latency added per action
restore-history.jsonl         every restore and its outcome
checker.jsonl                 checker verdicts
declarations.jsonl            [Backup needed] markers
subagent.log                  tier-3 runner diagnostics
hook-errors.log               internal hook errors and config.json warnings (the calls were allowed)
tier0-skipped.log             tier-0 rules that stood down, and why
learned-backup-rules.json     self-improvement rules (when enabled)
```

An action folder is created only when some tier captured something. The tier-3 runner may
write short-lived files named `backupper-sub-*` to the system temp directory; they are
removed when the subagent exits. With `BACKUPPER_PERSIST_SUBAGENT_SESSIONS=1`, the runner
CLI also keeps the subagent's session in its own history (for example `~/.claude/projects/`
or `~/.codex/sessions/`).

## Uninstall

```bash
backupper uninstall             # every agent installed in this project, or name one
npm uninstall -g agents-backupper
```

`uninstall` removes BackUpper's hooks, permission rules, slash commands and plugin files. A
file that held only BackUpper entries is deleted; your other settings are left as they were.
Your config and recorded backups stay in `.backupper/`; delete them with
`backupper clear --yes`, or remove the directory yourself.

## Development

```bash
npm ci                          # install and build dist/ (no separate build step needed)
npm test                        # build, unit tests, offline smoke test
npm run e2e                     # Docker: pack, install globally in Node 20, run the offline checks
npm run docs                    # regenerate the configuration table in this README
```

`npm run e2e` builds an image from `test/e2e/Dockerfile` with the packed tarball installed
globally, and runs the demo, hook-level checks, capture and restore, and
the smoke suite inside it, with networking disabled and no host mounts. It makes no model
calls. `BACKUPPER_E2E_REAL=1 npm run e2e` additionally drives one real `claude -p` session;
it passes `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` from your environment, and mounts
a credentials file read-only only when you name it in `BACKUPPER_E2E_CLAUDE_CREDENTIALS`.

The prompts sent to models are markdown files in `prompts/`; `npm run build` compiles them
into `src/prompts.generated.ts`.

## Citation

If you use BackUpper in your work, please cite it. A paper reference will be added here.

```bibtex
@misc{backupper2026,
  title        = {BackUpper: Pre-Execution Backups for Coding Agents},
  author       = {{BackUpper authors}},
  year         = {2026},
  howpublished = {\url{https://github.com/xli04/BackUpper}}
}
```

## License

MIT. See [LICENSE](LICENSE).
