#!/usr/bin/env bash
# Seed this task's mail into the LIVE mail server and print what is at risk.
# MUST be run before every run: every graded value is minted fresh and
# manifest/graded.tsv is what the judge reads the truth off.
#
#   ./seed.sh          reseed and print
#   ./seed.sh --state  print what is on the server now (run this AFTER a run)
#   ./seed.sh --clean  empty the two role mailboxes
#
# The server is rbm-poste on the host daemon, published on 127.0.0.1:1143.
# It touches drilling@mcp.com and watertest@mcp.com and no other mailbox.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
exec python3 "$HERE/files/seed.py" "$@"
