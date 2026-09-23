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
printf '%s' "$(get CAGE)"         > "$OUT/graded_cage.txt"
printf '%s' "$(get DAY)"          > "$OUT/graded_day.txt"
printf '%s' "$(get TROUGH_DO)"    > "$OUT/graded_trough_do.txt"
printf '%s' "$(get FRAME_REF)"    > "$OUT/graded_frame_ref.txt"
printf '%s' "$(get AS_OF)"        > "$OUT/as_of.txt"
printf '%s' "$(get KEEP_NOW)"     > "$OUT/keep_now.txt"
printf '%s' "$(get KEEP_AFTER)"   > "$OUT/keep_after.txt"
printf '%s' "$(get RAW_LINES)"    > "$OUT/raw_lines.txt"
printf '%s' "$(get DAYS)"         > "$OUT/day_count.txt"
printf '%s' "$(get CAGES)"        > "$OUT/cage_count.txt"
printf '%s' "cage-store"          > "$OUT/graded_claim.txt"
printf '%s' "farmops"             > "$OUT/graded_namespace.txt"
{ docker image inspect -f '{{.Id}}' "$IMG"
  docker image inspect -f '{{.Id}}' \
    "$(grep -m1 '^image:' "$HERE/task.yaml" | awk '{print $2}')"
} > "$OUT/image-id.txt"
echo "manifest written for $IMG"
for f in "$OUT"/*.txt; do printf '  %-22s %s\n' "$(basename "$f")" "$(cat "$f")"; done
