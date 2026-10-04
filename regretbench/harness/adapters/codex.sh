# codex-cli adapter for run.sh (contract: see adapters/claude.sh).
#
# Multi-turn: turn 1 runs `codex exec`, later turns `codex exec resume --last`;
# CODEX_HOME is private to the container, so `--last` is unambiguous.
# The `--json` event stream is converted to the Claude message format by
# codex_normalize.py and written to claude_stream.jsonl.

adapter_setup() {
  local TASKDIR="$1" RUN="$2"
  RB_RESULTS_DIR="$(dirname "$RUN")" RB_RUN_DIR="$RUN" \
    bash "$HERE/run_task_codex.sh" "$TASKDIR" ${MODEL:+"$MODEL"} \
    > "$RUN/setup.log" 2>&1
  local rc=$?
  # Adopt the setup's run dir if it minted its own.
  if [ ! -s "$RUN/session.env" ]; then
    local src; src="$(tail -1 "$RUN/setup.log" 2>/dev/null)"
    [ -s "$src/session.env" ] && cp "$src/session.env" "$RUN/session.env" \
      && cp -a "$src"/. "$RUN"/ 2>/dev/null
  fi
  [ -s "$RUN/session.env" ] || { echo "[fail] setup produced no session.env (see $RUN/setup.log)" >&2; return 1; }
  # `codex exec` discards the UserPromptSubmit hook's output, so the BackUpper
  # briefing is delivered with the first user message (see bu_announce.sh).
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

  local wall=$(( $(date +%s) - start ))
  echo "  rc=$rc wall=${wall}s" | tee -a "$RUN/driver.log"
  [ "$rc" = 124 ] && echo "timeout at $TID" > "$RUN/TIMEOUT"
  return $rc
}

adapter_collect() {
  local RUN="$1"

  # --- RB_BACKUPPER: copy the store out before teardown ----------------------
  # shadow-repo/ is dropped and backups/*/{pre,trash,external-shadow} are replaced
  # by a file manifest, so large task fixtures are not carried out.
  if [ "${RB_BACKUPPER:-0}" = 1 ]; then
    local rescue_log="$RUN/backupper_rescue.log"
    : > "$rescue_log"
    # The container-side store may be relocated; the host side is always $RUN/.backupper.
    local store="${BU_STORE:-$CWD/.backupper}"
    if docker exec "$CID" test -d "$store" 2>>"$rescue_log"; then
      if docker cp "$CID:$store" "$RUN/.backupper" >>"$rescue_log" 2>&1; then
        rm -rf "$RUN/.backupper/shadow-repo"
        local dir nbytes nfiles ndecl
        while IFS= read -r dir; do
          [ -d "$dir" ] || continue
          nbytes="$(du -sb "$dir" 2>/dev/null | cut -f1)"
          nfiles="$(find "$dir" -type f 2>/dev/null | wc -l)"
          { echo "# replaced by adapter_collect: bytes not carried out of the container"
            echo "# total: $nbytes bytes, $nfiles files"
            find "$dir" -type f -printf '%s\t%P\n' 2>/dev/null | sort -k2
          } > "$dir.manifest.txt" 2>/dev/null
          rm -rf "$dir"
        done < <(find "$RUN/.backupper/backups" -mindepth 2 -maxdepth 2 -type d \
                      \( -name pre -o -name trash -o -name external-shadow \) 2>/dev/null)
        ndecl="$(wc -l < "$RUN/.backupper/declarations.jsonl" 2>/dev/null || echo 0)"
        echo "[backupper] record -> $RUN/.backupper ($ndecl declarations)"
        # The tier-3 subagent keeps its own CODEX_HOME, so its transcripts are
        # collected separately.
        local sub_sessions="${BU_SUBCFG_IN:-/opt/rbcodex/subcfg}/sessions"
        if docker exec "$CID" test -d "$sub_sessions" 2>>"$rescue_log"; then
          docker cp "$CID:$sub_sessions" "$RUN/subagent-sessions" >>"$rescue_log" 2>&1 \
            && echo "[backupper] subagent transcripts -> $RUN/subagent-sessions ($(find "$RUN/subagent-sessions" -name '*.jsonl' 2>/dev/null | wc -l) rollouts)"
        else
          echo "[backupper] no subagent sessions dir at $sub_sessions" >>"$rescue_log"
        fi
      else
        echo "[backupper] docker cp failed -- see $rescue_log"
      fi
    else
      echo "[backupper] no store at $store -- the plugin never wrote anything"
    fi
  fi
  # shellcheck disable=SC1091
  source "$RUN/session.env"
  docker diff "$CID" | sort > "$RUN/diff_post_agent.txt" 2>/dev/null

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
    --model "$MODEL" --session "$RUN/claude_session.jsonl" \
    --stream "$RUN/claude_stream.jsonl" >> "$RUN/driver.log" 2>&1 \
    || echo "[warn] cc_trajectory failed; judge cannot score this run" >> "$RUN/driver.log"

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
  if [ -s "${IDFILE:-}" ]; then
    while read -r c; do
      [ -n "$c" ] && docker rm -f "$c" >/dev/null 2>&1
    done < <(sort -u "$IDFILE")
  else
    [ -n "${CID:-}" ] && docker rm -f "$CID" >/dev/null 2>&1
  fi
}
