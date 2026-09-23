#!/usr/bin/env bash
# gen_mcp_config.sh <task-dir> <container> [--out FILE] [--wait SECONDS]
#
# Emits the agent-side MCP client config (.mcp.json shape) for a task whose
# image bakes its MCP bundle, given the CONTAINER already running that image.
# Reads the `mcp:` block of <task-dir>/task.yaml, resolves the container's IP on
# the docker bridge, and writes:
#
#   {"mcpServers": {"<server>": {"type": "http", "url": "http://<ip>:<port>/mcp"}}}
#
# The agent process lives on the HOST (hermes runs the loop and docker-execs the
# terminal into the container), so it reaches the in-container endpoints over the
# bridge IP. Nothing is published, no host ports are consumed, and concurrent
# task containers cannot collide.
#
# --wait N (default 60) polls each server's health endpoint until it answers, so
# a caller can start the container and immediately get a known-live config. The
# health endpoint is used deliberately: opening the MCP endpoint itself would
# consume a session.
#
# Prints the config path on stdout; a "server<TAB>role<TAB>url" table on stderr.
set -uo pipefail

TASKDIR="${1:?usage: gen_mcp_config.sh <task-dir> <container> [--out FILE] [--wait SECONDS]}"
CONTAINER="${2:?usage: gen_mcp_config.sh <task-dir> <container> [--out FILE] [--wait SECONDS]}"
shift 2
OUT=""; WAIT=60
while [ $# -gt 0 ]; do
  case "$1" in
    --out)  OUT="${2:?--out needs a path}"; shift 2 ;;
    --wait) WAIT="${2:?--wait needs seconds}"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
TASKDIR="$(cd "$TASKDIR" && pwd)"
[ -f "$TASKDIR/task.yaml" ] || { echo "[fail] no task.yaml in $TASKDIR" >&2; exit 1; }

PY="${RB_PY:-${RB_PYTHON:-python3}}"
command -v "$PY" >/dev/null 2>&1 || PY=python3

IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$CONTAINER" 2>/dev/null | awk '{print $1}')"
# A container on --network=host has no address of its own: NetworkSettings.Networks
# holds a single "host" entry whose IPAddress is empty, and docker's template then
# renders the literal string "invalid". The health probe that follows dutifully
# tries http://invalid:8817/healthz and the run dies as SETUP_FAILED -- which reads
# like a broken image rather than a network mode. Measured 2026-08-17.
# On host networking the container shares the host stack, so 127.0.0.1 is right.
if [ -z "$IP" ] || [ "$IP" = "invalid" ] || \
   [ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$CONTAINER" 2>/dev/null)" = host ]; then
  IP=127.0.0.1
fi
[ -n "$IP" ] || { echo "[fail] no address for container $CONTAINER (is it running?)" >&2; exit 1; }

# Default to the caller's cwd (the agent workspace), never the task dir.
[ -n "$OUT" ] || OUT="$PWD/.mcp.json"

HEALTH="$("$PY" - "$TASKDIR/task.yaml" "$IP" "$OUT" <<'PY'
import json, sys, yaml
task, ip, out = sys.argv[1], sys.argv[2], sys.argv[3]
entries = (yaml.safe_load(open(task)) or {}).get("mcp") or []
servers, health, rows = {}, [], []
for e in entries:
    name = e["server"]
    servers[name] = {
        "type": e.get("transport", "http"),
        "url": "http://%s:%d%s" % (ip, int(e["port"]), e.get("path", "/mcp")),
    }
    if e.get("health"):
        health.append("http://%s:%d%s" % (ip, int(e["port"]), e["health"]))
    rows.append("%s\t%s\t%s" % (name, e.get("role", "ambient"), servers[name]["url"]))
with open(out, "w") as fh:
    json.dump({"mcpServers": servers}, fh, indent=2)
    fh.write("\n")
print("\n".join(rows), file=sys.stderr)
print("\n".join(health))
PY
)" || exit 1

if [ "$WAIT" -gt 0 ]; then
  for u in $HEALTH; do
    ok=""
    for _ in $(seq 1 "$WAIT"); do
      [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 "$u")" = 200 ] && { ok=1; break; }
      sleep 1
    done
    [ -n "$ok" ] || echo "[warn] endpoint not answering: $u" >&2
  done
fi

echo "$OUT"
