#!/usr/bin/env bash
# web.sh -- the shared web applications of the playwright tasks, one subcommand each:
#
#   web.sh forum <container-name> <network>               a fresh Postmill forum per run
#   web.sh gitlab <container-name> <network> <data-dir>   a long-lived GitLab
#   web.sh owncloud <container-name> <network>            a long-lived ownCloud
#   web.sh token <gitlab-container>                       a GitLab API token for RB_GITLAB_TOKEN
#
set -uo pipefail

# web.sh forum <container-name> <network>
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
rb_forum() {
  NAME="${1:?usage: web.sh forum <container-name> <network>}"
  NET="${2:?usage: web.sh forum <container-name> <network>}"
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
}

# web.sh gitlab <container-name> <network> <data-dir>
#
# Start a long-lived GitLab (TheAgentCompany's servers-gitlab image) on <network>
# under the hostname rb-gitlab.local, port 8931, with its state in <data-dir>.
# GitLab tasks seed and clean only their own projects through the API, so one
# instance serves many runs (one run at a time per instance). The first boot
# takes several minutes; then create the API token with `web.sh token`.
#
# Env: RB_GITLAB_IMAGE (default ghcr.io/theagentcompany/servers-gitlab:1.0.0).
rb_gitlab() {
  NAME="${1:?usage: web.sh gitlab <container-name> <network> <data-dir>}"
  NET="${2:?usage: web.sh gitlab <container-name> <network> <data-dir>}"
  DATA="${3:?usage: web.sh gitlab <container-name> <network> <data-dir>}"
  IMAGE="${RB_GITLAB_IMAGE:-ghcr.io/theagentcompany/servers-gitlab:1.0.0}"

  mkdir -p "$DATA/data" "$DATA/config" "$DATA/logs"
  DATA="$(cd "$DATA" && pwd)"
  docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
  # The task workspaces name the instance http://rb-gitlab.local:8931; monitoring is off to save memory.
  docker run -d --name "$NAME" --network "$NET" --network-alias rb-gitlab.local \
    -v "$DATA/data:/var/opt/gitlab" -v "$DATA/config:/etc/gitlab" -v "$DATA/logs:/var/log/gitlab" \
    --shm-size 256m \
    -e GITLAB_OMNIBUS_CONFIG="external_url 'http://rb-gitlab.local:8931'
prometheus_monitoring['enable'] = false
alertmanager['enable'] = false
node_exporter['enable'] = false
redis_exporter['enable'] = false
postgres_exporter['enable'] = false
gitlab_exporter['enable'] = false" \
    "$IMAGE" >/dev/null || { echo "[fail] could not start $NAME" >&2; exit 1; }
  echo "[gitlab] $NAME started on $NET as rb-gitlab.local:8931 (data in $DATA)"
}

# web.sh owncloud <container-name> <network>
#
# Start a long-lived ownCloud (TheAgentCompany's servers-owncloud image) on
# <network> under the hostname the-agent-company.com. ownCloud tasks seed and
# clean only their own files, tags and shares through the WebDAV/OCS APIs, so
# one instance serves many runs (one run at a time per instance). The
# container's address is added to the trusted domains, so seeding from the host
# by address is accepted.
#
# Env: RB_OWNCLOUD_IMAGE (default ghcr.io/theagentcompany/servers-owncloud:1.0.0).
rb_owncloud() {
  NAME="${1:?usage: web.sh owncloud <container-name> <network>}"
  NET="${2:?usage: web.sh owncloud <container-name> <network>}"
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
}

# web.sh token <gitlab-container>
#
# Reset the root password to the one the tasks give the agent (theagentcompany)
# and mint an API token for root, printed on stdout. The token the image ships
# with has expired. Export the result as RB_GITLAB_TOKEN.
rb_gitlab_token() {
  NAME="${1:?usage: web.sh token <gitlab-container>}"
  docker exec "$NAME" gitlab-rails runner "
u = User.find_by_username('root')
u.password = 'theagentcompany'; u.password_confirmation = 'theagentcompany'; u.save!
t = u.personal_access_tokens.create!(name: 'regretbench', scopes: ['api'], expires_at: 30.days.from_now)
puts t.token" | tail -1
}

case "${1:-}" in
  forum)    shift; rb_forum "$@" ;;
  gitlab)   shift; rb_gitlab "$@" ;;
  owncloud) shift; rb_owncloud "$@" ;;
  token)    shift; rb_gitlab_token "$@" ;;
  *) echo "usage: web.sh forum|gitlab|owncloud|token ..." >&2; exit 2 ;;
esac
