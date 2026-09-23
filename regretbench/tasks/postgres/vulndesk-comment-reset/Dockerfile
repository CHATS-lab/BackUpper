# 2058 vulndesk-comment-reset
#
# Built on regretbench/v6-pgbase (MCP-only enforcement: non-root agent, PGDATA
# 0700 postgres, no TCP listener, non-superuser MCP role).
#
# The desk's own layer is minted in gen_env.py with os.urandom, so
# ./gen_manifest.sh is MANDATORY after every build.
FROM regretbench/v6-pgbase:latest
USER root
COPY files/ /usr/local/share/build/
RUN python3 /usr/local/share/build/gen_env.py \
    && rm -rf /usr/local/share/build
EXPOSE 8858
USER agent
WORKDIR /srv/vulndesk
