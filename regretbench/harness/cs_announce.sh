#!/usr/bin/env bash
# Capture the plugin's own briefing and hand it to run.sh's first-user-message channel.
#
# Why this exists: on the claude lane the briefing arrives natively — the plugin's
# UserPromptSubmit hook writes {hookSpecificOutput:{additionalContext}} to stdout and
# Claude Code merges it into the first user message. Neither other lane can do that:
#
#   codex   the hook DOES run (Pre/PostToolUse were verified dispatching after
#           --dangerously-bypass-hook-trust), but `codex exec` never consumes the
#           UserPromptSubmit stdout. Measured on the smoke: announced-sessions.json had
#           the session recorded, the trajectory had zero hits for the announcement
#           text, and the agent's single declaration came from it stumbling on
#           .chats-sandbox with ls.
#   hermes  the hook signature is (tool_name, args) -> None. There is no return channel
#           at all.
#
# Without it those four models are not "worse at protecting" — they never learn the
# tool exists, which is a structural zero and not a capability difference.
#
# The channel used is run.sh's existing RB_GUIDANCE_FILE, which merges a file into
# turn 0's user message and no later turn. Same position the claude lane gets it in.
#
# The text is NOT hand-copied. A hand-copied copy drifts: harness/backupper-BRIEFING.md
# was missing the sentence patch 377 added ("put the marker inside the tool call"), so
# those lanes would have been told to write a marker without being told where — a
# difference in instructions masquerading as a difference in models. Instead this runs
# the plugin's OWN hook inside the container and keeps whatever it prints, so the text
# tracks every later patch and the Backup log path is the real one for this run.
#
# Usage: cs_announce.sh <RUN dir>   (reads CID / CWD from RUN/session.env)
# On success writes RUN/cs-announce.txt and appends RB_GUIDANCE_FILE=... to session.env
# — run.sh sources session.env BEFORE entering the turn loop, so setting it there takes
# effect for turn 0.
#
# BLAST RADIUS: one docker exec that runs the hook (which changes no state), and two
# files written under RUN.
set -uo pipefail
RUN="${1:?usage: cs_announce.sh <RUN dir>}"
[ -s "$RUN/session.env" ] || { echo "[announce] no session.env" >&2; exit 1; }
# shellcheck disable=SC1091
. "$RUN/session.env"
: "${CID:?session.env carries no CID}"
: "${CWD:?session.env carries no CWD}"

CSDIR=/opt/rbcs
NODE_IN="${RB_CS_NODE_IN:-$CSDIR/nodejs/bin/node}"
HOOK="$CSDIR/plugin/dist/hooks/user-prompt.js"
LOG="$RUN/cs-announce.log"

# CHATS_SANDBOX_NO_HOOK must stay UNSET here: that is the subagent recursion guard, and
# with it set the hook exits immediately.
#
# CHATS_SANDBOX_STORE_DIR, by contrast, MUST be passed when RB_CS_STORE relocated the
# store. Without it the hook's getConfigDir() looks in $CWD, finds no config.json, and
# builds the briefing from DEFAULT_CONFIG -- so a checker/lite run would be handed the
# long "smart" text instead, and the difference would show up as a model effect. Empty
# CS_STORE (the default layout, and every pre-RB_CS_STORE session.env) adds no -e flag,
# so nothing changes there.
CS_ENV=()
# Only when the store was actually RELOCATED. session.env records CS_STORE on every
# run now, and exporting CHATS_SANDBOX_STORE_DIR at its default value would still
# flip the plugin onto its override branch -- so compare against the default.
[ -n "${CS_STORE:-}" ] && [ "$CS_STORE" != "$CWD/.chats-sandbox" ] \
  && CS_ENV=(-e "CHATS_SANDBOX_STORE_DIR=$CS_STORE")
raw="$(printf '%s' '{"session_id":"__rb_announce_probe__","prompt":"probe"}' \
        | docker exec -i -w "$CWD" "${CS_ENV[@]+"${CS_ENV[@]}"}" "$CID" "$NODE_IN" "$HOOK" 2>>"$LOG")"
rc=$?

txt="$(printf '%s' "$raw" | /usr/bin/python3 -c '
import json,sys
try:
    d=json.load(sys.stdin)
    print(d.get("hookSpecificOutput",{}).get("additionalContext","").strip())
except Exception:
    pass
' 2>>"$LOG")"

# Clear the probe session id. Leaving it would not suppress the real announcement (the
# real session id differs), but a fake session in the artifact misleads anyone later
# reading declarations/announce counts.
docker exec -i "$CID" sh -c \
  "f=${CS_STORE:-$CWD/.chats-sandbox}/announced-sessions.json; [ -f \"\$f\" ] && printf '%s' '[]' > \"\$f\"" \
  >>"$LOG" 2>&1

if [ -z "$txt" ]; then
  echo "[announce] could not capture the briefing (hook rc=$rc) — see $LOG" >&2
  exit 2
fi

printf '%s\n' "$txt" > "$RUN/cs-announce.txt"
printf 'RB_GUIDANCE_FILE=%s\n' "$RUN/cs-announce.txt" >> "$RUN/session.env"
echo "[announce] ${#txt} chars -> $RUN/cs-announce.txt"
