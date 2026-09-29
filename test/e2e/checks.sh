#!/usr/bin/env bash
# Offline end-to-end checks against the globally installed `backupper` (run inside the e2e
# container). No model calls: the tier-3 subagent is disabled and the container has no network.
# Deny rules are checked by feeding tool calls to the hook, which decides but never executes.
set -uo pipefail

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); echo "ok    $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "FAIL  $1"; [ -n "${2:-}" ] && echo "      $2"; }
check() { local name="$1"; shift; if "$@"; then ok "$name"; else bad "$name"; fi; }

export BACKUPPER_READONLY_CHECKER=0
unset BACKUPPER_NO_HOOK BACKUPPER_STORE_DIR

new_project() {
  local d="/work/$1"
  rm -rf "$d" && mkdir -p "$d" && cd "$d" || exit 1
  git init -q
  echo "node_modules/" > .gitignore
}

# The hook command an agent would run, read from the file `install` wrote.
hook_cmd() {  # $1 = agent, $2 = PreToolUse|PostToolUse
  node -e '
    const [agent, ev] = process.argv.slice(1);
    const f = agent === "codex" ? ".codex/hooks.json" : ".claude/settings.local.json";
    const j = JSON.parse(require("fs").readFileSync(f, "utf-8"));
    console.log(j.hooks[ev][0].hooks[0].command);' "$1" "$2"
}

# Send one tool call to a hook; prints stdout, returns the hook's exit code.
send() {  # $1 = hook command, $2 = tool name, $3 = tool_input JSON
  printf '{"hook_event_name":"PreToolUse","tool_name":"%s","tool_input":%s,"cwd":"%s"}' "$2" "$3" "$PWD" \
    | sh -c "$1"
}

echo "== backupper $(backupper --version) on node $(node --version)"

# ── 1. Offline demo ──────────────────────────────────────────────────
out="$(cd /tmp && backupper demo --json)"
check "demo --json reports ok" node -e 'process.exit(JSON.parse(process.argv[1]).ok === true ? 0 : 1)' "$out"
check "demo (human output) exits 0" sh -c 'cd /tmp && backupper demo >/dev/null'

# ── 2. Deny rules, through the installed hooks ──────────────────────
DENY=(
  "mkfs.ext4 /dev/sdz1"
  "wipefs -a /dev/sdz"
  "dd if=/dev/zero of=/dev/sdz bs=1M"
  "shred -u notes.txt"
  "lvremove -f vg0/data"
  "rm -rf /"
  "sudo rm -rf ~"
  "rm -rf .backupper"
)
for agent in claude-code codex; do
  new_project "deny-$agent"
  backupper install "$agent" >/dev/null
  backupper config set subagentEnabled false >/dev/null
  echo "keep" > notes.txt
  pre="$(hook_cmd "$agent" PreToolUse)"
  for cmd in "${DENY[@]}"; do
    input="$(node -e 'console.log(JSON.stringify({command: process.argv[1]}))' "$cmd")"
    res="$(send "$pre" Bash "$input")"; code=$?
    if [ "$code" = 2 ] && echo "$res" | grep -q '"permissionDecision":"deny"'; then
      ok "$agent denies: $cmd"
    else
      bad "$agent denies: $cmd" "exit $code, output: $res"
    fi
  done
  for cmd in "ls -la" "dd if=in.img of=out.img" "wipefs --no-act -a /dev/sdz" "rm -rf build/"; do
    input="$(node -e 'console.log(JSON.stringify({command: process.argv[1]}))' "$cmd")"
    res="$(send "$pre" Bash "$input")"; code=$?
    if [ "$code" = 0 ]; then ok "$agent allows: $cmd"; else bad "$agent allows: $cmd" "exit $code, output: $res"; fi
  done
  check "$agent: nothing was executed (notes.txt intact)" grep -qx keep notes.txt
done

# User-edited denyPatterns take effect, and an empty list disables the default rules.
new_project deny-custom
backupper install claude-code >/dev/null
backupper config set subagentEnabled false >/dev/null
backupper config set denyPatterns '["terraform\\s+destroy"]' >/dev/null
pre="$(hook_cmd claude-code PreToolUse)"
send "$pre" Bash '{"command":"terraform destroy -auto-approve"}' >/dev/null; code=$?
check "custom denyPatterns: terraform destroy is denied" test "$code" = 2
send "$pre" Bash '{"command":"shred -u x"}' >/dev/null; code=$?
check "custom denyPatterns replace the defaults (shred now allowed)" test "$code" = 0

# ── 3. Fail-open on a rule-engine error ─────────────────────────────
new_project failopen
backupper install claude-code >/dev/null
node -e '
  const f = ".backupper/config.json"; const fs = require("fs");
  const c = JSON.parse(fs.readFileSync(f, "utf-8"));
  c.subagentEnabled = false; c.alwaysBackupPatterns = null;
  fs.writeFileSync(f, JSON.stringify(c));'
pre="$(hook_cmd claude-code PreToolUse)"
err="$(send "$pre" Bash '{"command":"ls"}' 2>&1 >/dev/null)"; code=$?
check "broken config: the call is allowed" test "$code" = 0
check "broken config: a warning is printed" sh -c "echo \"$err\" | grep -q 'rule evaluation failed'"
check "broken config: the error is logged" test -s .backupper/hook-errors.log
send "$pre" Bash '{"command":"mkfs.ext4 /dev/sdz1"}' >/dev/null 2>&1; code=$?
check "broken config: the deny list still applies" test "$code" = 2

# ── 4. Capture and restore ──────────────────────────────────────────
new_project restore
backupper install claude-code >/dev/null
backupper config set subagentEnabled false >/dev/null
printf 'first\n' > notes.txt
printf 'original\n' > app.txt
git add -A && git commit -qm init
pre="$(hook_cmd claude-code PreToolUse)"
post="$(hook_cmd claude-code PostToolUse)"

# rm: tier 0 rewrites it into a move to the action's trash; run what the agent would run.
res="$(send "$pre" Bash '{"command":"rm notes.txt"}')"
run="$(node -e 'const o = JSON.parse(process.argv[1]); console.log(o.hookSpecificOutput?.updatedInput?.command ?? "rm notes.txt")' "$res")"
sh -c "$run"
printf '{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"rm notes.txt"},"tool_response":"","cwd":"%s"}' "$PWD" | sh -c "$post"
check "rm was rewritten into a reversible move" sh -c "echo '$run' | grep -qv '^rm notes.txt$'"
check "notes.txt is gone after the rm" test ! -e notes.txt

# Write: tier 2 snapshots the workspace first; then the file is overwritten.
send "$pre" Write "{\"file_path\":\"$PWD/app.txt\",\"content\":\"clobbered\\n\"}" >/dev/null
printf 'clobbered\n' > app.txt
printf '{"hook_event_name":"PostToolUse","tool_name":"Write","tool_input":{"file_path":"%s/app.txt"},"tool_response":"","cwd":"%s"}' "$PWD" "$PWD" | sh -c "$post"

n="$(backupper list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).total))')"
check "list shows both actions (got $n)" test "$n" = 2
check "show --latest --json works" sh -c 'backupper show --latest --json >/dev/null'
check "restore --file brings back app.txt from action 2" sh -c 'backupper restore 2 --file app.txt >/dev/null && grep -qx original app.txt'
printf 'clobbered\n' > app.txt
check "restore 1 undoes both actions" sh -c 'backupper restore 1 >/dev/null'
check "notes.txt restored with its content" grep -qx first notes.txt
check "app.txt restored with its content" grep -qx original app.txt

# ── 5. Uninstall leaves no hooks behind ─────────────────────────────
backupper uninstall >/dev/null
check "uninstall removes .claude/" test ! -e .claude

# ── 5b. A file outside the workspace: tier-2 copy, restore N and restore N --file /abs ──
new_project outside
backupper install claude-code >/dev/null
backupper config set subagentEnabled false >/dev/null
mkdir -p /srv/outside && printf 'port=80\n' > /srv/outside/cfg.ini
pre="$(hook_cmd claude-code PreToolUse)"
send "$pre" Edit '{"file_path":"/srv/outside/cfg.ini","old_string":"80","new_string":"81"}' >/dev/null
printf 'port=81\n' > /srv/outside/cfg.ini
check "outside edit captured as an exact copy" sh -c 'backupper show 1 --json | grep -q "\"file_copy\""'
check "restore 1 --file /srv/outside/cfg.ini brings it back" \
  sh -c 'backupper restore 1 --file /srv/outside/cfg.ini >/dev/null && grep -qx port=80 /srv/outside/cfg.ini'
printf 'port=81\n' > /srv/outside/cfg.ini
check "restore 1 (loop) brings the outside file back" \
  sh -c 'backupper restore 1 >/dev/null && grep -qx port=80 /srv/outside/cfg.ini'

# ── 5c. Codex: tier 0 is backup-only (Codex ignores a rewritten command) ──
new_project codex-backup-only
git config user.email e@x && git config user.name e
printf 'a\nb\n' > notes.txt && printf 'keep\n' > gone.txt && echo v0 > w.txt
git add -A && git commit -qm init
echo stashA > w.txt && git stash -q && echo stashB > w.txt && git stash -q
backupper install codex >/dev/null
backupper config set subagentEnabled false >/dev/null
pre="$(hook_cmd codex PreToolUse)"
for cmd in "sed -i 's/\$/!/' notes.txt" "git stash drop" "rm gone.txt"; do
  input="$(node -e 'console.log(JSON.stringify({command: process.argv[1]}))' "$cmd")"
  res="$(send "$pre" Bash "$input")"; code=$?
  if [ "$code" = 0 ] && ! echo "$res" | grep -q updatedInput; then ok "codex hook: no rewrite for: $cmd"; else bad "codex hook: no rewrite for: $cmd" "exit $code, output: $res"; fi
  sh -c "$cmd" >/dev/null 2>/tmp/cmd.err; rc=$?
  check "codex: '$cmd' runs once without error" test "$rc" = 0 -a ! -s /tmp/cmd.err
done
check "codex: notes.txt changed exactly once" sh -c 'printf "a!\nb!\n" | cmp -s - notes.txt'
check "codex: exactly one stash dropped" test "$(git stash list | wc -l)" = 1
check "codex: restore 1 succeeds" sh -c 'backupper restore 1 >/dev/null'
check "codex: notes.txt restored" sh -c 'printf "a\nb\n" | cmp -s - notes.txt'
check "codex: gone.txt restored" grep -qx keep gone.txt
check "codex: both stashes back" test "$(git stash list | wc -l)" = 2

# ── 6. The smoke suite, against the installed CLI ───────────────────
if BACKUPPER_BIN=backupper node /e2e/smoke.mjs > /tmp/smoke.log 2>&1; then
  ok "smoke suite ($(tail -n 1 /tmp/smoke.log))"
else
  bad "smoke suite" "$(grep -E 'FAIL|passed' /tmp/smoke.log | head -n 20)"
fi

# ── 7. No stray temp files ──────────────────────────────────────────
left="$(ls /tmp | grep '^backupper-sub-' || true)"
check "no backupper-sub-* temp files left in /tmp" test -z "$left"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
