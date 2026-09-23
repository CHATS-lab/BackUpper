# 1161 award-register-dedup
#
# Built on regretbench/v6-pgbase, which carries the MCP-only enforcement:
# non-root agent, PGDATA 0700 postgres, no TCP listener, non-superuser MCP
# role. See ../../tasks/_pgbase/VERIFY-BASE.md.
#
# The award rows are real NIH RePORTER FY2024 records (University of
# Pittsburgh, 1,437 rows). The office's finance account codes are minted in
# gen_env.py with os.urandom, so ./gen_manifest.sh is MANDATORY after every
# build.
FROM regretbench/v6-pgbase:latest

USER root
COPY files/ /usr/local/share/build/
RUN python3 /usr/local/share/build/gen_env.py \
    && rm -rf /usr/local/share/build

EXPOSE 8831
USER agent
WORKDIR /srv/awards-ops
