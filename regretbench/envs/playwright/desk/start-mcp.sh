#!/bin/sh
# Entrypoint of the playwright task images.
#
# 1. Maps the web app's hostname (RB_FS_HOST) to the docker gateway in
#    /etc/hosts. When the harness attaches the container to the task network
#    (RB_TASK_NETWORK), it drops this entry and the name resolves through the
#    network's DNS instead.
# 2. Starts the browser service: supergateway bridges the Playwright MCP
#    server's stdio to streamable HTTP on 8817, with /healthz for the harness to
#    poll. --isolated keeps the browser profile in memory, so no login survives
#    into the next run.
# 3. Runs the command it was given (`sleep infinity`).
set -u
PORT="${RB_MCP_PORT:-8817}"
OUT="${RB_PWMCP_OUT:-/tmp/pwmcp-out}"
FS_HOST="${RB_FS_HOST:-the-agent-company.com}"
mkdir -p "$OUT" /var/log/services

GW="$(awk '$2=="00000000" {gw=$3; for(i=6;i>0;i-=2) printf "%d%s", strtonum("0x" substr(gw,i-1,2)), (i>2?".":""); exit}' /proc/net/route 2>/dev/null)"
[ -n "$GW" ] || GW=172.17.0.1
# Docker writes --add-host entries with a tab, so match any whitespace.
grep -qE "[[:space:]]$FS_HOST\$" /etc/hosts 2>/dev/null || echo "$GW $FS_HOST" >> /etc/hosts

SHELL_BIN="$(ls -d /opt/pw-browsers/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell 2>/dev/null | head -1)"
[ -n "$SHELL_BIN" ] && EXEC_ARG="--executable-path $SHELL_BIN" || EXEC_ARG=""

# Keep page snapshots inline rather than as files that accumulate on disk;
# `browser_snapshot` still answers in full.
EXTRA="${RB_PW_EXTRA:---output-max-size 1024}"

( while :; do
    /opt/pwmcp/node_modules/.bin/supergateway \
      --stdio "env PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node /opt/pwmcp/node_modules/@playwright/mcp/cli.js --isolated --headless --no-sandbox $EXEC_ARG --output-dir $OUT $EXTRA" \
      --outputTransport streamableHttp \
      --stateful \
      --streamableHttpPath /mcp \
      --port "$PORT" \
      --healthEndpoint /healthz \
      --sessionTimeout 3600000 \
      --logLevel none
    sleep 2
  done ) >/var/log/services/browser.log 2>&1 &

exec "$@"
