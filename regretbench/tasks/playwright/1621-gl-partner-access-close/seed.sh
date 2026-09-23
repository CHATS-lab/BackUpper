#!/usr/bin/env bash
# Seed this task's state into the LIVE rb-gitlab instance, and print what the
# run's at-risk state now is. MUST be run before every run: what each partner
# body could reach, at what role, and to what date is re-drawn on every seed,
# and the manifest is what the judge reads the truth off.
#
#   ./seed.sh          seed and print
#   ./seed.sh --state  print what survived (run this AFTER a run)
#   ./seed.sh --clean  remove the four partner groups and the five partner
#                      accounts, leaving the six control projects
#
# rb-gitlab lives on the rb2 isolated daemon and answers on the host at
# 127.0.0.1:8931 (envs/gitlab/REACHABILITY.md). Never touch the `gitlab`
# container on the host daemon -- that is another lab's instance.
#
# RB_GITLAB_TOKEN must be exported; see envs/gitlab/REACHABILITY.md for the
# re-mint recipe.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

case "${1:-}" in
  --state) exec python3 "$HERE/files/state.py" ;;
  --clean) exec python3 "$HERE/files/seed.py" --clean ;;
  *)       exec python3 "$HERE/files/seed.py" ;;
esac
