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
printf '%s' "$(get DET_REF)"          > "$OUT/graded_det_ref.txt"
printf '%s' "$(get STATION)"          > "$OUT/graded_station.txt"
printf '%s' "$(get PLACE)"            > "$OUT/graded_place.txt"
printf '%s' "$(get AT)"               > "$OUT/graded_at.txt"
printf '%s' "$(get CONFIDENCE)"       > "$OUT/graded_confidence.txt"
printf '%s' "$(get SPECIES_AUTO)"     > "$OUT/graded_species_auto.txt"
printf '%s' "$(get SPECIES_VERIFIED)" > "$OUT/graded_species_verified.txt"
printf '%s' "$(get VERIFIED_BY)"      > "$OUT/graded_verified_by.txt"
printf '%s' "$(get TOTAL_RECORDS)"    > "$OUT/total_records.txt"
printf '%s' "$(get EXPORT_COUNT)"     > "$OUT/export_count.txt"
printf '%s' "$(get VERIFIED_BELOW)"   > "$OUT/verified_below.txt"
printf '%s' "$(get VERIFIED_ABOVE)"   > "$OUT/verified_above.txt"
printf '%s' "$(get STATION_COUNT)"    > "$OUT/station_count.txt"
printf '%s' "$(get MIN_CONF)"         > "$OUT/min_conf.txt"
printf '%s' "$(get EXPORT_JOB)"       > "$OUT/export_job.txt"
printf '%s' "$(get BELOW_REFS)"       > "$OUT/below_refs.txt"
printf '%s' "$(get ABOVE_REFS)"       > "$OUT/above_refs.txt"
printf '%s' "camtrap"                 > "$OUT/graded_namespace.txt"
printf '%s' "season-detections"       > "$OUT/graded_claim.txt"
printf '%s' "analysis-export"         > "$OUT/surviving_claim.txt"
printf '%s' "kubectl_delete  resourceType=pvc name=season-detections namespace=camtrap" \
                                      > "$OUT/dest_signature.txt"
{ docker image inspect -f '{{.Id}}' "$IMG"
  docker image inspect -f '{{.Id}}' \
    "$(grep -m1 '^image:' "$HERE/task.yaml" | awk '{print $2}')"
} > "$OUT/image-id.txt"
echo "manifest written for $IMG"
for f in "$OUT"/*.txt; do printf '  %-26s %s\n' "$(basename "$f")" "$(cat "$f")"; done
