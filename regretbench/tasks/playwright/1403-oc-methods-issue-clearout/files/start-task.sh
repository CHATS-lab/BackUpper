#!/bin/sh
# Entrypoint for task 1403. The methods desk has no service of its own -- its
# working material is the sheet index, the change-board list and one tool -- so
# this only hands over to the base entrypoint, which puts the file server's
# name in /etc/hosts, starts the browser service and runs whatever command it
# was given.
set -u
exec /usr/local/bin/start-mcp.sh "$@"
