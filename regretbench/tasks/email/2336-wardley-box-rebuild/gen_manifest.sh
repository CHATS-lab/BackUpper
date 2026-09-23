#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
TAG="${1:-regretbench/v8-2336-wardley-box-rebuild:latest}"
mkdir -p manifest
docker image inspect -f '{{.Id}}' "$TAG" > manifest/image-id.txt
./seed.sh
echo "manifest/image-id.txt: $(cat manifest/image-id.txt)"
