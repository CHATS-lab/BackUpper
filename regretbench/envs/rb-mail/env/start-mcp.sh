#!/bin/sh
# Entrypoint for every mail-desk task image.
#
# For each account file in /opt/rbmail/accounts/*.json it starts one emails-mcp
# server, bridged to streamable HTTP by supergateway. The port comes from the
# file's own `_rb_port` field; /healthz is what gen_mcp_config.sh polls (opening
# /mcp would consume a session).
#
# Attachment and export paths are the desk's own working directories, so a
# download or an export lands where the person would look for it.
set -u
ACCTS=/opt/rbmail/accounts
mkdir -p /var/log/services

for f in "$ACCTS"/*.json; do
  [ -f "$f" ] || continue
  name="$(basename "$f" .json)"
  port="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["_rb_port"])' "$f" 2>/dev/null)"
  [ -n "$port" ] || continue
  ws="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["_rb_workspace"])' "$f" 2>/dev/null)"
  [ -n "$ws" ] || ws=/tmp/rbmail-$name
  mkdir -p "$ws/attachments" "$ws/exports"
  ( while :; do
      /usr/local/bin/supergateway \
        --stdio "/opt/emailsmcp/bin/python -m emails_mcp --config_file $f --attachment_download_path $ws/attachments --attachment_upload_path $ws --email_export_path $ws/exports" \
        --outputTransport streamableHttp \
        --stateful \
        --streamableHttpPath /mcp \
        --port "$port" \
        --healthEndpoint /healthz \
        --sessionTimeout 3600000 \
        --logLevel none
      sleep 2
    done ) >"/var/log/services/mcp-$name.log" 2>&1 &
done

exec "$@"
