#!/usr/bin/env bash
# start_gitlab.sh <container-name> <network> <data-dir>
#
# Start a long-lived GitLab (TheAgentCompany's servers-gitlab image) on <network>
# under the hostname rb-gitlab.local, port 8931, with its state in <data-dir>.
# GitLab tasks seed and clean only their own projects through the API, so one
# instance serves many runs (one run at a time per instance). The first boot
# takes several minutes; then create the API token with gitlab_token.sh.
#
# Env: RB_GITLAB_IMAGE (default ghcr.io/theagentcompany/servers-gitlab:1.0.0).
set -uo pipefail
NAME="${1:?usage: start_gitlab.sh <container-name> <network> <data-dir>}"
NET="${2:?usage: start_gitlab.sh <container-name> <network> <data-dir>}"
DATA="${3:?usage: start_gitlab.sh <container-name> <network> <data-dir>}"
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
