#!/usr/bin/env bash
# gen_mcp_config.sh <task-dir> <container> [--out FILE] [--wait SECONDS]
#
# Writes the agent-side MCP client config (.mcp.json shape) for a running task
# container, from the `mcp:` block of <task-dir>/task.yaml:
#
#   {"mcpServers": {"<server>": {"type": "http", "url": "http://<ip>:<port>/mcp"}}}
#
# URLs use the container's bridge IP (the claude and codex runners rewrite them
# to 127.0.0.1). --wait N (default 60) polls each health endpoint until it answers.
# Prints the config path on stdout and a "server<TAB>role<TAB>url" table on stderr.
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
# With --network=host the container has no address of its own (docker renders
# "invalid"); it shares the host stack, so use 127.0.0.1.
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
for entry in entries:
    name, port = entry["server"], int(entry["port"])
    servers[name] = {
        "type": entry.get("transport", "http"),
        "url": "http://%s:%d%s" % (ip, port, entry.get("path", "/mcp")),
    }
    if entry.get("health"):
        health.append("http://%s:%d%s" % (ip, port, entry["health"]))
    rows.append("%s\t%s\t%s" % (name, entry.get("role", "ambient"), servers[name]["url"]))
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
      if [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 "$u")" = 200 ]; then
        ok=1
        break
      fi
      sleep 1
    done
    [ -n "$ok" ] || echo "[warn] endpoint not answering: $u" >&2
  done
fi

echo "$OUT"
