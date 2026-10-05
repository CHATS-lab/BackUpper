#!/usr/bin/env bash
# run_task.sh <task-dir> <agent-model> -- setup step of the hermes harness.
#
# Called once per run by adapters/hermes.sh: build the image if missing,
# pre-create the container, wire MCP and gate on a real MCP handshake, then
# write $RUN/session.env; run.sh owns the turn loop.
#
# hermes runs on the host and executes terminal commands in the task container
# via `docker exec`, so each in-container MCP server is published on a free
# host port.
#
# Env:
#   RB_HERMES_BIN     hermes entry point           (required, not shipped)
#   HERMES_SRC        hermes-agent source tree     (required, not shipped)
#   RB_PY             python with pyyaml + docker  (default python3)
#   RB_RESULTS_DIR    default $RB/results/hermes
#   RB_RUN_DIR        use this run dir instead of minting one (adapter passes it)
#   RB_MCP_BIND       host address to publish MCP on (default 127.0.0.1)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; RB="$(cd "$HERE/.." && pwd)"
TASKDIR="${1:?usage: run_task.sh <task-dir> <model>}"; TASKDIR="$(cd "$TASKDIR" && pwd)"
MODEL="${2:?usage: run_task.sh <task-dir> <model>}"

# Sets HERMES_UPSTREAM_MODEL and HERMES_CONTEXT_LENGTH.
. "$HERE/hermes_model_route.sh"
rb_hermes_route "$MODEL"

PY="${RB_PY:-python3}"
# hermes-agent is not shipped: RB_HERMES_BIN is its entry point (installed with
# the [mcp] extra) and HERMES_SRC its source tree.
HERMES="${RB_HERMES_BIN:-}"
MCP_BIND="${RB_MCP_BIND:-127.0.0.1}"

# Fail early, with the reason, on a missing interpreter or binary.
if [ -z "$HERMES" ] || [ ! -x "$HERMES" ]; then
  echo "[fail] hermes not executable at '\"$HERMES\"' -- set RB_HERMES_BIN to the hermes-agent entry point (see regretbench/run_regretbench.sh --help)"
  exit 1
fi
"$PY" -c 'import yaml' 2>/dev/null || { echo "[fail] \$RB_PY ($PY) has no PyYAML"; exit 1; }
: "${OPENROUTER_API_KEY:?set OPENROUTER_API_KEY}"
"$HERMES" --version >/dev/null 2>&1 \
  || { echo "[fail] $HERMES does not run"; exit 1; }

eval "$($PY - "$TASKDIR/task.yaml" <<'PY'
import sys, yaml, shlex, os
d = yaml.safe_load(open(sys.argv[1]))
img = d.get("image") or f"regretbench/{os.path.basename(os.path.dirname(sys.argv[1]))}:latest"
print(f"SLUG={shlex.quote(str(d['slug']))}")
print(f"IMAGE={shlex.quote(img)}")
# MCP entries as parallel space-separated lists (name, port, path, health).
mcp = d.get("mcp") or []
print(f"MCP_NAMES={shlex.quote(' '.join(str(e['server']) for e in mcp))}")
print(f"MCP_PORTS={shlex.quote(' '.join(str(int(e['port'])) for e in mcp))}")
print(f"MCP_PATHS={shlex.quote(' '.join(str(e.get('path', '/mcp')) for e in mcp))}")
print(f"MCP_HEALTHS={shlex.quote(' '.join(str(e.get('health', '/healthz')) for e in mcp))}")
PY
)" || exit 1

# --- image ------------------------------------------------------------------
# Build only a missing image: a rebuild without cache re-mints the build-time random values.
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "[build] $IMAGE"
  docker build -q -t "$IMAGE" "$TASKDIR" >/dev/null || { echo "[fail] docker build"; exit 1; }
fi

RUN="${RB_RUN_DIR:-${RB_RESULTS_DIR:-$RB/results/hermes}/${SLUG}-$(date +%Y%m%d_%H%M%S)}"
mkdir -p "$RUN/home/.hermes"
docker image inspect -f '{{.Id}}' "$IMAGE" > "$RUN/image-id.txt" 2>/dev/null || true

# --- container bookkeeping --------------------------------------------------
# Container ids owned by this run, one per line; the reaper removes only these.
IDFILE="$RUN/containers.ids"
: > "$IDFILE"
# On a setup failure, copy the BackUpper store to $RUN/backupper before the
# container is removed (on success adapters/hermes.sh collects it).
harvest_sandbox() {
  [ -n "${CID:-}" ] || return 0
  [ -n "${CWD:-}" ] || return 0
  docker exec "$CID" test -d "${BU_STORE_IN:-$CWD/.backupper}" >/dev/null 2>&1 || return 0
  docker cp "$CID:${BU_STORE_IN:-$CWD/.backupper}" "$RUN/backupper" >/dev/null 2>&1 || return 0
  local acts subs
  acts=$(wc -l < "$RUN/backupper/effects.jsonl" 2>/dev/null | tr -d ' ')
  subs=$(grep -c 'subagent verdict' "$RUN/backupper/subagent.log" 2>/dev/null)
  echo "[backupper] store harvested: ${acts:-0} effect line(s), ${subs:-0} tier-4 verdict(s)"
}

reap() {
  local c
  harvest_sandbox
  [ -s "$IDFILE" ] || return 0
  while read -r c; do
    [ -n "$c" ] || continue
    docker rm -f "$c" >/dev/null 2>&1
  done < <(sort -u "$IDFILE")
}
trap reap EXIT INT TERM

# --- the agent's cwd inside the container -----------------------------------
# Pass the image's WORKDIR (else /root) explicitly; hermes would otherwise use
# the host cwd.
CWD="$(docker image inspect -f '{{.Config.WorkingDir}}' "$IMAGE" 2>/dev/null)"
case "$CWD" in ""|"/") CWD=/root ;; esac

# Container-side location of the BackUpper store (RB_BU_STORE moves it out of
# the workspace); the host side is always $RUN/.backupper.
BU_STORE_IN="${RB_BU_STORE:-$CWD/.backupper}"

# RELAX_FS / non-persistent keep hermes' hardened backend from shadowing the
# seeded /root, /home, /tmp. No API key here: COMMON_ENV is written to session.env.
COMMON_ENV=(
  HOME="$RUN/home" HERMES_HOME="$RUN/home/.hermes"
  TERMINAL_ENV=docker TERMINAL_DOCKER_IMAGE="$IMAGE" TERMINAL_CWD="$CWD"
  HERMES_TERMINAL_RELAX_FS=1 TERMINAL_CONTAINER_PERSISTENT=false
  HERMES_TERMINAL_CONTAINER_IDFILE="$IDFILE"
)

# --- publish the MCP ports onto the host loopback ---------------------------
# One free host port per MCP entry, added to HERMES_TERMINAL_DOCKER_EXTRA_ARGS.
EXTRA_ARGS="${HERMES_TERMINAL_DOCKER_EXTRA_ARGS:-}"
MCP_HOSTPORTS=""
if [ -n "${MCP_NAMES:-}" ]; then
  for p in $MCP_PORTS; do
    hp="$("$PY" - <<'PY'
import socket
sock = socket.socket()
sock.bind(("127.0.0.1", 0))
print(sock.getsockname()[1])
sock.close()
PY
)"
    MCP_HOSTPORTS="$MCP_HOSTPORTS $hp"
    EXTRA_ARGS="$EXTRA_ARGS -p $MCP_BIND:$hp:$p"
  done
  MCP_HOSTPORTS="${MCP_HOSTPORTS# }"
fi
# RB_BACKUPPER, part 1 of 2: bind-mount the host-side store into the container
# (mounts must exist at creation). It is mounted twice: at the agent's store path,
# and at its own host path, which is where the plugin tells the subagent to write.
if [ "${RB_BACKUPPER:-0}" = 1 ]; then
  mkdir -p "$RUN/.backupper"
  EXTRA_ARGS="$EXTRA_ARGS -v $RUN/.backupper:$BU_STORE_IN"
  EXTRA_ARGS="$EXTRA_ARGS -v $RUN/.backupper:$RUN/.backupper"
  echo "[arm] backupper store bind-mounted: $RUN/.backupper -> $BU_STORE_IN (+ identically-named host path)"
fi
export HERMES_TERMINAL_DOCKER_EXTRA_ARGS="$EXTRA_ARGS"

# --- pre-create the task container (through hermes' own code) ---------------
# hermes would create it lazily on the first terminal call; run.sh needs the CID
# up front. Every turn adopts it via HERMES_TERMINAL_DOCKER_ADOPT.
CID="$(env "${COMMON_ENV[@]}" "$PY" "$HERE/precreate_container.py" 2>"$RUN/precreate.log" | tail -1)"
if [ -z "$CID" ]; then
  echo "[fail] could not pre-create the task container (see $RUN/precreate.log)"
  tail -5 "$RUN/precreate.log" >&2
  exit 1
fi
echo "$CID" >> "$IDFILE"
COMMON_ENV+=(HERMES_TERMINAL_DOCKER_ADOPT="$CID")

docker inspect -f '{{.Id}} {{.Name}}' "$CID" > "$RUN/container.id" 2>/dev/null
echo "[task] container=${CID:0:12} image=$IMAGE cwd=$CWD"

# Join the task's service network and expand the GitLab token placeholder
# before anything resolves a service name (see task_env.sh).
# shellcheck source=task_env.sh
. "$HERE/task_env.sh"
attach_task_network "$CID"
inject_gitlab_pat "$CID"

# --- MCP wiring + the gate --------------------------------------------------
TOOLSETS="terminal,file"
if [ -n "${MCP_NAMES:-}" ]; then
  : > "$RUN/mcp_health.log"
  set -- $MCP_NAMES;   names=("$@")
  set -- $MCP_PORTS;   ports=("$@")
  set -- $MCP_PATHS;   paths=("$@")
  set -- $MCP_HEALTHS; healths=("$@")
  set -- $MCP_HOSTPORTS; hostports=("$@")

  # Step 1: in-container liveness via bash's /dev/tcp (task images lack curl).
  for i in "${!names[@]}"; do
    code=000
    for _ in $(seq 1 90); do
      code="$(docker exec "$CID" bash -c '
        exec 3<>/dev/tcp/127.0.0.1/"$1" 2>/dev/null || { echo 000; exit 0; }
        printf "GET %s HTTP/1.0\r\nHost: 127.0.0.1:%s\r\nConnection: close\r\n\r\n" "$2" "$1" >&3
        read -r -t 5 s <&3 || { echo 000; exit 0; }
        set -- $s; echo "${2:-000}"' _ "${ports[$i]}" "${healths[$i]}" 2>/dev/null)"
      [ "$code" = 200 ] && break
      sleep 1
    done
    echo "${names[$i]} in-container health ${healths[$i]} -> $code" >> "$RUN/mcp_health.log"
    [ "$code" = 200 ] || {
      echo "[fail] MCP '${names[$i]}' never answered ${healths[$i]} inside the container"
      cat "$RUN/mcp_health.log"; exit 1; }
  done

  # Step 2: the client config, pointing at the published host ports.
  "$PY" - "$RUN/mcp_servers.json" "$RUN/home/.hermes/config.yaml" "$MCP_BIND" \
        "$MCP_NAMES" "$MCP_HOSTPORTS" "$MCP_PATHS" "$MCP_PORTS" "$CID" "$IMAGE" <<'PY' \
    || { echo "[fail] writing hermes mcp config"; exit 1; }
import json, sys, yaml
record_path, config_path, bind = sys.argv[1:4]
names, host_ports, paths, container_ports = (arg.split() for arg in sys.argv[4:8])
cid, image = sys.argv[8:10]
servers = {name: "http://%s:%s%s" % (bind, port, path)
           for name, port, path in zip(names, host_ports, paths)}
# Only mcp_servers: the terminal backend stays configured by environment.
hermes_cfg = {"mcp_servers": {name: {"url": url, "timeout": 300, "connect_timeout": 120}
                              for name, url in servers.items()}}
yaml.safe_dump(hermes_cfg, open(config_path, "w"), sort_keys=False)
record = {
    "container_id": cid, "image": image, "bind": bind,
    "servers": [{"server": name, "url": servers[name], "host_port": host_port,
                 "container_port": container_port, "toolset": "mcp-%s" % name}
                for name, host_port, container_port in zip(names, host_ports, container_ports)],
}
json.dump(record, open(record_path, "w"), indent=2)
open(record_path, "a").write("\n")
PY

  # Step 3, the gate: a real MCP handshake from the host on the exact URL hermes
  # will use, requiring at least one usable tool.
  for i in "${!names[@]}"; do
    u="http://$MCP_BIND:${hostports[$i]}${paths[$i]}"
    out="$("$PY" "$HERE/mcp_handshake.py" "$u" \
            --attempts "${RB_MCP_HANDSHAKE_ATTEMPTS:-40}" \
            --timeout "${RB_MCP_HANDSHAKE_TIMEOUT:-90}" \
            --names-out "$RUN/mcp_tools_${names[$i]}.txt" \
            2>>"$RUN/mcp_health.log")"
    rc=$?
    read -r nusable ntotal nbad <<<"${out:-0 0 }"
    echo "${names[$i]} host handshake $u -> ${nusable:-0}/${ntotal:-0} usable ${nbad:-}" \
      >> "$RUN/mcp_health.log"
    if [ "$rc" != 0 ] || [ "${nusable:-0}" -lt 1 ] 2>/dev/null; then
      echo "[fail] MCP '${names[$i]}' answered health but the handshake at $u"
      echo "       produced ${nusable:-0} usable tools -- the agent would run shell-only,"
      echo "       which is indistinguishable from a careful refusal. Not proceeding."
      cat "$RUN/mcp_health.log"
      exit 1
    fi
    TOOLSETS="$TOOLSETS,mcp-${names[$i]}"
  done
  sed 's/^/[mcp] /' "$RUN/mcp_health.log"

  # Seed the stream with the MCP tool roster as a Claude Code
  # `deferred_tools_delta` record, using mcp__<server>__<tool> names.
  "$PY" - "$RUN/claude_stream.jsonl" "$MCP_NAMES" "$RUN" <<'PY'
import json, os, sys
stream, names, run = sys.argv[1], sys.argv[2].split(), sys.argv[3]
added = []
for name in names:
    roster = os.path.join(run, "mcp_tools_%s.txt" % name)
    if not os.path.exists(roster):
        continue
    for line in open(roster):
        tool = line.strip()
        if tool:
            added.append("mcp__%s__%s" % (name, tool))
if added:
    with open(stream, "a") as fh:
        fh.write(json.dumps({"attachment": {"type": "deferred_tools_delta",
                                            "addedNames": added}}) + "\n")
PY
fi

# --- output cap --------------------------------------------------------------
# Claude upstreams require an explicit max_tokens, and reasoning models need a
# high one so the chain of thought does not exhaust the output budget.
case "$HERMES_UPSTREAM_MODEL" in
  *deepseek*|*DeepSeek*) MAX_TOKENS="${RB_HERMES_DEEPSEEK_MAX_TOKENS:-162000}" ;;
  *claude*)              MAX_TOKENS="${RB_HERMES_CLAUDE_MAX_TOKENS:-32000}" ;;
  *)                     MAX_TOKENS="" ;;
esac
if [ -n "$MAX_TOKENS" ]; then
  "$PY" - "$RUN/home/.hermes/config.yaml" "$MAX_TOKENS" <<'PY' \
    || { echo "[fail] writing hermes model.max_tokens"; exit 1; }
import os, sys, yaml
path, cap = sys.argv[1], int(sys.argv[2])
cfg = {}
if os.path.exists(path):  # merge with the mcp_servers written above
    cfg = yaml.safe_load(open(path)) or {}
os.makedirs(os.path.dirname(path), exist_ok=True)
model = cfg.get("model")
cfg["model"] = dict(model) if isinstance(model, dict) else {}
cfg["model"]["max_tokens"] = cap
yaml.safe_dump(cfg, open(path, "w"), sort_keys=False)
PY
  echo "[cfg] model.max_tokens=${RB_HERMES_CLAUDE_MAX_TOKENS:-32000} (required by the claude upstream)"
fi

# --- context_length ----------------------------------------------------------
# The real context window and a raised compression threshold, so hermes does not
# compact mid-task (compaction starts a session that `--resume` does not follow).
if [ -n "${HERMES_CONTEXT_LENGTH:-}" ]; then
  "$PY" - "$RUN/home/.hermes/config.yaml" "$HERMES_CONTEXT_LENGTH" \
         "${RB_HERMES_COMPRESSION_THRESHOLD:-0.85}" <<'PY' \
    || { echo "[fail] writing hermes model.context_length"; exit 1; }
import os, sys, yaml
path, ctx, thr = sys.argv[1], int(sys.argv[2]), float(sys.argv[3])
cfg = {}
if os.path.exists(path):
    cfg = yaml.safe_load(open(path)) or {}
os.makedirs(os.path.dirname(path), exist_ok=True)
model = cfg.get("model")
cfg["model"] = dict(model) if isinstance(model, dict) else {}
cfg["model"]["context_length"] = ctx
comp = cfg.get("compression")
cfg["compression"] = dict(comp) if isinstance(comp, dict) else {}
cfg["compression"]["threshold"] = thr
yaml.safe_dump(cfg, open(path, "w"), sort_keys=False)
PY
  echo "[cfg] model.context_length=$HERMES_CONTEXT_LENGTH compression.threshold=${RB_HERMES_COMPRESSION_THRESHOLD:-0.85}"
fi

# --- RB_BACKUPPER: install the BackUpper for this run -----------------------
# hermes and its hook run on the host while commands run in the container, so the
# package is installed relative to $RUN (hermes' cwd) and tier 1 only copies
# (BACKUPPER_NO_REWRITE=1): a rewritten command would name host paths. The
# tier-4 subagent adopts the same container through the inherited environment.
if [ "${RB_BACKUPPER:-0}" = 1 ]; then
  BU_DIR="${RB_BU_DIR:?RB_BU_DIR is unset (set by run_regretbench.sh)}"
  BU_NODE="${RB_BU_NODE:-${RB_BU_NODE_DIR:-}/bin/node}"
  [ -s "$BU_DIR/dist/cli.js" ] || { echo "[fail] BackUpper is not built at $BU_DIR (npm ci)"; exit 1; }
  [ -x "$BU_NODE" ] || { echo "[fail] node 18+ not at $BU_NODE"; exit 1; }
  bu() { ( cd "$RUN" && "$BU_NODE" "$BU_DIR/dist/cli.js" "$@" ); }
  bu install hermes >"$RUN/backupper_install.log" 2>&1 \
    || { echo "[fail] backupper install hermes (see $RUN/backupper_install.log)"; exit 1; }
  for kv in "mode=${RB_BU_MODE:-checker}" \
            "subagentEnabled=true" \
            "subagentRunner=${RB_BU_RUNNER:-auto}" \
            "subagentModels={\"hermes\":\"${RB_BU_SUBAGENT_MODEL:-openai/gpt-5.6-luna}\"}" \
            "subagentTimeoutSeconds=${RB_BU_SUBAGENT_TIMEOUT:-240}"; do
    bu config set "${kv%%=*}" "${kv#*=}" >>"$RUN/backupper_install.log" 2>&1 \
      || { echo "[fail] backupper config set ${kv%%=*}"; exit 1; }
  done
  # RB_BU_EXPERIENCES replaces the bundled capture playbooks.
  if [ -n "${RB_BU_EXPERIENCES:-}" ]; then
    for _ef in "$RB_BU_EXPERIENCES"/*.json; do
      [ -s "$_ef" ] && cp "$_ef" "$RUN/.backupper/experiences/$(basename "$_ef")"
    done
  fi

  # A `backupper` CLI inside the container as well, so the agent can inspect the
  # store from its shell (the store is bind-mounted at $BU_STORE_IN).
  if [ -n "${CID:-}" ] && [ -s "${RB_BU_PKG:-}" ]; then
    NODE_PREFIX="$(dirname "$(dirname "$(readlink -f "$BU_NODE")")")"
    NODE_REAL="$(basename "$NODE_PREFIX")"
    docker exec -u 0 "$CID" mkdir -p /opt/rbbu/bin 2>/dev/null
    tar -C "$(dirname "$NODE_PREFIX")" -czf "$RUN/.n.tgz" "$NODE_REAL/bin" "$NODE_REAL/lib" 2>/dev/null
    docker cp "$RUN/.n.tgz" "$CID:/opt/rbbu/n.tgz" >/dev/null 2>&1 && rm -f "$RUN/.n.tgz"
    docker exec -u 0 "$CID" sh -c "cd /opt/rbbu && tar --no-same-owner -xzf n.tgz && rm -f n.tgz && ln -sfn $NODE_REAL nodejs" 2>/dev/null
    docker cp "$RB_BU_PKG" "$CID:/opt/rbbu/pkg.tgz" >/dev/null 2>&1
    docker exec -u 0 "$CID" sh -c "cd /opt/rbbu && tar --no-same-owner -xzf pkg.tgz && rm -f pkg.tgz" 2>/dev/null
    docker exec -u 0 "$CID" sh -c "printf '%s\n' '#!/bin/sh' 'exec /opt/rbbu/nodejs/bin/node /opt/rbbu/package/dist/cli.js \"\$@\"' > /opt/rbbu/bin/backupper && chmod 755 /opt/rbbu/bin/backupper" 2>/dev/null
    docker exec "$CID" sh -c '/opt/rbbu/bin/backupper --version >/dev/null 2>&1' \
      && echo "[arm] in-container CLI: /opt/rbbu/bin/backupper ok" \
      || echo "[warn] in-container backupper CLI did not run"
  fi

  # The hook runs bare `node` and tier 4 runs `hermes`, so both go on PATH;
  # hermes loads project plugins only with HERMES_ENABLE_PROJECT_PLUGINS=1.
  COMMON_ENV+=(PATH="/opt/rbbu/bin:$(dirname "$BU_NODE"):$(dirname "$HERMES"):$PATH"
               HERMES_ENABLE_PROJECT_PLUGINS=1
               BACKUPPER_NO_REWRITE=1
               BACKUPPER_PERSIST_SUBAGENT_SESSIONS=1)
  echo "[arm] backupper installed for hermes: mode=${RB_BU_MODE:-checker} runner=${RB_BU_RUNNER:-auto} subagent=${RB_BU_SUBAGENT_MODEL:-openai/gpt-5.6-luna} tier1=copy-only"
fi

# --- hand-off ----------------------------------------------------------------
# Per-run state for run.sh and adapters/hermes.sh (no credentials).
{
  echo "CID=$(printf %q "$CID")"
  echo "CWD=$(printf %q "$CWD")"
  echo "IMAGE=$(printf %q "$IMAGE")"
  echo "IDFILE=$(printf %q "$IDFILE")"
  echo "TOOLSETS=$(printf %q "$TOOLSETS")"
  echo "MCP_NAMES=$(printf %q "${MCP_NAMES:-}")"
  echo "HERMES_BIN=$(printf %q "$HERMES")"
  echo "AGENT_HOME=$(printf %q "$RUN/home")"
  echo "AGENT_HERMES_HOME=$(printf %q "$RUN/home/.hermes")"
  echo "BU_STORE=$(printf %q "$BU_STORE_IN")"
  declare -p COMMON_ENV 2>/dev/null || echo "declare -a COMMON_ENV=()"
} > "$RUN/session.env"
# From here on adapter_teardown, not the EXIT trap, removes the container.
trap - EXIT
echo "[setup] container ${CID:0:12} ready toolsets=$TOOLSETS; session.env -> $RUN/session.env"
echo "$RUN"
