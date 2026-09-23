#!/bin/sh
# Entrypoint for every tasks-v6 ownCloud task image.
#
# 1. Points the desk's own hostname at the file server. The instance answers on
#    the ops network under the name its trusted-domain list carries; inside a
#    container that name has to be in /etc/hosts, exactly as an internal
#    resolver would supply it on a workstation.
# 2. Starts the browser service: supergateway bridges the Playwright MCP
#    server's stdio to streamable HTTP on 8817, with /healthz for
#    gen_mcp_config.sh to poll (opening /mcp would consume a session).
#    --isolated keeps the browser profile in memory, so no cookie and no login
#    survives into the next run.
# 3. Runs whatever command it was given (the harness passes `sleep infinity`).
set -u
PORT="${RB_MCP_PORT:-8817}"
OUT="${RB_PWMCP_OUT:-/tmp/pwmcp-out}"
FS_HOST="${RB_FS_HOST:-the-agent-company.com}"
mkdir -p "$OUT" /var/log/services

GW="$(awk '$2=="00000000" {gw=$3; for(i=6;i>0;i-=2) printf "%d%s", strtonum("0x" substr(gw,i-1,2)), (i>2?".":""); exit}' /proc/net/route 2>/dev/null)"
[ -n "$GW" ] || GW=172.17.0.1
# The guard used to be `grep -q " $FS_HOST\$"` -- a literal SPACE. Docker writes
# --add-host entries with a TAB, so the guard missed them and this line appended a
# second, dead mapping on top of a correct one. Whether the run worked then came
# down to which glibc returned first. Match either separator, and skip if the host
# already resolves at all.
grep -qE "[[:space:]]$FS_HOST\$" /etc/hosts 2>/dev/null || echo "$GW $FS_HOST" >> /etc/hosts

SHELL_BIN="$(ls -d /opt/pw-browsers/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell 2>/dev/null | head -1)"
[ -n "$SHELL_BIN" ] && EXEC_ARG="--executable-path $SHELL_BIN" || EXEC_ARG=""

# Cap snapshot residue. The server attaches an implicit page snapshot to every
# action result, and with an output directory those land on disk as .yml files
# that accumulate for the life of the container. The threshold evicts them
# immediately; `browser_snapshot` still answers inline, so no capability is
# removed -- only the disk residue is.
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
