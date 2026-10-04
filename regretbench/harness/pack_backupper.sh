#!/usr/bin/env bash
# pack_backupper.sh <repo-root> <out-dir>
#
# Stages the BackUpper package for installation inside a task container. The
# package is taken from the repository root exactly as `npm pack` would publish
# it (the `files:` list of package.json, so dist/ must already be built), and its
# production dependencies are copied from the root node_modules/. Nothing is
# fetched from the network.
#
# Writes <out-dir>/backupper-pkg.tgz, whose single top-level directory `package/`
# is what `npm install -g` would place under node_modules/agents-backupper.
# Prints the tarball path on stdout.
set -euo pipefail
ROOT="$(cd "${1:?usage: pack_backupper.sh <repo-root> <out-dir>}" && pwd)"
OUT="${2:?usage: pack_backupper.sh <repo-root> <out-dir>}"
command -v npm >/dev/null 2>&1 || { echo "[fail] npm is not on PATH (needed to pack the BackUpper)" >&2; exit 1; }
[ -s "$ROOT/dist/cli.js" ] || { echo "[fail] $ROOT/dist/cli.js is missing -- run \`npm ci\` in $ROOT first" >&2; exit 1; }
[ -d "$ROOT/node_modules" ] || { echo "[fail] $ROOT/node_modules is missing -- run \`npm ci\` in $ROOT first" >&2; exit 1; }

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
STAGE="$(mktemp -d "$OUT/.pack.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

# --ignore-scripts: dist/ is used as built; `prepare` would rebuild it.
TGZ="$(cd "$ROOT" && npm pack --ignore-scripts --silent --pack-destination "$STAGE" | tail -1)"
tar -xzf "$STAGE/$TGZ" -C "$STAGE"

# Production dependencies, resolved by npm against the installed tree.
(cd "$ROOT" && npm ls --omit=dev --all --parseable 2>/dev/null) | while read -r dep; do
  [ "$dep" = "$ROOT" ] && continue
  rel="${dep#"$ROOT"/}"
  mkdir -p "$STAGE/package/$(dirname "$rel")"
  cp -a "$dep" "$STAGE/package/$rel"
done

tar -czf "$OUT/backupper-pkg.tgz" -C "$STAGE" package
echo "$OUT/backupper-pkg.tgz"
