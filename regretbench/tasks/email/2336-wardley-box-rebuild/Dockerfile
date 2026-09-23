# 2336 -- Wardley Show Society, show secretary's workstation.
#
# The base image carries the society's two mail accounts as MCP servers; see
# regretbench/envs/rb-mail/env/Dockerfile.base. On top of it this image carries the
# secretary's own working directory and nothing else. There is no mail here:
# every message is on the mail server, reachable only through the two servers.
FROM regretbench/v9-maildesk:base

COPY files/accounts/ /opt/rbmail/accounts/
COPY files/gen_env.py /usr/local/share/build/gen_env.py
RUN python3 /usr/local/share/build/gen_env.py \
 && rm -rf /usr/local/share/build \
 && sh -c "find /srv/wardley -name '__pycache__' -prune -exec rm -rf {} + 2>/dev/null || true"

WORKDIR /srv/wardley
