# codex-cli adapter for run.sh (contract: see adapters/claude.sh).
#
# Multi-turn: turn 1 runs `codex exec`, later turns `codex exec resume --last`;
# CODEX_HOME is private to the container, so `--last` is unambiguous.
# The `--json` event stream is converted to the Claude message format by
# codex_normalize.py and written to claude_stream.jsonl.

# shellcheck source=_common.sh
. "$HERE/adapters/_common.sh"

adapter_setup() {
  local rc=0
  rb_adapter_setup run_task_codex.sh "$1" "$2" || rc=$?
  [ -s "$2/session.env" ] || return "$rc"
  # `codex exec` discards the UserPromptSubmit hook's output, so the BackUpper
  # briefing is delivered with the first user message (see bu_announce.sh).
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
    | "$PY" "$HERE/codex_normalize.py" >> "$RUN/claude_stream.jsonl"
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
