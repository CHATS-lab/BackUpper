# setup_lib.sh -- the setup steps shared by run_task_claude.sh, run_task_codex.sh
# and run_task.sh (hermes). Sourced; defines functions only. The caller sets
# HERE (harness/), RB (regretbench/), PY and TASKDIR, and calls, in order:
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
# plus the MCP readiness checks (rb_mcp_*) and the install audit
# (rb_audit_install_begin / rb_audit_install_end). Agent auth, install and
# MCP-client wiring stay in the per-agent scripts.

# shellcheck source=adapters/_common.sh
. "$HERE/adapters/_common.sh"
# shellcheck source=task_env.sh
. "$HERE/task_env.sh"

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
# Created through hermes' own code (precreate_container.py), so every harness
# gets hermes' docker flags; HERMES_TERMINAL_DOCKER_EXTRA_ARGS, if exported,
# is honoured. RELAX_FS / non-persistent keep hermes' hardened backend from
# shadowing the seeded /root, /home, /tmp. No API key in COMMON_ENV: hermes
# writes it to session.env. Then the container joins the task's service
# network and the GitLab token placeholder is expanded, before anything
# resolves a service name (see task_env.sh).
rb_precreate() {
  COMMON_ENV=(
    HOME="$RUN/home" HERMES_HOME="$RUN/home/.hermes"
    TERMINAL_ENV=docker TERMINAL_DOCKER_IMAGE="$IMAGE" TERMINAL_CWD="$CWD"
    HERMES_TERMINAL_RELAX_FS=1 TERMINAL_CONTAINER_PERSISTENT=false
    HERMES_TERMINAL_CONTAINER_IDFILE="$IDFILE"
  )
  mkdir -p "$RUN/home/.hermes"
  CID="$(env "${COMMON_ENV[@]}" "$PY" "$HERE/precreate_container.py" 2>"$RUN/precreate.log" | tail -1)"
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
#   (mcp_handshake.py; 90 s request timeout, DELETE on close) requiring at least
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
    out="$(docker exec -i "$CID" python3 - "$cu" "${args[@]}" < "$HERE/mcp_handshake.py" 2>>"$log")"
  else
    where=host; url="$hu"
    out="$("$PY" "$HERE/mcp_handshake.py" "$hu" "${args[@]}" \
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
  "$PY" "$HERE/install_pollution.py" "$RUN/install_delta_filtered.txt" \
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
