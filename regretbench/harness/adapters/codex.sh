# codex-cli (OpenAI Codex CLI, via OpenRouter) adapter for run.sh.
#
# Agent semantics ONLY -- see adapters/claude.sh's header for the contract
# this file must satisfy (setup/turn/collect/teardown). Mirrors claude.sh
# function-for-function; read that file first, this one only calls out
# where codex's own CLI forces a different shape.
#
# Multi-turn: codex-cli has no --session-id to OPEN a session under a chosen
# id (see `codex exec --help` / `codex exec resume --help`) -- a fresh
# `codex exec` mints and persists its own session; continuation is
# `codex exec resume --last <prompt>`. Because CODEX_HOME ($CCDIR/cfg, see
# run_task_codex.sh) is private to this run's own container, "--last" is
# unambiguous: there is exactly one codex session ever created in that
# CODEX_HOME for the whole run's lifetime. Turn 1 opens fresh; turns 2..N
# (and the confirmation-nudge turn) resume --last -- the same
# fresh-then-resume shape claude.sh uses, just without needing to track an
# explicit id.
#
# Trajectory format: codex's own `--json` event stream is NOT the Claude
# message shape asks_confirmation.py / predicate.py / cc_trajectory.py
# already read. Rather than teach those three files a second format, every
# codex event is piped through harness/codex_normalize.py, which re-emits it
# as that SAME envelope, into a file named claude_stream.jsonl (yes, that
# name, on a codex run) -- because run.sh's confirmation-nudge check and
# predicate.py's AVOIDED-detection both hardcode that filename, and matching
# it means neither one needs to change for a second agent. See
# codex_normalize.py's module docstring for the (unverified -- no live
# `codex exec` output was obtainable this session) event-shape mapping.
#
# *** UNTESTED END-TO-END. See the run report for exactly what was and was
# not empirically verified before relying on this for a real sweep. ***

adapter_setup() {
  local TASKDIR="$1" RUN="$2"
  RB_PHASE=setup RB_RESULTS_DIR="$(dirname "$RUN")" RB_RUN_DIR="$RUN" \
    bash "$HERE/run_task_codex.sh" "$TASKDIR" ${MODEL:+"$MODEL"} \
    > "$RUN/setup.log" 2>&1
  local rc=$?
  # run_task_codex.sh mints its own timestamped run dir (same reason
  # run_task_claude.sh does); adopt its session.env if it did not land in ours.
  if [ ! -s "$RUN/session.env" ]; then
    local src; src="$(tail -1 "$RUN/setup.log" 2>/dev/null)"
    [ -s "$src/session.env" ] && cp "$src/session.env" "$RUN/session.env" \
      && cp -a "$src"/. "$RUN"/ 2>/dev/null
  fi
  [ -s "$RUN/session.env" ] || { echo "[fail] setup produced no session.env (see $RUN/setup.log)" >&2; return 1; }
  # `codex exec` runs the plugin's UserPromptSubmit hook but throws away its
  # stdout, so the briefing never reaches the model -- measured, not assumed: the
  # smoke's announced-sessions.json had the session recorded and the trajectory had
  # zero hits for the announcement text, while the agent's single declaration came
  # from it stumbling on .chats-sandbox with ls. Capture the hook's own output and
  # hand it to run.sh's first-user-message channel instead. See harness/cs_announce.sh.
  if [ "${RB_BACKUPPER:-0}" = 1 ]; then
    bash "$HERE/cs_announce.sh" "$RUN" >> "$RUN/setup.log" 2>&1 \
      || echo "[warn] briefing capture failed; this run measures discovery, not the tool" >&2
  fi
  return $rc
}

adapter_turn() {
  local RUN="$1" TID="$2" PROMPT="$3" TIMEOUT="$4"
  # shellcheck disable=SC1091
  source "$RUN/session.env"

  # In subscription (chatgpt) mode, model_provider must not be passed: the CLI's -c
  # override takes precedence over config.toml, and subscription mode's config.toml has
  # no [model_providers.*] table -- passing it produces
  # "Model provider `openrouter` not found", turn 1 dies immediately, and the whole run
  # is graded VOID.
  local args=(-c "model=$MODEL")
  [ "${CODEX_AUTH:-apikey}" = chatgpt ] || args+=(-c "model_provider=$PROVIDER")
  args+=(\
              -c "model_reasoning_effort=$REASONING_EFFORT" \
              --skip-git-repo-check --json)
  # codex gates hooks behind a trust mechanism (HookStateToml / trusted_hash): an
  # untrusted hook simply does not run, and trust is granted interactively, which
  # nobody is around to do in a sweep. This flag exists for exactly that -- `codex
  # exec --help`: "Intended only for automation that already vets hook sources". We
  # docker cp the hook in ourselves, so its provenance is known. The `hooks` feature
  # is stable/true in 0.147.0; no extra features toggle is needed.
  # MEASURED on 0.147 (fake-model probe): WITHOUT this flag not one hook of
  # any event fires under `codex exec`, and nothing says so -- the run looks
  # completely normal. So it gates the backupper arm too, not just the
  # shadow snapshot.
  if [ -n "${RB_SHADOW_HOOK:-}" ] || [ "${RB_BACKUPPER:-0}" = 1 ]; then
    args+=(--dangerously-bypass-hook-trust)
  fi
  local sub=exec was_open=0
  # First turn opens the session; every later turn (including the
  # confirmation-nudge turn) resumes the one-and-only session in this
  # container's CODEX_HOME. Captured BEFORE touching the marker below, so it
  # still means "was this already open going into THIS turn" after the marker
  # is set for next time.
  if [ -f "$RUN/.session-open" ]; then sub="exec resume --last"; was_open=1; fi
  # --add-dir ONLY on the opening turn. `codex exec` accepts it; `codex exec
  # resume` does NOT -- it exits 2 with "error: unexpected argument '--add-dir'
  # found" before contacting the model. Measured: task 93's first terra run had
  # turn 1 succeed (rc=0, 7 tool calls) and then EVERY remaining turn fail
  # rc=2 in under a second, so the run scored VOID with the agent never seeing
  # turns 2-10. The session's directory reach is established when the session
  # is opened, so re-passing it on resume was never needed anyway.
  if [ -n "${ADD_DIR:-}" ] && [ "$was_open" = 0 ]; then args+=(--add-dir "$ADD_DIR"); fi

  local start rc=0
  start=$(date +%s)
  # The prompt is passed as one argv element read from a file: no
  # interpolation, so nothing in the task text can alter the command.
  # shellcheck disable=SC2086
  docker exec -w "$CWD" "${AGENT_ENV[@]}" "$CID" \
    timeout "$TIMEOUT" "$CCDIR/pkg/codex/bin/codex" $sub \
      "${args[@]}" -- "$(cat "$PROMPT")" \
    2>> "$RUN/agent.stderr.log" \
    | tee -a "$RUN/codex_stream.raw.jsonl" \
    | "$PY" "$HERE/codex_normalize.py" >> "$RUN/claude_stream.jsonl"
  rc=${PIPESTATUS[0]:-0}
  touch "$RUN/.session-open"

  # PRE-FLIGHT: after turn 1, assert the session was actually persisted under
  # CODEX_HOME. Probe as root (-u 0): the same permission fault that breaks
  # this also makes the cfg dir unlistable by the agent's own uid. Codex's
  # exact on-disk session layout under $CODEX_HOME is not confirmed live
  # (see codex_normalize.py's docstring) -- this searches broadly for ANY
  # *.jsonl written under $CCDIR/cfg in the last few minutes, rather than
  # hardcoding one exact subdirectory, specifically because that path is a
  # guess.
  if [ ! -f "$RUN/.session-checked" ]; then
    touch "$RUN/.session-checked"
    if ! docker exec -u 0 "$CID" bash -c \
         "f=\$(find $CCDIR/cfg -name '*.jsonl' -newer $CCDIR/cfg/config.toml 2>/dev/null | head -1); [ -s \"\$f\" ]" 2>/dev/null; then
      echo "[fail] no codex session file found under $CCDIR/cfg after turn 1 -- resume --last will fail (permissions, or the session path guessed in this adapter is wrong)" \
        | tee -a "$RUN/driver.log" >&2
      echo "$TID" >> "$RUN/RESUME_FAILED"
    fi
  fi

  # A BROKEN RESUME MUST NOT LOOK LIKE A CLEAN RESULT (same lesson claude.sh
  # records for task 54). codex's exact resume-failure message on stderr is
  # not confirmed live, so this is a best-effort net: a non-zero rc on any
  # turn that used --last (was_open=1), with a stderr line that looks like a
  # missing-session complaint, is at least logged loudly even where it cannot
  # be auto-classified with certainty.
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

  # --- RB_BACKUPPER: carry the record out before teardown --------------------
  # Same shape and the same reasoning as adapters/claude.sh: shadow-repo/ is
  # dropped, and backups/*/{pre,trash} are replaced by a manifest so a batch
  # does not drag several GB of task fixture out of the images.
  if [ "${RB_BACKUPPER:-0}" = 1 ]; then
    local _csr="$RUN/backupper_rescue.log"; : > "$_csr"
    # WHERE THE STORE IS vs WHERE IT LANDS. CS_STORE comes from session.env and
    # is $CWD/.chats-sandbox unless RB_CS_STORE moved the store out of the
    # workspace (see run_task_codex.sh). The DESTINATION never moves: every
    # downstream reader joins on $RUN/.chats-sandbox, so the run
    # directory layout stays exactly as it was whichever side the source is on.
    local _store="${CS_STORE:-$CWD/.chats-sandbox}"
    if docker exec "$CID" test -d "$_store" 2>>"$_csr"; then
      if docker cp "$CID:$_store" "$RUN/.chats-sandbox" >>"$_csr" 2>&1; then
        rm -rf "$RUN/.chats-sandbox/shadow-repo"
        while IFS= read -r _d; do
          [ -d "$_d" ] || continue
          { echo "# replaced by adapter_collect: bytes not carried out of the container"
            echo "# total: $(du -sb "$_d" 2>/dev/null | cut -f1) bytes, $(find "$_d" -type f 2>/dev/null | wc -l) files"
            find "$_d" -type f -printf '%s\t%P\n' 2>/dev/null | sort -k2
          } > "$_d.manifest.txt" 2>/dev/null
          rm -rf "$_d"
        done < <(find "$RUN/.chats-sandbox/backups" -mindepth 2 -maxdepth 2 -type d \
                      \( -name pre -o -name trash -o -name external-shadow \) 2>/dev/null)
        echo "[backupper] record -> $RUN/.chats-sandbox ($(wc -l < "$RUN/.chats-sandbox/declarations.jsonl" 2>/dev/null || echo 0) declarations)"
        # The tier-3 subagent's own transcript: the plugin cannot find it here and
        # writes a MISSING marker instead, because it looks under the CODEX_HOME it
        # spawned with ($CCDIR/cfg) while the subagent shim re-exports a private one
        # ($CCDIR/subcfg) inside the child. That privacy is deliberate -- sharing the
        # dir makes the next turn's `resume --last` pick the subagent's session and
        # the main agent's history vanishes (verified) -- so rather than merge them
        # back, collect the rollouts ourselves. Without this there is no subagent log
        # and no tok_sub on this lane.
        local _sub="${CS_SUBCFG_IN:-/opt/rbcodex/subcfg}/sessions"
        if docker exec "$CID" test -d "$_sub" 2>>"$_csr"; then
          docker cp "$CID:$_sub" "$RUN/subagent-sessions" >>"$_csr" 2>&1 \
            && echo "[backupper] subagent transcripts -> $RUN/subagent-sessions ($(find "$RUN/subagent-sessions" -name '*.jsonl' 2>/dev/null | wc -l) rollouts)"
        else
          echo "[backupper] no subagent sessions dir at $_sub" >>"$_csr"
        fi
      else
        echo "[backupper] docker cp failed -- see $_csr"
      fi
    else
      echo "[backupper] no store at $_store -- the plugin never wrote anything"
    fi
  fi
  # shellcheck disable=SC1091
  source "$RUN/session.env"
  docker diff "$CID" | sort > "$RUN/diff_post_agent.txt" 2>/dev/null

  # Evidence that the snapshots happened. teardown is about to delete the container
  # and /tmp/.rb-shadow lives inside it, so without this nothing survives and the
  # question "did the hook actually run" becomes unanswerable. One line per commit;
  # the message carries tool_name and tool_use_id so commits line up with the
  # trajectory's calls.
  if [ -n "${RB_SHADOW_HOOK:-}" ]; then
    docker exec "$CID" sh -c \
      'git --git-dir=/tmp/.rb-shadow log --oneline --format="%H %s" 2>/dev/null' \
      > "$RUN/shadow_commits.txt" 2>/dev/null || true
    docker cp "$CID:/tmp/.rb-shadow-audit.log" "$RUN/shadow_audit.log" >/dev/null 2>&1 || true
    echo "[shadow] $(wc -l < "$RUN/shadow_commits.txt" 2>/dev/null || echo 0) snapshot commits / $(wc -l < "$RUN/shadow_audit.log" 2>/dev/null || echo 0) audit lines"
  fi

  # No separate "canonical session file" distinct from the normalized stream
  # (see codex_normalize.py) -- claude_session.jsonl is the SAME content as
  # claude_stream.jsonl. Kept as its own file (rather than a symlink) purely
  # because predicate.py's --trajectory and cc_trajectory.py's --session both
  # take a path, and giving them the exact filename run.sh already expects
  # keeps this adapter a drop-in.
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

  # Evidence for reasoning_effort: whatever codex's own session-start event
  # said, verbatim, alongside what was actually requested on argv. If codex's
  # start event carries no such field (schema mismatch -- see
  # codex_normalize.py), this is at least an honest "not found", not a
  # fabricated confirmation.
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
    while read -r c; do [ -n "$c" ] && docker rm -f "$c" >/dev/null 2>&1; done < <(sort -u "$IDFILE")
  else
    [ -n "${CID:-}" ] && docker rm -f "$CID" >/dev/null 2>&1
  fi
}
