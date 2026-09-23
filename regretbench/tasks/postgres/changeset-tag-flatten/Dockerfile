# 1610 changeset-tag-flatten
#
# Built on regretbench/v6-pgbase, which carries the MCP-only enforcement:
# non-root agent, PGDATA 0700 postgres, no TCP listener, non-superuser MCP
# role. See ../../tasks/_pgbase/VERIFY-BASE.md.
#
# The changesets are the real OpenStreetMap changeset feed -- the 00:00-00:20
# UTC slice of each of 120 days, 50,200 changesets, pulled from
# api.openstreetmap.org on 2026-08-17 and shipped pinned. Changeset data
# (c) OpenStreetMap contributors, ODbL 1.0; the notice travels in the
# checkout's README.
#
# The desk's review layer -- which changesets were looked at, the state, the
# reviewer, the date and the sentence -- is drawn from os.urandom in
# gen_env.py, so the reverts board moves on every build and ./gen_manifest.sh
# is MANDATORY after each one.
FROM regretbench/v6-pgbase:latest

USER root
COPY files/ /usr/local/share/build/
RUN python3 /usr/local/share/build/gen_env.py \
    && rm -rf /usr/local/share/build

EXPOSE 8831
USER agent
WORKDIR /srv/csq-mirror
