#!/bin/bash
# setup-mail.sh — build the rbm-poste mail environment from scratch. Idempotent-ish:
# it removes and recreates ONLY the containers named rbm-poste / rbm-client.
#
# Result: poste.io on 10005(web) 2525(smtp) 1143(imap) 1587(submission),
# domain mcp.com, 503 mailboxes + admin, plaintext auth enabled.
set -euo pipefail
ROOT="${RB_MAIL_ROOT:-$(cd "$(dirname "$0")" && pwd)}"
DATA=$ROOT/poste-data
USERS=$ROOT/Toolathlon-main/configs/users_data.json

docker rm -f rbm-poste rbm-client 2>/dev/null || true
rm -rf "$DATA"; mkdir -p "$DATA"; chmod -R 777 "$DATA"

docker run -d --name rbm-poste \
  --cap-add NET_ADMIN --cap-add NET_RAW --cap-add NET_BIND_SERVICE --cap-add SYS_PTRACE \
  -p 10005:80 -p 2525:25 -p 1143:143 -p 1587:587 \
  -e DISABLE_CLAMAV=TRUE -e DISABLE_RSPAMD=TRUE -e DISABLE_P0F=TRUE \
  -e HTTPS_FORCE=0 -e HTTPS=OFF \
  -v "${DATA}":/data:Z --hostname mcp.com analogic/poste.io:2.5.5 >/dev/null
sleep 20

# plaintext auth (poste ships TLS-required defaults)
docker exec rbm-poste sed -i 's/ssl = required/ssl = yes/' /etc/dovecot/conf.d/10-ssl.conf
docker exec rbm-poste sed -i 's/auth_allow_cleartext = no/auth_allow_cleartext = yes/' /etc/dovecot/conf.d/10-auth.conf
docker exec rbm-poste sed -i '/disable_plaintext_auth/d' /etc/dovecot/conf.d/10-auth.conf
docker exec rbm-poste sed -i 's/tls_required = true/tls_required = false/' /opt/haraka-smtp/config/auth.ini
docker exec rbm-poste sed -i 's/tls_required = true/tls_required = false/' /opt/haraka-submission/config/auth.ini
docker exec rbm-poste sed -i 's|^auth/poste|#auth/poste|' /opt/haraka-submission/config/plugins
docker exec rbm-poste sh -c 'printf "127.0.0.1/8\n192.168.0.0/16\n172.16.0.0/12\n10.0.0.0/8\n" > /opt/haraka-submission/config/relay_acl_allow'
docker exec rbm-poste s6-svc -t /var/run/s6/services/dovecot
docker exec rbm-poste s6-svc -t /var/run/s6/services/haraka-smtp
docker exec rbm-poste s6-svc -t /var/run/s6/services/haraka-submission
sleep 5

docker exec --user=8 rbm-poste php /opt/admin/bin/console domain:create mcp.com >/dev/null 2>&1 || true
docker exec --user=8 rbm-poste php /opt/admin/bin/console email:create mcpposte_admin@mcp.com mcpposte "System Administrator" >/dev/null 2>&1 || true
docker exec --user=8 rbm-poste php /opt/admin/bin/console email:admin mcpposte_admin@mcp.com >/dev/null 2>&1 || true

# NUL-separated args: passwords contain $ and % and MUST NOT go through a heredoc
# or any shell that performs parameter expansion (that silently truncates them).
python3 - "$USERS" > /tmp/rbm_users.nul <<'PY'
import json,sys
for u in json.load(open(sys.argv[1]))['users']:
    sys.stdout.write('%s\0%s\0%s\0' % (u['email'], u['password'], u['full_name']))
PY
docker cp /tmp/rbm_users.nul rbm-poste:/tmp/users.nul >/dev/null
docker exec --user=8 rbm-poste sh -c \
  'xargs -0 -n3 -P12 sh -c "php /opt/admin/bin/console email:create \"\$1\" \"\$2\" \"\$3\" >/dev/null 2>&1 || echo FAIL \$1" _ < /tmp/users.nul'
docker exec --user=8 rbm-poste sh -c \
  'xargs -0 -n3 -P12 sh -c "php /opt/admin/bin/console email:passwd \"\$1\" \"\$2\" >/dev/null 2>&1 || echo PWFAIL \$1" _ < /tmp/users.nul'
rm -f /tmp/rbm_users.nul
echo "mailboxes: $(docker exec --user=8 rbm-poste php /opt/admin/bin/console email:list 2>/dev/null | wc -l)"

# client container: runs emails-mcp and the verification scripts, host network so
# localhost:1143 / :1587 resolve exactly as they do for the agent harness.
docker run -d --name rbm-client --network host -v "$ROOT:$ROOT" \
  python:3.12-slim sleep infinity >/dev/null
docker exec rbm-client pip install --quiet uv
echo "setup complete. now: ./reset-mail.sh --snapshot snapshots/pristine.tgz"
