#!/usr/bin/env bash
# run_task_claude.sh <task-dir> [model]
#
# Setup step of the Claude Code harness. adapters/claude.sh calls it once per run
# to create the task container, install the agent and write $RUN/session.env;
# run.sh then drives the turns.
#
# Differences from the hermes harness (run_task.sh):
#   * The agent binary runs inside the task container, since Claude Code's file
#     and shell tools act on the host process's filesystem. The container itself
#     is still created by precreate_container.py with hermes' docker flags.
#   * Claude Code is installed from a pinned prebuilt bundle (RB_CC_BUNDLE) under
#     /opt/rbcc; no node or npm runs in the task container. The install is
#     audited with `docker diff`.
#   * MCP servers are passed with --mcp-config, from a file kept under /opt/rbcc
#     so that nothing is added to the agent's workspace.
#   * The session JSONL is copied out and normalised by cc_trajectory.py.
#
# The agent sees only the task's turn text. The BackUpper plugin is asserted
# absent unless RB_BACKUPPER=1.
#
# Env:
#   RB_CLAUDE_AUTH=subscription|direct|gateway   (default subscription)
#     subscription  copy the host credential file (RB_CLAUDE_CREDENTIALS) into
#                   the container; never bind-mounted.
#     direct        pass ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN (and optional
#                   ANTHROPIC_BASE_URL) into the container.
#     gateway       a sidecar holds the upstream key (RB_UPSTREAM_KEY, else
#                   OPENROUTER_API_KEY); only its URL and a per-run nonce enter
#                   the task container.
#   RB_CC_BUNDLE          claude-code bundle tarball (required, not shipped)
#   RB_RESULTS_DIR        default $RB/results/claude
#   RB_MAX_BUDGET_USD     optional per-run spend cap passed to claude
#   RB_CLAUDE_ADD_DIR     default "/", matching hermes' unrestricted terminal
#   RB_SKIP_BUILD=1       skip `docker build`
#   RB_STRICT_POLLUTION=1 make the install-pollution report fatal
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"; RB="$(cd "$HERE/.." && pwd)"
TASKDIR="${1:?usage: run_task_claude.sh <task-dir> [model]}"; TASKDIR="$(cd "$TASKDIR" && pwd)"
MODEL="${2:-${RB_CLAUDE_MODEL:-claude-sonnet-5}}"
SMALL_MODEL="${RB_CLAUDE_SMALL_MODEL:-claude-haiku-4.5}"
AUTH="${RB_CLAUDE_AUTH:-subscription}"
CREDS="${RB_CLAUDE_CREDENTIALS:-$HOME/.claude/.credentials.json}"
# Python 3.10+ with PyYAML (required by hermes' terminal_tool).
PY="${RB_PY:-python3}"
if ! "$PY" -c 'import yaml' 2>/dev/null; then
  echo "[fail] \$RB_PY ($PY) is not a Python 3.10+ with PyYAML"; exit 1
fi
# The Claude Code CLI is not shipped; RB_CC_BUNDLE is the official linux-x64 tarball.
CC_BUNDLE="${RB_CC_BUNDLE:-}"
if [ -z "$CC_BUNDLE" ]; then
  echo "[fail] RB_CC_BUNDLE is unset -- point it at a claude-code-<version>-linux-x64.tar.gz (see regretbench/run_regretbench.sh --help)"
  exit 1
fi
GW_IMAGE="${RB_CLAUDE_GATEWAY_IMAGE:-continuumio/miniconda3:latest}"
GW_PORT="${RB_CLAUDE_GATEWAY_PORT:-8900}"
ADD_DIR="${RB_CLAUDE_ADD_DIR:-/}"
CCDIR=/opt/rbcc                        # everything this runner installs lives here
if [ ! -f "$CC_BUNDLE" ]; then
  echo "[fail] claude-code bundle not found: $CC_BUNDLE"; exit 1
fi

eval "$($PY - "$TASKDIR/task.yaml" <<'PY'
import sys, yaml, shlex, os
d = yaml.safe_load(open(sys.argv[1]))
img = d.get("image") or f"regretbench/{os.path.basename(os.path.dirname(sys.argv[1]))}:latest"
print(f"SLUG={shlex.quote(str(d['slug']))}")
print(f"IMAGE={shlex.quote(img)}")
mcp = d.get("mcp") or []
print(f"MCP_NAMES={shlex.quote(' '.join(str(e['server']) for e in mcp))}")
PY
)"

if [ "${RB_SKIP_BUILD:-0}" != 1 ] && docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "[build] $IMAGE exists, skipping"
elif [ "${RB_SKIP_BUILD:-0}" != 1 ]; then
  echo "[build] $IMAGE"
  docker build -q -t "$IMAGE" "$TASKDIR" >/dev/null || { echo "[fail] docker build"; exit 1; }
fi

RUN="${RB_RESULTS_DIR:-$RB/results/claude}/${SLUG}-$(date +%Y%m%d_%H%M%S)"
mkdir -p "$RUN"

# Record the image id so that a verdict can be tied to a task build.
docker image inspect -f '{{.Id}}' "$IMAGE" > "$RUN/image-id.txt" 2>/dev/null || true

# --- the agent's cwd inside the container -----------------------------------
# The image's WorkingDir (possibly inherited from its base) is the agent's
# workspace; it falls back to /root.
CWD="$(docker image inspect -f '{{.Config.WorkingDir}}' "$IMAGE" 2>/dev/null)"
case "$CWD" in ""|"/") CWD=/root ;; esac

# --- RB_BU_STORE: the backupper store's location INSIDE the container --------
# Default $CWD/.backupper; an absolute RB_BU_STORE moves the store out of the
# agent's workspace. The plugin reads it as BACKUPPER_STORE_DIR.
BU_STORE_IN="${RB_BU_STORE:-$CWD/.backupper}"
# Exported only when RB_BU_STORE is set: the plugin treats any explicit value as
# an override and then records an absolute backupDir in config.json.
BU_STORE_ENV=()
[ -n "${RB_BU_STORE:-}" ] && BU_STORE_ENV=(-e "BACKUPPER_STORE_DIR=$BU_STORE_IN")

# --- container bookkeeping (same contract as run_task.sh) -------------------
# Ids of every container this invocation created (task container and gateway
# sidecar); the reaper removes exactly these.
IDFILE="$RUN/containers.ids"; : > "$IDFILE"
# Copy the BackUpper store out before the container is removed; it is the only
# record of what tier 3 captured.
harvest_sandbox() {
  [ -n "${CID:-}" ] || return 0
  [ -n "${CWD:-}" ] || return 0
  docker exec "$CID" test -d "${BU_STORE_IN:-$CWD/.backupper}" >/dev/null 2>&1 || return 0
  docker cp "$CID:${BU_STORE_IN:-$CWD/.backupper}" "$RUN/backupper" >/dev/null 2>&1 || return 0
  local acts subs
  acts=$(wc -l < "$RUN/backupper/effects.jsonl" 2>/dev/null | tr -d ' ')
  subs=$(grep -c 'subagent verdict' "$RUN/backupper/subagent.log" 2>/dev/null)
  echo "[backupper] store harvested: ${acts:-0} effect line(s), ${subs:-0} tier-3 verdict(s)"
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

# --- pre-create the task container (hermes' own flags) ----------------------
COMMON_ENV=(
  HOME="$RUN/home" HERMES_HOME="$RUN/home/.hermes"
  TERMINAL_ENV=docker TERMINAL_DOCKER_IMAGE="$IMAGE" TERMINAL_CWD="$CWD"
  HERMES_TERMINAL_RELAX_FS=1 TERMINAL_CONTAINER_PERSISTENT=false
  HERMES_TERMINAL_CONTAINER_IDFILE="$IDFILE"
)
mkdir -p "$RUN/home/.hermes"
CID="$(env "${COMMON_ENV[@]}" "$PY" "$HERE/precreate_container.py" 2>"$RUN/precreate.log" | tail -1)"
if [ -z "$CID" ]; then
  echo "[fail] could not pre-create the task container (see $RUN/precreate.log)"; exit 1
fi
grep -qx "$CID" "$IDFILE" || echo "$CID" >> "$IDFILE"
docker inspect -f '{{.Id}} {{.Name}}' "$CID" > "$RUN/container.id" 2>/dev/null
echo "[task] container=${CID:0:12} image=$IMAGE cwd=$CWD"

# Join the task's service network and expand the GitLab token placeholder
# before anything resolves a service name (see task_env.sh).
# shellcheck source=task_env.sh
. "$HERE/task_env.sh"
attach_task_network "$CID"
inject_gitlab_pat "$CID"

# --- MCP wiring (only tasks with a non-empty `mcp:` block) ------------------
# The servers run inside the task container and must be healthy before the
# agent starts; a run with zero MCP tools would measure nothing.
MCP_ARGS=()
if [ -n "${MCP_NAMES:-}" ]; then
  # Health wait in seconds: 180 for a postgres base image, 90 otherwise.
  MCP_WAIT="${RB_MCP_WAIT:-90}"
  case "$(grep -hE '^FROM ' "$TASKDIR/Dockerfile" 2>/dev/null | tr '\n' ' ')" in
    *postgres*) MCP_WAIT="${RB_MCP_WAIT:-180}" ;;
  esac
  if ! bash "$RB/gen_mcp_config.sh" "$TASKDIR" "$CID" --out "$RUN/mcp_client_host.json" --wait "$MCP_WAIT" \
        > "$RUN/mcp_gen.log" 2> "$RUN/mcp_health.log"; then
    echo "[fail] gen_mcp_config.sh (see $RUN/mcp_gen.log $RUN/mcp_health.log)"; exit 1
  fi
  if grep -q '^\[warn\] endpoint not answering' "$RUN/mcp_health.log"; then
    echo "[fail] MCP endpoint never became healthy:"
    grep '^\[warn\]' "$RUN/mcp_health.log"
    exit 1
  fi
  # The client runs inside the container: rewrite the bridge IP to 127.0.0.1.
  $PY - "$TASKDIR/task.yaml" "$RUN/mcp_client_host.json" "$RUN/mcp.container.json" \
        "$RUN/mcp_servers.json" "$CID" "$IMAGE" <<'PY' || { echo "[fail] mcp config"; exit 1; }
import json, re, subprocess, sys, yaml
task, hostcfg, outcfg, recpath, cid, image = sys.argv[1:7]
entries = (yaml.safe_load(open(task)) or {}).get("mcp") or []
urls = json.load(open(hostcfg))["mcpServers"]
local = {}
for n, s in urls.items():
    local[n] = {**s, "url": re.sub(r"//[^:/]+:", "//127.0.0.1:", s["url"])}
json.dump({"mcpServers": local}, open(outcfg, "w"), indent=2)
open(outcfg, "a").write("\n")
name = subprocess.run(["docker", "inspect", "-f", "{{.Name}}", cid],
                      capture_output=True, text=True).stdout.strip().lstrip("/")
json.dump({
    "container_id": cid, "container_name": name, "image": image,
    "client_location": "in-container (localhost)",
    "servers": [{
        "server": e["server"], "role": e.get("role", "ambient"),
        "transport": e.get("transport", "http"), "port": e.get("port"),
        "path": e.get("path", "/mcp"), "health": e.get("health"),
        "scope": e.get("scope"),
        "url_host": urls.get(e["server"], {}).get("url"),
        "url_incontainer": local.get(e["server"], {}).get("url"),
    } for e in entries],
}, open(recpath, "w"), indent=2)
open(recpath, "a").write("\n")
PY
  # server_url <client-config.json> <name>: the server's URL in that config.
  server_url() {
    $PY -c '
import json, sys
servers = json.load(open(sys.argv[1]))["mcpServers"]
print(servers[sys.argv[2]]["url"])' "$1" "$2"
  }
  # health_url <name>: the in-container health endpoint declared in task.yaml.
  health_url() {
    $PY -c '
import sys, yaml
entries = (yaml.safe_load(open(sys.argv[1])) or {}).get("mcp") or []
e = [x for x in entries if x["server"] == sys.argv[2]][0]
print("http://127.0.0.1:%d%s" % (int(e["port"]), e.get("health", "/healthz")))' \
      "$TASKDIR/task.yaml" "$1"
  }

  # Second health check, from inside the container, where the client dials.
  : > "$RUN/mcp_health_incontainer.log"
  for n in $MCP_NAMES; do
    u="$(server_url "$RUN/mcp.container.json" "$n")"
    h="$(health_url "$n")"
    # Most task images have no curl, so probe with bash's /dev/tcp.
    hp="${h#http://}"
    hh="${hp%%/*}"
    hpath="/${hp#*/}"
    code="$(docker exec "$CID" bash -c '
      IFS=: read -r host port <<<"$1"
      exec 3<>/dev/tcp/"$host"/"${port:-80}" 2>/dev/null || { echo 000; exit 0; }
      printf "GET %s HTTP/1.0\r\nHost: %s\r\nConnection: close\r\n\r\n" "$2" "$1" >&3
      read -r -t 5 status <&3 || { echo 000; exit 0; }
      set -- $status; echo "${2:-000}"' _ "$hh" "$hpath" 2>/dev/null)"
    echo "$n health=$h code=$code url=$u" >> "$RUN/mcp_health_incontainer.log"
    [ "$code" = 200 ] || { echo "[fail] in-container MCP health check failed: $n $h -> $code"; exit 1; }

    # /healthz answers before the server can serve requests, so also require an
    # initialize + tools/list handshake with at least one usable tool. This runs
    # on the host, so it probes the host-side URL.
    uhost="$(server_url "$RUN/mcp_client_host.json" "$n" 2>/dev/null)"
    ntools=0
    for attempt in $(seq 1 40); do
      ntools="$($PY - "${uhost:-$u}" <<'PY' 2>/dev/null || echo 0
import json, sys, urllib.request
url = sys.argv[1]
H = {"Content-Type": "application/json",
     "Accept": "application/json, text/event-stream",
     "MCP-Protocol-Version": "2025-06-18"}


def post(body, sid=None):
    h = dict(H)
    if sid:
        h["Mcp-Session-Id"] = sid
    # A long timeout: abandoning an in-flight request crashes supergateway.
    r = urllib.request.urlopen(
        urllib.request.Request(url, json.dumps(body).encode(), h), timeout=90)
    return r, r.read().decode("utf-8", "replace")


def parse(raw):
    """First JSON object in a reply; streamable HTTP may frame it as SSE."""
    for line in raw.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            line = line[5:].strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except Exception:
                pass
    return {}


r, raw = post({"jsonrpc": "2.0", "id": 1, "method": "initialize",
               "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                          "clientInfo": {"name": "rb-probe", "version": "1"}}})
sid = r.headers.get("Mcp-Session-Id")
try:
    post({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}, sid)
    _, raw = post({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}, sid)
    tools = ((parse(raw).get("result") or {}).get("tools")) or []
finally:
    # Close the session, best-effort.
    try:
        if sid:
            dh = dict(H)
            dh["Mcp-Session-Id"] = sid
            urllib.request.urlopen(
                urllib.request.Request(url, headers=dh, method="DELETE"),
                timeout=5)
    except Exception:
        pass


# A tool without a usable inputSchema makes the client drop the whole server,
# so count only usable tools.
def usable(t):
    s = t.get("inputSchema")
    if not isinstance(s, dict):
        return False
    return s.get("type") == "object" or bool(s.get("properties"))


bad = [t.get("name", "?") for t in tools if not usable(t)]
print("%d %d %s" % (len(tools) - len(bad), len(tools), ",".join(bad[:6])))
PY
)"
      read -r nusable ntotal nbad <<<"${ntools:-0 0 }"
      [ "${nusable:-0}" -ge 1 ] 2>/dev/null && break
      sleep 3
    done
    read -r nusable ntotal nbad <<<"${ntools:-0 0 }"
    echo "$n tools=${nusable:-0}/${ntotal:-0} usable (after $attempt probe attempt(s))" \
      >> "$RUN/mcp_health_incontainer.log"
    if [ -n "${nbad:-}" ]; then
      echo "$n UNUSABLE SCHEMAS: $nbad" >> "$RUN/mcp_health_incontainer.log"
    fi
    ntools="${nusable:-0}"
    if ! [ "${ntools:-0}" -ge 1 ] 2>/dev/null; then
      echo "[fail] MCP server '$n' answered /healthz and listed ${ntotal:-0} tools," \
           "but NONE had a usable inputSchema (${nbad:-?}) -- the client will drop" \
           "this server. Check zod/zod-to-json-schema version skew."
      exit 1
    fi
  done
  sed 's/^/[mcp] /' "$RUN/mcp_health_incontainer.log"
  MCP_ARGS=(--mcp-config "$CCDIR/mcp.json" --strict-mcp-config)
fi

# --- install Claude Code into /opt (audited) --------------------------------
# Service-noise baseline: two `docker diff` samples 3 s apart record the paths
# the task's own services touch, which are then excluded from the audit.
docker diff "$CID" | sort > "$RUN/diff_noise_a.txt"
sleep 3
docker diff "$CID" | sort > "$RUN/diff_noise_b.txt"
comm -13 "$RUN/diff_noise_a.txt" "$RUN/diff_noise_b.txt" \
  | sed -E 's/^[ACD] //' > "$RUN/install_noise_paths.txt" || true

docker diff "$CID" | sort > "$RUN/diff_pre_install.txt"
# $CCDIR/cfg (mode 700) must be owned by the image's own user, which the agent
# runs as; an unwritable config dir makes every --resume fail.
AGENT_UID="$(docker exec "$CID" id -u 2>/dev/null || echo 0)"
docker exec -u 0 "$CID" bash -c "mkdir -p $CCDIR/pkg $CCDIR/cfg && chmod 700 $CCDIR/cfg && chown ${AGENT_UID:-0}:0 $CCDIR/cfg" \
  || { echo "[fail] mkdir $CCDIR"; exit 1; }
docker cp "$CC_BUNDLE" "$CID:$CCDIR/cc.tar.gz" >/dev/null \
  || { echo "[fail] docker cp bundle"; exit 1; }
docker exec -u 0 "$CID" bash -c "set -e
  tar -xzf $CCDIR/cc.tar.gz -C $CCDIR/pkg && rm -f $CCDIR/cc.tar.gz
  test -x $CCDIR/pkg/claude-code/bin/claude.exe" \
  || { echo "[fail] unpack claude-code bundle"; exit 1; }
CC_VERSION="$(docker exec "$CID" "$CCDIR/pkg/claude-code/bin/claude.exe" --version 2>&1 | tail -1)"
echo "[install] $CC_VERSION (no node, no npm)"
if [ -f "$RUN/mcp.container.json" ]; then
  docker cp "$RUN/mcp.container.json" "$CID:$CCDIR/mcp.json" >/dev/null
fi

# Pollution audit: every path the install changed must lie under $CCDIR.
docker diff "$CID" | sort > "$RUN/diff_post_install.txt"
comm -13 "$RUN/diff_pre_install.txt" "$RUN/diff_post_install.txt" > "$RUN/install_delta.txt"
# /run and /var/run hold the services' runtime files, which the install never writes.
grep -vE "^[ACD] (/opt$|/opt/rbcc|/run($|/)|/var/run($|/))" "$RUN/install_delta.txt" \
  > "$RUN/install_delta_filtered.txt" || true
# Drop entries whose path is, contains, or lies under a service-noise path.
"$PY" - "$RUN/install_delta_filtered.txt" "$RUN/install_noise_paths.txt" \
       "$RUN/install_pollution.txt" <<'PY'
import sys, pathlib

delta, noise, out = (pathlib.Path(p) for p in sys.argv[1:4])
noisy = []
if noise.exists():
    noisy = [line.strip() for line in noise.read_text().splitlines() if line.strip()]


def is_noise(path):
    for n in noisy:
        if (path == n or path.startswith(n.rstrip("/") + "/")
                or n.startswith(path.rstrip("/") + "/")):
            return True
    return False


kept = []
for line in delta.read_text().splitlines():
    if not line.strip():
        continue
    path = line.split(" ", 1)[1] if " " in line else line
    if not is_noise(path):
        kept.append(line)
out.write_text("".join(line + "\n" for line in kept))
PY
# A/D entries are reported as possible install pollution; C entries are the
# task's services rewriting existing files. Both are fatal only under
# RB_STRICT_POLLUTION=1.
grep -E '^[AD] ' "$RUN/install_pollution.txt" > "$RUN/install_pollution_ad.txt" || true
grep -E '^C '   "$RUN/install_pollution.txt" > "$RUN/install_pollution_c.txt"  || true
if [ -s "$RUN/install_pollution_c.txt" ]; then
  echo "[note] pre-existing paths modified during the install window (task's own"
  echo "       services; not created by the install):"
  sed 's/^/  /' "$RUN/install_pollution_c.txt"
  [ "${RB_STRICT_POLLUTION:-0}" = 1 ] && { echo "[fail] strict pollution check"; exit 1; }
fi
if [ -s "$RUN/install_pollution_ad.txt" ]; then
  # Not fatal by default: `docker diff` cannot attribute a write to a process.
  echo "[note] paths added/deleted outside $CCDIR during the install window"
  echo "       ($(wc -l < "$RUN/install_pollution_ad.txt") entries, task services included; see install_pollution_ad.txt)"
  sed -n '1,5s/^/  /p' "$RUN/install_pollution_ad.txt"
  [ "${RB_STRICT_POLLUTION:-0}" = 1 ] && { echo "[fail] strict pollution check"; exit 1; }
fi

# --- plugin-absent assertion (baseline arm) ---------------------------------
# On the baseline arm, assert that no BackUpper artifact is present in the image
# or workspace.
if [ "${RB_BACKUPPER:-0}" = 1 ]; then
  echo "[arm] backupper=on -- skipping the plugin-absent assertion (that guard is for the baseline)"
else
  PLUGIN_PROBE="$(docker exec -i "$CID" bash -s -- \
    "$CWD/.backupper" /root/.backupper "$CCDIR/cfg/plugins" \
    "$CWD/.claude/settings.local.json" /root/.claude /opt/rbbu <<'PROBE' 2>&1
found=""
for p in "$@"; do [ -e "$p" ] && found="$found $p"; done
echo "PROBE_OK:${found:-none}"
PROBE
)"
  case "$PLUGIN_PROBE" in
    PROBE_OK:none)
      ;;
    PROBE_OK:*)
      echo "[fail] baseline requires the sandbox plugin ABSENT, but found:${PLUGIN_PROBE#PROBE_OK:}"
      exit 1 ;;
    *)
      echo "[fail] plugin-absence probe did not run: $PLUGIN_PROBE"
      exit 1 ;;
  esac
  echo "[baseline] plugin=absent (asserted)"
fi

# --- RB_BACKUPPER: install the BackUpper in the task container --------------
# Tier 3 spawns `claude`, so a shim for the bundled CLI goes on the agent's PATH.
if [ "${RB_BACKUPPER:-0}" = 1 ]; then
  # shellcheck source=backupper_install.sh
  . "$HERE/backupper_install.sh"
  # A vendor-prefixed RB_BU_SUBAGENT_MODEL (openai/gpt-5.6-luna) is routed through
  # an Anthropic-compatible endpoint below, which maps every Claude tier to it;
  # a bare one (haiku, sonnet, a claude-* id) runs on the main agent's login.
  case "${RB_BU_SUBAGENT_MODEL:-haiku}" in
    */*) _BU_TIER=haiku ;;
    *)   _BU_TIER="${RB_BU_SUBAGENT_MODEL:-haiku}" ;;
  esac
  _BU_MCP=()
  [ -f "$RUN/mcp.container.json" ] && _BU_MCP=("subagentMcpConfig=$CCDIR/mcp.json")
  bu_install_in_container claude-code claude "$_BU_TIER" "${_BU_MCP[@]+"${_BU_MCP[@]}"}" || exit 1
  docker exec -u 0 "$CID" sh -c "printf '%s\n' '#!/bin/sh' 'exec $CCDIR/pkg/claude-code/bin/claude.exe \"\$@\"' > $BUDIR/bin/claude && chmod 755 $BUDIR/bin/claude" \
    || { echo "[fail] claude shim"; exit 1; }
  echo "[arm] $BU_SUMMARY"
fi

# --- credentials -----------------------------------------------------------
# No credential below is written to a run artifact.
# RB_THINKING sets MAX_THINKING_TOKENS; unset keeps Claude Code's default.
_THINK_ENV=()
if [ -n "${RB_THINKING:-}" ]; then
  _THINK_ENV=(-e MAX_THINKING_TOKENS="$RB_THINKING")
fi
# The ${arr[@]+...} form expands to nothing when the array is unset.
AGENT_ENV=(-e IS_SANDBOX=1 -e CLAUDE_CONFIG_DIR="$CCDIR/cfg"
           ${_THINK_ENV[@]+"${_THINK_ENV[@]}"} ${BU_PATH_ENV[@]+"${BU_PATH_ENV[@]}"}
           -e DISABLE_AUTOUPDATER=1 -e DISABLE_TELEMETRY=1 -e DISABLE_ERROR_REPORTING=1
           -e DISABLE_BUG_COMMAND=1 -e CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
           -e ANTHROPIC_SMALL_FAST_MODEL="$SMALL_MODEL"
           -e ANTHROPIC_DEFAULT_HAIKU_MODEL="$SMALL_MODEL"
           # Generous MCP timeouts: a server that is slow at startup is dropped,
           # and an abandoned request crashes it for the rest of the run.
           -e MCP_TIMEOUT=120000 -e MCP_TOOL_TIMEOUT=600000)

# Route the tier-3 subagent (only) through an Anthropic-compatible endpoint when
# its model is vendor-prefixed; the plugin applies these three variables to the
# child process, so the main agent keeps its own credentials. The base URL omits
# /v1, which claude appends.
_SB_MODEL_ID="${RB_BU_SUBAGENT_MODEL:-haiku}"
if [ "${RB_BACKUPPER:-0}" = 1 ]; then
  case "$_SB_MODEL_ID" in
    */*)
      _SB_TOKEN="${RB_BU_SUBAGENT_AUTH_TOKEN:-${OPENROUTER_API_KEY:-}}"
      [ -n "$_SB_TOKEN" ] || { echo "[fail] subagent model $_SB_MODEL_ID needs RB_BU_SUBAGENT_AUTH_TOKEN or OPENROUTER_API_KEY"; exit 1; }
      AGENT_ENV+=(-e BACKUPPER_SUBAGENT_BASE_URL="${RB_BU_SUBAGENT_BASE_URL:-https://openrouter.ai/api}"
                  -e BACKUPPER_SUBAGENT_AUTH_TOKEN="$_SB_TOKEN"
                  -e BACKUPPER_SUBAGENT_MODEL_ID="$_SB_MODEL_ID")
      echo "[arm] subagent routed to $_SB_MODEL_ID via ${RB_BU_SUBAGENT_BASE_URL:-https://openrouter.ai/api} (main agent untouched)" ;;
    *)
      echo "[arm] subagent runs $_SB_MODEL_ID on the main agent's login" ;;
  esac
fi
GW_CID=""; AUTH_DESC=""
case "$AUTH" in
  subscription)
    # A private copy, never a mount, so the task cannot reach the host file.
    if [ ! -f "$CREDS" ]; then
      echo "[fail] no credential file at $CREDS (RB_CLAUDE_CREDENTIALS)"; exit 1
    fi
    docker exec -u 0 "$CID" install -d -m 700 "$CCDIR/cfg" || { echo "[fail] mkdir $CCDIR/cfg"; exit 1; }
    # Give the container an ACCESS-ONLY copy: a container CLI that refreshes the token rotates the refresh token
    # server-side and kills the host credential (and every other lane). The host stays the only refresher.
    if ! python3 -c 'import json,sys,time;d=json.load(open(sys.argv[1]))["claudeAiOauth"];sys.exit(0 if d.get("expiresAt",0)/1000-time.time()>5400 else 1)' "$CREDS"; then
      timeout 120 claude -p "reply ok" --tools "" --no-session-persistence >/dev/null 2>&1 || true
    fi
    _AO="$(mktemp)"; chmod 600 "$_AO"
    python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));d["claudeAiOauth"]["refreshToken"]="";json.dump(d,open(sys.argv[2],"w"))' "$CREDS" "$_AO" \
      || { rm -f "$_AO"; echo "[fail] could not prepare access-only credential"; exit 1; }
    docker cp "$_AO" "$CID:$CCDIR/cfg/.credentials.json" >/dev/null \
      || { rm -f "$_AO"; echo "[fail] could not copy credentials into the container"; exit 1; }
    rm -f "$_AO"
    docker exec -u 0 "$CID" chmod 600 "$CCDIR/cfg/.credentials.json" || true
    # Hand the credential to the image's user, which the agent runs as.
    CRED_UID="$(docker exec "$CID" id -u 2>/dev/null || echo 0)"
    docker exec -u 0 "$CID" chown -R "${CRED_UID:-0}:0" "$CCDIR/cfg" || true
    # Pre-seeded config, so a fresh CLAUDE_CONFIG_DIR writes nothing outside $CCDIR.
    docker exec -u 0 "$CID" bash -c "printf '%s' '{\"hasCompletedOnboarding\":true,\"bypassPermissionsModeAccepted\":true}' > $CCDIR/cfg/.claude.json" || true
    AUTH_DESC="subscription:copied-credentials"
    echo "[auth] subscription credentials COPIED into ${CID:0:12}:$CCDIR/cfg (host file untouched, copy dies with the container)"
    ;;
  direct)
    if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
      AGENT_ENV+=(-e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY")
    elif [ -n "${ANTHROPIC_AUTH_TOKEN:-}" ]; then
      AGENT_ENV+=(-e ANTHROPIC_AUTH_TOKEN="$ANTHROPIC_AUTH_TOKEN")
    else
      echo "[fail] RB_CLAUDE_AUTH=direct needs ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN"; exit 1
    fi
    if [ -n "${ANTHROPIC_BASE_URL:-}" ]; then
      AGENT_ENV+=(-e ANTHROPIC_BASE_URL="$ANTHROPIC_BASE_URL")
    fi
    AUTH_DESC="direct:${ANTHROPIC_BASE_URL:-https://api.anthropic.com}"
    ;;
  gateway)
    NONCE="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    UPSTREAM_URL="${RB_UPSTREAM_URL:-https://openrouter.ai/api/v1}"
    GW_ARGS=(--mode relay --listen "0.0.0.0:$GW_PORT" --token "$NONCE"
             --log /gw/gateway.jsonl --key-env RB_UPSTREAM_KEY
             --upstream "$UPSTREAM_URL")
    case "$UPSTREAM_URL" in
      *openrouter*) GW_ARGS+=(--prefix-anthropic) ;;
    esac
    # The key is copied into the (capability-stripped) sidecar as a file, so it
    # appears in no image, `docker inspect` output or run artifact.
    STAGE="$(mktemp -d)"
    chmod 700 "$STAGE"
    cp "$HERE/claude_gateway.py" "$STAGE/claude_gateway.py"
    printf '%s' "${RB_UPSTREAM_KEY:-$OPENROUTER_API_KEY}" > "$STAGE/key"
    chmod 600 "$STAGE/key"
    AUTH_DESC="gateway:$UPSTREAM_URL"
    GW_CID="$(docker create --cap-drop ALL --security-opt no-new-privileges --pids-limit 64 \
                --memory 512m --entrypoint /bin/sh "$GW_IMAGE" \
                -c "cd /gw && RB_UPSTREAM_KEY=\$(cat /gw/key 2>/dev/null) \
                    exec python /gw/claude_gateway.py $(printf '%q ' "${GW_ARGS[@]}")" 2>/dev/null)"
    if [ -z "$GW_CID" ]; then
      rm -rf "$STAGE"
      echo "[fail] could not create the gateway sidecar"; exit 1
    fi
    echo "$GW_CID" >> "$IDFILE"
    if ! docker cp "$STAGE" "$GW_CID:/gw" >/dev/null; then
      rm -rf "$STAGE"
      echo "[fail] docker cp gateway"; exit 1
    fi
    rm -rf "$STAGE"
    docker start "$GW_CID" >/dev/null || { echo "[fail] gateway sidecar did not start"; exit 1; }
    GW_IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$GW_CID")"
    # Health-probe the sidecar from inside the task container via /dev/tcp.
    ok=""
    for _ in $(seq 1 30); do
      gwcode="$(docker exec "$CID" bash -c '
        exec 3<>/dev/tcp/"$1"/"$2" 2>/dev/null || { echo 000; exit 0; }
        printf "GET /healthz HTTP/1.0\r\nHost: %s:%s\r\nConnection: close\r\n\r\n" "$1" "$2" >&3
        read -r -t 5 status <&3 || { echo 000; exit 0; }
        set -- $status; echo "${2:-000}"' _ "$GW_IP" "$GW_PORT" 2>/dev/null)"
      if [ "$gwcode" = 200 ]; then
        ok=1
        break
      fi
      sleep 1
    done
    if [ -z "$ok" ]; then
      echo "[fail] gateway not reachable from the task container"
      docker logs "$GW_CID" 2>&1 | tail -20
      exit 1
    fi
    AGENT_ENV+=(-e ANTHROPIC_BASE_URL="http://$GW_IP:$GW_PORT" -e ANTHROPIC_AUTH_TOKEN="$NONCE")
    echo "[auth] $AUTH_DESC via sidecar ${GW_CID:0:12} at http://$GW_IP:$GW_PORT (key not in task container)"
    ;;
  *) echo "[fail] unknown RB_CLAUDE_AUTH=$AUTH (subscription|direct|gateway)"; exit 1 ;;
esac

# --- hand-off --------------------------------------------------------------
# Write the per-run state to session.env; run.sh owns the turn loop from here.
{
  echo "CID=$(printf %q "$CID")"
  echo "CWD=$(printf %q "$CWD")"
  # The store's location inside the container; adapters/claude.sh reads it.
  echo "BU_STORE=$(printf %q "$BU_STORE_IN")"
  echo "CCDIR=$(printf %q "$CCDIR")"
  echo "IMAGE=$(printf %q "$IMAGE")"
  echo "MODEL=$(printf %q "$MODEL")"
  echo "ADD_DIR=$(printf %q "${ADD_DIR:-}")"
  echo "GW_CID=$(printf %q "${GW_CID:-}")"
  echo "IDFILE=$(printf %q "$IDFILE")"
  echo "SID=$($PY -c 'import uuid;print(uuid.uuid4())')"
  declare -p AGENT_ENV 2>/dev/null || echo "declare -a AGENT_ENV=()"
  declare -p MCP_ARGS  2>/dev/null || echo "declare -a MCP_ARGS=()"
} > "$RUN/session.env"
# From here on adapter_teardown, not the EXIT trap, removes the container.
trap - EXIT
echo "[setup] container ${CID:0:12} ready; session.env -> $RUN/session.env"
echo "$RUN"
