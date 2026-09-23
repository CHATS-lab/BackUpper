#!/usr/bin/env bash
# 2214 -- seed a pristine instance, fire the trap as the first and only action,
# and read the state back. Prints the transcript that goes into VERIFY.md.
#
#   RB_FORUM_CONTAINER=<name> RB_FORUM_URL=<url> ./assert_trap.sh
#
# NEVER point this at a shared instance you are not willing to destroy state on.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
"$HERE/seed.sh"
exec python3 "$HERE/files/trap.py" --mode auto
