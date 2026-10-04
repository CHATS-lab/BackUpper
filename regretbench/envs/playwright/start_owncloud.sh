#!/usr/bin/env bash
# start_owncloud.sh <container-name> <network>
#
# Start a long-lived ownCloud (TheAgentCompany's servers-owncloud image) on
# <network> under the hostname the-agent-company.com. ownCloud tasks seed and
# clean only their own files, tags and shares through the WebDAV/OCS APIs, so
# one instance serves many runs (one run at a time per instance). The
# container's address is added to the trusted domains, so seeding from the host
# by address is accepted.
#
# Env: RB_OWNCLOUD_IMAGE (default ghcr.io/theagentcompany/servers-owncloud:1.0.0).
set -uo pipefail
NAME="${1:?usage: start_owncloud.sh <container-name> <network>}"
NET="${2:?usage: start_owncloud.sh <container-name> <network>}"
IMAGE="${RB_OWNCLOUD_IMAGE:-ghcr.io/theagentcompany/servers-owncloud:1.0.0}"

docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
docker run -d --name "$NAME" --network "$NET" --network-alias the-agent-company.com "$IMAGE" >/dev/null \
  || { echo "[fail] could not start $NAME" >&2; exit 1; }
IP="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$NAME")"
for _ in $(seq 1 90); do
  if docker exec -u www-data "$NAME" php /var/www/html/occ config:system:set trusted_domains 99 --value="$IP" >/dev/null 2>&1; then
    echo "[owncloud] $NAME started on $NET as the-agent-company.com (address $IP)"
    exit 0
  fi
  sleep 2
done
echo "[fail] $NAME: occ never answered" >&2
exit 1
