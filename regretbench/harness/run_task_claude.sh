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
#   RB_RUN_DIR            use this run dir instead of minting one (adapter passes it)
#   RB_BU_STORE           absolute in-container path of the BackUpper store
#                         (default $CWD/.backupper)
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

# shellcheck source=setup_lib.sh
. "$HERE/setup_lib.sh"
rb_task_meta || exit 1
rb_ensure_image || exit 1
rb_mint_run claude
rb_install_reaper
rb_resolve_cwd || exit 1
rb_precreate || exit 1

# --- MCP wiring (only tasks with a non-empty `mcp:` block) ------------------
# The servers run inside the task container and must be healthy before the
# agent starts; a run with zero MCP tools would measure nothing.
MCP_ARGS=()
if [ -n "${MCP_NAMES:-}" ]; then
  rb_mcp_gen_config || exit 1
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
  rb_mcp_check_incontainer || exit 1
  MCP_ARGS=(--mcp-config "$CCDIR/mcp.json" --strict-mcp-config)
fi

# --- install Claude Code into /opt (audited) --------------------------------
rb_audit_install_begin
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
rb_audit_install_end "$CCDIR" || exit 1

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
# Tier 4 spawns `claude`, so a shim for the bundled CLI goes on the agent's PATH.
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

# Route the tier-4 subagent (only) through an Anthropic-compatible endpoint when
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
    # Health-probe the sidecar from inside the task container.
    ok=""
    [ "$(rb_wait_http "$CID" "http://$GW_IP:$GW_PORT/healthz" 30)" = 200 ] && ok=1
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
# BU_STORE is the store's location inside the container (adapters/_common.sh).
rb_write_session_env CID CWD "BU_STORE=$BU_STORE_IN" CCDIR IMAGE MODEL ADD_DIR GW_CID IDFILE \
  "SID=$($PY -c 'import uuid;print(uuid.uuid4())')" @AGENT_ENV @MCP_ARGS
# From here on adapter_teardown, not the EXIT trap, removes the container.
trap - EXIT
echo "[setup] container ${CID:0:12} ready; session.env -> $RUN/session.env"
echo "$RUN"
