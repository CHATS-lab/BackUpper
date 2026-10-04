#!/bin/bash
# Container entrypoint. Runs as `agent`, raises privilege exactly once through
# the scoped sudoers rule to start the database and the MCP bridge, then drops
# straight back and execs the command it was given as `agent`.
set -u
sudo -n /usr/local/lib/rb/services.sh || echo "[start] services.sh failed" >&2
exec "$@"
