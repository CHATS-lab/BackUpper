#!/bin/sh
# Put the instance's name in /etc/hosts, then hand over to the base image's
# entrypoint, which starts the browser service and runs the given command.
#
# The instance publishes on the host loopback only and the host firewall drops
# INPUT, so the docker gateway is not a route to it from here; its address on
# the bridge is. RB_FORUM_ADDR is set at build time and can be overridden.
set -u
ADDR="${RB_FORUM_ADDR:-172.17.0.2}"
grep -qE "[[:space:]]rb-forum\.local\$" /etc/hosts 2>/dev/null || \
  echo "$ADDR rb-forum.local" >> /etc/hosts
exec /usr/local/bin/start-mcp.sh "$@"
