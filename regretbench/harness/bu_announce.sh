#!/usr/bin/env bash
# Capture the BackUpper plugin's briefing for the codex and hermes harnesses, whose
# CLIs cannot surface UserPromptSubmit hook output (Claude Code does so natively).
#
# Usage: bu_announce.sh <RUN dir>   (reads CID / CWD from RUN/session.env)
# Runs the plugin's own hook in the container, writes RUN/bu-announce.txt and
# appends RB_GUIDANCE_FILE=... to session.env, so run.sh prepends the briefing
# to the first user message.
set -uo pipefail
RUN="${1:?usage: bu_announce.sh <RUN dir>}"
[ -s "$RUN/session.env" ] || { echo "[announce] no session.env" >&2; exit 1; }
# shellcheck disable=SC1091
. "$RUN/session.env"
: "${CID:?session.env carries no CID}"
: "${CWD:?session.env carries no CWD}"

BUDIR=/opt/rbbu
NODE_IN="${RB_BU_NODE_IN:-$BUDIR/nodejs/bin/node}"
HOOK="$BUDIR/package/dist/hooks/user-prompt.js"
LOG="$RUN/bu-announce.log"

# BACKUPPER_NO_HOOK must stay unset (it is the subagent recursion guard).
# BACKUPPER_STORE_DIR is passed only when the store was relocated from its
# default, so the hook reads this run's config.json.
BU_ENV=()
if [ -n "${BU_STORE:-}" ] && [ "$BU_STORE" != "$CWD/.backupper" ]; then
  BU_ENV=(-e "BACKUPPER_STORE_DIR=$BU_STORE")
fi
PROBE='{"session_id":"__rb_announce_probe__","prompt":"probe"}'
raw="$(printf '%s' "$PROBE" \
        | docker exec -i -w "$CWD" "${BU_ENV[@]+"${BU_ENV[@]}"}" "$CID" "$NODE_IN" "$HOOK" 2>>"$LOG")"
rc=$?

txt="$(printf '%s' "$raw" | "${RB_PY:-python3}" -c '
import json, sys
try:
    hook_output = json.load(sys.stdin)
    print(hook_output.get("hookSpecificOutput", {}).get("additionalContext", "").strip())
except Exception:
    pass
' 2>>"$LOG")"

# Reset the announced-sessions record so the probe session does not appear in it.
docker exec "$CID" sh -c \
  "f=${BU_STORE:-$CWD/.backupper}/announced-sessions.json; [ -f \"\$f\" ] && printf '%s' '[]' > \"\$f\"" \
  </dev/null >>"$LOG" 2>&1

if [ -z "$txt" ]; then
  echo "[announce] could not capture the briefing (hook rc=$rc) — see $LOG" >&2
  exit 2
fi

printf '%s\n' "$txt" > "$RUN/bu-announce.txt"
printf 'RB_GUIDANCE_FILE=%s\n' "$RUN/bu-announce.txt" >> "$RUN/session.env"
echo "[announce] ${#txt} chars -> $RUN/bu-announce.txt"
