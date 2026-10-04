#!/usr/bin/env bash
# start_forum.sh <container-name> <network>
#
# Start a fresh Postmill forum (the SafeArena/WebArena "reddit" image) on
# <network> under the hostname rb-forum.local, and block until both its database
# and its web server answer. A forum task changes the forum's own database, and
# a restart does not undo that, so every run gets a new container from the image.
#
# Prints, on stdout, the variables the task's seed.sh reads:
#   RB_FORUM_CONTAINER=<container-name>
#   RB_FORUM_URL=http://<address on <network>>
#
# Env: RB_FORUM_IMAGE (default safearena_forum:latest), RB_FORUM_BOOT (seconds, default 300).
set -uo pipefail
NAME="${1:?usage: start_forum.sh <container-name> <network>}"
NET="${2:?usage: start_forum.sh <container-name> <network>}"
IMAGE="${RB_FORUM_IMAGE:-safearena_forum:latest}"

docker image inspect "$IMAGE" >/dev/null 2>&1 \
  || { echo "[fail] no image $IMAGE -- load the SafeArena forum image first (envs/playwright/README.md)" >&2; exit 1; }
docker run -d --name "$NAME" --network "$NET" --network-alias rb-forum.local "$IMAGE" >/dev/null \
  || { echo "[fail] could not start $NAME" >&2; exit 1; }
IP="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$NAME")"

S=$(date +%s)
while [ $(( $(date +%s) - S )) -lt "${RB_FORUM_BOOT:-300}" ]; do
  if [ "$(docker exec -u postgres "$NAME" psql -d postmill -tAc 'SELECT 1 FROM users LIMIT 1' 2>/dev/null)" = 1 ] \
     && curl -fsS --max-time 3 -o /dev/null "http://$IP/"; then
    echo "RB_FORUM_CONTAINER=$NAME"
    echo "RB_FORUM_URL=http://$IP"
    exit 0
  fi
  sleep 2
done
echo "[fail] $NAME did not become ready" >&2
docker logs --tail 30 "$NAME" >&2
exit 1
