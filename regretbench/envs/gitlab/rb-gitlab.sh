#!/usr/bin/env bash
# OUR OWN GitLab, on the isolated daemon. Never touches the OpenAgentSafety one.
#
# WHY A COPY AT ALL
# -----------------
# The instance on the host daemon (container `gitlab`, compose project `servers`)
# serves http://gitlab.chats-lab.org and is IN ACTIVE USE -- 51 browser sessions
# on 2026-08-13, more on 08-14, plus a live gitlab-runner. Its own reset endpoint
# (`POST :2999/api/reset-gitlab`) is a SILENT NO-OP: the Makefile drives
# `docker compose -p theagentcompany`, but that container is labelled project
# `servers`, so stop/rm match nothing and `up` collides on the container name.
# We therefore never reset theirs, and never destroy against it.
#
# PROMETHEUS IS OFF, DELIBERATELY
# -------------------------------
# Measured on their instance: its 87.4 GB volume is 80.9 GB of Prometheus TSDB
# and only ~8 GB of real data (postgresql 3.4G, git-data 2.6G, gitlab-rails 2.4G).
# Prometheus scrapes nginx/redis/postgres/workhorse/rails/sidekiq -- pure
# self-monitoring, no user data, and nobody reads it. Disabling it is the
# difference between an ~88 GB footprint and a ~9 GB one.
#
# HOW AN AGENT REACHES IT  (full detail: envs/gitlab/REACHABILITY.md)
# -------------------------------------------------------------------
# Agent containers run on the HOST daemon -- they must, because the isolated
# daemons have no container egress and an agent started there cannot reach the
# Claude gateway (api_retry x10, zero tool calls). This instance is on rb2. The
# bridge between them is ONE ufw rule, added 2026-08-14:
#
#   ufw allow in on docker0 from 172.17.0.0/16 to any port 8931 proto tcp
#
# It is needed because the host's INPUT policy is DROP and a container hitting
# the gateway IP is INPUT traffic. Host-daemon published ports (ownCloud's 8092)
# dodge that via docker's nat DNAT rule; rb2 runs --iptables=false, so 8931 has
# no DNAT rule and stayed blocked. The rule is -i docker0 and source-limited, so
# 8931 is still NOT open to the internet. Reset-safe (the port never changes).
#
# Task images should use  http://rb-gitlab.local:8931  and write the bridge
# gateway into /etc/hosts (`-e RB_FS_HOST=rb-gitlab.local` on the ocdesk base
# image does exactly this). http://172.17.0.1:8931 works too.
#
# CREDENTIALS: root / theagentcompany. The seeded glpat-OPENHANDS_EVAL_TOKEN_01
# returns 401 -- the image's only PAT expired 2025-11-18. A working PAT and the
# re-mint recipe (needed after every `reset`) are in REACHABILITY.md.
#
# RESET MODEL
# -----------
# `rb-gitlab.sh reset` = stop + rm the container + rm ITS named volume by exact
# name, then start clean from the image (which carries the seed data baked in at
# build time). This works where theirs does not, because we own the names.
# Li's cadence: run tasks one at a time, reset roughly every 5 runs, and keep the
# 5 tasks inside a window on DISJOINT state -- otherwise task N's destruction
# falsifies task N+1's premise.
set -uo pipefail

# The GitLab service container lives on whatever daemon the caller is using.
# Set DOCKER_HOST yourself if that is not the default one.
IMAGE=ghcr.io/theagentcompany/servers-gitlab:1.0.0
NAME=rb-gitlab
VOL=rb-gitlab-data
PORT="${RB_GITLAB_PORT:-8931}"     # theirs holds 8929/8930; do not collide

start() {
  if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
    docker start "$NAME" >/dev/null && echo "[rb-gitlab] started existing container"
  else
    docker volume create "$VOL" >/dev/null
    docker run -d --name "$NAME" \
      --hostname rb-gitlab.local \
      -e GITLAB_OMNIBUS_CONFIG="external_url 'http://localhost:$PORT'
prometheus_monitoring['enable'] = false
alertmanager['enable'] = false
node_exporter['enable'] = false
redis_exporter['enable'] = false
postgres_exporter['enable'] = false
gitlab_exporter['enable'] = false" \
      `# NO grafana['enable'] -- GitLab 17.5.1 dropped the bundled Grafana, and an` \
      `# unknown omnibus key is FATAL, not ignored: the whole cinc config phase` \
      `# aborts with Mixlib::Config::UnknownConfigOptionError and the container` \
      `# exits 1. Verified here 2026-08-14. Do not "helpfully" add it back.` \
      -p "$PORT:$PORT" \
      -v "$VOL:/var/opt/gitlab" \
      --shm-size 256m \
      "$IMAGE" >/dev/null
    echo "[rb-gitlab] created. GitLab needs ~5 min before it answers."
  fi
  echo "[rb-gitlab] url: http://localhost:$PORT"
}

stop() { docker stop "$NAME" >/dev/null 2>&1; echo "[rb-gitlab] stopped"; }

# Full reset: container AND its data volume, both by EXACT NAME.
# Never `docker volume prune`, never a filter, never `-v` on someone else's rm.
reset() {
  docker stop "$NAME" >/dev/null 2>&1
  docker rm "$NAME"   >/dev/null 2>&1
  docker volume rm "$VOL" >/dev/null 2>&1 && echo "[rb-gitlab] removed volume $VOL"
  start
}

status() {
  docker ps -a --filter "name=^${NAME}$" --format '{{.Names}}\t{{.Status}}'
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://localhost:$PORT/help" 2>/dev/null)
  echo "[rb-gitlab] GET /help -> ${code:-no answer}"
  df -h "$(dirname "$0")" | tail -1
}

case "${1:-status}" in
  start) start ;; stop) stop ;; reset) reset ;; status) status ;;
  *) echo "usage: $0 start|stop|reset|status"; exit 2 ;;
esac
