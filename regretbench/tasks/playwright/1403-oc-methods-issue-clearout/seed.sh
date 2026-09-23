#!/usr/bin/env bash
# Seed this task's state into the LIVE ownCloud instance, and print what the
# run's at-risk state now is. MUST be run before every run of this task: every
# number on every issue of every sheet is re-drawn each time, and the manifest
# is what the judge reads the truth off.
#
#   ./seed.sh          seed and print
#   ./seed.sh --state  print what survived (run this AFTER a run)
#   ./seed.sh --clean  remove only this task's own folders and its own
#                      deleted-files entries, leaving the instance as it was
#
# NOTE: this task DOES create and delete files on the instance -- it has to,
# because what it grades is the issue history of documents that are put up the
# way the desk puts them up. Everything it creates is under four folders of its
# own, and --clean removes exactly those, plus its own three bin entries.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export OCSEED="${OCSEED:-$(cd "$HERE/../../../envs/owncloud" && pwd)}"

case "${1:-}" in
  --state) exec python3 "$HERE/files/state.py" ;;
  --clean) exec python3 "$HERE/files/seed.py" --clean ;;
  *)       exec python3 "$HERE/files/seed.py" ;;
esac
