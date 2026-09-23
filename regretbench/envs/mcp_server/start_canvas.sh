#!/usr/bin/env bash
# Canvas LMS MCP server, in RegretBench's transport shape.
#
# CONVERTED FROM Toolathlon:
#   https://github.com/hkust-nlp/Toolathlon/blob/main/configs/mcp_servers/canvas.yaml
# which is a stdio server:
#   command: npx   args: ["-y", "canvas-mcp-server"]
#   env: CANVAS_API_TOKEN, CANVAS_DOMAIN, NODE_TLS_REJECT_UNAUTHORIZED=0
#   client_session_timeout_seconds: 10
#
# Upstream:          https://github.com/DMontgomery40/mcp-canvas-lms
# Toolathlon's fork: https://github.com/lockon-n/mcp-canvas-lms
#
# WHY THIS MATTERS FOR US
# -----------------------
# We previously had no LMS tool surface. `envs/canvas` was DELETED after Li
# rejected a from-scratch REST mock, and `instructure/canvas-lms` is unusable
# here (5.98 GB, built 2019-06-05, Rails 5, ships no database.yml, expects
# docker-compose to supply Postgres and Redis). This server gives us the CLIENT
# half against a real Canvas API. It does NOT give us a Canvas SERVER -- that is
# still outstanding, and Toolathlon carries its own `deployment/canvas` for it.
#
# Until a Canvas server exists, `envs/moodle` remains our working LMS.
#
# TRANSPORT: see the note in start_k8s.sh. RegretBench's gen_mcp_config.sh polls
# /healthz and speaks streamable HTTP at /mcp, so the four flags below are
# required; OpenAgentSafety's scripts take supergateway's SSE default instead.
#
# Ports:  9091 postgres / 9092 playwright / 9093 gitlab (OpenAgentSafety)
#         9094 k8s      / 9095 canvas                   (RegretBench)
set -uo pipefail

PORT="${RB_MCP_PORT:-9095}"

# Toolathlon parameterises these as ${token.canvas_api_token} / ${token.canvas_domain}.
CANVAS_DOMAIN="${CANVAS_DOMAIN:-}"
CANVAS_API_TOKEN="${CANVAS_API_TOKEN:-}"

if [ -z "$CANVAS_DOMAIN" ] || [ -z "$CANVAS_API_TOKEN" ]; then
  echo "[canvas-mcp] FATAL: CANVAS_DOMAIN and CANVAS_API_TOKEN must both be set." >&2
  echo "[canvas-mcp] These are per-instance secrets -- never hard-code them here." >&2
  exit 1
fi

# Upstream sets NODE_TLS_REJECT_UNAUTHORIZED=0 to tolerate a self-signed cert on
# a locally deployed Canvas. Kept, because our instance will be self-signed too,
# but scoped to the child process rather than exported into this shell.
echo "----------------------------------------------------------------"
echo "  Canvas LMS MCP  ->  port $PORT"
echo "----------------------------------------------------------------"
echo "  CANVAS_DOMAIN:   $CANVAS_DOMAIN"
echo "  token:           ${#CANVAS_API_TOKEN} chars (not echoed)"
echo "  transport:       streamableHttp /mcp   health: /healthz"

exec npx -y supergateway \
  --stdio "env CANVAS_API_TOKEN=$CANVAS_API_TOKEN CANVAS_DOMAIN=$CANVAS_DOMAIN NODE_TLS_REJECT_UNAUTHORIZED=0 npx -y canvas-mcp-server" \
  --outputTransport streamableHttp \
  --stateful \
  --streamableHttpPath /mcp \
  --port "$PORT" \
  --healthEndpoint /healthz \
  --sessionTimeout 3600000
