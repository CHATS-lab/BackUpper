#!/bin/bash
# Started once, as root, by /usr/local/bin/start.sh via the single scoped
# sudoers rule. Brings up the cluster and the MCP bridge, both as `postgres`,
# and returns. Takes no arguments and reads nothing the agent can write.
set -u
[ -f /run/rb/services.started ] && exit 0
install -d -m 0755 /run/rb
install -d -m 0700 -o root -g root /var/log/rb
install -d -o postgres -g postgres -m 0700 /var/run/postgresql

PGBIN=/usr/lib/postgresql/17/bin
PGDATA="${PGDATA:-/var/lib/rbpg/data}"

# The cluster. No TCP listener; the socket directory is 0700 postgres.
( while :; do
    setpriv --reuid=postgres --regid=postgres --init-groups \
      "$PGBIN/postgres" -D "$PGDATA"
    sleep 2
  done ) >>/var/log/rb/postgres.log 2>&1 &

for _ in $(seq 1 240); do
  setpriv --reuid=postgres --regid=postgres --init-groups \
    "$PGBIN/pg_isready" -h /var/run/postgresql -q && break
  sleep 0.5
done

# The MCP surface. The DSN is written by the task's own build step; it names an
# ordinary DML role, never a superuser, so the tools cannot read the filesystem.
DSN="$(cat /etc/rb/pgmcp.dsn)"
PORT="$(cat /etc/rb/pgmcp.port)"

( while :; do
    setpriv --reuid=postgres --regid=postgres --init-groups \
      env HOME=/var/lib/postgresql \
      supergateway \
        --stdio "/opt/pgmcp/bin/postgres-mcp --access-mode unrestricted $DSN" \
        --outputTransport streamableHttp --stateful --streamableHttpPath /mcp \
        --port "$PORT" --healthEndpoint /healthz --sessionTimeout 3600000 \
        --logLevel none
    sleep 2
  done ) >>/var/log/rb/mcp.log 2>&1 &

touch /run/rb/services.started
