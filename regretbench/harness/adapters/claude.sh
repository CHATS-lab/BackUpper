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

adapter_setup() {
  local TASKDIR="$1" RUN="$2"
  RB_RESULTS_DIR="$(dirname "$RUN")" RB_RUN_DIR="$RUN" \
    bash "$HERE/run_task_claude.sh" "$TASKDIR" ${MODEL:+"$MODEL"} \
    > "$RUN/setup.log" 2>&1
  local rc=$?
  # Adopt the setup's run dir if it minted its own.
  if [ ! -s "$RUN/session.env" ]; then
    local src; src="$(tail -1 "$RUN/setup.log" 2>/dev/null)"
    [ -s "$src/session.env" ] && cp "$src/session.env" "$RUN/session.env" \
      && cp -a "$src"/. "$RUN"/ 2>/dev/null
  fi
  [ -s "$RUN/session.env" ] || { echo "[fail] setup produced no session.env (see $RUN/setup.log)" >&2; return 1; }
  return $rc
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
  docker diff "$CID" | sort > "$RUN/diff_post_agent.txt" 2>/dev/null

  # BackUpper runs: copy the plugin's store out before the container is removed.
  if [ "${RB_BACKUPPER:-0}" = 1 ]; then
    _bu_store="${BU_STORE:-$CWD/.backupper}"
    if docker exec "$CID" test -d "$_bu_store" 2>/dev/null; then
      docker cp "$CID:$_bu_store" "$RUN/backupper-store" >/dev/null 2>&1 \
        && echo "[backupper] store copied out -> $RUN/backupper-store" \
        || echo "[backupper] store present in container but copy-out FAILED"
    else
      echo "[backupper] no store at $_bu_store at collect time -- plugin captured nothing"
    fi
  fi

  local sess
  sess="$(docker exec "$CID" bash -c "ls -t $CCDIR/cfg/projects/*/$SID.jsonl 2>/dev/null | head -1" 2>/dev/null)"
  [ -n "$sess" ] || sess="$(docker exec "$CID" bash -c "ls -t $CCDIR/cfg/projects/*/*.jsonl 2>/dev/null | head -1" 2>/dev/null)"
  [ -n "$sess" ] && docker cp "$CID:$sess" "$RUN/claude_session.jsonl" >/dev/null 2>&1

  if [ -n "${GW_CID:-}" ]; then
    docker cp "$GW_CID:/gw/gateway.jsonl" "$RUN/gateway.jsonl" >/dev/null 2>&1 || true
  fi

  # cc_trajectory.py needs one instruction file: concatenate the turn prompts.
  : > "$RUN/instruction.txt"
  for p in $(ls -tr "$RUN"/turn-*.prompt 2>/dev/null); do
    printf '### %s\n%s\n\n' "$(basename "$p" .prompt | sed 's/^turn-//')" "$(cat "$p")" \
      >> "$RUN/instruction.txt"
  done
  [ -s "$RUN/instruction.txt" ] || echo "(no turn prompts recorded)" > "$RUN/instruction.txt"

  # One trajectory for the whole conversation.
  "$PY" "$HERE/cc_trajectory.py" --out "$RUN/trajectory.json" --log "$RUN/agent.log" \
    --instruction-file "$RUN/instruction.txt" \
    --model "$MODEL" --session "$RUN/claude_session.jsonl" \
    --stream "$RUN/claude_stream.jsonl" >> "$RUN/driver.log" 2>&1 \
    || echo "[warn] cc_trajectory failed; judge cannot score this run" >> "$RUN/driver.log"
}

adapter_teardown() {
  local RUN="$1"
  # shellcheck disable=SC1091
  source "$RUN/session.env" 2>/dev/null || return 0
  # Remove exactly the containers this run created, never by name.
  if [ -s "${IDFILE:-}" ]; then
    while read -r c; do
      [ -n "$c" ] && docker rm -f "$c" >/dev/null 2>&1
    done < <(sort -u "$IDFILE")
  else
    [ -n "${CID:-}" ] && docker rm -f "$CID" >/dev/null 2>&1
    [ -n "${GW_CID:-}" ] && docker rm -f "$GW_CID" >/dev/null 2>&1
  fi
}
