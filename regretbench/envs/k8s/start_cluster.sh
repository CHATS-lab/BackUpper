#!/usr/bin/env bash
# start_cluster.sh -- start a task's cluster container and block until it is
# usable: node Ready, first-boot seed done, MCP answering tools/list.
#
#   ./start_cluster.sh <container-name> <cluster-image> [extra docker run args...]
#
# A reset is always a fresh container: `docker restart` reboots k3s but keeps
# every object of the previous run, and the image deliberately holds no pristine
# copy of the seed (the agent could read it out through the MCP server, which
# runs as root). Graded values are minted at image build time, so a fresh
# container from the same image starts from the same state.
#
# Only the container named on the command line is ever removed.
set -uo pipefail
NAME=${1:?usage: reset.sh <container-name> <image> [docker run args...]}
IMAGE=${2:?usage: reset.sh <container-name> <image> [docker run args...]}
shift 2
BUDGET=${K8SENV_RESET_TIMEOUT:-420}

docker rm -f "$NAME" >/dev/null 2>&1
docker run -d --name "$NAME" --privileged --tmpfs /run "$@" "$IMAGE" >/dev/null || {
  echo "start_cluster.sh: docker run failed" >&2; exit 1; }

S=$(date +%s)

# Wait until start.sh has moved PID 1 out of the container's root cgroup before
# the first `docker exec`: an exec placed in the root cgroup during the
# controller delegation makes every `+controller` write fail with EBUSY, and the
# kubelet then dies on missing controllers. Visible only when the daemon shares
# this host's pid namespace; otherwise fall back to a short delay.
CPID=$(docker inspect -f '{{.State.Pid}}' "$NAME" 2>/dev/null)
CID=$(docker inspect -f '{{.Id}}' "$NAME" 2>/dev/null)
if [ -n "$CPID" ] && [ -n "$CID" ] && [ -r "/proc/$CPID/cgroup" ]; then
  # The container's cgroup is the path component carrying its id; "moved" means
  # there is a further component after it.
  CUR=
  while [ $(( $(date +%s) - S )) -lt 60 ]; do
    CUR=$(cut -d: -f3 "/proc/$CPID/cgroup" 2>/dev/null) || break
    case "$CUR" in *"$CID"*/*) break ;; esac
    sleep 0.2
  done
  case "$CUR" in *"$CID"*/*) ;; *)
    [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" = "true" ] \
      && echo "start_cluster.sh: warning: PID 1 of $NAME still in its root cgroup after 60s ($CUR)" >&2 ;; esac
else
  sleep 5
fi

ready=
while [ $(( $(date +%s) - S )) -lt "$BUDGET" ]; do
  if docker exec "$NAME" sh -c 'curl -sf -m2 http://127.0.0.1:${K8SENV_MCP_PORT:-8815}/healthz' >/dev/null 2>&1 \
     && docker exec -u 0 "$NAME" test -e /var/lib/rbenv/.seeded 2>/dev/null; then
    ready=1; break
  fi
  # start.sh exits non-zero on a failed boot or a failed seed; do not spin on a corpse.
  if [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" != "true" ]; then
    echo "start_cluster.sh: container exited during boot -- last log lines:" >&2
    docker logs --tail 40 "$NAME" >&2; exit 1
  fi
  sleep 3
done
[ -n "$ready" ] || { echo "start_cluster.sh: not ready inside ${BUDGET}s" >&2
                     docker logs --tail 40 "$NAME" >&2; exit 1; }

# Require a real tools/list: a bad name in ALLOWED_TOOLS kills the server child
# while /healthz still answers 200.
docker cp "$(dirname "$0")/mcpcall.py" "$NAME":/tmp/rb-mcpcall.py >/dev/null 2>&1
N=$(docker exec "$NAME" sh -c 'python3 /tmp/rb-mcpcall.py http://127.0.0.1:${K8SENV_MCP_PORT:-8815}/mcp --tools 2>/dev/null | grep -c .')
docker exec -u 0 "$NAME" rm -f /tmp/rb-mcpcall.py 2>/dev/null
[ "${N:-0}" -ge 15 ] || { echo "start_cluster.sh: MCP answered with only ${N:-0} tools -- NOT usable" >&2; exit 1; }

echo "start_cluster.sh: $NAME ready in $(( $(date +%s) - S ))s from $IMAGE (tools=$N)"
