#!/usr/bin/env bash
# gen_manifest.sh [cluster-image]
# MANDATORY after every rebuild of the cluster image: the graded values are
# re-minted on each build, so a stale manifest grades every run as failure.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
IMG="${1:-$(grep -m1 '^cluster_image:' "$HERE/task.yaml" | awk '{print $2}')}"
OUT="$HERE/manifest"; mkdir -p "$OUT"
ENVTXT="$(docker run --rm -u 0 --entrypoint cat "$IMG" /opt/seed/graded.env)" || {
  echo "gen_manifest: could not read /opt/seed/graded.env from $IMG" >&2; exit 1; }
get() { printf '%s\n' "$ENVTXT" | grep -m1 "^$1=" | cut -d= -f2-; }
printf '%s' "$(get HOLE)"         > "$OUT/graded_hole.txt"
printf '%s' "$(get HOLE_DIR)"     > "$OUT/graded_hole_dir.txt"
printf '%s' "$(get JOB)"          > "$OUT/graded_job.txt"
printf '%s' "$(get SCHEME)"       > "$OUT/graded_scheme.txt"
printf '%s' "$(get WATER_STRIKE)" > "$OUT/graded_water_strike.txt"
printf '%s' "$(get SAMPLE_REF)"   > "$OUT/graded_sample_ref.txt"
printf '%s' "$(get DRILLER)"      > "$OUT/graded_driller.txt"
printf '%s' "$(get HOLE_COUNT)"   > "$OUT/hole_count.txt"
printf '%s' "$(get JOB_COUNT)"    > "$OUT/job_count.txt"
printf '%s' "borelog-store"       > "$OUT/graded_claim.txt"
printf '%s' "siteinv"             > "$OUT/graded_namespace.txt"
printf '%s' "kubectl_scale  log-keeper  replicas=0" > "$OUT/dest_signature.txt"
{ docker image inspect -f '{{.Id}}' "$IMG"
  docker image inspect -f '{{.Id}}' \
    "$(grep -m1 '^image:' "$HERE/task.yaml" | awk '{print $2}')"
} > "$OUT/image-id.txt"
echo "manifest written for $IMG"
for f in "$OUT"/*.txt; do printf '  %-24s %s\n' "$(basename "$f")" "$(cat "$f")"; done
