# adapters.sh -- the agent adapters for run.sh: agent-side semantics only. Turn order, hooks,
# grading and result layout live in run.sh. Sourced by run.sh with HARNESS set; defines the
# four adapter functions of that harness (claude, codex or hermes).
#
# Contract:
#   adapter_setup    TASKDIR RUNDIR   stand the agent up; write RUNDIR/session.env with CID=
#   adapter_turn     RUNDIR TURN_ID PROMPT_FILE TIMEOUT   deliver ONE user message in-session
#   adapter_collect  RUNDIR           transcript -> trajectory.json
#   adapter_teardown RUNDIR           remove exactly what setup created
#
#

# shellcheck source=setup_lib.sh
. "$HERE/setup_lib.sh"

case "$HARNESS" in
claude)
  # Claude Code. Multi-turn uses Claude Code session resume: turn 1 opens
  # `--session-id $SID`, later turns attach with `--resume $SID`.

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
  ;;

codex)
  # codex-cli.
  #
  # Multi-turn: turn 1 runs `codex exec`, later turns `codex exec resume --last`;
  # CODEX_HOME is private to the container, so `--last` is unambiguous.
  # The `--json` event stream is converted to the Claude message format by
  # `trajectory.py codex` and written to claude_stream.jsonl.

  adapter_setup() {
    local rc=0
    rb_adapter_setup run_task_codex.sh "$1" "$2" || rc=$?
    [ -s "$2/session.env" ] || return "$rc"
    # `codex exec` discards the UserPromptSubmit hook's output, so the BackUpper
    # briefing is delivered with the first user message (see `setup_lib.sh announce`).
    rb_bu_announce "$2"
    return "$rc"
  }

  adapter_turn() {
    local RUN="$1" TID="$2" PROMPT="$3" TIMEOUT="$4"
    # shellcheck disable=SC1091
    source "$RUN/session.env"

    # Subscription (chatgpt) mode defines no [model_providers.*], so no model_provider.
    local args=(-c "model=$MODEL")
    [ "${CODEX_AUTH:-apikey}" = chatgpt ] || args+=(-c "model_provider=$PROVIDER")
    args+=(-c "model_reasoning_effort=$REASONING_EFFORT" --skip-git-repo-check --json)
    # Hook trust is otherwise granted interactively; the hook is installed by this harness.
    if [ "${RB_BACKUPPER:-0}" = 1 ]; then
      args+=(--dangerously-bypass-hook-trust)
    fi
    local sub=exec was_open=0
    # First turn opens the session; later turns (including the nudge) resume it.
    if [ -f "$RUN/.session-open" ]; then sub="exec resume --last"; was_open=1; fi
    # --add-dir only on the opening turn: `codex exec resume` rejects it.
    if [ -n "${ADD_DIR:-}" ] && [ "$was_open" = 0 ]; then args+=(--add-dir "$ADD_DIR"); fi

    local start rc=0
    start=$(date +%s)
    # The prompt is a single argv element, never interpolated into a command.
    # shellcheck disable=SC2086
    docker exec -w "$CWD" "${AGENT_ENV[@]}" "$CID" \
      timeout "$TIMEOUT" "$CCDIR/pkg/codex/bin/codex" $sub \
        "${args[@]}" -- "$(cat "$PROMPT")" \
      2>> "$RUN/agent.stderr.log" \
      | tee -a "$RUN/codex_stream.raw.jsonl" \
      | "$PY" "$HERE/trajectory.py" codex >> "$RUN/claude_stream.jsonl"
    rc=${PIPESTATUS[0]:-0}
    touch "$RUN/.session-open"

    # After turn 1, check (as root) that a session file was written under CODEX_HOME.
    if [ ! -f "$RUN/.session-checked" ]; then
      touch "$RUN/.session-checked"
      if ! docker exec -u 0 "$CID" bash -c \
           "f=\$(find $CCDIR/cfg -name '*.jsonl' -newer $CCDIR/cfg/config.toml 2>/dev/null | head -1); [ -s \"\$f\" ]" 2>/dev/null; then
        echo "[fail] no codex session file found under $CCDIR/cfg after turn 1 -- resume --last will fail (permissions, or the session path guessed in this adapter is wrong)" \
          | tee -a "$RUN/driver.log" >&2
        echo "$TID" >> "$RUN/RESUME_FAILED"
      fi
    fi

    # Record a failed resume (non-zero rc plus a missing-session message on stderr)
    # so the run can be excluded rather than read as protected.
    if [ "$rc" != 0 ] && [ "$was_open" = 1 ]; then
      if tail -5 "$RUN/agent.stderr.log" 2>/dev/null | grep -qiE 'no (conversation|session|thread) found|resume.*fail|not found'; then
        echo "$TID" >> "$RUN/RESUME_FAILED"
      fi
    fi

    rb_turn_end "$RUN" "$TID" "$start" "$rc"
  }

  adapter_collect() {
    local RUN="$1"
    # shellcheck disable=SC1091
    source "$RUN/session.env"

    # --- RB_BACKUPPER: copy the store out before teardown ----------------------
    # Trimmed to a record (rb_store_trim), so large task fixtures are not carried out.
    if [ "${RB_BACKUPPER:-0}" = 1 ]; then
      local rescue_log="$RUN/backupper_rescue.log" rc=0
      : > "$rescue_log"
      rb_store_harvest "$CID" "${BU_STORE:-$CWD/.backupper}" "$RUN" "$rescue_log" || rc=$?
      case "$rc" in
        0)
          rb_store_trim "$RUN/$RB_STORE_NAME"
          # The tier-4 subagent keeps its own CODEX_HOME, so its transcripts are
          # collected separately.
          local sub_sessions="${BU_SUBCFG_IN:-/opt/rbcodex/subcfg}/sessions"
          if docker exec "$CID" test -d "$sub_sessions" 2>>"$rescue_log"; then
            docker cp "$CID:$sub_sessions" "$RUN/subagent-sessions" >>"$rescue_log" 2>&1 \
              && echo "[backupper] subagent transcripts -> $RUN/subagent-sessions ($(find "$RUN/subagent-sessions" -name '*.jsonl' 2>/dev/null | wc -l) rollouts)"
          else
            echo "[backupper] no subagent sessions dir at $sub_sessions" >>"$rescue_log"
          fi ;;
        2) echo "[backupper] no store at ${BU_STORE:-$CWD/.backupper} -- the plugin never wrote anything" ;;
        *) echo "[backupper] docker cp failed -- see $rescue_log" ;;
      esac
    fi
    docker diff "$CID" | sort > "$RUN/diff_post_agent.txt" 2>/dev/null

    # The normalized stream doubles as the session transcript.
    cp "$RUN/claude_stream.jsonl" "$RUN/claude_session.jsonl" 2>/dev/null || true
    rb_build_trajectory "$RUN"

    # Record the requested reasoning effort next to what codex's own events reported.
    {
      echo "requested_reasoning_effort=$REASONING_EFFORT (via -c model_reasoning_effort=... on every turn)"
      grep -o '"reasoning_effort"[^,}]*' "$RUN/codex_stream.raw.jsonl" 2>/dev/null | sort -u
    } > "$RUN/reasoning_effort_evidence.txt" 2>/dev/null || true
  }

  adapter_teardown() {
    local RUN="$1"
    # shellcheck disable=SC1091
    source "$RUN/session.env" 2>/dev/null || return 0
    rb_rm_containers "${IDFILE:-}" "${CID:-}"
  }
  ;;

hermes)
  # hermes.
  #
  # hermes runs on the host; every turn is a new process that adopts the task
  # container via HERMES_TERMINAL_DOCKER_ADOPT and resumes its session with
  # `hermes chat --resume <id>`. Each turn's new session messages are converted to
  # the Claude message format by `trajectory.py hermes-normalize`; `.hermes-emitted` holds the
  # index of the last message already written to claude_stream.jsonl.

  # hermes copies OPENROUTER_API_KEY into $HERMES_HOME/auth.json inside the run
  # dir; remove it (called from both collect and teardown).
  _hermes_scrub_credentials() {
    local RUN="$1"
    rm -f "$RUN/home/.hermes/auth.json" 2>/dev/null
  }

  adapter_setup() {
    local rc=0
    rb_adapter_setup run_task.sh "$1" "$2" || rc=$?
    [ -s "$2/session.env" ] || return "$rc"
    # hermes hooks cannot add text to the conversation, so the BackUpper briefing
    # is delivered with the first user message (see `setup_lib.sh announce`).
    rb_bu_announce "$2"
    return "$rc"
  }

  adapter_turn() {
    local RUN="$1" TID="$2" PROMPT="$3" TIMEOUT="$4"
    # shellcheck disable=SC1091
    source "$RUN/session.env"

    # Sets HERMES_UPSTREAM_MODEL.
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
    sid="$("$PY" "$HERE/trajectory.py" hermes-sessions --home "$AGENT_HERMES_HOME" --leaf 2>/dev/null)"
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
      emitted="$("$PY" "$HERE/trajectory.py" hermes-normalize "$sess" --from "$from" \
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
    mstats="$("$PY" "$HERE/trajectory.py" hermes-sessions --merge --home "$AGENT_HERMES_HOME" \
                ${snaps[0]+--snapshots "${snaps[@]}"} \
                --out "$RUN/hermes_session_merged.json" 2>>"$RUN/driver.log")"
    if [ -s "$RUN/hermes_session_merged.json" ]; then
      echo "[sessions] merged $mstats" | tee -a "$RUN/driver.log"
      : > "$RUN/claude_stream.jsonl"
      "$PY" "$HERE/trajectory.py" hermes-normalize "$RUN/hermes_session_merged.json" --from 0 \
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
  ;;
esac
