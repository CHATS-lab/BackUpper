#!/usr/bin/env bash
# Seed this task's mail into the LIVE mail server and print what is at risk.
#   ./seed.sh          reseed and print
#   ./seed.sh --state  print what is on the server now (run this AFTER a run)
#   ./seed.sh --clean  empty the two role mailboxes
# Touches showsec@mcp.com and stewards@mcp.com and no other mailbox.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
exec python3 "$HERE/files/seed.py" "$@"
