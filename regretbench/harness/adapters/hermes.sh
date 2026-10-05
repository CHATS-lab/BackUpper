# hermes adapter for run.sh (contract: see adapters/claude.sh).
#
# hermes runs on the host; every turn is a new process that adopts the task
# container via HERMES_TERMINAL_DOCKER_ADOPT and resumes its session with
# `hermes chat --resume <id>`. Each turn's new session messages are converted to
# the Claude message format by hermes_normalize.py; `.hermes-emitted` holds the
# index of the last message already written to claude_stream.jsonl.

# hermes copies OPENROUTER_API_KEY into $HERMES_HOME/auth.json inside the run
# dir; remove it (called from both collect and teardown).
_hermes_scrub_credentials() {
  local RUN="$1"
  rm -f "$RUN/home/.hermes/auth.json" 2>/dev/null
}

# shellcheck source=_common.sh
. "$HERE/adapters/_common.sh"

adapter_setup() {
  local rc=0
  rb_adapter_setup run_task.sh "$1" "$2" || rc=$?
  [ -s "$2/session.env" ] || return "$rc"
  # hermes hooks cannot add text to the conversation, so the BackUpper briefing
  # is delivered with the first user message (see bu_announce.sh).
  rb_bu_announce "$2"
  return "$rc"
}

adapter_turn() {
  local RUN="$1" TID="$2" PROMPT="$3" TIMEOUT="$4"
  # shellcheck disable=SC1091
  source "$RUN/session.env"

  # Sets HERMES_UPSTREAM_MODEL.
  . "$HERE/hermes_model_route.sh"
  rb_hermes_route "$MODEL"
  local args=(chat --toolsets "$TOOLSETS" -m "$HERMES_UPSTREAM_MODEL" --provider openrouter -Q --yolo)
  local was_open=0
  # Turn 1 opens the session; later turns (including the nudge) resume it.
  if [ -s "$RUN/.hermes-session-id" ]; then
    args+=(--resume "$(cat "$RUN/.hermes-session-id")")
    was_open=1
  fi

  local start rc=0
  start=$(date +%s)
  # The prompt is a single argv element, never interpolated into a command.
  # OPENROUTER_API_KEY is inherited from the environment, not from session.env.
  ( cd "$RUN" && env "${COMMON_ENV[@]}" \
      timeout "$TIMEOUT" "$HERMES_BIN" "${args[@]}" -q "$(cat "$PROMPT")" \
      >> "$RUN/hermes_stdout.log" 2>> "$RUN/agent.stderr.log" )
  rc=$?

  # Snapshot the session dir per turn: hermes rewrites session files in place,
  # and the snapshots fix the message order for the final merge.
  cp -a "$AGENT_HERMES_HOME/sessions" "$RUN/sessions-turn-$TID" 2>/dev/null || true

  # Re-resolve the session to resume each turn: compaction mints a child
  # session, and --leaf picks the most recently active one.
  local sid
  sid="$("$PY" "$HERE/hermes_sessions.py" --home "$AGENT_HERMES_HOME" --leaf 2>/dev/null)"
  if [ -z "$sid" ]; then
    sid="$(grep -oE '^session_id: [0-9a-zA-Z_]+' "$RUN/hermes_stdout.log" 2>/dev/null | tail -1 | awk '{print $2}')"
  fi
  if [ -n "$sid" ]; then
    local prev
    prev="$(cat "$RUN/.hermes-session-id" 2>/dev/null)"
    if [ -n "$prev" ] && [ "$prev" != "$sid" ]; then
      echo "  [session] $TID compacted: $prev -> $sid" | tee -a "$RUN/driver.log"
    fi
    printf '%s' "$sid" > "$RUN/.hermes-session-id"
  fi

  # Record a failed resume (no session id, or a resume error on stderr) so the
  # run can be excluded rather than read as protected.
  if [ ! -s "$RUN/.hermes-session-id" ]; then
    echo "[fail] no hermes session id after $TID -- later turns cannot resume" \
      | tee -a "$RUN/driver.log" >&2
    echo "$TID" >> "$RUN/RESUME_FAILED"
  elif [ "$was_open" = 1 ] && tail -5 "$RUN/agent.stderr.log" 2>/dev/null \
        | grep -qiE 'session .*not found|could not (find|load) session|no such session'; then
    echo "$TID" >> "$RUN/RESUME_FAILED"
  fi

  # Append only this turn's new messages to the Claude-format stream.
  local sess="$AGENT_HERMES_HOME/sessions/session_$(cat "$RUN/.hermes-session-id" 2>/dev/null).json"
  if [ -s "$sess" ]; then
    local from emitted
    from="$(cat "$RUN/.hermes-emitted" 2>/dev/null || echo 0)"
    emitted="$("$PY" "$HERE/hermes_normalize.py" "$sess" --from "$from" \
                 --mcp-servers "$(echo "${MCP_NAMES:-}" | tr ' ' ',')" \
                 --out "$RUN/claude_stream.jsonl" 2>>"$RUN/driver.log")"
    [ -n "$emitted" ] && printf '%s' "$emitted" > "$RUN/.hermes-emitted"
  else
    echo "[warn] no hermes session file for $TID at $sess" >> "$RUN/driver.log"
  fi

  rb_turn_end "$RUN" "$TID" "$start" "$rc"
}

adapter_collect() {
  local RUN="$1"
  # shellcheck disable=SC1091
  source "$RUN/session.env"

  # --- RB_BACKUPPER: the store is already on the host (bind mount) ----------
  # Moved to the run's store name (the container's mount follows the move) and
  # trimmed to a record.
  if [ "${RB_BACKUPPER:-0}" = 1 ] && [ -d "$RUN/.backupper" ] && [ ! -e "$RUN/$RB_STORE_NAME" ]; then
    mv "$RUN/.backupper" "$RUN/$RB_STORE_NAME"
    rb_store_trim "$RUN/$RB_STORE_NAME"
  fi

  docker diff "$CID" | sort > "$RUN/diff_post_agent.txt" 2>/dev/null

  # Keep hermes' own session record (system prompt, tool schemas, finish reasons).
  local sess="$AGENT_HERMES_HOME/sessions/session_$(cat "$RUN/.hermes-session-id" 2>/dev/null).json"
  [ -s "$sess" ] && cp "$sess" "$RUN/hermes_session.json"

  # Rebuild the stream from the whole session tree (compaction spreads a run over
  # several files), ordered by the per-turn snapshots. The loop variable must not
  # be `s`, which run.sh's sample loop uses.
  local snaps=() _snap
  for _snap in "$RUN"/sessions-turn-*; do
    [ -d "$_snap" ] && snaps+=("$_snap")
  done
  local mstats
  mstats="$("$PY" "$HERE/hermes_sessions.py" --merge --home "$AGENT_HERMES_HOME" \
              ${snaps[0]+--snapshots "${snaps[@]}"} \
              --out "$RUN/hermes_session_merged.json" 2>>"$RUN/driver.log")"
  if [ -s "$RUN/hermes_session_merged.json" ]; then
    echo "[sessions] merged $mstats" | tee -a "$RUN/driver.log"
    : > "$RUN/claude_stream.jsonl"
    "$PY" "$HERE/hermes_normalize.py" "$RUN/hermes_session_merged.json" --from 0 \
      --mcp-servers "$(echo "${MCP_NAMES:-}" | tr ' ' ',')" \
      --out "$RUN/claude_stream.jsonl" >/dev/null 2>>"$RUN/driver.log" || true
    # Transcript completeness: merged tool calls vs hermes' "preparing" progress lines.
    "$PY" - "$RUN" "$mstats" <<'PYEOF' >> "$RUN/driver.log" 2>&1 || true
import json, os, re, sys
run, stats = sys.argv[1], sys.argv[2]
try:
    merged = json.loads(stats).get("tool_calls", 0)
except Exception:
    merged = 0
log = os.path.join(run, "hermes_stdout.log")
preparing = 0
if os.path.exists(log):
    with open(log, encoding="utf-8", errors="replace") as fh:
        preparing = sum(1 for line in fh if re.search(r"\bpreparing ", line))
ratio = (merged / preparing) if preparing else None
with open(os.path.join(run, "transcript_quality.json"), "w") as fh:
    json.dump({"merged_tool_calls": merged, "preparing_count": preparing,
               "recovered": ratio}, fh)
percent = "" if ratio is None else " = %.1f%%" % (100 * ratio)
print("[sessions] transcript quality %s/%s%s" % (merged, preparing, percent))
PYEOF
  fi

  # The normalized stream doubles as the session transcript.
  cp "$RUN/claude_stream.jsonl" "$RUN/claude_session.jsonl" 2>/dev/null || true

  rb_build_trajectory "$RUN" --agent hermes

  _hermes_scrub_credentials "$RUN"
}

adapter_teardown() {
  local RUN="$1"
  _hermes_scrub_credentials "$RUN"
  # shellcheck disable=SC1091
  source "$RUN/session.env" 2>/dev/null || return 0
  # Copy the BackUpper store out before the container is removed (a no-op when
  # adapter_collect already moved the bind-mounted store into place).
  rb_store_harvest "${CID:-}" "${BU_STORE:-${CWD:+$CWD/.backupper}}" "$RUN"
  # Remove exactly the containers this run created, never by name.
  rb_rm_containers "${IDFILE:-}" "${CID:-}"
}
