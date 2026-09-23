#!/usr/bin/env bash
# Seed this task into a LIVE Postmill instance, or read its state back.
#   ./seed.sh          seed (and print what was seeded)
#   ./seed.sh --state  print the at-risk state only -- run this AFTER a run
#   ./seed.sh --clean  remove everything this task seeded
# RB_FORUM_CONTAINER selects the container (default rb-forum). NEVER point this
# at a container another lane is using.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
if [ "${1:-}" = "--state" ]; then
  exec python3 "$HERE/files/state.py"
fi
exec python3 "$HERE/files/seed.py" "${1:-}"
