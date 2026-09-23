#!/usr/bin/env bash
# Kubernetes MCP server, in RegretBench's transport shape.
#
# CONVERTED FROM Toolathlon:
#   https://github.com/hkust-nlp/Toolathlon/blob/main/configs/mcp_servers/k8s.yaml
# which is a stdio server:
#   command: npx   args: ["-y", "mcp-server-kubernetes"]
#   env: KUBECONFIG_PATH   client_session_timeout_seconds: 600
#
# Upstream:            https://github.com/Flux159/mcp-server-kubernetes
# Toolathlon's fork:   https://github.com/lockon-n/mcp-server-kubernetes
# npm (verified 2026-08-14): mcp-server-kubernetes@4.1.4
#
# WHY THIS IS NOT A COPY OF OpenAgentSafety's start_*.sh
# ------------------------------------------------------
# OpenAgentSafety's scripts (evaluation/mcp_server/start_{postgres,playwright,
# gitlab}.sh) run `npx -y supergateway --port $PORT --stdio "..."` and take
# supergateway's DEFAULT output transport (SSE). RegretBench's harness does not:
# `gen_mcp_config.sh` resolves the container's bridge IP, polls **/healthz**
# (deliberately NOT /mcp -- opening that consumes a session) and writes a client
# config for **streamable HTTP** at /mcp. So every RegretBench MCP server must be
# launched with the four flags below or the harness cannot health-check it.
#
# Ports are allocated to continue OpenAgentSafety's block, so the two sets can
# run side by side without collision:
#   9091 postgres (theirs)   9092 playwright (theirs)   9093 gitlab (theirs)
#   9094 k8s      (ours)     9095 canvas     (ours)
set -uo pipefail

PORT="${RB_MCP_PORT:-9094}"

# Toolathlon parameterises this as ${token.kubeconfig_path}. Ours is explicit:
# point it at the kubeconfig for the k3s environment under envs/k8s.
KUBECONFIG_PATH="${KUBECONFIG_PATH:-/opt/rbcc/k8s/kubeconfig.yaml}"

if [ ! -r "$KUBECONFIG_PATH" ]; then
  echo "[k8s-mcp] FATAL: kubeconfig not readable at $KUBECONFIG_PATH" >&2
  echo "[k8s-mcp] set KUBECONFIG_PATH, or start the k3s env first." >&2
  exit 1
fi

echo "----------------------------------------------------------------"
echo "  Kubernetes MCP  ->  port $PORT"
echo "----------------------------------------------------------------"
echo "  KUBECONFIG_PATH: $KUBECONFIG_PATH"
echo "  transport:       streamableHttp /mcp   health: /healthz"

exec npx -y supergateway \
  --stdio "env KUBECONFIG_PATH=$KUBECONFIG_PATH npx -y mcp-server-kubernetes" \
  --outputTransport streamableHttp \
  --stateful \
  --streamableHttpPath /mcp \
  --port "$PORT" \
  --healthEndpoint /healthz \
  --sessionTimeout 3600000
