#!/bin/bash
# reset-mail.sh — restore the rbm-poste mail server to a snapshot (byte-exact maildir restore).
#
#   ./reset-mail.sh                        restore from snapshots/base.tgz
#   ./reset-mail.sh <snapshot.tgz>         restore from a specific snapshot
#   ./reset-mail.sh --snapshot <out.tgz>   capture a new snapshot instead of restoring
#
# Restores every mailbox on the server: message bytes, UIDs, INTERNALDATE, flags,
# folder structure and attachments. Takes ~25s. Exits non-zero if IMAP does not
# come back up.
set -euo pipefail
CONTAINER=rbm-poste
SNAPDIR="${RB_MAIL_SNAPSHOTS:-$(cd "$(dirname "$0")" && pwd)/snapshots}"

reapply_plaintext_config() {
  # poste.io ships TLS-required defaults; a container restart resets these files.
  docker exec "$CONTAINER" sed -i 's/ssl = required/ssl = yes/' /etc/dovecot/conf.d/10-ssl.conf
  docker exec "$CONTAINER" sed -i 's/auth_allow_cleartext = no/auth_allow_cleartext = yes/' /etc/dovecot/conf.d/10-auth.conf
  docker exec "$CONTAINER" sed -i '/disable_plaintext_auth/d' /etc/dovecot/conf.d/10-auth.conf
  docker exec "$CONTAINER" sed -i 's/tls_required = true/tls_required = false/' /opt/haraka-smtp/config/auth.ini
  docker exec "$CONTAINER" sed -i 's/tls_required = true/tls_required = false/' /opt/haraka-submission/config/auth.ini
  docker exec "$CONTAINER" sed -i 's|^auth/poste|#auth/poste|' /opt/haraka-submission/config/plugins
  docker exec "$CONTAINER" sh -c 'printf "127.0.0.1/8\n192.168.0.0/16\n172.16.0.0/12\n10.0.0.0/8\n" > /opt/haraka-submission/config/relay_acl_allow'
  # restart via s6, never pgrep/kill: a "haraka.*smtp" pattern matches the shell running it
  docker exec "$CONTAINER" s6-svc -t /var/run/s6/services/dovecot
  docker exec "$CONTAINER" s6-svc -t /var/run/s6/services/haraka-smtp
  docker exec "$CONTAINER" s6-svc -t /var/run/s6/services/haraka-submission
}

wait_for_imap() {
  # probe from the client container: poste's /bin/sh is dash and has no /dev/tcp
  for i in $(seq 1 60); do
    if docker exec rbm-client python -c "
import socket,sys
try:
    s=socket.create_connection(('127.0.0.1',1143),2); b=s.recv(64); s.close()
    sys.exit(0 if b'OK' in b else 1)
except Exception: sys.exit(1)
" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  echo "ERROR: IMAP did not come back up" >&2
  return 1
}

if [ "${1:-}" = "--snapshot" ]; then
  OUT="${2:-$SNAPDIR/base.tgz}"
  mkdir -p "$(dirname "$OUT")"
  docker exec "$CONTAINER" sh -c 'cd /data && tar czf /tmp/_snap.tgz domains'
  docker cp "$CONTAINER":/tmp/_snap.tgz "$OUT" >/dev/null
  docker exec "$CONTAINER" rm -f /tmp/_snap.tgz
  echo "snapshot written: $OUT ($(du -h "$OUT" | cut -f1))"
  exit 0
fi

SNAP="${1:-$SNAPDIR/base.tgz}"
[ -f "$SNAP" ] || { echo "no snapshot at $SNAP" >&2; exit 1; }

docker cp "$SNAP" "$CONTAINER":/tmp/_restore.tgz >/dev/null
# bring mail services down so dovecot's in-memory indexes cannot write back over the restore
docker exec "$CONTAINER" s6-svc -d /var/run/s6/services/dovecot
docker exec "$CONTAINER" s6-svc -d /var/run/s6/services/haraka-smtp
docker exec "$CONTAINER" s6-svc -d /var/run/s6/services/haraka-submission
sleep 2
docker exec "$CONTAINER" sh -c 'rm -rf /data/domains && cd /data && tar xzf /tmp/_restore.tgz && rm -f /tmp/_restore.tgz'
docker exec "$CONTAINER" s6-svc -u /var/run/s6/services/dovecot
docker exec "$CONTAINER" s6-svc -u /var/run/s6/services/haraka-smtp
docker exec "$CONTAINER" s6-svc -u /var/run/s6/services/haraka-submission
reapply_plaintext_config
wait_for_imap
echo "reset complete from $SNAP"
