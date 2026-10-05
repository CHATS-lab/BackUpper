# _common.sh -- helpers shared by adapters/{claude,codex,hermes}.sh, and by the
# setup scripts through setup_lib.sh. Function definitions only; HERE (the
# harness directory) and PY come from the caller.

# The BackUpper store's directory inside a run dir, for every harness.
RB_STORE_NAME=backupper-store

# rb_rm_containers IDFILE [FALLBACK_ID...]
#   Remove exactly the containers listed in IDFILE, never by name; when IDFILE
#   is missing or empty, remove the fallback ids instead.
rb_rm_containers() {
  local idfile="$1" c; shift
  if [ -s "$idfile" ]; then
    while read -r c; do
      [ -n "$c" ] && docker rm -f "$c" >/dev/null 2>&1
    done < <(sort -u "$idfile")
  else
    for c in "$@"; do
      [ -n "$c" ] && docker rm -f "$c" >/dev/null 2>&1
    done
  fi
  return 0
}

# rb_store_harvest CID STORE_IN RUN [LOG]
#   Copy the container's BackUpper store (STORE_IN, a path inside CID) to
#   RUN/backupper-store. An existing copy is kept. Returns 0 when the store is in
#   the run dir afterwards, 2 when the container has no store, 3 when the copy
#   failed (reported), 1 on missing arguments.
rb_store_harvest() {
  local cid="$1" store="$2" run="$3" log="${4:-/dev/null}"
  local dest="$run/$RB_STORE_NAME" acts subs
  [ -n "$cid" ] && [ -n "$store" ] && [ -n "$run" ] || return 1
  [ -e "$dest" ] && return 0
  docker exec "$cid" test -d "$store" >>"$log" 2>&1 || return 2
  if ! docker cp "$cid:$store" "$dest" >>"$log" 2>&1; then
    echo "[backupper] store present at $store but the copy-out FAILED"
    return 3
  fi
  acts=$( { wc -l < "$dest/effects.jsonl"; } 2>/dev/null | tr -d ' ')
  subs=$(grep -c 'subagent verdict' "$dest/subagent.log" 2>/dev/null)
  echo "[backupper] store harvested -> $dest: ${acts:-0} effect line(s), ${subs:-0} tier-4 verdict(s)"
}

# rb_store_trim STORE
#   Keep the record, not the bytes: drop shadow-repo/ and replace every
#   backups/*/{pre,trash,external-shadow} directory by DIR.manifest.txt.
rb_store_trim() {
  local store="$1" dir nbytes nfiles ndecl n=0
  [ -d "$store" ] || return 0
  rm -rf "$store/shadow-repo"
  while IFS= read -r dir; do
    [ -d "$dir" ] || continue
    nbytes="$(du -sb "$dir" 2>/dev/null | cut -f1)"
    nfiles="$(find "$dir" -type f 2>/dev/null | wc -l)"
    { echo "# replaced by adapter_collect: bytes not kept with the run"
      echo "# total: $nbytes bytes, $nfiles files"
      find "$dir" -type f -printf '%s\t%P\n' 2>/dev/null | sort -k2
    } > "$dir.manifest.txt" 2>/dev/null
    rm -rf "$dir"
    n=$((n + 1))
  done < <(find "$store/backups" -mindepth 2 -maxdepth 2 -type d \
                \( -name pre -o -name trash -o -name external-shadow \) 2>/dev/null)
  ndecl="$( { wc -l < "$store/declarations.jsonl"; } 2>/dev/null || echo 0)"
  echo "[backupper] record -> $store ($ndecl declarations; $n dir(s) trimmed to a manifest)"
}

# rb_adapter_setup SETUP_SCRIPT TASKDIR RUN
#   Run harness/SETUP_SCRIPT into RUN (RB_RUN_DIR); it must leave RUN/session.env.
rb_adapter_setup() {
  local script="$1" taskdir="$2" run="$3" rc
  RB_RESULTS_DIR="$(dirname "$run")" RB_RUN_DIR="$run" \
    bash "$HERE/$script" "$taskdir" ${MODEL:+"$MODEL"} \
    > "$run/setup.log" 2>&1
  rc=$?
  if [ ! -s "$run/session.env" ]; then
    echo "[fail] setup produced no session.env (see $run/setup.log)" >&2
    tail -20 "$run/setup.log" >&2
    return 1
  fi
  return $rc
}

# rb_bu_announce RUN
#   For CLIs that cannot surface the UserPromptSubmit hook's output (codex,
#   hermes): capture the BackUpper briefing for the first user message.
rb_bu_announce() {
  [ "${RB_BACKUPPER:-0}" = 1 ] || return 0
  bash "$HERE/bu_announce.sh" "$1" >> "$1/setup.log" 2>&1 \
    || echo "[warn] briefing capture failed; this run measures discovery, not the tool" >&2
}

# rb_turn_end RUN TURN_ID START_EPOCH RC
#   The tail of every adapter_turn: log rc and wall time, mark a timeout(1)
#   expiry (rc 124; the driver then stops delivering turns), return RC.
rb_turn_end() {
  local run="$1" tid="$2" start="$3" rc="$4" wall
  wall=$(( $(date +%s) - start ))
  echo "  rc=$rc wall=${wall}s" | tee -a "$run/driver.log"
  [ "$rc" = 124 ] && echo "timeout at $tid" > "$run/TIMEOUT"
  return "$rc"
}

# rb_build_trajectory RUN [EXTRA cc_trajectory.py ARGS...]
#   Concatenate the turn prompts into RUN/instruction.txt and write
#   RUN/trajectory.json from claude_session.jsonl + claude_stream.jsonl.
rb_build_trajectory() {
  local run="$1" p; shift
  : > "$run/instruction.txt"
  for p in $(ls -tr "$run"/turn-*.prompt 2>/dev/null); do
    printf '### %s\n%s\n\n' "$(basename "$p" .prompt | sed 's/^turn-//')" "$(cat "$p")" \
      >> "$run/instruction.txt"
  done
  [ -s "$run/instruction.txt" ] || echo "(no turn prompts recorded)" > "$run/instruction.txt"
  "$PY" "$HERE/cc_trajectory.py" --out "$run/trajectory.json" --log "$run/agent.log" \
    --instruction-file "$run/instruction.txt" \
    --model "$MODEL" --session "$run/claude_session.jsonl" \
    --stream "$run/claude_stream.jsonl" "$@" >> "$run/driver.log" 2>&1 \
    || echo "[warn] cc_trajectory failed; judge cannot score this run" >> "$run/driver.log"
}
