# Claude Code adapter for run.sh.
#
# Agent semantics ONLY. Anything a second agent would also need -- turn order,
# hooks, grading, result layout -- belongs in run.sh, not here.
#
# The contract:
#   adapter_setup    TASKDIR RUNDIR   stand the agent up; write RUNDIR/session.env with CID=
#   adapter_turn     RUNDIR TURN_ID PROMPT_FILE TIMEOUT   deliver ONE user message in-session
#   adapter_collect  RUNDIR           transcript -> trajectory.json
#   adapter_teardown RUNDIR           remove exactly what we created
#
# Multi-turn works because Claude Code persists a session and can be resumed:
# turn 1 opens `--session-id $SID`, turns 2..N attach with `--resume $SID`.
# That is genuine conversational continuity, not a re-prompt with a transcript
# pasted in -- which matters here, because a v2 task's whole premise is that
# the agent carries its own memory of the runway into the destructive turn.

adapter_setup() {
  local TASKDIR="$1" RUN="$2"
  RB_PHASE=setup RB_RESULTS_DIR="$(dirname "$RUN")" RB_RUN_DIR="$RUN" \
    bash "$HERE/run_task_claude.sh" "$TASKDIR" ${MODEL:+"$MODEL"} \
    > "$RUN/setup.log" 2>&1
  local rc=$?
  # run_task_claude.sh mints its own timestamped run dir; adopt its session.env
  # if it did not land in ours.
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
  if [ -f "$RUN/.session-open" ]; then args+=(--resume "$SID")
  else args+=(--session-id "$SID"); fi
  [ -n "${ADD_DIR:-}" ] && args+=(--add-dir "$ADD_DIR")
  [ -n "${RB_MAX_BUDGET_USD:-}" ] && args+=(--max-budget-usd "$RB_MAX_BUDGET_USD")
  args+=("${MCP_ARGS[@]+"${MCP_ARGS[@]}"}")

  local start rc=0
  start=$(date +%s)
  # The prompt is passed as one argv element read from a file: no interpolation,
  # so nothing in the task text can alter the command.
  docker exec -w "$CWD" "${AGENT_ENV[@]}" "$CID" \
    timeout "$TIMEOUT" "$CCDIR/pkg/claude-code/bin/claude.exe" \
      "${args[@]}" -- "$(cat "$PROMPT")" \
    >> "$RUN/claude_stream.jsonl" 2>> "$RUN/agent.stderr.log" || rc=$?
  touch "$RUN/.session-open"

  # PRE-FLIGHT: after turn 1, assert the session was actually persisted. Probe as
  # root (-u 0): the same permission fault that causes the bug also makes the cfg
  # dir unlistable by the agent's uid, so a non-root probe cannot tell "missing"
  # from "unreadable". -s not -e, to catch a zero-byte flush. Failing here costs
  # one turn; failing later costs seven and yields a run that looks RECOVERED.
  if [ ! -f "$RUN/.session-checked" ]; then
    touch "$RUN/.session-checked"
    if ! docker exec -u 0 "$CID" bash -c \
         "f=\$(ls -t $CCDIR/cfg/projects/*/$SID.jsonl 2>/dev/null | head -1); [ -s \"\$f\" ]" 2>/dev/null; then
      echo "[fail] session $SID never persisted under $CCDIR/cfg/projects -- resume will fail (image USER vs cfg ownership)" \
        | tee -a "$RUN/driver.log" >&2
      echo "$TID" >> "$RUN/RESUME_FAILED"
    fi
  fi

  # A BROKEN RESUME MUST NOT LOOK LIKE A CLEAN RESULT. Observed on task 54:
  # turn 1 succeeded but its session was never persisted under $SID, so turns
  # 2..8 each died in ~2s with "No conversation found with session ID". The
  # destructive turn therefore never ran, the at-risk state was untouched, and
  # the predicate graded the run RECOVERED -- a single-turn run scored as a
  # passing multi-turn one. Record it so the scorer can VOID the run instead of
  # counting a measurement that never happened.
  if [ "$rc" != 0 ] && tail -3 "$RUN/agent.stderr.log" 2>/dev/null \
       | grep -q "No conversation found with session ID"; then
    echo "$TID" >> "$RUN/RESUME_FAILED"
  fi

  local wall=$(( $(date +%s) - start ))
  echo "  rc=$rc wall=${wall}s" | tee -a "$RUN/driver.log"
  # 124 is the timeout(1) signal. Record it so the driver stops delivering
  # turns rather than burning the remaining budget on a dead session.
  [ "$rc" = 124 ] && echo "timeout at $TID" > "$RUN/TIMEOUT"
  return $rc
}

adapter_collect() {
  local RUN="$1"
  # shellcheck disable=SC1091
  source "$RUN/session.env"
  docker diff "$CID" | sort > "$RUN/diff_post_agent.txt" 2>/dev/null

  # RB_CHATS_SANDBOX runs only: copy the backupper's store out BEFORE teardown,
  # otherwise the container is reaped and the only evidence of what the plugin
  # actually captured goes with it. Best-effort; absence is itself a finding.
  # RB_BACKUPPER also needs to go through this branch: it installs the same store as
  # RB_CHATS_SANDBOX, just under a newer-generation wiring that uses a different
  # variable name. Without this, .chats-sandbox would never get pulled into the run
  # directory, and the driver's dedup reads "no .chats-sandbox in the run directory" as
  # "this task never ran" -- so every claude backupper run would be rerun forever.
  # CS_STORE comes from session.env and is $CWD/.chats-sandbox unless RB_CS_STORE moved
  # the store out of the workspace (see run_task_codex.sh). That path is not exercised
  # here yet, so this only makes the source path variable, defaulting to the original
  # value -- the destination $RUN/chats-sandbox-store is untouched, and the dedup logic
  # above stays exactly as it was.
  # Note: the claude lane's run_task_claude.sh does not yet wire up RB_CS_STORE, so on
  # this path CS_STORE is always empty and takes the default branch -- behavior is
  # identical to before this change.
  if [ -n "${RB_CHATS_SANDBOX:-}" ] || [ "${RB_BACKUPPER:-0}" = 1 ]; then
    _cs_store="${CS_STORE:-$CWD/.chats-sandbox}"
    if docker exec "$CID" test -d "$_cs_store" 2>/dev/null; then
      docker cp "$CID:$_cs_store" "$RUN/chats-sandbox-store" >/dev/null 2>&1 \
        && echo "[backupper] store copied out -> $RUN/chats-sandbox-store" \
        || echo "[backupper] store present in container but copy-out FAILED"
    else
      echo "[backupper] no store at $_cs_store at collect time -- plugin captured nothing"
    fi
  fi

  local sess
  sess="$(docker exec "$CID" bash -c "ls -t $CCDIR/cfg/projects/*/$SID.jsonl 2>/dev/null | head -1" 2>/dev/null)"
  [ -n "$sess" ] || sess="$(docker exec "$CID" bash -c "ls -t $CCDIR/cfg/projects/*/*.jsonl 2>/dev/null | head -1" 2>/dev/null)"
  [ -n "$sess" ] && docker cp "$CID:$sess" "$RUN/claude_session.jsonl" >/dev/null 2>&1

  if [ -n "${GW_CID:-}" ]; then
    docker cp "$GW_CID:/gw/gateway.jsonl" "$RUN/gateway.jsonl" >/dev/null 2>&1 || true
  fi

  # cc_trajectory.py REQUIRES --instruction-file. v1 has a single `instruction`;
  # a v2 conversation's equivalent is the ordered turn text, so synthesise it
  # from the per-turn prompt files the driver already wrote (oldest first = turn
  # order). Without this the call fails argument parsing, `|| true` swallows it,
  # no trajectory.json is produced, and judge.py can never score a v2 run --
  # which is exactly why every v2 run before 2026-08-04 has a null backed_up.
  : > "$RUN/instruction.txt"
  for p in $(ls -tr "$RUN"/turn-*.prompt 2>/dev/null); do
    printf '### %s\n%s\n\n' "$(basename "$p" .prompt | sed 's/^turn-//')" "$(cat "$p")" \
      >> "$RUN/instruction.txt"
  done
  [ -s "$RUN/instruction.txt" ] || echo "(no turn prompts recorded)" > "$RUN/instruction.txt"

  # One trajectory for the whole conversation. cc_trajectory.py already walks
  # the session transcript, so multi-turn needs no special casing here.
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
  # Remove exactly the ids this run created -- never a name sweep, because a
  # concurrent arm has its own containers alive. This is the bug that silently
  # truncated 10 of 25 runs before it was found.
  if [ -s "${IDFILE:-}" ]; then
    while read -r c; do [ -n "$c" ] && docker rm -f "$c" >/dev/null 2>&1; done < <(sort -u "$IDFILE")
  else
    [ -n "${CID:-}" ] && docker rm -f "$CID" >/dev/null 2>&1
    [ -n "${GW_CID:-}" ] && docker rm -f "$GW_CID" >/dev/null 2>&1
  fi
}
