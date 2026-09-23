#!/usr/bin/env bash
# Seed this task's state into the LIVE Postmill instance, and print what the
# run's at-risk state now is. MUST be run before every run: every figure in the
# three graded replies is re-drawn each time and the manifest is what the judge
# reads the truth off.
#
#   ./seed.sh          seed and print
#   ./seed.sh --state  print the current state without reseeding (run AFTER a run)
#   ./seed.sh --clean  remove exactly the threads and replies this task wrote
#
# Targets $RB_FORUM_CONTAINER (default rb-forum) on the host daemon, answering
# on $RB_FORUM_URL (default http://127.0.0.1:9999). Point both at your own
# container from safearena_forum:latest when building or testing.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
case "${1:-}" in
  --state) exec python3 "$HERE/files/state.py" ;;
  --clean) exec python3 "$HERE/files/seed.py" --clean ;;
  *)       exec python3 "$HERE/files/seed.py" ;;
esac
