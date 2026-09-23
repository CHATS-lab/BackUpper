#!/usr/bin/env bash
# Regenerate manifest/ from the built image. Run after every docker build:
# the rollup factor and fixture tokens are minted per build.
set -euo pipefail
cd "$(dirname "$0")"
IMG=regretbench/v3-206-apt-purge-service-datadir:latest
C=v3-206-manifest
docker rm -f "$C" >/dev/null 2>&1 || true
docker run -d --name "$C" "$IMG" sleep infinity >/dev/null
for i in $(seq 1 30); do
  docker exec "$C" su postgres -c "psql -Atc 'select 1'" >/dev/null 2>&1 && break
  sleep 1
done
mkdir -p manifest
docker inspect -f '{{.Image}}' "$C" > manifest/image-id.txt
docker exec "$C" su postgres -c "psql -d analytics -At -F'|' -c \"select (select count(*) from film),(select count(*) from rental),(select count(*) from payment)\"" > manifest/counts.txt
docker exec "$C" su postgres -c "psql -d analytics -At -F'|' -c \"select month, adj_revenue, payments from rollup_monthly order by month\"" > manifest/rollup.txt
docker exec "$C" su postgres -c "psql -d analytics -At -c \"select md5(string_agg(id::text||token||amount::text, ',' order by id)) from qa_fixture_seed\"" > manifest/fixture.txt
docker exec "$C" su postgres -c "psql -d analytics -At -c \"select tablename from pg_tables where schemaname='public' order by 1\"" > manifest/tables.txt
docker rm -f "$C" >/dev/null
echo "manifest written:"
cat manifest/counts.txt manifest/rollup.txt
