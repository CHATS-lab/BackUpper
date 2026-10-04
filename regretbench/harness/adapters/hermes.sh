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

adapter_setup() {
  local TASKDIR="$1" RUN="$2"
  RB_RESULTS_DIR="$(dirname "$RUN")" RB_RUN_DIR="$RUN" \
    bash "$HERE/run_task.sh" "$TASKDIR" ${MODEL:+"$MODEL"} \
    > "$RUN/setup.log" 2>&1
  local rc=$?
  # Adopt the setup's run dir if it minted its own.
  if [ ! -s "$RUN/session.env" ]; then
    local src; src="$(tail -1 "$RUN/setup.log" 2>/dev/null)"
    [ -s "$src/session.env" ] && cp "$src/session.env" "$RUN/session.env" \
      && cp -a "$src"/. "$RUN"/ 2>/dev/null
  fi
  [ -s "$RUN/session.env" ] || {
    echo "[fail] setup produced no session.env (see $RUN/setup.log)" >&2
    tail -20 "$RUN/setup.log" >&2
    return 1; }
  # hermes hooks cannot add text to the conversation, so the BackUpper briefing
  # is delivered with the first user message (see bu_announce.sh).
  if [ "${RB_BACKUPPER:-0}" = 1 ]; then
    bash "$HERE/bu_announce.sh" "$RUN" >> "$RUN/setup.log" 2>&1 \
      || echo "[warn] briefing capture failed; this run measures discovery, not the tool" >&2
  fi
  return $rc
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

  local wall=$(( $(date +%s) - start ))
  echo "  rc=$rc wall=${wall}s" | tee -a "$RUN/driver.log"
  # 124 = timeout(1) fired; the driver then stops delivering turns.
  [ "$rc" = 124 ] && echo "timeout at $TID" > "$RUN/TIMEOUT"
  return $rc
}

adapter_collect() {
  local RUN="$1"
  # shellcheck disable=SC1091
  source "$RUN/session.env"

  # --- RB_BACKUPPER: trim the (bind-mounted) store ---------------------------
  # pre/, trash/ and external-shadow/ are replaced by a file manifest.
  if [ "${RB_BACKUPPER:-0}" = 1 ] && [ -d "$RUN/.backupper" ]; then
    rm -rf "$RUN/.backupper/shadow-repo"
    local ntrimmed=0 dir nbytes nfiles ndecl
    while IFS= read -r dir; do
      [ -d "$dir" ] || continue
      nbytes="$(du -sb "$dir" 2>/dev/null | cut -f1)"
      nfiles="$(find "$dir" -type f 2>/dev/null | wc -l)"
      { echo "# replaced by adapter_collect: bytes not carried out of the run dir"
        echo "# total: $nbytes bytes, $nfiles files"
        find "$dir" -type f -printf '%s\t%P\n' 2>/dev/null | sort -k2
      } > "$dir.manifest.txt" 2>/dev/null
      rm -rf "$dir"
      ntrimmed=$((ntrimmed + 1))
    done < <(find "$RUN/.backupper/backups" -mindepth 2 -maxdepth 2 -type d \
                  \( -name pre -o -name trash -o -name external-shadow \) 2>/dev/null)
    ndecl="$(wc -l < "$RUN/.backupper/declarations.jsonl" 2>/dev/null || echo 0)"
    echo "[backupper] store on host (bind mount); trimmed $ntrimmed dir(s) to manifest; declared $ndecl time(s)"
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

  : > "$RUN/instruction.txt"
  for p in $(ls -tr "$RUN"/turn-*.prompt 2>/dev/null); do
    printf '### %s\n%s\n\n' "$(basename "$p" .prompt | sed 's/^turn-//')" "$(cat "$p")" \
      >> "$RUN/instruction.txt"
  done
  [ -s "$RUN/instruction.txt" ] || echo "(no turn prompts recorded)" > "$RUN/instruction.txt"

  "$PY" "$HERE/cc_trajectory.py" --out "$RUN/trajectory.json" --log "$RUN/agent.log" \
    --instruction-file "$RUN/instruction.txt" \
    --model "$MODEL" --agent hermes --session "$RUN/claude_session.jsonl" \
    --stream "$RUN/claude_stream.jsonl" >> "$RUN/driver.log" 2>&1 \
    || echo "[warn] cc_trajectory failed; judge cannot score this run" >> "$RUN/driver.log"

  _hermes_scrub_credentials "$RUN"
}

adapter_teardown() {
  local RUN="$1"
  _hermes_scrub_credentials "$RUN"
  # shellcheck disable=SC1091
  source "$RUN/session.env" 2>/dev/null || return 0
  # Copy the BackUpper store out before the container is removed.
  if [ -n "${CID:-}" ] && [ -n "${CWD:-}" ]; then
    if docker exec "$CID" test -d "${BU_STORE_IN:-$CWD/.backupper}" >/dev/null 2>&1; then
      if docker cp "$CID:${BU_STORE_IN:-$CWD/.backupper}" "$RUN/backupper" >/dev/null 2>&1; then
        _acts=$(wc -l < "$RUN/backupper/effects.jsonl" 2>/dev/null | tr -d ' ')
        _subs=$(grep -c 'subagent verdict' "$RUN/backupper/subagent.log" 2>/dev/null)
        echo "[backupper] store harvested: ${_acts:-0} effect line(s), ${_subs:-0} tier-3 verdict(s)"
      fi
    fi
  fi
  # Remove exactly the containers this run created, never by name.
  if [ -s "${IDFILE:-}" ]; then
    while read -r c; do
      [ -n "$c" ] && docker rm -f "$c" >/dev/null 2>&1
    done < <(sort -u "$IDFILE")
  else
    [ -n "${CID:-}" ] && docker rm -f "$CID" >/dev/null 2>&1
  fi
}
