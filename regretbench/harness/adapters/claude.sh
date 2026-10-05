# Claude Code adapter for run.sh: agent-side semantics only. Turn order, hooks,
# grading and result layout live in run.sh.
#
# Contract:
#   adapter_setup    TASKDIR RUNDIR   stand the agent up; write RUNDIR/session.env with CID=
#   adapter_turn     RUNDIR TURN_ID PROMPT_FILE TIMEOUT   deliver ONE user message in-session
#   adapter_collect  RUNDIR           transcript -> trajectory.json
#   adapter_teardown RUNDIR           remove exactly what setup created
#
# Multi-turn uses Claude Code session resume: turn 1 opens `--session-id $SID`,
# later turns attach with `--resume $SID`.

# shellcheck source=_common.sh
. "$HERE/adapters/_common.sh"

adapter_setup() {
  rb_adapter_setup run_task_claude.sh "$1" "$2"
}

adapter_turn() {
  local RUN="$1" TID="$2" PROMPT="$3" TIMEOUT="$4"
  # shellcheck disable=SC1091
  source "$RUN/session.env"

  local args=(-p --model "$MODEL" --dangerously-skip-permissions
              --output-format stream-json --verbose)
  # First turn opens the session; every later turn resumes it.
  if [ -f "$RUN/.session-open" ]; then
    args+=(--resume "$SID")
  else
    args+=(--session-id "$SID")
  fi
  [ -n "${ADD_DIR:-}" ] && args+=(--add-dir "$ADD_DIR")
  [ -n "${RB_MAX_BUDGET_USD:-}" ] && args+=(--max-budget-usd "$RB_MAX_BUDGET_USD")
  args+=("${MCP_ARGS[@]+"${MCP_ARGS[@]}"}")

  local start rc=0
  start=$(date +%s)
  # The prompt is a single argv element, never interpolated into a command.
  docker exec -w "$CWD" "${AGENT_ENV[@]}" "$CID" \
    timeout "$TIMEOUT" "$CCDIR/pkg/claude-code/bin/claude.exe" \
      "${args[@]}" -- "$(cat "$PROMPT")" \
    >> "$RUN/claude_stream.jsonl" 2>> "$RUN/agent.stderr.log" || rc=$?
  touch "$RUN/.session-open"

  # After turn 1, check (as root) that the session file was persisted and non-empty.
  if [ ! -f "$RUN/.session-checked" ]; then
    touch "$RUN/.session-checked"
    if ! docker exec -u 0 "$CID" bash -c \
         "f=\$(ls -t $CCDIR/cfg/projects/*/$SID.jsonl 2>/dev/null | head -1); [ -s \"\$f\" ]" 2>/dev/null; then
      echo "[fail] session $SID never persisted under $CCDIR/cfg/projects -- resume will fail (image USER vs cfg ownership)" \
        | tee -a "$RUN/driver.log" >&2
      echo "$TID" >> "$RUN/RESUME_FAILED"
    fi
  fi

  # Record a failed resume (RESUME_FAILED) so the run can be excluded rather than read as protected.
  if [ "$rc" != 0 ] && tail -3 "$RUN/agent.stderr.log" 2>/dev/null \
       | grep -q "No conversation found with session ID"; then
    echo "$TID" >> "$RUN/RESUME_FAILED"
  fi

  rb_turn_end "$RUN" "$TID" "$start" "$rc"
}

adapter_collect() {
  local RUN="$1"
  # shellcheck disable=SC1091
  source "$RUN/session.env"
  docker diff "$CID" | sort > "$RUN/diff_post_agent.txt" 2>/dev/null

  # BackUpper runs: copy the plugin's store out before the container is removed.
  if [ "${RB_BACKUPPER:-0}" = 1 ]; then
    rb_store_harvest "$CID" "${BU_STORE:-$CWD/.backupper}" "$RUN"
    [ $? = 2 ] && echo "[backupper] no store at ${BU_STORE:-$CWD/.backupper} at collect time -- plugin captured nothing"
  fi

  local sess
  sess="$(docker exec "$CID" bash -c "ls -t $CCDIR/cfg/projects/*/$SID.jsonl 2>/dev/null | head -1" 2>/dev/null)"
  [ -n "$sess" ] || sess="$(docker exec "$CID" bash -c "ls -t $CCDIR/cfg/projects/*/*.jsonl 2>/dev/null | head -1" 2>/dev/null)"
  [ -n "$sess" ] && docker cp "$CID:$sess" "$RUN/claude_session.jsonl" >/dev/null 2>&1

  if [ -n "${GW_CID:-}" ]; then
    docker cp "$GW_CID:/gw/gateway.jsonl" "$RUN/gateway.jsonl" >/dev/null 2>&1 || true
  fi

  # One trajectory for the whole conversation.
  rb_build_trajectory "$RUN"
}

adapter_teardown() {
  local RUN="$1"
  # shellcheck disable=SC1091
  source "$RUN/session.env" 2>/dev/null || return 0
  # Remove exactly the containers this run created, never by name.
  rb_rm_containers "${IDFILE:-}" "${CID:-}" "${GW_CID:-}"
}
