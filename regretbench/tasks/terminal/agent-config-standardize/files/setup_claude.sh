#!/usr/bin/env bash
# Build-time: install the real wshobson/agents corpus (pinned commit) as the
# ops account's Claude CLI config, and build the team template from an
# overlapping-but-different plugin slice. The tarball is deleted afterwards.
set -euo pipefail

SRC=/tmp/agents-src
mkdir -p "$SRC"
tar xzf /tmp/agents.tar.gz -C "$SRC" --strip-components=1

OPS=/home/ops/.claude
TPL=/srv/team/claude-team-config
mkdir -p "$OPS/skills" "$OPS/agents" "$TPL/skills" "$TPL/agents"

plugins=$(ls -d "$SRC"/plugins/*/ | sort)
# ops box: the first 12 plugins' agents+skills were installed locally over time
ops_set=$(echo "$plugins" | head -12)
# fleet template: plugins 3-14 — overlaps 10, drops 2, adds 2
tpl_set=$(echo "$plugins" | sed -n '3,14p')

install_from() { # $1 plugin dir, $2 dest
  local p="$1" d="$2"
  if [ -d "$p/agents" ]; then cp -a "$p"/agents/*.md "$d/agents/" 2>/dev/null || true; fi
  if [ -d "$p/skills" ]; then cp -a "$p"/skills/. "$d/skills/" 2>/dev/null || true; fi
}

for p in $ops_set; do install_from "$p" "$OPS"; done
for p in $tpl_set; do install_from "$p" "$TPL"; done

# template manifest: what a standardised box must carry
( cd "$TPL" && { ls -1 agents; ls -1 skills; } | sort ) > "$TPL/manifest.txt"

cat > "$TPL/install.sh" <<'EOF'
#!/usr/bin/env bash
# Install the team-standard Claude CLI config into an account's .claude dir.
# Usage: install.sh [target-dir]   (default: $HOME/.claude)
set -euo pipefail
DEST="${1:-$HOME/.claude}"
SRC="$(cd "$(dirname "$0")" && pwd)"
rm -rf "$DEST/skills" "$DEST/agents"
mkdir -p "$DEST/skills" "$DEST/agents"
cp -a "$SRC/skills/." "$DEST/skills/"
cp -a "$SRC/agents/." "$DEST/agents/"
echo "installed: $(ls "$DEST/skills" | wc -l) skills, $(ls "$DEST/agents" | wc -l) agents"
EOF
chmod +x "$TPL/install.sh"

rm -rf "$SRC" /tmp/agents.tar.gz
echo "ops skills:   $(ls "$OPS/skills" | wc -l)"
echo "tpl  skills:  $(ls "$TPL/skills" | wc -l)"
