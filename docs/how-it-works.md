# How BackUpper Works

BackUpper sits on the agent's pre-tool-call hook. Each call is checked before it runs:

1. **Read-only allowlist.** Calls that cannot change state pass straight through.
2. **Preference check** (personalized modes only). Calls that do not match your preference pass without a backup.
3. **Tiers 1–3** (rules, no model call) run on every state-changing call, so their protection never depends on the agent.
4. **Tier 4** (backup subagent) handles complex or ambiguous cases.

| Tier | Backup | Example |
|---|---|---|
| **1** | **Command rewriting.** A known destructive command is replaced by a reversible one, and the inverse is recorded. | `rm notes.txt` becomes a move into the action's trash |
| **2** | **Command pairing.** A matching backup command runs first, then the original call. | `pip freeze` before `pip install`, `npm list` before `npm install` |
| **3** | **Snapshot.** A commit in a private shadow git repo, plus an exact copy of a single file edited outside the workspace through a native tool. | before an `Edit`, or a script that rewrites files |
| **4** | **Backup subagent.** A one-shot agent captures state no local snapshot can reach, and writes down how to restore it. | a database row, a mailbox, a cluster object, a web page |

## Permission modes

A pre-tool-call hook runs before the agent checks its own permissions, so a capture made inside the hook would happen even for a call that is later denied. BackUpper therefore picks how Tier 1 acts from the agent's permission mode:

- **Bypass** (Claude Code `bypassPermissions`, or an equivalent no-approval mode): Tier 1 acts inside the hook and the agent receives the rewritten call, as in the table above. This is the setting used in the paper.
- **Any other mode:** BackUpper performs nothing itself. It rewrites the command to `<copy the target> && <original command>`, so the copy happens only once the call is allowed, the agent's allow and deny rules still match the original command, and a denied call runs neither part. The copy is made by a small helper that `backupper install` allows in the agent's permission settings; it can only write the files recorded for that action. Targets over the size limit fall back to Tiers 3 and 4.

## When Tier 4 runs

Tier 4 runs only when all of these hold:

- the call touches state outside the workspace;
- Tiers 1–3 did not already capture that state;
- the agent marked the step with `[BACKUP NEEDED]`, or the checker judged the call not read-only.

**The `[BACKUP NEEDED]` marker.** At the start of each session the agent is told to add `[BACKUP NEEDED]` to a step that would destroy state the hook cannot see. A marked call skips the checker.

**The checker.** A read-only model call with no tools. It judges calls the agent did not mark, because the common failure is an agent that forgets to mark. The hook never relies on the agent's own account of what is at risk; it performs its own backup.

## The backup subagent

**It follows your agent.** Under Claude Code it runs `claude -p`, under Codex `codex exec`, and under Hermes `hermes chat`, each with that CLI's existing login, so no extra key is needed. By default it uses a cheap model (`haiku` for Claude Code, `gpt-6-luna` for Codex, the provider default for Hermes). Pick another with `backupper config set subagentModel <model>`, or another CLI with `subagentRunner`.

**It has full permissions.** A backup may need to run arbitrary commands (a database dump, a `kubectl get`, a copy outside the project), so the subagent runs without approval prompts and with your user's access: Claude Code with `--dangerously-skip-permissions` (set `subagentPermissionMode` to `acceptEdits` to limit it to file edits), Codex with `--sandbox danger-full-access`, and Hermes with `--yolo`. It is told to only read and copy, never to change the target, but nothing enforces that beyond its instructions. The checker runs with no tools (Claude) or a read-only sandbox (Codex). Turn Tier 4 off with `backupper config set subagentEnabled false`.

**Backup experiences** are per-MCP-server playbooks added to the subagent's prompt. `backupper init` copies a starter set for `playwright`, `k8s`, `postgres` and `email` servers into `.backupper/experiences/`.

## Customization and self-improvement

- **Personalized modes** limit what gets backed up to one preference: **High-Impact** (hard-to-reverse changes), **Beyond-Request** (effects the user did not ask for) or **Human-Work** (human-authored content). In these modes the preference check runs before every tier.
- **Self-improvement** adds one reflection turn after each Tier 4 backup. It writes a deterministic rule, so the next similar call is handled by a rule instead of the subagent.

## Restore

`restore N` undoes action N and every later action, newest first, replaying each tier's inverse: trashed files move back, packages are reinstalled from their manifests, snapshots are checked out, and Tier 4 recovery commands run. `--direct` undoes only action N: its own backups are applied (its workspace snapshot only to the paths action N changed), and later actions and their backups are kept. `--file <path>` puts back one path as it was before action N, from whichever capture of action N holds it (workspace snapshot, Tier 1 trash copy, outside-workspace copy or Tier 4 external snapshot). Snapshot restores also put back file modes, owners and empty directories, which git itself does not keep. An action whose effect was only partly captured is marked INCOMPLETE in `list` and `show`, and `restore` names what it could not bring back. When a Tier 4 backup needs a live restore, `restore` prints a prompt to give your agent instead. A file edited outside the workspace is copied back from its exact pre-action copy. A restore cannot bring back something that was never backed up.

## Failure handling

If the hook hits an internal error, it lets the call through, prints the error to stderr and appends it to `.backupper/hook-errors.log`.
