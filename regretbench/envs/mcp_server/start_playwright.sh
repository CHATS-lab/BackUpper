#!/usr/bin/env bash
# Playwright MCP server, in RegretBench's transport shape.
#
# CONVERTED FROM OpenAgentSafety's evaluation/mcp_server/start_playwright.sh,
# which takes supergateway's SSE default and points PLAYWRIGHT_BROWSERS_PATH at
# /root/.cache/ms-playwright. Both are changed here:
#
#   * transport -- gen_mcp_config.sh polls /healthz and speaks streamable HTTP
#     at /mcp, so the four transport flags below are required.
#   * browsers  -- a Chromium download is ~650 MB, so the browsers live on a
#     data volume (RB_PWMCP_BROWSERS), never in /root/.cache.
#
# The package is the one installed for RegretBench, from regretbench/mcpdeps:
#   node_modules/@playwright/mcp   (0.0.79)
#   playwright-core 1.63.0-alpha-2026-08-05  ->  chromium build 1237
#
# Ports:  9091 postgres / 9092 playwright / 9093 gitlab (OpenAgentSafety)
#         9094 k8s      / 9095 canvas                   (RegretBench)
#         9096 playwright (RegretBench's own instance -- 9092 is occupied by
#               OpenAgentSafety's, which runs a different package and a
#               different browser build; do not kill it)
#
# --isolated  : every session gets a fresh browser profile, so no cookie or
#               login survives between runs. This matters for task isolation:
#               the agent must log in to the target itself.
# --no-sandbox: required, this runs as root.
set -uo pipefail

PORT="${RB_MCP_PORT:-9096}"
_ENVS="$(cd "$(dirname "$0")/.." && pwd)"          # regretbench/envs
BROWSERS="${PLAYWRIGHT_BROWSERS_PATH:-$_ENVS/owncloud/buildctx/pw-browsers}"
MCPDIR="${RB_PWMCP_DIR:-$(cd "$_ENVS/.." && pwd)/mcpdeps}"
CLI="$MCPDIR/node_modules/@playwright/mcp/cli.js"
SG="$MCPDIR/node_modules/.bin/supergateway"
NODE="${RB_NODE:-$(command -v node)}"
OUTDIR="${RB_PWMCP_OUT:-${TMPDIR:-/tmp}/rb-playwright-out}"

[ -f "$CLI" ] || { echo "[playwright-mcp] FATAL: no cli.js at $CLI" >&2; exit 1; }
[ -x "$SG" ]  || { echo "[playwright-mcp] FATAL: no supergateway at $SG" >&2; exit 1; }
[ -d "$BROWSERS" ] || { echo "[playwright-mcp] FATAL: no browsers at $BROWSERS" >&2
  echo "  install with: cd $MCPDIR && PLAYWRIGHT_BROWSERS_PATH=$BROWSERS ./node_modules/.bin/playwright install chromium" >&2
  exit 1; }
mkdir -p "$OUTDIR"

echo "----------------------------------------------------------------"
echo "  Playwright MCP  ->  port $PORT"
echo "----------------------------------------------------------------"
echo "  package:    $CLI"
echo "  browsers:   $BROWSERS"
echo "  output dir: $OUTDIR"
echo "  transport:  streamableHttp /mcp   health: /healthz"

exec "$SG" \
  --stdio "env PLAYWRIGHT_BROWSERS_PATH=$BROWSERS $NODE $CLI --isolated --headless --no-sandbox --output-dir $OUTDIR" \
  --outputTransport streamableHttp \
  --stateful \
  --streamableHttpPath /mcp \
  --port "$PORT" \
  --healthEndpoint /healthz \
  --sessionTimeout 3600000
