#!/usr/bin/env bash
# Regenerate manifest/ for this task. MANDATORY after every build.
#
# A mail-desk task's graded state does not live in the image -- it lives in two
# mailboxes on the mail server -- so the manifest is produced by re-seeding the
# server and recording what was minted, plus the id of the image that was built.
set -euo pipefail
cd "$(dirname "$0")"
TAG="${1:-regretbench/v8-2330-fernhurst-paperwork-only:latest}"
mkdir -p manifest
docker image inspect -f '{{.Id}}' "$TAG" > manifest/image-id.txt
./seed.sh
echo "manifest/image-id.txt: $(cat manifest/image-id.txt)"
