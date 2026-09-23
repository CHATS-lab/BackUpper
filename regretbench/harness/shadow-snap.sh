#!/bin/sh
# Snapshot the agent's workspace BEFORE every tool call.
#
# Purpose: make in-workspace changes automatically reversible, so the agent owes
# nothing for them and is responsible only for state OUTSIDE the workspace. The
# coverage-rate denominator counts out-of-workspace actions only.
#
# ========================= THIS MUST NEVER FAIL =========================
# claude-code's PreToolUse hook has this semantics (verbatim from the binary):
#   "PreToolUse hook failed with an unexpected error. The tool call was not executed"
#   "PreToolUse hook did not respond before its timeout. The tool call was not executed"
# So if this script errors or stalls, THE AGENT'S TOOL CALL DOES NOT RUN. That
# would silently destroy a whole sweep: it looks like the agent did nothing, and
# in the data that is indistinguishable from a model choosing not to act.
# Hence: every command wrapped in timeout, every failure swallowed, exit 0 at the
# end unconditionally. Losing a snapshot always beats blocking a tool call.
# ========================================================================
#
# Usage (shared by all three harnesses):
#   shadow-snap.sh                    # hook JSON on stdin (claude-code / codex)
#   shadow-snap.sh <tool_name> <id>   # direct args (hermes calls this from Python)
#
# The git dir lives OUTSIDE the work tree, so no .git appears in the workspace
# and the task cannot see it.

set +e +u                      # inverted on purpose: nothing here may abort. /bin/sh
                               # rather than bash — one less dependency, and a failing
                               # PreToolUse hook blocks the tool call. Not every task
                               # image ships bash.

SNAP_TIMEOUT="${RB_SNAP_TIMEOUT:-5}"        # per-git-command ceiling, seconds
# The first snapshot has to read the whole workspace into git and is one to two
# orders of magnitude more expensive than the incremental ones that follow:
# measured 3.6 s for a 227 MB / 703-file workspace, then 21 ms. That 3.6 s was on
# an idle box; with ten lanes in parallel it can multiply. Capping the first one at
# 5 s would drop EXACTLY the baseline snapshot that matters most, so it gets its
# own budget.
FIRST_TIMEOUT="${RB_SNAP_FIRST_TIMEOUT:-60}"
GIT_DIR_PATH="${RB_SHADOW_GIT_DIR:-/tmp/.rb-shadow}"
WORK_TREE="${RB_SHADOW_WORK_TREE:-${CLAUDE_PROJECT_DIR:-$PWD}}"

tool_name="${1:-}"
tool_id="${2:-}"

# Hooks deliver JSON on stdin. Fields are pulled with grep rather than python:
# one less process to spawn and one less way to fail.
if [ -z "$tool_name" ] && [ ! -t 0 ]; then
  payload="$(timeout 2 cat 2>/dev/null)"
  tool_name="$(printf '%s' "$payload" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' \
               | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
  tool_id="$(printf '%s' "$payload" | grep -o '"tool_use_id"[[:space:]]*:[[:space:]]*"[^"]*"' \
             | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
  # The cwd the hook reports is used ONLY when the work tree was not pinned.
  # It must not override RB_SHADOW_WORK_TREE: the moment the agent cd's, the
  # reported cwd changes and the snapshot scope drifts with it — while the skill
  # tells the agent that path is fixed and does not follow it. Worse, after a
  # `cd /` this would try to snapshot the entire root filesystem, time out, and
  # take the tool call down with it.
  if [ -z "${RB_SHADOW_WORK_TREE:-}" ]; then
    hook_cwd="$(printf '%s' "$payload" | grep -o '"cwd"[[:space:]]*:[[:space:]]*"[^"]*"' \
                | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
    [ -n "$hook_cwd" ] && [ -d "$hook_cwd" ] && WORK_TREE="$hook_cwd"
  fi
fi

AUDIT="${RB_SHADOW_AUDIT:-/tmp/.rb-shadow-audit.log}"
# One line per invocation. Without it a missed snapshot is SILENT: afterwards all
# you can see is that the commit count is lower than the tool-call count, with no
# way to tell which step failed or why. Measured on claude: a run once went six
# consecutive calls without a snapshot.
note() { printf '%s\t%s\t%s\t%s\n' "$(date +%s 2>/dev/null)" "${tool_name:-?}" \
         "${tool_id:-?}" "$1" >> "$AUDIT" 2>/dev/null; }

[ -d "$WORK_TREE" ] || { note "skip:no-worktree:$WORK_TREE"; exit 0; }

# Backstop: if the work tree ever resolves to a system root, the snapshot would
# walk the whole filesystem, time out, and take the tool call with it. Only the
# genuinely explosive ones are blocked — filtering by path depth would be wrong,
# since /work, /srv and /root are all real task workspaces (3 of the 110).
case "${WORK_TREE%/}" in
  "" | /usr | /var | /etc | /proc | /sys | /dev | /lib | /bin | /sbin | /opt )
    note "skip:system-root:$WORK_TREE"; exit 0 ;;
esac

# -c core.excludesFile=/dev/null: an image may ship a global excludes file
# (/etc/gitexclude) that would keep files out of the snapshot just as the
# workspace's own .gitignore does.
g() { timeout "$SNAP_TIMEOUT" git -c core.excludesFile=/dev/null \
        --git-dir="$GIT_DIR_PATH" --work-tree="$WORK_TREE" "$@" >/dev/null 2>&1; }

if [ ! -d "$GIT_DIR_PATH" ]; then
  SNAP_TIMEOUT="$FIRST_TIMEOUT"        # this pass is the baseline; give it room
  timeout "$SNAP_TIMEOUT" git init --bare -q "$GIT_DIR_PATH" >/dev/null 2>&1 \
    || { note "fail:git-init"; exit 0; }
  g config user.email rb@local
  g config user.name  rb-shadow
  # Workspaces can hold huge build artefacts and datasets. core.bigFileThreshold
  # stops git from delta-compressing them, which is what keeps snapshots in the
  # millisecond range — the precondition for never slowing a tool call down.
  g config core.bigFileThreshold 1m
  g config gc.auto 0
fi

# The snapshot itself. --allow-empty: a read changes nothing and produces an empty
# commit, which is exactly what completes the timeline of "state before tool call
# N" and lets actions be lined up against snapshots.
#
# -f is required: the workspace is often a git repo itself, and its .gitignore
# will keep node_modules/, data/, *.env — precisely the irreplaceable things —
# out of the snapshot. Measured: without -f, a .gitignore'd data/only.csv is
# unrecoverable once deleted.
#
# `add -A` is all-or-nothing: a single NESTED git repo in the workspace (submodule
# or git worktree) makes the whole command exit 128, and that snapshot stores not
# one file. Confirmed by measurement. On failure we fall back to adding files one
# by one — the nested repo's contents are still unreachable (git treats it as a
# gitlink), but everything else survives. The fallback is bounded by a find cap
# and its own timeout: losing a snapshot always beats slowing a tool call.
rc_add=0
if ! g add -A -f; then
  rc_add=1
  ( cd "$WORK_TREE" 2>/dev/null &&
    timeout "$SNAP_TIMEOUT" find . -type f -not -path './.git/*' -print0 2>/dev/null \
      | head -c 2000000 \
      | timeout "$SNAP_TIMEOUT" xargs -0 -r -n 500 \
          git -c core.excludesFile=/dev/null --git-dir="$GIT_DIR_PATH" \
              --work-tree="$WORK_TREE" add -f
  ) >/dev/null 2>&1 && rc_add=2      # 2 = add -A failed, per-file fallback completed
fi
if g commit --allow-empty -q -m "presnap ${tool_name:-unknown} ${tool_id:-}"; then
  note "ok:add=$rc_add"
else
  note "fail:commit:add=$rc_add"      # no commit means this call has NO snapshot
fi

exit 0
