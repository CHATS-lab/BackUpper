#!/usr/bin/env bash
# reset.sh — put a k8s task box back to its as-built state, and BLOCK until it
# is actually usable (cluster Ready, seeder finished, MCP answering tools/list).
#
#   ./reset.sh <container-name> <image> [extra docker run args...]
#
# WHY IT IS A RECREATE AND NOT AN IN-PLACE RESEED (measured 2026-08-26):
#
#  * `docker restart` is NOT a reset and looks like one. /run is tmpfs so the
#    one-shot boot marker clears and start.sh boots the cluster again, but
#    /var/lib/rbenv/.seeded is on the container filesystem, so the seeder is
#    skipped and EVERY object and every byte the previous run left behind is
#    still there. Measured: a namespace created through MCP before the restart
#    was still present after it.
#  * An in-place reseed would need a pristine copy of /opt/seed to survive
#    inside the container. That copy would be reachable BY THE AGENT:
#    `kubectl_generic {"command":"cp"}` is executed by the MCP server, which
#    runs as root (RECOVERABILITY.md 1.3), so any root-only path on the node
#    can be read out through a pod. A stashed seed is a one-call undo of the
#    whole task. So there is deliberately no pristine seed in the image.
#  * A recreate is total. The image is immutable and this environment uses no
#    docker volumes and no bind mounts, so a container carries 100% of the
#    mutable state and removing it removes 100% of it. Graded values are minted
#    at BUILD time, so a fresh container from the same image has byte-identical
#    graded values and the task's manifest/ stays valid.
#
# Only the container named on the command line is ever removed. No prune, no
# filters, no wildcards, no -v.
set -uo pipefail
NAME=${1:?usage: reset.sh <container-name> <image> [docker run args...]}
IMAGE=${2:?usage: reset.sh <container-name> <image> [docker run args...]}
shift 2
# Deliberately no DOCKER_HOST default: the caller's daemon is the right one.
# Forcing the isolated socket here made assert_trap.sh look for an image that
# had been built on the host daemon and report "pull access denied".
BUDGET=${K8SENV_RESET_TIMEOUT:-420}

case "$NAME" in
  rb-forum|rbq|gitlab|plane|owncloud|rocketchat|rbf-*|rbm-*)
    echo "reset.sh: refusing to touch '$NAME' -- not ours" >&2; exit 2 ;;
esac

docker rm -f "$NAME" >/dev/null 2>&1
docker run -d --name "$NAME" --privileged --tmpfs /run "$@" "$IMAGE" >/dev/null || {
  echo "reset.sh: docker run failed" >&2; exit 1; }

S=$(date +%s)

# Do not `docker exec` into the container until start.sh has finished its
# cgroup v2 evacuation (measured 2026-09-19, host load 9 on 4 cores): an exec
# is placed in PID 1's *current* cgroup, so an exec that lands while PID 1 is
# still in the container's root cgroup -- and after start.sh has read
# cgroup.procs -- sits in the root during the `+controller` writes, every one
# of which then fails with EBUSY and is swallowed by start.sh's `|| true`.
# 15s later the kubelet dies with "cgroup [kubepods] has some missing
# controllers: cpu, cpuset, hugetlb, memory, pids". start.sh is baked into the
# pinned cluster image, so the fix lives here: wait until PID 1 has moved out
# of the root cgroup (its /proc cgroup path gains a component after the
# container's scope), after which any exec lands in that sub-cgroup instead.
# Visible only when the daemon shares this host's pid namespace (the host
# daemon and rb-dockerd.sh both do); otherwise fall back to a short delay.
CPID=$(docker inspect -f '{{.State.Pid}}' "$NAME" 2>/dev/null)
CID=$(docker inspect -f '{{.Id}}' "$NAME" 2>/dev/null)
if [ -n "$CPID" ] && [ -n "$CID" ] && [ -r "/proc/$CPID/cgroup" ]; then
  # The container's own cgroup is the path component that carries its id
  # (systemd driver: .../docker-<id>.scope, cgroupfs driver: /docker/<id>).
  # "Moved" means there is a further component after it. The reference is
  # taken from the id, not from the first observation: under load PID 1 has
  # often moved before `docker inspect` even returns.
  CUR=
  while [ $(( $(date +%s) - S )) -lt 60 ]; do
    CUR=$(cut -d: -f3 "/proc/$CPID/cgroup" 2>/dev/null) || break
    case "$CUR" in *"$CID"*/*) break ;; esac
    sleep 0.2
  done
  case "$CUR" in *"$CID"*/*) ;; *)
    [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" = "true" ] \
      && echo "reset.sh: warning: PID 1 of $NAME still in its root cgroup after 60s ($CUR)" >&2 ;; esac
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
    echo "reset.sh: container exited during boot -- last log lines:" >&2
    docker logs --tail 40 "$NAME" >&2; exit 1
  fi
  sleep 3
done
[ -n "$ready" ] || { echo "reset.sh: not ready inside ${BUDGET}s" >&2
                     docker logs --tail 40 "$NAME" >&2; exit 1; }

# Prove the surface answers, not just that the health endpoint is up: a tool
# name that is not one of the server's own kills the child silently and
# /healthz still returns 200 (README, "that cost an hour here").
docker cp "$(dirname "$0")/mcpcall.py" "$NAME":/tmp/rb-mcpcall.py >/dev/null 2>&1
N=$(docker exec "$NAME" sh -c 'python3 /tmp/rb-mcpcall.py http://127.0.0.1:${K8SENV_MCP_PORT:-8815}/mcp --tools 2>/dev/null | grep -c .')
docker exec -u 0 "$NAME" rm -f /tmp/rb-mcpcall.py 2>/dev/null
[ "${N:-0}" -ge 15 ] || { echo "reset.sh: MCP answered with only ${N:-0} tools -- NOT usable" >&2; exit 1; }

echo "reset.sh: $NAME ready in $(( $(date +%s) - S ))s from $IMAGE (tools=$N)"
