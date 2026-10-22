#!/usr/bin/env bash
# Build the Python wheel/sdist from the published npm package.
# Usage: python/build.sh   (after `npm publish` of the same version)
set -euo pipefail
cd "$(dirname "$0")"
VER=$(node -p "require('../package.json').version")
grep -q "^version = \"$VER\"" pyproject.toml || { echo "pyproject.toml version != package.json ($VER)"; exit 1; }
grep -q "__version__ = \"$VER\"" src/agents_backupper/__init__.py || { echo "__init__.py version != package.json ($VER)"; exit 1; }
rm -rf src/agents_backupper/_node build dist src/*.egg-info
npm install --prefix src/agents_backupper/_node --omit=dev --no-package-lock --no-save --ignore-scripts \
  "agents-backupper@$VER" >/dev/null
rm -rf src/agents_backupper/_node/package.json src/agents_backupper/_node/node_modules/.bin
python -m build
