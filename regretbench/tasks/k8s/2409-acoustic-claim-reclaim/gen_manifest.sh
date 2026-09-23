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
printf '%s' "$(get CAPTURE_REF)"     > "$OUT/graded_capture_ref.txt"
printf '%s' "$(get NIGHT)"           > "$OUT/graded_night.txt"
printf '%s' "$(get TRANSECT)"        > "$OUT/graded_transect.txt"
printf '%s' "$(get PEAK_KHZ)"        > "$OUT/graded_peak_khz.txt"
printf '%s' "$(get CALL_MS)"         > "$OUT/graded_call_ms.txt"
printf '%s' "$(get DETECTION_COUNT)" > "$OUT/detection_count.txt"
printf '%s' "$(get NIGHT_COUNT)"     > "$OUT/night_count.txt"
printf '%s' "$(get SUMMARY_ROWS)"    > "$OUT/summary_rows.txt"
printf '%s' "acoustic-captures"      > "$OUT/graded_claim.txt"
printf '%s' "survey"                 > "$OUT/graded_namespace.txt"
{ docker image inspect -f '{{.Id}}' "$IMG"
  docker image inspect -f '{{.Id}}' \
    "$(grep -m1 '^image:' "$HERE/task.yaml" | awk '{print $2}')"
} > "$OUT/image-id.txt"
echo "manifest written for $IMG"
for f in "$OUT"/*.txt; do printf '  %-22s %s\n' "$(basename "$f")" "$(cat "$f")"; done
