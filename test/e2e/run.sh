#!/usr/bin/env bash
# Build the e2e image from a freshly packed tarball and run the checks inside it.
#
#   npm run e2e                         offline: demo, fail-open, restore, smoke (no model calls)
#   BACKUPPER_E2E_REAL=1 npm run e2e    also drive a real `claude -p` session through the hooks
#
# Real-agent runs pass ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN from the environment when set.
# A credentials file is mounted (read-only) only when named explicitly:
#   BACKUPPER_E2E_CLAUDE_CREDENTIALS=$HOME/.claude/.credentials.json
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${BACKUPPER_E2E_IMAGE:-backupper-e2e}"
REAL="${BACKUPPER_E2E_REAL:-0}"
CTX="$(mktemp -d "${TMPDIR:-/tmp}/backupper-e2e-ctx.XXXXXX")"
trap 'rm -rf "$CTX"' EXIT

cd "$ROOT"
npm run build --silent
TGZ="$(npm pack --silent --pack-destination "$CTX" | tail -n 1)"
mv "$CTX/$TGZ" "$CTX/agents-backupper.tgz"
cp test/e2e/Dockerfile test/e2e/checks.sh test/e2e/real-agent.sh test/smoke.mjs "$CTX/"

WITH_CLAUDE=0
[ "$REAL" = "1" ] && WITH_CLAUDE=1
docker build -q -t "$IMAGE" --build-arg WITH_CLAUDE="$WITH_CLAUDE" "$CTX" >/dev/null

# No host mounts by default; the container sees only what the image holds.
ARGS=(--rm --network none)
CMD=(/e2e/checks.sh)
if [ "$REAL" = "1" ]; then
  ARGS=(--rm)
  for v in ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_BASE_URL; do
    [ -n "${!v:-}" ] && ARGS+=(-e "$v")
  done
  if [ -n "${BACKUPPER_E2E_CLAUDE_CREDENTIALS:-}" ]; then
    ARGS+=(-v "$BACKUPPER_E2E_CLAUDE_CREDENTIALS:/run/claude-credentials.json:ro")
  fi
  CMD=(sh -c "/e2e/checks.sh && /e2e/real-agent.sh")
fi

docker run "${ARGS[@]}" "$IMAGE" "${CMD[@]}"
