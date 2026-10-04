#!/usr/bin/env bash
##############################################################################
# start_envs.sh
# Builds the base images the task images derive from, and starts the
# long-lived web applications (GitLab, ownCloud) that playwright tasks share.
#
#   bash regretbench/start_envs.sh images [DOMAIN...]   build base images
#   bash regretbench/start_envs.sh web                  start GitLab + ownCloud
#   bash regretbench/start_envs.sh all                  both
#
# Per-run environments (a fresh forum, mail server or cluster for each run)
# are started by run_regretbench.sh, not here.
##############################################################################
set -uo pipefail
RB="$(cd "$(dirname "$0")" && pwd)"
ENVS="$RB/envs"

# Base image tag -> build context. The tags are the ones the task Dockerfiles name.
base_images() {
  case "$1" in
    postgres)   echo "regretbench/pgbase:latest $ENVS/postgres" ;;
    playwright) echo "regretbench/v6-ocdesk:base $ENVS/playwright/desk" ;;
    email)      echo "regretbench/v9-maildesk:base $ENVS/email/maildesk" ;;
    k8s)        echo "regretbench/env-k8s:base $ENVS/k8s" ;;
    terminal)   ;;
    *) echo "unknown domain: $1" >&2; return 1 ;;
  esac
}

build_images() {
  local domains=("$@") d tag ctx
  [ ${#domains[@]} -gt 0 ] || domains=(postgres playwright email k8s)
  for d in "${domains[@]}"; do
    read -r tag ctx <<<"$(base_images "$d")" || exit 1
    [ -n "${tag:-}" ] || continue
    if docker image inspect "$tag" >/dev/null 2>&1; then
      echo "✓ $tag already built"
    else
      echo "Building $tag ..."
      docker build -t "$tag" "$ctx" || { echo "Error: building $tag failed"; exit 1; }
    fi
  done
}

start_web() {
  local net="${RB_WEB_NET:-regretbench-web}"
  local gl="${RB_GITLAB_CONTAINER:-rb-gitlab}" oc="${RB_OWNCLOUD_CONTAINER:-rb-owncloud}"
  docker network inspect "$net" >/dev/null 2>&1 || docker network create "$net" >/dev/null
  if docker inspect "$gl" >/dev/null 2>&1; then
    echo "✓ $gl already running"
  else
    bash "$ENVS/playwright/start_gitlab.sh" "$gl" "$net" "${RB_GITLAB_DATA:-$HOME/.regretbench/gitlab}" || exit 1
  fi
  if docker inspect "$oc" >/dev/null 2>&1; then
    echo "✓ $oc already running"
  else
    bash "$ENVS/playwright/start_owncloud.sh" "$oc" "$net" || exit 1
  fi
  echo
  echo "GitLab needs several minutes for its first boot. Then:"
  echo "  export RB_GITLAB_TOKEN=\$(bash $ENVS/playwright/gitlab_token.sh $gl)"
}

case "${1:-all}" in
  images) shift; build_images "$@" ;;
  web)    start_web ;;
  all)    build_images; start_web ;;
  -h|--help) sed -n '2,13p' "$0" ;;
  *) echo "usage: start_envs.sh images [DOMAIN...] | web | all" >&2; exit 2 ;;
esac
