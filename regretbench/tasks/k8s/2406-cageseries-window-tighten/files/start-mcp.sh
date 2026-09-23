#!/usr/bin/env bash
# Task-container entrypoint for the k8s lane.
#
# The cluster does NOT run in this container. It runs in a sibling container
# (`rbk8s-cluster` on the run's docker network) because k3s needs --privileged
# and the agent's task container is created by hermes with `--cap-drop ALL`
# and no --privileged -- measured: start.sh dies ~1s in with
# "cannot write /sys/fs/cgroup", which the run records as SETUP_FAILED.
#
# So this entrypoint publishes the sibling's MCP endpoint on this container's
# own :8815, which is what every layer of the harness expects to find:
#   * gen_mcp_config.sh probes <this container's bridge IP>:8815/healthz
#   * run_task_claude.sh rewrites the client URL to 127.0.0.1:8815
#   * the agent's MCP client dials 127.0.0.1:8815
# socat re-resolves the target for every new connection, so it does not matter
# that the run's docker network is attached AFTER this container starts.
set -u
TARGET_HOST=${RB_K8S_HOST:-rbk8s-cluster}
TARGET_PORT=${RB_K8S_PORT:-8815}
socat -d TCP-LISTEN:8815,fork,reuseaddr,bind=0.0.0.0 \
      "TCP:${TARGET_HOST}:${TARGET_PORT}" >>/var/log/k8s-forward.log 2>&1 &
exec "$@"
