# hermes adapter for run.sh.
#
# Agent semantics ONLY -- see adapters/claude.sh's header for the contract this
# file must satisfy (setup/turn/collect/teardown). Read that file first; this
# one only calls out where hermes forces a different shape.
#
# STATUS: v1 and v2 both supported as of 2026-08-17.
#
# WHAT CHANGED, AND WHY THE OLD "v2 IS IMPOSSIBLE" NOTE IS GONE
# --------------------------------------------------------------
# The previous version of this file refused v2 outright, on the grounds that
# "hermes' cli.py exposes no session-resume equivalent to Claude Code's
# --resume, so the only way to fake it would be to replay a transcript into a
# fresh context each turn" -- which would hand the agent a clean machine-written
# record of what it just did, i.e. exactly the context echo the v2 design exists
# to eliminate. That reasoning was right and the constraint is now gone: the
# hermes in hermes-agent/ (0.8.0) has
#     hermes chat --resume <session_id> -q <prompt>
# with session state in $HERMES_HOME/sessions/session_<id>.json. Turn 1 opens
# the session and we scrape its id off the CLI's own `session_id:` line; turns
# 2..N resume it. That is genuine conversational continuity, same as claude.sh.
#
# THE AGENT IS ON THE HOST -- UNLESS RB_HERMES_IN_CONTAINER=1. That is the
# structural difference from the other two arms and it shows up in every function
# below: there is no `docker exec ... agent` here, we exec hermes directly. Each
# turn is a NEW host process, so the container must be re-adopted every turn
# (HERMES_TERMINAL_DOCKER_ADOPT, set in COMMON_ENV by run_task.sh). Without
# adoption hermes would create a FRESH container on each turn's first terminal
# call: every turn would start from a pristine image, the runway would leave no
# trace, and nothing would look wrong.
#
# UNDER RB_HERMES_IN_CONTAINER=1 the shape becomes the claude/codex one: the agent
# is `docker exec`'d into the task container with AGENT_ENV (built once in
# run_task.sh and round-tripped through session.env), its terminal tool is hermes'
# LocalEnvironment -- a bash in that same container -- and adoption is irrelevant
# because there is nothing to adopt. Everything else in this file is unchanged:
# --resume, the per-turn session snapshot, the compaction-aware leaf lookup and
# hermes_normalize.py all read $AGENT_HERMES_HOME, which is a bind mount of the
# container's HOME, so the host-side paths are literally the same paths.
# See run_task.sh's header for what was measured before this mode was added.
#
# TRANSCRIPT FORMAT. hermes writes one OpenAI-shaped session JSON, rewritten in
# full on every turn. run.sh's confirmation-nudge check, predicate.py and
# cc_trajectory.py all read the Claude envelope out of a file literally named
# claude_stream.jsonl (two of the three hardcode the name). So each turn's NEW
# messages are re-emitted into that file through hermes_normalize.py -- the same
# trick, for the same reason, as codex_normalize.py. `.hermes-emitted` carries
# the message index already emitted, so the nudge check's byte offset really
# does isolate one turn.

# The API key must not survive on disk. hermes copies OPENROUTER_API_KEY out of
# the environment into $HERMES_HOME/auth.json (its "credential pool") on first
# use -- verified 2026-08-17: access_token holds the key verbatim. That file
# lives inside the run directory, which is archived and shipped with the
# results, so it is deleted as soon as the run no longer needs it. Called from
# both collect and teardown: a run that dies before collect must still not
# leave the credential behind.
_hermes_scrub_credentials() {
  local RUN="$1"
  rm -f "$RUN/home/.hermes/auth.json" 2>/dev/null
}

adapter_setup() {
  local TASKDIR="$1" RUN="$2"
  RB_PHASE=setup RB_RESULTS_DIR="$(dirname "$RUN")" RB_RUN_DIR="$RUN" \
    bash "$HERE/run_task.sh" "$TASKDIR" ${MODEL:+"$MODEL"} \
    > "$RUN/setup.log" 2>&1
  local rc=$?
  # run_task.sh honours RB_RUN_DIR, so session.env lands in our own dir. The
  # fallback mirrors claude.sh/codex.sh for the case where it minted its own.
  if [ ! -s "$RUN/session.env" ]; then
    local src; src="$(tail -1 "$RUN/setup.log" 2>/dev/null)"
    [ -s "$src/session.env" ] && cp "$src/session.env" "$RUN/session.env" \
      && cp -a "$src"/. "$RUN"/ 2>/dev/null
  fi
  [ -s "$RUN/session.env" ] || {
    echo "[fail] setup produced no session.env (see $RUN/setup.log)" >&2
    tail -20 "$RUN/setup.log" >&2
    return 1; }
  # hermes' hook signature is (tool_name, args) -> None: the plugin can still act
  # on a call, but it has no way to put text back into the conversation, so the
  # briefing cannot arrive the way it does on the claude lane. Deliver the hook's
  # own announcement through run.sh's first-user-message channel instead -- same
  # text, same position. See harness/cs_announce.sh for why it is not hand-copied.
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

  # $MODEL is the label the whole run is reported under; the name and the URL
  # the UPSTREAM wants can differ from it (Claude models need the genai alias
  # and the /compat route -- see harness/hermes_model_route.sh for the measured
  # reason). Resolve per turn: this function is the only place that talks to
  # the API, and rb_hermes_route also (re-)exports OPENROUTER_BASE_URL, which
  # `env` below inherits from this shell.
  . "$HERE/hermes_model_route.sh"
  rb_hermes_route "$MODEL"
  local args=(chat --toolsets "$TOOLSETS" -m "$HERMES_UPSTREAM_MODEL" --provider openrouter -Q --yolo)
  local was_open=0
  # Turn 1 opens the session; every later turn (including the nudge turn)
  # resumes THAT session id. Captured before the marker is touched so it still
  # means "was this open going into THIS turn".
  if [ -s "$RUN/.hermes-session-id" ]; then
    args+=(--resume "$(cat "$RUN/.hermes-session-id")")
    was_open=1
  fi

  local start rc=0
  start=$(date +%s)
  # The prompt is passed as one argv element read from a file: no interpolation,
  # so nothing in the task text can alter the command.
  # OPENROUTER_API_KEY / OPENROUTER_BASE_URL are inherited from the ambient
  # environment (env-hermes.sh) -- `env` without -i keeps them, and keeping the
  # key out of COMMON_ENV keeps it out of session.env on disk.
  # RB_SHADOW_*: hermes runs on the host, and cli.py's _on_tool_start needs these two
  # to know which container to docker exec into and which directory to snapshot.
  # `env` is called without -i, so they are passed explicitly.
  local _shadow_env=()
  if [ -n "${RB_SHADOW_HOOK:-}" ]; then
    _shadow_env=(RB_SHADOW_CID="$CID" RB_SHADOW_WORK_TREE="$CWD")
  fi
  if [ "${IN_CT:-0}" = 1 ]; then
    # The agent runs INSIDE the task container. AGENT_ENV was built once in
    # run_task.sh (nonce, HOME, PATH, CA roots, plugin switches) and came through
    # session.env; nothing is appended to it here except the real key under the
    # non-default `direct` route, which is deliberately never written to disk.
    #
    # WHERE THE TURN BUDGET IS ENFORCED. `timeout` on the HOST side of a docker exec
    # kills only the exec CLIENT: the agent goes on running inside the container and
    # can still be acting while the NEXT turn's prompt is delivered -- which on a
    # multi-turn regret task means state changing under a turn that did not ask for
    # it. So use the container's own timeout(1) when the image has one (detected at
    # setup, recorded as TIMEOUT_IN), and fall back to the host wrapper when it does
    # not, rather than assuming coreutils is there.
    local _k=()
    [ "${HERMES_MODEL_ROUTE:-sidecar}" = sidecar ] || _k=(-e OPENROUTER_API_KEY="$OPENROUTER_API_KEY")
    if [ "${TIMEOUT_IN:-0}" = 1 ]; then
      docker exec -w "$CWD" "${AGENT_ENV[@]}" "${_k[@]+"${_k[@]}"}" "$CID" \
          timeout "$TIMEOUT" "${HERMES_BIN_IN:-/opt/rbhermes/bin/hermes}" "${args[@]}" -q "$(cat "$PROMPT")" \
          >> "$RUN/hermes_stdout.log" 2>> "$RUN/agent.stderr.log"
      rc=$?
    else
      timeout "$TIMEOUT" docker exec -w "$CWD" "${AGENT_ENV[@]}" "${_k[@]+"${_k[@]}"}" "$CID" \
          "${HERMES_BIN_IN:-/opt/rbhermes/bin/hermes}" "${args[@]}" -q "$(cat "$PROMPT")" \
          >> "$RUN/hermes_stdout.log" 2>> "$RUN/agent.stderr.log"
      rc=$?
    fi
    # MEASURED, and it would have silently emptied every transcript on this lane.
    # HOME is a bind mount, but on images with a non-root USER the agent's uid maps
    # to a subuid the host user is not, and hermes writes session_*.json 0600 --
    # so `ls` and `stat` succeed while open() raises PermissionError. Everything
    # downstream (the per-turn snapshot, hermes_sessions.py, hermes_normalize.py)
    # reads those files FROM THE HOST, and every one of them swallows the error:
    # the run would come back with an empty claude_stream.jsonl and read as a model
    # that did nothing. Relax it from inside, where root still is root.
    docker exec -u 0 "$CID" sh -c "chmod -R a+rwX '${AGENT_HOME_IN:-/rbhome}/.hermes' 2>/dev/null; true" \
      >/dev/null 2>&1
  else
  ( cd "$RUN" && env "${COMMON_ENV[@]}" "${_shadow_env[@]}" \
      timeout "$TIMEOUT" "$HERMES_BIN" "${args[@]}" -q "$(cat "$PROMPT")" \
      >> "$RUN/hermes_stdout.log" 2>> "$RUN/agent.stderr.log" )
  rc=$?
  fi

  # Snapshot the session dir per turn, BEFORE anything can rewrite it. hermes
  # rewrites the resumed session file in place, so the only record of what a
  # turn looked like before the next resume is the copy we take now. This is
  # also what gives the merge a reliable order: the messages carry no
  # timestamps, and session-id order is not activity order.
  cp -a "$AGENT_HERMES_HOME/sessions" "$RUN/sessions-turn-$TID" 2>/dev/null || true

  # Session id to resume next turn. RE-RESOLVED EVERY TURN, not just the first:
  # compaction ends the current session and mints a child (run_agent.py's
  # _compress_context), and `--resume` looks up history with WHERE session_id=?
  # without following parent_session_id. Pinning turn 1's id therefore resumes a
  # session whose rows stopped growing the moment anything compacted -- observed
  # as "Session ... found but has no messages. Starting fresh." mid-run, and as
  # a final turn with no memory of the destructive one. That does not just lose
  # transcript, it dismantles the multi-turn premise the task is built on.
  # hermes' own `session_id:` line keeps printing the ROOT, so it cannot answer
  # this; hermes_sessions.py --leaf picks the most recently active session.
  local sid
  sid="$("$PY" "$HERE/hermes_sessions.py" --home "$AGENT_HERMES_HOME" --leaf 2>/dev/null)"
  if [ -z "$sid" ]; then
    sid="$(grep -oE '^session_id: [0-9a-zA-Z_]+' "$RUN/hermes_stdout.log" 2>/dev/null | tail -1 | awk '{print $2}')"
  fi
  if [ -n "$sid" ]; then
    local prev; prev="$(cat "$RUN/.hermes-session-id" 2>/dev/null)"
    [ -n "$prev" ] && [ "$prev" != "$sid" ] \
      && echo "  [session] $TID compacted: $prev -> $sid" | tee -a "$RUN/driver.log"
    printf '%s' "$sid" > "$RUN/.hermes-session-id"
  fi

  # A BROKEN RESUME MUST NOT LOOK LIKE A CLEAN RESULT (the lesson claude.sh
  # records for task 54: turn 1 ran, turns 2..N died instantly, the destructive
  # turn never happened, and the predicate graded the run RECOVERED). Two nets:
  # no session id at all after turn 1, and hermes' own resume complaint.
  if [ ! -s "$RUN/.hermes-session-id" ]; then
    echo "[fail] no hermes session id after $TID -- later turns cannot resume" \
      | tee -a "$RUN/driver.log" >&2
    echo "$TID" >> "$RUN/RESUME_FAILED"
  elif [ "$was_open" = 1 ] && tail -5 "$RUN/agent.stderr.log" 2>/dev/null \
        | grep -qiE 'session .*not found|could not (find|load) session|no such session'; then
    echo "$TID" >> "$RUN/RESUME_FAILED"
  fi

  # Fold THIS turn's new messages into the Claude-shaped stream. hermes rewrites
  # the whole session file each turn, so only messages past the emitted index
  # are new -- otherwise every turn would re-append the entire conversation and
  # the nudge check's byte offset would see the run, not the turn.
  local sess="$AGENT_HERMES_HOME/sessions/session_$(cat "$RUN/.hermes-session-id" 2>/dev/null).json"
  if [ -s "$sess" ]; then
    local from; from="$(cat "$RUN/.hermes-emitted" 2>/dev/null || echo 0)"
    local now
    now="$("$PY" "$HERE/hermes_normalize.py" "$sess" --from "$from" \
             --mcp-servers "$(echo "${MCP_NAMES:-}" | tr ' ' ',')" \
             --out "$RUN/claude_stream.jsonl" 2>>"$RUN/driver.log")"
    [ -n "$now" ] && printf '%s' "$now" > "$RUN/.hermes-emitted"
  else
    echo "[warn] no hermes session file for $TID at $sess" >> "$RUN/driver.log"
  fi

  local wall=$(( $(date +%s) - start ))
  echo "  rc=$rc wall=${wall}s" | tee -a "$RUN/driver.log"
  # 124 is timeout(1)'s. Record it so the driver stops delivering turns rather
  # than burning the remaining budget on a session that will not answer.
  [ "$rc" = 124 ] && echo "timeout at $TID" > "$RUN/TIMEOUT"
  return $rc
}

adapter_collect() {
  local RUN="$1"
  # shellcheck disable=SC1091
  source "$RUN/session.env"

  # --- RB_BACKUPPER: trim artifacts -----------------------------------------
  # This lane does not need docker cp: the store is already a bind mount, so whatever
  # gets written into it is already on the host (the claude / codex lanes have to pull
  # .chats-sandbox out of the container first). But trimming still has to happen --
  # one postgres run's pre/ can be tens of MB, and 220 runs would blow out the results
  # directory.
  # Convention matches claude.sh / codex.sh: pre/ trash/ external-shadow/ get replaced
  # by a manifest, and the judge accepts a manifest (it has been explicitly told that a
  # manifest just means "these files existed, at this size, at the time").
  # But in in-container mode the store lives inside the container (same as claude /
  # codex), so docker cp it out first, then run the same trimming below. Both paths
  # share the manifest logic that follows, so the convention never diverges.
  if [ "${RB_BACKUPPER:-0}" = 1 ] && [ "${IN_CT:-0}" = 1 ]; then
    local _csr="$RUN/backupper_rescue.log"; : > "$_csr"
    # CS_STORE comes from session.env: the store's location inside the container,
    # defaulting to $CWD/.chats-sandbox, unless RB_CS_STORE moved it out of the
    # workspace. The destination $RUN/.chats-sandbox never changes -- the run
    # directory layout is the interface the judge and stats scripts rely on.
    local _store="${CS_STORE:-$CWD/.chats-sandbox}"
    if docker exec "$CID" test -d "$_store" 2>>"$_csr"; then
      docker cp "$CID:$_store" "$RUN/.chats-sandbox" >>"$_csr" 2>&1 \
        || echo "[backupper] docker cp failed -- see $_csr"
    else
      echo "[backupper] no store at $_store -- the plugin never wrote anything"
    fi
  fi
  if [ "${RB_BACKUPPER:-0}" = 1 ] && [ -d "$RUN/.chats-sandbox" ]; then
    rm -rf "$RUN/.chats-sandbox/shadow-repo"
    local _n=0 _d
    while IFS= read -r _d; do
      [ -d "$_d" ] || continue
      { echo "# replaced by adapter_collect: bytes not carried out of the run dir"
        echo "# total: $(du -sb "$_d" 2>/dev/null | cut -f1) bytes, $(find "$_d" -type f 2>/dev/null | wc -l) files"
        find "$_d" -type f -printf '%s\t%P\n' 2>/dev/null | sort -k2
      } > "$_d.manifest.txt" 2>/dev/null
      rm -rf "$_d"; _n=$((_n+1))
    done < <(find "$RUN/.chats-sandbox/backups" -mindepth 2 -maxdepth 2 -type d \
                  \( -name pre -o -name trash -o -name external-shadow \) 2>/dev/null)
    echo "[backupper] store $([ "${IN_CT:-0}" = 1 ] && echo 'in container (copied out via docker cp)' || echo 'on host (bind mount)'); trimmed $_n dir(s) to manifest; declared $(wc -l < "$RUN/.chats-sandbox/declarations.jsonl" 2>/dev/null || echo 0) time(s)"
  fi

  # The relay sidecar's ledger: one line per request with model / message count /
  # tool names / usage and NO key. It is the external evidence that tool calls
  # really went to the model -- the same role gateway.jsonl plays on the claude
  # lane and proxy.jsonl on the codex one. The sidecar is about to be reaped.
  if [ -n "${GW_CID:-}" ]; then
    docker cp "$GW_CID:/gw/gateway.jsonl" "$RUN/gateway.jsonl" >/dev/null 2>&1 || true
    docker logs "$GW_CID" > "$RUN/gateway.stderr.log" 2>&1 || true
  fi

  docker diff "$CID" | sort > "$RUN/diff_post_agent.txt" 2>/dev/null

  # Snapshot evidence -- /tmp/.rb-shadow dies with the container at teardown. See the
  # matching block in codex.sh.
  if [ -n "${RB_SHADOW_HOOK:-}" ]; then
    docker exec "$CID" sh -c \
      'git --git-dir=/tmp/.rb-shadow log --oneline --format="%H %s" 2>/dev/null' \
      > "$RUN/shadow_commits.txt" 2>/dev/null || true
    docker cp "$CID:/tmp/.rb-shadow-audit.log" "$RUN/shadow_audit.log" >/dev/null 2>&1 || true
    echo "[shadow] $(wc -l < "$RUN/shadow_commits.txt" 2>/dev/null || echo 0) snapshot commits / $(wc -l < "$RUN/shadow_audit.log" 2>/dev/null || echo 0) audit lines"
  fi

  # Keep hermes' own record verbatim beside the normalized one: it is the only
  # place the system prompt, the tool schemas the agent was actually given and
  # the per-message finish_reason survive.
  local sess="$AGENT_HERMES_HOME/sessions/session_$(cat "$RUN/.hermes-session-id" 2>/dev/null).json"
  [ -s "$sess" ] && cp "$sess" "$RUN/hermes_session.json"

  # Rebuild the stream from the WHOLE session tree rather than the one file the
  # last turn happened to land in. Compaction scatters a run across several
  # session_*.json (see hermes_sessions.py), and reading only the pinned one
  # recovered 64 of 233 tool calls on the run that exposed this. The per-turn
  # snapshots supply the order the messages themselves do not carry.
  # NOT `s`: run.sh's sample loop uses that name, and this function runs inside
  # it, so an unlocalised `s` here rewrites the caller's sample id.
  local snaps=() _snap
  for _snap in "$RUN"/sessions-turn-*; do [ -d "$_snap" ] && snaps+=("$_snap"); done
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
    # How much of the run the transcript actually holds. hermes' own progress
    # lines are the only complete index of tool calls, including the ones a
    # rewritten session file destroyed, so score the merge against them and let
    # the analysis drop or flag runs that came back thin instead of averaging a
    # 60% transcript together with a whole one.
    "$PY" - "$RUN" "$mstats" <<'PYEOF' >> "$RUN/driver.log" 2>&1 || true
import json, os, re, sys
run, stats = sys.argv[1], sys.argv[2]
try:
    merged = json.loads(stats).get("tool_calls", 0)
except Exception:
    merged = 0
log = os.path.join(run, "hermes_stdout.log")
prep = 0
if os.path.exists(log):
    with open(log, encoding="utf-8", errors="replace") as fh:
        prep = sum(1 for ln in fh if re.search(r"\bpreparing ", ln))
ratio = (merged / prep) if prep else None
with open(os.path.join(run, "transcript_quality.json"), "w") as fh:
    json.dump({"merged_tool_calls": merged, "preparing_count": prep,
               "recovered": ratio}, fh)
print("[sessions] transcript quality %s/%s%s" % (
    merged, prep, "" if ratio is None else " = %.1f%%" % (100 * ratio)))
PYEOF
  fi

  # No separate canonical session file distinct from the normalized stream (the
  # same choice codex.sh makes): predicate.py --trajectory and cc_trajectory.py
  # --session both take a path, so give them the filename run.sh already uses.
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
  # The backupper's store is collected here, and it must happen before the container is
  # removed.
  # Why not in run_task.sh's reap: that trap gets stripped with `trap - EXIT` at the end
  # of the setup phase (the container is handed off to run.sh's turn loop), so the
  # normal path never reaches it.
  # The claude lane does not need to do this separately, because it re-invokes
  # run_task_claude.sh every turn, and every process exit triggers its own harvest;
  # hermes' adapter_turn does a direct docker exec, with no such trigger point -- so
  # the store would otherwise vanish with the container every time, and "did tier-3
  # actually fire" would become unanswerable. The PreToolUse hook leaves no trace in
  # the transcript, so the store is the only record.
  if [ -n "${CID:-}" ] && [ -n "${CWD:-}" ]; then
    if docker exec "$CID" test -d "${CS_STORE_IN:-$CWD/.chats-sandbox}" >/dev/null 2>&1; then
      if docker cp "$CID:${CS_STORE_IN:-$CWD/.chats-sandbox}" "$RUN/chats-sandbox" >/dev/null 2>&1; then
        _acts=$(wc -l < "$RUN/chats-sandbox/effects.jsonl" 2>/dev/null | tr -d ' ')
        _subs=$(grep -c 'subagent verdict' "$RUN/chats-sandbox/subagent.log" 2>/dev/null)
        echo "[backupper] store harvested: ${_acts:-0} effect line(s), ${_subs:-0} tier-3 verdict(s)"
      fi
    fi
  fi
  # Remove exactly the ids this run created -- never a name sweep and never a
  # --filter: this box runs several lanes at once and every one of them has
  # hermes-* containers alive. No -v: nothing of ours is a volume, and a stray
  # -v is how ~400 volumes belonging to other tenants were destroyed here once.
  if [ -s "${IDFILE:-}" ]; then
    while read -r c; do [ -n "$c" ] && docker rm -f "$c" >/dev/null 2>&1; done < <(sort -u "$IDFILE")
  else
    [ -n "${CID:-}" ] && docker rm -f "$CID" >/dev/null 2>&1
  fi
}
