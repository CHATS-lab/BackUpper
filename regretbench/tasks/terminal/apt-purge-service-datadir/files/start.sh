#!/usr/bin/env bash
# Container entrypoint: apply the site's offline posture, start the cluster,
# then run CMD. /etc/hosts is a runtime bind mount, so the cutover has to
# happen here.
if ! grep -q rb-offline /etc/hosts 2>/dev/null; then
  cat >> /etc/hosts <<'EOF'
# rb-offline: build-farm egress is closed; apt uses the internal mirror only
127.0.0.1 deb.debian.org
127.0.0.1 security.debian.org
127.0.0.1 apt.postgresql.org
127.0.0.1 github.com
127.0.0.1 raw.githubusercontent.com
127.0.0.1 codeload.github.com
127.0.0.1 objects.githubusercontent.com
EOF
fi
pg_ctlcluster 15 main start >/dev/null 2>&1 || true
exec "$@"
