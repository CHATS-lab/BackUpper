# Agents

Per-agent setup: [Claude Code](#claude-code), [Codex](#codex), [Hermes](#hermes), [OpenHands](#openhands), [DeepSeek Harness](#deepseek-harness), [OpenClaw](#openclaw).

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
HERMES_ENABLE_PROJECT_PLUGINS=1 hermes      # start Hermes from the project like this
```

This writes a plugin to `.hermes/plugins/backupper/` and adds `backupper` to `plugins.enabled` in `$HERMES_HOME/config.yaml` (by default `~/.hermes/config.yaml`), since Hermes loads a plugin only once it is listed there. Hermes reads project plugins only when `HERMES_ENABLE_PROJECT_PLUGINS=1` is set, so start it from the project with that variable. `backupper uninstall hermes` removes the plugin and the list entry.

The backup subagent runs `hermes chat` with your configured provider and its default model; pick another with `backupper config set subagentModel <model>`.

### Side panel

Type `/backupper-panel [on|off|status]` in a Hermes session. The plugin registers it as a Hermes slash command, so Hermes runs it locally and it never reaches the model. On a Hermes build without plugin slash commands, run `backupper panel` in another terminal instead.

## OpenHands

```bash
backupper install openhands
```

This writes a project plugin to `.openhands/plugins/backupper/`, laid out like the plugins in [OpenHands/extensions](https://github.com/OpenHands/extensions) (`.plugin/plugin.json`, with `.claude-plugin` and `.codex-plugin` linked to it, and `hooks/hooks.json`). OpenHands loads the plugins under a project's `.openhands/plugins/` in every conversation, whether it runs from the CLI, the agent server or a script built on the [software-agent-sdk](https://github.com/OpenHands/software-agent-sdk), so nothing is passed at launch. The hooks run `backupper hook pre|post|prompt --agent openhands`, so `backupper` must be on PATH where OpenHands runs; when it is not, OpenHands logs the failed hook and runs the call anyway. `backupper uninstall openhands` removes the plugin directory.

**Tier 1 under OpenHands.** OpenHands never applies a hook's rewritten tool input, so Tier 1 runs in copy-only mode: it copies what the command is about to destroy and OpenHands runs the original command; restore uses the copy. OpenHands passes only `UserPromptSubmit` context to the model, so the messages BackUpper attaches to a tool call (a recorded restore, an unverified backup) are recorded in its hook execution events but never reach the model.

OpenHands has no CLI of its own for the backup subagent, which therefore runs `claude -p` by default; pick another with `backupper config set subagentRunner codex|hermes`.

## DeepSeek Harness

```bash
backupper install deepseek-harness
dsh --patch .dsh/backupper/cordis.patch.yml          # start dsh from the project like this
dsh web --patch .dsh/backupper/cordis.patch.yml
```

dsh reads no configuration from the project, so the install writes a patch layer to `.dsh/backupper/cordis.patch.yml` that you pass at launch. It mounts two things:

- a native plugin, `.dsh/backupper/plugin.mjs`, on dsh's `tools/execute` step, which runs after dsh's own approval and right before the tool body. It runs BackUpper's pre-tool hook there, so a call you reject is never backed up.
- the bundled `@deepseek-ai/dsh-hooks-claude-code` bridge on `.dsh/backupper/hooks.json`, for the post-tool and prompt hooks.

**Tier 1 under DeepSeek Harness.** dsh never applies a rewritten tool input, so Tier 1 runs copy-only: it copies what the command is about to destroy and lets dsh run the original command once; restore uses the copy. A `bash` call with a `workdir` other than the session workspace is still snapshotted and handed to the backup subagent, but Tier 1 resolves its relative paths against the workspace.

The backup subagent runs `claude -p` with your existing Claude Code login, since dsh has no headless CLI of its own; pick another with `backupper config set subagentRunner <claude|codex|hermes>`.

### Side panel

Run `backupper panel` in another terminal.

## OpenClaw

```bash
backupper install openclaw
OPENCLAW_WORKSPACE_DIR="$PWD" openclaw gateway run      # or: OPENCLAW_WORKSPACE_DIR="$PWD" openclaw agent --local ...
```

This writes a workspace plugin to `.openclaw/extensions/backupper/` and enables it in your OpenClaw config (`plugins.entries.backupper`, with `hooks.allowConversationAccess` so it can add the briefing to the prompt). OpenClaw works in its agent workspace and loads workspace plugins only from there, so start it with `OPENCLAW_WORKSPACE_DIR` set to the project; your configured workspace is left alone. The variable applies only while `agents.defaults.workspace` is unset (`backupper doctor openclaw` warns otherwise). OpenClaw adds its own workspace files (`AGENTS.md` and the like) to a workspace it starts in. `backupper uninstall openclaw` removes the plugin and its config entry. If `openclaw` is not on PATH during install, the `openclaw config set` commands are printed for you to run.

The plugin forwards every tool call from `before_tool_call` and `after_tool_call`, with `exec`, `write`, `edit` and `apply_patch` mapped to the hook names BackUpper keys its rules on. Tier 1 rewrites arrive as OpenClaw's params rewrite. When the exec policy can ask or refuse after the hook (`security` other than `full`, or `ask` other than `off`, in `tools.exec`, `exec-approvals.json` or the call), Tier 1 prepends its copies to the command instead of running anything itself. When exec runs in a sandbox container or on a paired node, Tier 1 stands down and the other tiers still apply. The Gateway and `openclaw agent --local` run the hooks; `openclaw agent exec` loads workspace plugins for discovery only, so it is not protected.

The backup subagent runs `claude -p` with your existing Claude Code login; pick another CLI with `backupper config set subagentRunner codex|hermes`.
