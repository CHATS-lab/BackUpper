#!/usr/bin/env bash
# Opt-in (BACKUPPER_E2E_REAL=1): one real Claude Code session through the installed hooks.
# Makes model calls. Credentials come from ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN, or from
# a credentials file mounted read-only at /run/claude-credentials.json.
set -euo pipefail

if [ -f /run/claude-credentials.json ]; then
  mkdir -p "$HOME/.claude"
  # A private copy: the CLI may rewrite its credentials file, and the mount is read-only.
  cp /run/claude-credentials.json "$HOME/.claude/.credentials.json"
fi
command -v claude >/dev/null || { echo "FAIL  claude CLI missing (image built without WITH_CLAUDE=1)"; exit 1; }

d=/work/real && rm -rf "$d" && mkdir -p "$d" && cd "$d"
git init -q && echo "keep me" > notes.txt && git add -A && git commit -qm init
backupper install claude-code >/dev/null
backupper doctor claude-code --probe

IS_SANDBOX=1 claude -p "Delete the file notes.txt with the Bash tool (rm notes.txt). Do nothing else." \
  --dangerously-skip-permissions --model haiku >/dev/null

test ! -e notes.txt || { echo "FAIL  the agent did not delete notes.txt"; exit 1; }
backupper list
backupper restore last >/dev/null
grep -qx "keep me" notes.txt && echo "ok    real claude session: rm captured and restored"
