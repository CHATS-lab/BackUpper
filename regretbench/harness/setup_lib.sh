# setup_lib.sh -- the shell library of the harness. Sourced by the setup steps
# (run_task_claude.sh, run_task_codex.sh, run_task.sh) and by the adapters
# (adapters.sh); defines functions only when sourced. The
# caller sets HERE (harness/) and PY; the setup steps also set RB (regretbench/)
# and TASKDIR, and call, in order:
#
#   rb_task_meta            SLUG IMAGE MCP_NAMES MCP_PORTS MCP_PATHS MCP_HEALTHS
#   rb_ensure_image         build $IMAGE if missing (RB_SKIP_BUILD=1 skips)
#   rb_mint_run AGENT       RUN (RB_RUN_DIR, else a new dir under RB_RESULTS_DIR)
#   rb_install_reaper       IDFILE + an EXIT/INT/TERM trap that harvests the
#                           store and removes this run's containers
#   rb_resolve_cwd          CWD, BU_STORE_IN, BU_STORE_ENV (RB_BU_STORE checked)
#   rb_precreate            COMMON_ENV, CID; joins the task network
#   rb_write_session_env    the hand-off to run.sh and the adapter
#
# plus the MCP readiness checks (rb_mcp_*), the install audit
# (rb_audit_install_begin / rb_audit_install_end), the adapter helpers
# (rb_rm_containers, rb_store_*, rb_adapter_setup, rb_turn_end,
# rb_build_trajectory), the task-environment hooks (attach_task_network,
# inject_gitlab_pat), the hermes model route (rb_hermes_route) and the
# in-container BackUpper install (bu_install_in_container). Agent auth, install
# and MCP-client wiring stay in the per-agent scripts.
#
# Executed rather than sourced, it runs one subcommand in its own process:
#
#   setup_lib.sh announce <RUN dir>          capture the BackUpper briefing
#   setup_lib.sh pack <repo-root> <out-dir>  stage the BackUpper package

# =============================================================================
# adapter helpers
# =============================================================================
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
#   hermes): capture the BackUpper briefing for the first user message
#   (`setup_lib.sh announce`, below).
rb_bu_announce() {
  [ "${RB_BACKUPPER:-0}" = 1 ] || return 0
  bash "$HERE/setup_lib.sh" announce "$1" >> "$1/setup.log" 2>&1 \
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

# rb_build_trajectory RUN [EXTRA trajectory.py build ARGS...]
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
  "$PY" "$HERE/trajectory.py" build --out "$run/trajectory.json" --log "$run/agent.log" \
    --instruction-file "$run/instruction.txt" \
    --model "$MODEL" --session "$run/claude_session.jsonl" \
    --stream "$run/claude_stream.jsonl" "$@" >> "$run/driver.log" 2>&1 \
    || echo "[warn] trajectory build failed; judge cannot score this run" >> "$run/driver.log"
}

# =============================================================================
# task environment
# =============================================================================
# Connect a freshly created task container to the task's external environment,
# right after the container is created (rb_precreate) and before the agent or
# any MCP probe runs.
#
# attach_task_network CID
#   RB_TASK_NETWORK (set by run_regretbench.sh for playwright, k8s and email
#   tasks) names the docker network on which the task's service (web app, mail
#   server, cluster) answers under its own hostname. The container joins it, and
#   the image's /etc/hosts entry for RB_FS_HOST, which points at the docker
#   gateway, is dropped so the name resolves through the network's DNS.
#
# inject_gitlab_pat CID
#   GitLab task images carry the literal placeholder ${RB_GITLAB_PAT} in their
#   workspace configuration, or a /etc/rb/gitlab.token file. Both are replaced
#   with RB_GITLAB_TOKEN, the token of the GitLab instance this run uses. The
#   token travels through a 0600 file, never through argv or the container
#   environment, and is never logged.

attach_task_network() {
  local cid="$1" fsh
  [ -n "${RB_TASK_NETWORK:-}" ] || return 0
  if ! docker network inspect "$RB_TASK_NETWORK" >/dev/null 2>&1; then
    echo "[ERROR] RB_TASK_NETWORK=$RB_TASK_NETWORK does not exist -- the task's service will be unreachable" >&2
    return 1
  fi
  if ! docker network connect "$RB_TASK_NETWORK" "$cid" 2>/dev/null; then
    echo "[ERROR] could not attach the task container to $RB_TASK_NETWORK -- the task's service will be unreachable" >&2
    return 1
  fi
  fsh="$(docker exec "$cid" printenv RB_FS_HOST 2>/dev/null || true)"
  if [ -z "$fsh" ]; then
    echo "[net] task container attached to $RB_TASK_NETWORK"
    return 0
  fi
  # /etc/hosts is a bind mount, so it is rewritten in place rather than with `sed -i`.
  if docker exec -u 0 "$cid" sh -c \
       "grep -v '[[:space:]]${fsh}\$' /etc/hosts > /tmp/.h && cat /tmp/.h > /etc/hosts && rm -f /tmp/.h" 2>/dev/null; then
    echo "[net] task container attached to $RB_TASK_NETWORK; $fsh resolves through its DNS"
  else
    echo "[ERROR] attached to $RB_TASK_NETWORK but could not drop the /etc/hosts entry for $fsh" >&2
    return 1
  fi
}

inject_gitlab_pat() {
  local cid="$1" rc tmp out n
  # grep exit status: 0 = placeholder present, 1 = absent, anything else = unknown (treated as present).
  rc="$(docker exec "$cid" sh -c 'grep -rlF "$1" /srv >/dev/null 2>&1; echo $?' sh '${RB_GITLAB_PAT}' 2>/dev/null | tail -1)"
  if [ "${rc:-x}" = 1 ] && ! docker exec "$cid" test -f /etc/rb/gitlab.token 2>/dev/null; then
    return 0
  fi
  if [ -z "${RB_GITLAB_TOKEN:-}" ]; then
    echo "[gitlab] !! the image expects a GitLab token but RB_GITLAB_TOKEN is empty -- API calls will return 401"
    return 0
  fi
  tmp="$(mktemp)" || return 0
  chmod 600 "$tmp"
  printf '%s' "$RB_GITLAB_TOKEN" > "$tmp"
  docker cp "$tmp" "$cid:/tmp/.rb_glpat" >/dev/null 2>&1
  rm -f "$tmp"
  out="$(docker exec -i -u 0 "$cid" python3 - <<'PY' 2>&1
import os
import stat

PLACE = "${RB_GITLAB_PAT}"
try:
    with open("/tmp/.rb_glpat") as fh:
        tok = fh.read().strip()
finally:
    try:
        os.unlink("/tmp/.rb_glpat")
    except OSError:
        pass

n = 0
for root, dirs, files in os.walk("/srv"):
    dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(root, d))]
    for name in files:
        p = os.path.join(root, name)
        try:
            st = os.lstat(p)
            if not stat.S_ISREG(st.st_mode) or st.st_size > 1000000:
                continue
            with open(p, encoding="utf-8") as fh:
                data = fh.read()
        except (OSError, UnicodeDecodeError, ValueError):
            continue
        if PLACE not in data:
            continue
        tmp = p + ".rbpat.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(data.replace(PLACE, tok))
        os.chmod(tmp, stat.S_IMODE(st.st_mode))
        os.chown(tmp, st.st_uid, st.st_gid)
        os.rename(tmp, p)
        n += 1
        print("EXPANDED %s" % p)
if os.path.isfile("/etc/rb/gitlab.token"):
    with open("/etc/rb/gitlab.token", "w") as fh:
        fh.write(tok + "\n")
    os.chmod("/etc/rb/gitlab.token", 0o644)
    n += 1
    print("EXPANDED /etc/rb/gitlab.token")
print("COUNT %d" % n)
PY
)"
  printf '%s\n' "$out" | sed -n 's|^EXPANDED |[gitlab] token written to |p'
  n="$(printf '%s\n' "$out" | sed -n 's/^COUNT \([0-9][0-9]*\)$/\1/p' | tail -1)"
  [ "${n:-0}" -gt 0 ] || echo "[gitlab] !! the token was not written anywhere -- API calls will return 401"
}

# =============================================================================
# hermes model route
# =============================================================================
# Model name sent upstream and its context length on the hermes harness; used by
# run_task.sh and adapters.sh (hermes).
#
# rb_hermes_route <model>
#   Exports:
#     HERMES_UPSTREAM_MODEL  the name passed to `hermes chat -m` (the model id,
#                            unchanged; OpenRouter ids carry a vendor prefix)
#     HERMES_CONTEXT_LENGTH  written into hermes' config.yaml by run_task.sh
rb_hermes_route() {
  HERMES_UPSTREAM_MODEL="$1"
  # Context length per model family; unknown models keep hermes' 128k default.
  case "$HERMES_UPSTREAM_MODEL" in
    *claude*)   HERMES_CONTEXT_LENGTH=1000000 ;;
    *gemini*)   HERMES_CONTEXT_LENGTH=1048576 ;;
    *deepseek*) HERMES_CONTEXT_LENGTH=1048575 ;;
    *)          HERMES_CONTEXT_LENGTH=128000  ;;
  esac
  export HERMES_UPSTREAM_MODEL HERMES_CONTEXT_LENGTH
}

# =============================================================================
# BackUpper install inside a task container
# =============================================================================
# Used by run_task_claude.sh and run_task_codex.sh (the agents that run in the
# container); run_task.sh installs it on the host for hermes.
#
# bu_install_in_container AGENT RUNNER MODEL [KEY=VALUE ...]
#   AGENT   claude-code | codex       (the argument of `backupper install`)
#   RUNNER  claude | codex            (the key of subagentModels for MODEL)
#   MODEL   the tier-4 subagent's model
#   KEY=VALUE  further `backupper config set` pairs
#
# Reads CID, CWD, RUN, AGENT_UID, BU_STORE_IN and BU_STORE_ENV from the caller,
# and RB_BU_PKG (from `setup_lib.sh pack`), RB_BU_NODE_DIR, RB_BU_MODE,
# RB_BU_RUNNER, RB_BU_SUBAGENT_TIMEOUT and RB_BU_EXPERIENCES from the environment;
# BU_EXTRA_PATH, if set, is placed on the agent's PATH after the BackUpper's own.
# Sets BU_PATH_ENV (docker exec -e flags for the agent) and BU_SUMMARY.
# Everything is placed under /opt/rbbu except the hook registration that
# `backupper install` writes into the workspace and the store itself.

BUDIR=/opt/rbbu
BU_NODE_IN="$BUDIR/nodejs/bin/node"
BU_CLI_IN="$BUDIR/package/dist/cli.js"

# _bu_cli ARGS...: the installed CLI, run as root in the workspace on the same store as the hooks.
_bu_cli() {
  docker exec -u 0 -w "$CWD" "${BU_STORE_ENV[@]+"${BU_STORE_ENV[@]}"}" "$CID" \
    "$BU_NODE_IN" "$BU_CLI_IN" "$@"
}

bu_install_in_container() {
  local agent="$1" runner="$2" model="$3"; shift 3
  local pkg="${RB_BU_PKG:-}" node_src="${RB_BU_NODE_DIR:-}" node_real hookfile kv
  [ -s "$pkg" ] || { echo "[fail] RB_BU_PKG is not a packed BackUpper (see setup_lib.sh pack): '$pkg'"; return 1; }
  [ -x "$node_src/bin/node" ] || { echo "[fail] RB_BU_NODE_DIR has no bin/node: '$node_src'"; return 1; }

  # A private node runtime: task images are not expected to ship one. Only bin/
  # and lib/ are needed; --no-same-owner because a rootless userns cannot chown.
  node_real="$(basename "$(readlink -f "$node_src")")"
  docker exec -u 0 "$CID" mkdir -p "$BUDIR/bin" || { echo "[fail] mkdir $BUDIR"; return 1; }
  tar -C "$(dirname "$(readlink -f "$node_src")")" -czf "$RUN/.node.tgz" "$node_real/bin" "$node_real/lib" 2>/dev/null
  docker cp "$RUN/.node.tgz" "$CID:$BUDIR/node.tgz" >/dev/null && rm -f "$RUN/.node.tgz"
  docker exec -u 0 "$CID" sh -c "cd $BUDIR && tar --no-same-owner -xzf node.tgz && rm -f node.tgz && ln -sfn $node_real nodejs" \
    || { echo "[fail] staging node"; return 1; }

  # The package as published, with its production dependencies.
  docker cp "$pkg" "$CID:$BUDIR/pkg.tgz" >/dev/null \
    && docker exec -u 0 "$CID" sh -c "cd $BUDIR && tar --no-same-owner -xzf pkg.tgz && rm -f pkg.tgz" \
    || { echo "[fail] staging the BackUpper package"; return 1; }
  # A `backupper` command on the agent's PATH, as after `npm install -g`.
  docker exec -u 0 "$CID" sh -c "printf '%s\n' '#!/bin/sh' 'exec $BU_NODE_IN $BU_CLI_IN \"\$@\"' > $BUDIR/bin/backupper && chmod 755 $BUDIR/bin/backupper" \
    || { echo "[fail] backupper shim"; return 1; }

  # The package's own installer writes the hooks (and seeds the bundled experiences).
  _bu_cli install "$agent" > "$RUN/backupper_install.log" 2>&1 \
    || { echo "[fail] backupper install $agent (see backupper_install.log)"; return 1; }

  # The installed hooks invoke a bare `node`; point them at the staged runtime.
  case "$agent" in
    claude-code) hookfile="$CWD/.claude/settings.local.json" ;;
    codex)       hookfile="$CWD/.codex/hooks.json" ;;
    *) echo "[fail] bu_install_in_container: unsupported agent $agent"; return 1 ;;
  esac
  docker exec -u 0 "$CID" "$BU_NODE_IN" -e '
    const fs = require("fs"), [file, node] = process.argv.slice(1);
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const groups of Object.values(doc.hooks || {}))
      for (const g of groups) for (const h of g.hooks || [])
        if (typeof h.command === "string") h.command = h.command.replace(/^node /, node + " ");
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  ' "$hookfile" "$BU_NODE_IN" || { echo "[fail] rewriting the node path in $hookfile"; return 1; }

  # subagentRunner=auto follows the agent whose hook fired; the model is set per runner.
  for kv in "mode=${RB_BU_MODE:-checker}" \
            "subagentEnabled=true" \
            "subagentRunner=${RB_BU_RUNNER:-auto}" \
            "subagentModels={\"$runner\":\"$model\"}" \
            "subagentTimeoutSeconds=${RB_BU_SUBAGENT_TIMEOUT:-240}" \
            "$@"; do
    [ -n "$kv" ] || continue
    _bu_cli config set "${kv%%=*}" "${kv#*=}" >> "$RUN/backupper_install.log" 2>&1 \
      || { echo "[fail] backupper config set ${kv%%=*}"; return 1; }
  done
  docker exec -u 0 "$CID" test -s "$BU_STORE_IN/config.json" \
    || { echo "[fail] backupper config.json not at $BU_STORE_IN/config.json"; return 1; }

  # RB_BU_EXPERIENCES replaces the bundled capture playbooks.
  if [ -n "${RB_BU_EXPERIENCES:-}" ]; then
    local ef
    for ef in "$RB_BU_EXPERIENCES"/*.json; do
      [ -s "$ef" ] || continue
      docker cp "$ef" "$CID:$BU_STORE_IN/experiences/$(basename "$ef")" >/dev/null \
        && echo "[arm] experience: $(basename "$ef") (from RB_BU_EXPERIENCES)"
    done
  fi
  echo "[arm] experiences: $(docker exec "$CID" sh -c "ls $BU_STORE_IN/experiences 2>/dev/null | tr '\n' ' '")"

  # The agent, and so the hook, runs as the image's user: hand it the store.
  docker exec -u 0 "$CID" chown -R "${AGENT_UID:-0}:0" "$BUDIR" "$BU_STORE_IN" "$(dirname "$hookfile")" >/dev/null 2>&1 || true
  if docker exec "$CID" sh -c "mkdir -p '$BU_STORE_IN/.wtest' && rmdir '$BU_STORE_IN/.wtest'" >/dev/null 2>&1; then
    BU_SUMMARY="store $BU_STORE_IN writable by the agent"
  else
    BU_SUMMARY="[ERROR] store $BU_STORE_IN NOT writable by the agent -- every hook call fails and nothing is captured"
  fi

  local img_path
  img_path="$(docker exec "$CID" sh -c 'printf %s "$PATH"' 2>/dev/null)"
  BU_PATH_ENV=(-e "PATH=$BUDIR/bin:$BUDIR/nodejs/bin:${BU_EXTRA_PATH:+$BU_EXTRA_PATH:}${img_path:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"
               "${BU_STORE_ENV[@]+"${BU_STORE_ENV[@]}"}"
               -e BACKUPPER_PERSIST_SUBAGENT_SESSIONS=1)
  echo "[arm] backupper $(_bu_cli --version 2>/dev/null | tail -1) installed for $agent:" \
       "mode=${RB_BU_MODE:-checker} runner=${RB_BU_RUNNER:-auto} subagent=$model"
}

# =============================================================================
# setup steps
# =============================================================================
# --- task.yaml ----------------------------------------------------------------
# MCP entries come out as parallel space-separated lists (name, port, path, health).
rb_task_meta() {
  local meta
  meta="$("$PY" - "$TASKDIR/task.yaml" <<'PY'
import os, shlex, sys, yaml
d = yaml.safe_load(open(sys.argv[1]))
img = d.get("image") or f"regretbench/{os.path.basename(os.path.dirname(sys.argv[1]))}:latest"
print(f"SLUG={shlex.quote(str(d['slug']))}")
print(f"IMAGE={shlex.quote(img)}")
mcp = d.get("mcp") or []
print(f"MCP_NAMES={shlex.quote(' '.join(str(e['server']) for e in mcp))}")
print(f"MCP_PORTS={shlex.quote(' '.join(str(int(e['port'])) for e in mcp))}")
print(f"MCP_PATHS={shlex.quote(' '.join(str(e.get('path', '/mcp')) for e in mcp))}")
print(f"MCP_HEALTHS={shlex.quote(' '.join(str(e.get('health', '/healthz')) for e in mcp))}")
PY
)" || { echo "[fail] cannot read $TASKDIR/task.yaml"; return 1; }
  eval "$meta"
}

# --- image ----------------------------------------------------------------------
# Build only a missing image: a rebuild without cache re-mints the build-time
# random values. RB_SKIP_BUILD=1 skips the step entirely.
rb_ensure_image() {
  [ "${RB_SKIP_BUILD:-0}" = 1 ] && return 0
  if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "[build] $IMAGE exists, skipping"
  else
    echo "[build] $IMAGE"
    docker build -q -t "$IMAGE" "$TASKDIR" >/dev/null || { echo "[fail] docker build"; return 1; }
  fi
}

# --- run dir --------------------------------------------------------------------
# rb_mint_run AGENT: RB_RUN_DIR (the adapter passes run.sh's dir), else a new
# $RB_RESULTS_DIR/<slug>-<timestamp>. Records the image id, so that a verdict
# can be tied to a task build.
rb_mint_run() {
  RUN="${RB_RUN_DIR:-${RB_RESULTS_DIR:-$RB/results/$1}/${SLUG}-$(date +%Y%m%d_%H%M%S)}"
  mkdir -p "$RUN/home/.hermes"
  docker image inspect -f '{{.Id}}' "$IMAGE" > "$RUN/image-id.txt" 2>/dev/null || true
}

# --- container bookkeeping ------------------------------------------------------
# IDFILE lists every container this setup created (task container, gateway
# sidecar), one id per line; the reaper removes exactly these. On a setup
# failure it first copies the BackUpper store out, the only record of what
# tier 4 captured. Once session.env is written the caller drops the EXIT trap
# and adapter_teardown owns the containers.
rb_install_reaper() {
  IDFILE="$RUN/containers.ids"
  : > "$IDFILE"
  trap rb_setup_reap EXIT INT TERM
}
rb_setup_reap() {
  rb_store_harvest "${CID:-}" "${BU_STORE_IN:-}" "$RUN"
  rb_rm_containers "$IDFILE"
}

# --- the agent's cwd and the store's location inside the container ------------
# The image's WorkingDir (possibly inherited from its base) is the agent's
# workspace; it falls back to /root. The BackUpper store defaults to
# $CWD/.backupper; an absolute RB_BU_STORE moves it out of the workspace.
# BU_STORE_ENV exports it to the plugin as BACKUPPER_STORE_DIR only when
# RB_BU_STORE is set: the plugin treats any explicit value as an override and
# then records an absolute backupDir in config.json.
rb_resolve_cwd() {
  CWD="$(docker image inspect -f '{{.Config.WorkingDir}}' "$IMAGE" 2>/dev/null)"
  case "$CWD" in ""|"/") CWD=/root ;; esac
  BU_STORE_IN="${RB_BU_STORE:-$CWD/.backupper}"
  case "$BU_STORE_IN" in
    /*) ;;
    *) echo "[fail] RB_BU_STORE must be an absolute path, got: ${RB_BU_STORE:-}"; return 1 ;;
  esac
  BU_STORE_ENV=()
  [ -n "${RB_BU_STORE:-}" ] && BU_STORE_ENV=(-e "BACKUPPER_STORE_DIR=$BU_STORE_IN")
  return 0
}

# --- the task container ---------------------------------------------------------
# Created through hermes' own code (`harness_util.py precreate-container`), so every harness
# gets hermes' docker flags; HERMES_TERMINAL_DOCKER_EXTRA_ARGS, if exported,
# is honoured. RELAX_FS / non-persistent keep hermes' hardened backend from
# shadowing the seeded /root, /home, /tmp. No API key in COMMON_ENV: hermes
# writes it to session.env. Then the container joins the task's service
# network and the GitLab token placeholder is expanded, before anything
# resolves a service name (see the task-environment section above).
rb_precreate() {
  COMMON_ENV=(
    HOME="$RUN/home" HERMES_HOME="$RUN/home/.hermes"
    TERMINAL_ENV=docker TERMINAL_DOCKER_IMAGE="$IMAGE" TERMINAL_CWD="$CWD"
    HERMES_TERMINAL_RELAX_FS=1 TERMINAL_CONTAINER_PERSISTENT=false
    HERMES_TERMINAL_CONTAINER_IDFILE="$IDFILE"
  )
  mkdir -p "$RUN/home/.hermes"
  CID="$(env "${COMMON_ENV[@]}" "$PY" "$HERE/harness_util.py" precreate-container 2>"$RUN/precreate.log" | tail -1)"
  if [ -z "$CID" ]; then
    echo "[fail] could not pre-create the task container (see $RUN/precreate.log)"
    tail -5 "$RUN/precreate.log" >&2
    return 1
  fi
  grep -qx "$CID" "$IDFILE" || echo "$CID" >> "$IDFILE"
  docker inspect -f '{{.Id}} {{.Name}}' "$CID" > "$RUN/container.id" 2>/dev/null
  echo "[task] container=${CID:0:12} image=$IMAGE cwd=$CWD"
  attach_task_network "$CID"
  inject_gitlab_pat "$CID"
  return 0
}

# --- MCP readiness --------------------------------------------------------------
# rb_tcp_http_status CID URL: the HTTP status of GET URL issued from inside the
# container with bash's /dev/tcp (most task images have no curl); 000 when
# nothing answers.
rb_tcp_http_status() {
  local hp="${2#http://}" hostport path
  hostport="${hp%%/*}"
  path="/${hp#*/}"
  [ "$hp" = "$hostport" ] && path=/
  docker exec "$1" bash -c '
      IFS=: read -r host port <<<"$1"
      exec 3<>/dev/tcp/"$host"/"${port:-80}" 2>/dev/null || { echo 000; exit 0; }
      printf "GET %s HTTP/1.0\r\nHost: %s\r\nConnection: close\r\n\r\n" "$2" "$1" >&3
      read -r -t 5 status <&3 || { echo 000; exit 0; }
      set -- $status; echo "${2:-000}"' _ "$hostport" "$path" 2>/dev/null
}

# rb_wait_http CID URL TRIES: poll rb_tcp_http_status, 1 s apart, until 200;
# prints the last status.
rb_wait_http() {
  local code=000 n
  for n in $(seq 1 "$3"); do
    code="$(rb_tcp_http_status "$1" "$2")"
    [ "$code" = 200 ] && break
    [ "$n" -lt "$3" ] && sleep 1
  done
  echo "${code:-000}"
}

# rb_mcp_url NAME KIND: a URL of the task.yaml `mcp:` entry NAME.
#   path       http://127.0.0.1:<port><path>     where an in-container client dials
#   health     http://127.0.0.1:<port><health>   the in-container health endpoint
#   host       the url in $RUN/mcp_client_host.json (bridge IP, gen_mcp_config.sh)
#   published  http://$MCP_BIND:<host port><path> (hermes' published ports)
rb_mcp_url() {
  local name="$1" kind="$2" i=0 n ports paths healths hostports
  read -r -a ports <<<"${MCP_PORTS:-}"
  read -r -a paths <<<"${MCP_PATHS:-}"
  read -r -a healths <<<"${MCP_HEALTHS:-}"
  read -r -a hostports <<<"${MCP_HOSTPORTS:-}"
  for n in ${MCP_NAMES:-}; do
    if [ "$n" = "$name" ]; then
      case "$kind" in
        path)      echo "http://127.0.0.1:${ports[$i]}${paths[$i]}" ;;
        health)    echo "http://127.0.0.1:${ports[$i]}${healths[$i]}" ;;
        published) echo "http://${MCP_BIND:-127.0.0.1}:${hostports[$i]}${paths[$i]}" ;;
        host)      "$PY" -c '
import json, sys
print(json.load(open(sys.argv[1]))["mcpServers"][sys.argv[2]]["url"])' \
                     "$RUN/mcp_client_host.json" "$name" ;;
        *) return 1 ;;
      esac
      return
    fi
    i=$((i + 1))
  done
  return 1
}

# rb_mcp_gate NAME CONTAINER_URL HOST_URL LOG [NAMES_OUT]
#   The readiness gate: a real initialize + tools/list handshake
#   (`harness_util.py mcp-handshake`; 90 s request timeout, DELETE on close) requiring at least
#   one tool with a usable inputSchema. A health endpoint answers before the
#   server can serve requests, and a tool without a usable schema makes the
#   client drop the whole server. Runs inside the container (on CONTAINER_URL)
#   when it has python3, else on the host (on HOST_URL); an empty CONTAINER_URL
#   forces the host. NAMES_OUT (host only) receives the usable tool names.
rb_mcp_gate() {
  local name="$1" cu="$2" hu="$3" log="$4" names_out="${5:-}"
  local args=(--attempts "${RB_MCP_HANDSHAKE_ATTEMPTS:-40}" --timeout "${RB_MCP_HANDSHAKE_TIMEOUT:-90}")
  local out rc where url nusable ntotal nbad
  if [ -n "$cu" ] && docker exec "$CID" sh -c 'command -v python3' >/dev/null 2>&1; then
    where=container; url="$cu"
    out="$(docker exec -i "$CID" python3 - mcp-handshake "$cu" "${args[@]}" < "$HERE/harness_util.py" 2>>"$log")"
  else
    where=host; url="$hu"
    out="$("$PY" "$HERE/harness_util.py" mcp-handshake "$hu" "${args[@]}" \
             ${names_out:+--names-out "$names_out"} 2>>"$log")"
  fi
  rc=$?
  read -r nusable ntotal nbad <<<"${out:-0 0 }"
  echo "$name handshake ($where) $url -> ${nusable:-0}/${ntotal:-0} usable${nbad:+ UNUSABLE SCHEMAS: $nbad}" >> "$log"
  if [ "$rc" != 0 ] || ! [ "${nusable:-0}" -ge 1 ] 2>/dev/null; then
    echo "[fail] MCP '$name' answered its health check, but the initialize + tools/list handshake"
    echo "       at $url ($where) yielded ${nusable:-0}/${ntotal:-0} usable tools (${nbad:-none unusable})."
    echo "       The agent would run shell-only, which is indistinguishable from a careful refusal."
    echo "       Not proceeding. (A listed tool without a usable inputSchema: check zod/zod-to-json-schema skew.)"
    cat "$log"
    return 1
  fi
}

# rb_mcp_gen_config: for agents that run inside the task container (claude,
# codex). gen_mcp_config.sh waits for every health endpoint from the host and
# writes $RUN/mcp_client_host.json (bridge-IP URLs). Health wait in seconds:
# RB_MCP_WAIT, else 180 for a postgres base image and 90 otherwise.
rb_mcp_gen_config() {
  local wait="${RB_MCP_WAIT:-90}"
  case "$(grep -hE '^FROM ' "$TASKDIR/Dockerfile" 2>/dev/null | tr '\n' ' ')" in
    *postgres*) wait="${RB_MCP_WAIT:-180}" ;;
  esac
  if ! bash "$RB/gen_mcp_config.sh" "$TASKDIR" "$CID" --out "$RUN/mcp_client_host.json" --wait "$wait" \
        > "$RUN/mcp_gen.log" 2> "$RUN/mcp_health.log"; then
    echo "[fail] gen_mcp_config.sh (see $RUN/mcp_gen.log $RUN/mcp_health.log)"; return 1
  fi
  if grep -q '^\[warn\] endpoint not answering' "$RUN/mcp_health.log"; then
    echo "[fail] MCP endpoint never became healthy:"
    grep '^\[warn\]' "$RUN/mcp_health.log"
    return 1
  fi
}

# rb_mcp_check_incontainer: per server, the health endpoint from inside the
# container (where the client dials), then the handshake gate.
rb_mcp_check_incontainer() {
  local log="$RUN/mcp_health_incontainer.log" n h u code
  : > "$log"
  for n in $MCP_NAMES; do
    h="$(rb_mcp_url "$n" health)"
    u="$(rb_mcp_url "$n" path)"
    code="$(rb_tcp_http_status "$CID" "$h")"
    echo "$n health=$h code=$code url=$u" >> "$log"
    [ "$code" = 200 ] || { echo "[fail] in-container MCP health check failed: $n $h -> $code"; return 1; }
    rb_mcp_gate "$n" "$u" "$(rb_mcp_url "$n" host)" "$log" || return 1
  done
  sed 's/^/[mcp] /' "$log"
}

# --- install audit ----------------------------------------------------------------
# Everything an in-container agent install writes must lie under its own prefix.
# rb_audit_install_begin records a service-noise baseline (two `docker diff`
# samples 3 s apart: the paths the task's own services touch, later excluded)
# and the pre-install diff; rb_audit_install_end PREFIX reports what else the
# install window changed. Fatal only under RB_STRICT_POLLUTION=1, since
# `docker diff` cannot attribute a write to a process.
rb_audit_install_begin() {
  docker diff "$CID" | sort > "$RUN/diff_noise_a.txt"
  sleep 3
  docker diff "$CID" | sort > "$RUN/diff_noise_b.txt"
  comm -13 "$RUN/diff_noise_a.txt" "$RUN/diff_noise_b.txt" \
    | sed -E 's/^[ACD] //' > "$RUN/install_noise_paths.txt" || true
  docker diff "$CID" | sort > "$RUN/diff_pre_install.txt"
}
rb_audit_install_end() {
  local prefix="$1"
  docker diff "$CID" | sort > "$RUN/diff_post_install.txt"
  comm -13 "$RUN/diff_pre_install.txt" "$RUN/diff_post_install.txt" > "$RUN/install_delta.txt"
  # /run and /var/run hold the services' runtime files, which the install never writes.
  grep -vE "^[ACD] (/opt$|$prefix|/run($|/)|/var/run($|/))" "$RUN/install_delta.txt" \
    > "$RUN/install_delta_filtered.txt" || true
  "$PY" "$HERE/harness_util.py" install-pollution "$RUN/install_delta_filtered.txt" \
        "$RUN/install_noise_paths.txt" "$RUN/install_pollution.txt"
  # A/D entries are possible install pollution; C entries are the task's
  # services rewriting existing files.
  grep -E '^[AD] ' "$RUN/install_pollution.txt" > "$RUN/install_pollution_ad.txt" || true
  grep -E '^C '   "$RUN/install_pollution.txt" > "$RUN/install_pollution_c.txt"  || true
  if [ -s "$RUN/install_pollution_c.txt" ]; then
    echo "[note] pre-existing paths modified during the install window (task's own"
    echo "       services; not created by the install):"
    sed 's/^/  /' "$RUN/install_pollution_c.txt"
    [ "${RB_STRICT_POLLUTION:-0}" = 1 ] && { echo "[fail] strict pollution check"; return 1; }
  fi
  if [ -s "$RUN/install_pollution_ad.txt" ]; then
    echo "[note] paths added/deleted outside $prefix during the install window"
    echo "       ($(wc -l < "$RUN/install_pollution_ad.txt") entries, task services included; see install_pollution_ad.txt)"
    sed -n '1,5s/^/  /p' "$RUN/install_pollution_ad.txt"
    [ "${RB_STRICT_POLLUTION:-0}" = 1 ] && { echo "[fail] strict pollution check"; return 1; }
  fi
  return 0
}

# --- hand-off ---------------------------------------------------------------------
# rb_write_session_env ENTRY...: write $RUN/session.env, the per-run state for
# run.sh and the adapter (never a credential, except what an agent's own
# AGENT_ENV must carry). ENTRY is NAME (a scalar), NAME=VALUE, or @NAME (an
# array, written with declare -p; empty when unset).
rb_write_session_env() {
  local e
  {
    for e in "$@"; do
      case "$e" in
        @*)  declare -p "${e#@}" 2>/dev/null || echo "declare -a ${e#@}=()" ;;
        *=*) echo "${e%%=*}=$(printf %q "${e#*=}")" ;;
        *)   echo "$e=$(printf %q "${!e:-}")" ;;
      esac
    done
  } > "$RUN/session.env"
}

# =============================================================================
# subcommands (executed, not sourced)
# =============================================================================

# setup_lib.sh announce <RUN dir>
# Capture the BackUpper plugin's briefing for the codex and hermes harnesses, whose
# CLIs cannot surface UserPromptSubmit hook output (Claude Code does so natively).
# Reads CID / CWD from RUN/session.env, runs the plugin's own hook in the
# container, writes RUN/bu-announce.txt and appends RB_GUIDANCE_FILE=... to
# session.env, so run.sh prepends the briefing to the first user message.
rb_announce_main() {
  RUN="${1:?usage: setup_lib.sh announce <RUN dir>}"
  [ -s "$RUN/session.env" ] || { echo "[announce] no session.env" >&2; exit 1; }
  # shellcheck disable=SC1091
  . "$RUN/session.env"
  : "${CID:?session.env carries no CID}"
  : "${CWD:?session.env carries no CWD}"

  NODE_IN="${RB_BU_NODE_IN:-$BUDIR/nodejs/bin/node}"
  HOOK="$BUDIR/package/dist/hook.js"
  LOG="$RUN/bu-announce.log"

  # BACKUPPER_NO_HOOK must stay unset (it is the subagent recursion guard).
  # BACKUPPER_STORE_DIR is passed only when the store was relocated from its
  # default, so the hook reads this run's config.json.
  BU_ENV=()
  if [ -n "${BU_STORE:-}" ] && [ "$BU_STORE" != "$CWD/.backupper" ]; then
    BU_ENV=(-e "BACKUPPER_STORE_DIR=$BU_STORE")
  fi
  PROBE='{"session_id":"__rb_announce_probe__","prompt":"probe"}'
  raw="$(printf '%s' "$PROBE" \
          | docker exec -i -w "$CWD" "${BU_ENV[@]+"${BU_ENV[@]}"}" "$CID" "$NODE_IN" "$HOOK" prompt 2>>"$LOG")"
  rc=$?

  txt="$(printf '%s' "$raw" | "${RB_PY:-python3}" -c '
import json, sys
try:
    hook_output = json.load(sys.stdin)
    print(hook_output.get("hookSpecificOutput", {}).get("additionalContext", "").strip())
except Exception:
    pass
' 2>>"$LOG")"

  # Reset the announced-sessions record so the probe session does not appear in it.
  docker exec "$CID" sh -c \
    "f=${BU_STORE:-$CWD/.backupper}/announced-sessions.json; [ -f \"\$f\" ] && printf '%s' '[]' > \"\$f\"" \
    </dev/null >>"$LOG" 2>&1

  if [ -z "$txt" ]; then
    echo "[announce] could not capture the briefing (hook rc=$rc) — see $LOG" >&2
    exit 2
  fi

  printf '%s\n' "$txt" > "$RUN/bu-announce.txt"
  printf 'RB_GUIDANCE_FILE=%s\n' "$RUN/bu-announce.txt" >> "$RUN/session.env"
  echo "[announce] ${#txt} chars -> $RUN/bu-announce.txt"
}

# setup_lib.sh pack <repo-root> <out-dir>
#
# Stages the BackUpper package for installation inside a task container. The
# package is taken from the repository root exactly as `npm pack` would publish
# it (the `files:` list of package.json, so dist/ must already be built), and its
# production dependencies are copied from the root node_modules/. Nothing is
# fetched from the network.
#
# Writes <out-dir>/backupper-pkg.tgz, whose single top-level directory `package/`
# is what `npm install -g` would place under node_modules/agents-backupper.
# Prints the tarball path on stdout.
rb_pack_main() {
  ROOT="$(cd "${1:?usage: setup_lib.sh pack <repo-root> <out-dir>}" && pwd)"
  OUT="${2:?usage: setup_lib.sh pack <repo-root> <out-dir>}"
  command -v npm >/dev/null 2>&1 || { echo "[fail] npm is not on PATH (needed to pack the BackUpper)" >&2; exit 1; }
  [ -s "$ROOT/dist/cli.js" ] || { echo "[fail] $ROOT/dist/cli.js is missing -- run \`npm ci\` in $ROOT first" >&2; exit 1; }
  [ -d "$ROOT/node_modules" ] || { echo "[fail] $ROOT/node_modules is missing -- run \`npm ci\` in $ROOT first" >&2; exit 1; }

  mkdir -p "$OUT"
  OUT="$(cd "$OUT" && pwd)"
  STAGE="$(mktemp -d "$OUT/.pack.XXXXXX")"
  trap 'rm -rf "$STAGE"' EXIT

  # --ignore-scripts: dist/ is used as built; `prepare` would rebuild it.
  TGZ="$(cd "$ROOT" && npm pack --ignore-scripts --silent --pack-destination "$STAGE" | tail -1)"
  tar -xzf "$STAGE/$TGZ" -C "$STAGE"

  # Production dependencies, resolved by npm against the installed tree.
  (cd "$ROOT" && npm ls --omit=dev --all --parseable 2>/dev/null) | while read -r dep; do
    [ "$dep" = "$ROOT" ] && continue
    rel="${dep#"$ROOT"/}"
    mkdir -p "$STAGE/package/$(dirname "$rel")"
    cp -a "$dep" "$STAGE/package/$rel"
  done

  tar -czf "$OUT/backupper-pkg.tgz" -C "$STAGE" package
  echo "$OUT/backupper-pkg.tgz"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-}" in
    announce) shift; set -uo pipefail; rb_announce_main "$@" ;;
    pack)     shift; set -euo pipefail; rb_pack_main "$@" ;;
    *) echo "usage: setup_lib.sh announce <RUN dir> | pack <repo-root> <out-dir>" >&2; exit 2 ;;
  esac
fi
