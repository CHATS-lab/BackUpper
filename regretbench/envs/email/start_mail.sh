#!/usr/bin/env bash
# start_mail.sh <task-dir> <container-name> <network> <data-dir>
#
# Start a fresh poste.io mail server for one email task, on <network> under the
# hostname mail.mcp.com, with its /data in <data-dir> (created empty), and block
# until IMAP offers plaintext login. Then create domain mcp.com, the admin
# account, and the task's own accounts (<task-dir>/files/accounts/*.json).
# With RB_MAIL_USERS_JSON (Toolathlon's configs/users_data.json) the shared
# population of mcp.com mailboxes is created as well.
#
# Prints, on stdout, the variables the task's seed.sh reads:
#   RBMAIL_HOST=<address on <network>>
#   RBMAIL_PORT=143
#
# Env: RB_POSTE_IMAGE (default analogic/poste.io:2.5.5), RB_MAIL_BOOT (seconds, default 300).
set -uo pipefail
TD="${1:?usage: start_mail.sh <task-dir> <container-name> <network> <data-dir>}"
NAME="${2:?usage: start_mail.sh <task-dir> <container-name> <network> <data-dir>}"
NET="${3:?usage: start_mail.sh <task-dir> <container-name> <network> <data-dir>}"
DATA="${4:?usage: start_mail.sh <task-dir> <container-name> <network> <data-dir>}"
IMAGE="${RB_POSTE_IMAGE:-analogic/poste.io:2.5.5}"
PY="${RB_PY:-python3}"

mkdir -p "$DATA" && chmod 777 "$DATA" && DATA="$(cd "$DATA" && pwd)"
docker run -d --name "$NAME" --network "$NET" --network-alias mail.mcp.com \
  --cap-add NET_ADMIN --cap-add NET_RAW --cap-add NET_BIND_SERVICE --cap-add SYS_PTRACE \
  -e DISABLE_CLAMAV=TRUE -e DISABLE_RSPAMD=TRUE -e DISABLE_P0F=TRUE \
  -e HTTPS_FORCE=0 -e HTTPS=OFF -e HTTP_PORT=80 -e HTTPS_PORT=443 -e APP_ENV=dev -e MODE=free \
  -v "$DATA":/data:Z --hostname mcp.com "$IMAGE" >/dev/null \
  || { echo "[fail] could not start $NAME" >&2; exit 1; }
IP="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$NAME")"
[ -n "$IP" ] || { echo "[fail] no address for $NAME on $NET" >&2; exit 1; }

# probe <port> [needle]: a banner from <port> on the server, containing needle.
probe() {
  "$PY" - "$IP" "$1" "${2:-}" <<'PY'
import socket, sys
host, port, needle = sys.argv[1], int(sys.argv[2]), sys.argv[3]
try:
    s = socket.create_connection((host, port), 3); s.settimeout(3)
    b = s.recv(512); s.close()
except Exception:
    sys.exit(1)
sys.exit(0 if (not needle or needle.encode() in b) else 1)
PY
}

# poste writes its dovecot configuration during boot; it must exist before it is edited.
ok=0
for _ in $(seq 1 "${RB_MAIL_BOOT:-300}"); do
  if docker exec "$NAME" test -f /etc/dovecot/conf.d/10-ssl.conf 2>/dev/null \
     && docker exec "$NAME" test -d /var/run/s6/services/dovecot 2>/dev/null \
     && probe 143 OK; then ok=1; break; fi
  sleep 1
done
[ "$ok" = 1 ] || { echo "[fail] dovecot did not come up" >&2; docker logs --tail 40 "$NAME" >&2; exit 1; }

# Plaintext authentication: poste ships TLS-required defaults, and the task
# accounts connect without TLS. Services restart through s6.
docker exec "$NAME" sed -i 's/ssl = required/ssl = yes/' /etc/dovecot/conf.d/10-ssl.conf
docker exec "$NAME" sed -i 's/auth_allow_cleartext = no/auth_allow_cleartext = yes/' /etc/dovecot/conf.d/10-auth.conf
docker exec "$NAME" sed -i '/disable_plaintext_auth/d' /etc/dovecot/conf.d/10-auth.conf
docker exec "$NAME" sed -i 's/tls_required = true/tls_required = false/' /opt/haraka-smtp/config/auth.ini
docker exec "$NAME" sed -i 's/tls_required = true/tls_required = false/' /opt/haraka-submission/config/auth.ini
docker exec "$NAME" sed -i 's|^auth/poste|#auth/poste|' /opt/haraka-submission/config/plugins
docker exec "$NAME" sh -c 'printf "127.0.0.1/8\n192.168.0.0/16\n172.16.0.0/12\n10.0.0.0/8\n" > /opt/haraka-submission/config/relay_acl_allow'
for svc in dovecot haraka-smtp haraka-submission; do
  docker exec "$NAME" s6-svc -t "/var/run/s6/services/$svc"
done

# Ready means plaintext LOGIN is offered, not merely that 143 answers.
ok=0
for _ in $(seq 1 120); do
  if "$PY" - "$IP" <<'PY'
import socket, sys
try:
    s = socket.create_connection((sys.argv[1], 143), 3); s.settimeout(4)
    s.recv(1024); s.sendall(b"a1 CAPABILITY\r\n")
    b = b""
    while b"a1 " not in b:
        c = s.recv(4096)
        if not c:
            break
        b += c
    s.sendall(b"a2 LOGOUT\r\n"); s.close()
except Exception:
    sys.exit(1)
sys.exit(0 if (b"AUTH=PLAIN" in b and b"LOGINDISABLED" not in b) else 1)
PY
  then ok=1; break; fi
  sleep 1
done
[ "$ok" = 1 ] || { echo "[fail] IMAP never offered plaintext login" >&2; exit 1; }

# Accounts. Arguments travel NUL-separated, never through a shell that would
# expand the `$` and `%` some passwords contain.
console() { docker exec --user=8 "$NAME" php /opt/admin/bin/console "$@"; }
console domain:create mcp.com >/dev/null 2>&1 || true
console email:create mcpposte_admin@mcp.com mcpposte "System Administrator" >/dev/null 2>&1 || true
console email:admin mcpposte_admin@mcp.com >/dev/null 2>&1 || true
"$PY" - "$TD/files/accounts" "${RB_MAIL_USERS_JSON:-}" > "$DATA/.users.nul" <<'PY'
import glob, json, os, sys
accounts, users_json = sys.argv[1], sys.argv[2]
rows = []
if users_json:
    rows += [(u["email"], u["password"], u["full_name"]) for u in json.load(open(users_json))["users"]]
for f in sorted(glob.glob(os.path.join(accounts, "*.json"))):
    a = json.load(open(f))
    rows.append((a["email"], a["password"], a.get("name") or a["email"]))
for row in rows:
    sys.stdout.write("%s\0%s\0%s\0" % row)
PY
docker cp "$DATA/.users.nul" "$NAME:/tmp/users.nul" >/dev/null && rm -f "$DATA/.users.nul"
docker exec --user=8 "$NAME" sh -c \
  'xargs -0 -n3 -P8 sh -c "php /opt/admin/bin/console email:create \"\$1\" \"\$2\" \"\$3\" >/dev/null 2>&1 || true" _ < /tmp/users.nul'
docker exec --user=8 "$NAME" sh -c \
  'xargs -0 -n3 -P8 sh -c "php /opt/admin/bin/console email:passwd \"\$1\" \"\$2\" >/dev/null 2>&1 || echo FAIL \$1" _ < /tmp/users.nul' >&2

# Submission (587) carries forward_email; slow is reported, not fatal.
for _ in $(seq 1 90); do probe 587 220 && break; sleep 1; done
probe 587 220 || echo "[warn] submission (587) is not answering yet" >&2

echo "RBMAIL_HOST=$IP"
echo "RBMAIL_PORT=143"
