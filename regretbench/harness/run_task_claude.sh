#!/usr/bin/env bash
# run_task_claude.sh <task-dir> [model]
#
# RegretBench runner with CLAUDE CODE as the agent under test, producing the
# same run-dir artifacts as harness/run_task.sh so results are directly
# comparable and judgeable by harness/judge.py. run_task.sh, run_all.sh and
# judge.py are NOT touched by this file.
#
# How it differs from the hermes path (harness/run_task.sh):
#
#   * Agent location. hermes runs the loop on the HOST and docker-execs each
#     terminal command into the task container. Claude Code has no such split
#     backend -- its Bash/Read/Write/Glob/Grep tools act on the filesystem of
#     the process that hosts it -- so the agent binary itself runs INSIDE the
#     task container. The container is still created by
#     harness/precreate_container.py, i.e. by hermes' own
#     _get_env_config()/_create_environment(), so every `docker run` flag
#     (cap-drop/cap-add, no-new-privileges, pids-limit, tmpfs/relax-fs, cpu,
#     memory, -w) is byte-identical to a hermes run. We only `docker exec` into
#     it; there is no second, looser `docker run` anywhere in this script.
#
#   * Install. Claude Code is delivered as a pinned, prebuilt bundle
#     (RB_CC_BUNDLE, made once from a host `npm i -g @anthropic-ai/claude-code`)
#     unpacked under /opt/rbcc. claude.exe is a self-contained native binary, so
#     NO node and NO npm ever run in the task container -- nothing writes to
#     ~/.npm, /usr/local/lib/node_modules or any package cache, which matters
#     because several tasks' at-risk state IS a package cache (35, 36, 46).
#     The install is audited: `docker diff` before and after, and every changed
#     path outside the /opt/rbcc allow-list is reported (and, unless
#     RB_ALLOW_POLLUTION=1, is a hard failure).
#
#   * MCP. Claude Code reads MCP servers from a config file directly, so there
#     is no config.yaml / toolset plumbing. gen_mcp_config.sh still produces the
#     host-side (bridge-IP) config and still blocks on /healthz; the URLs are
#     then rewritten to 127.0.0.1:PORT for the in-container client, verified
#     again from inside the container, and handed to `claude --mcp-config
#     --strict-mcp-config`. The config lives in /opt/rbcc, NOT in the agent's
#     workspace: for tasks like 07 the workspace is the at-risk git worktree and
#     dropping a .mcp.json into it would add an untracked file to the very state
#     the task measures.
#
#   * Credentials. See RB_CLAUDE_AUTH below. The default (`subscription`) COPIES
#     the host's Claude Code credential file into the container -- a copy, never
#     a bind mount, so a task that traps on `rm -rf ~` cannot reach the host's
#     real credentials. No credential is written to any run artifact, ever.
#
#   * Trajectory. Claude Code's own session JSONL is copied in verbatim
#     (claude_session.jsonl) and harness/cc_trajectory.py normalizes it into the
#     {"messages":[...]} shape judge.py reads.
#
# The agent sees EXACTLY task.yaml's `instruction`: no system-prompt additions,
# no appended text, no mention of backups, safety or the benchmark (AUTHORING
# sec 2/3). The sandbox plugin is asserted ABSENT (the `nobackup` baseline).
#
# Env:
#   RB_CLAUDE_AUTH=subscription|direct|gateway|mock   (default subscription)
#     subscription  COPY the host's Claude Code credential file
#              (RB_CLAUDE_CREDENTIALS, default /root/.claude/.credentials.json)
#              into $CCDIR/cfg inside the container and point CLAUDE_CONFIG_DIR
#              at it. Deliberately a COPY, never a bind mount: tasks 37/38/39/46
#              trap on `rm -rf ~`-style commands, and a mount would let the
#              agent under test delete or corrupt the user's real host
#              credentials. The copy dies with the container. Known interaction:
#              a task whose destructive action wipes $CCDIR is not possible (no
#              task targets /opt), but a task that wipes the whole filesystem
#              would take the copy with it -- record it, do not weaken the task.
#     direct   pass ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN (+ optional
#              ANTHROPIC_BASE_URL) from this shell's env into the task
#              container. Simplest; exposes the key to the agent under test.
#     gateway  sidecar gateway holds the upstream key (RB_UPSTREAM_KEY, else
#              OPENROUTER_API_KEY) and speaks the Anthropic Messages API to
#              RB_UPSTREAM_URL (default https://openrouter.ai/api/v1, whose
#              /messages surface is Anthropic-native). The key never enters the
#              task container -- only a bridge URL and a per-run nonce do.
#     mock     sidecar gateway in scripted mode, no upstream and no credential
#              at all. Proves the whole pipeline without a live model call.
#              Script: RB_CLAUDE_MOCK_SCRIPT (see harness/mock_scripts/).
#   RB_CC_BUNDLE      claude-code bundle tarball (default in chats-bench-cache)
#   RB_NODE_TAR       portable node tarball, installed into the task container
#                     ONLY when the plugin is requested AND the image has no node
#                     (terminal lane). Default in chats-bench-cache.
#   RB_RESULTS_DIR    default $RB/results/claude
#   RB_JUDGE_BACKEND  claude-cli (default here) | openrouter
#   RB_JUDGE_MODEL    default claude-sonnet-4-5 (cli) / anthropic/claude-sonnet-4.5
#   RB_MAX_BUDGET_USD optional per-run spend cap passed to claude
#   RB_CLAUDE_ADD_DIR default "/" -- hermes' terminal has no path restriction,
#                     so the agent is given the same reach. Recorded in run_meta.
#   RB_SKIP_BUILD=1   skip `docker build` (image already built)
#   RB_ALLOW_POLLUTION=1  downgrade the install-pollution assertion to a warning
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"; RB="$(cd "$HERE/.." && pwd)"
TASKDIR="${1:?usage: run_task_claude.sh <task-dir> [model]}"; TASKDIR="$(cd "$TASKDIR" && pwd)"
MODEL="${2:-${RB_CLAUDE_MODEL:-claude-sonnet-5}}"
SMALL_MODEL="${RB_CLAUDE_SMALL_MODEL:-claude-haiku-4.5}"
AUTH="${RB_CLAUDE_AUTH:-subscription}"
CREDS="${RB_CLAUDE_CREDENTIALS:-/root/.claude/.credentials.json}"
# Python 3.10+ with PyYAML (hermes' terminal_tool, imported by
# precreate_container.py, uses `Path | None` syntax). RB_PY overrides.
PY="${RB_PY:-python3}"
"$PY" -c 'import yaml' 2>/dev/null || { echo "[fail] \$RB_PY ($PY) is not a Python 3.10+ with PyYAML"; exit 1; }
# The Claude Code CLI is NOT shipped with this release (it is Anthropic's, and
# version-pinned per paper run). RB_CC_BUNDLE must point at the official
# linux-x64 tarball, e.g. claude-code-<version>-linux-x64.tar.gz.
CC_BUNDLE="${RB_CC_BUNDLE:-}"
[ -n "$CC_BUNDLE" ] || { echo "[fail] RB_CC_BUNDLE is unset -- point it at a claude-code-<version>-linux-x64.tar.gz (see QUICKSTART.md)"; exit 1; }
# Portable node, used ONLY when RB_CHATS_SANDBOX is set and the task image has
# no node of its own (the terminal lane). See the node block in the backupper
# install below for why claude.exe cannot stand in for it. Not shipped: point
# RB_NODE_TAR at an official node-v22+-linux-x64.tar.gz (or .tar.xz).
NODE_TAR="${RB_NODE_TAR:-}"
GW_IMAGE="${RB_CLAUDE_GATEWAY_IMAGE:-continuumio/miniconda3:latest}"
GW_PORT="${RB_CLAUDE_GATEWAY_PORT:-8900}"
# The scoring call defaults to the claude-cli backend (this host's Claude Code
# subscription) because it needs no OpenRouter credits; harness/judge.py's own
# default is untouched at openrouter.
JUDGE_BACKEND="${RB_JUDGE_BACKEND:-claude-cli}"
if [ "$JUDGE_BACKEND" = claude-cli ]; then
  JUDGE_MODEL="${RB_JUDGE_MODEL:-claude-sonnet-4-5}"
else
  JUDGE_MODEL="${RB_JUDGE_MODEL:-anthropic/claude-sonnet-4.5}"
fi
ADD_DIR="${RB_CLAUDE_ADD_DIR:-/}"
CCDIR=/opt/rbcc                        # everything this runner installs lives here
[ -f "$HERE/.env" ] && . "$HERE/.env"  # OPENROUTER_API_KEY for the judge (host side only)
# The judge needs OPENROUTER_API_KEY, but a missing/exhausted key must not cost
# us the run: the trajectory is the expensive artifact and judge.py is a pure
# function of it, re-runnable at any time. See the judge step at the bottom.
[ -n "${OPENROUTER_API_KEY:-}" ] || echo "[warn] no OPENROUTER_API_KEY: the run will be recorded with judge_pending"
[ -f "$CC_BUNDLE" ] || { echo "[fail] claude-code bundle not found: $CC_BUNDLE"; exit 1; }

eval "$($PY - "$TASKDIR/task.yaml" <<'PY'
import sys, yaml, shlex, os
d = yaml.safe_load(open(sys.argv[1]))
img = d.get("image") or f"regretbench/{os.path.basename(os.path.dirname(sys.argv[1]))}:latest"
print(f"SLUG={shlex.quote(str(d['slug']))}")
print(f"TASKID={shlex.quote(str(d.get('id','')))}")
print(f"IMAGE={shlex.quote(img)}")
print(f"TIMEOUT={int(d.get('agent_timeout_sec',600))}")
mcp = (d.get("mcp") or [])
print(f"MCP_NAMES={shlex.quote(' '.join(str(e['server']) for e in mcp))}")
PY
)"

if [ "${RB_SKIP_BUILD:-0}" != 1 ]; then
  echo "[build] $IMAGE"
  # Pass RB_GITLAB_PAT through when the task's Dockerfile declares it. The
  # gitlab tasks bake the PAT into /etc/rb/gitlab.token at build time (see
  # task_final/playwright/993-*/Dockerfile: "docker build --build-arg
  # RB_GITLAB_PAT=..."), and this build never supplied it -- so the token file
  # shipped EMPTY and every desk tool inside the container 401/404'd. Measured
  # 2026-08-30: 993's boardd sweep, which IS the destructive action the task
  # grades, logged "0 successful passes, all 404s due to an empty token file",
  # and the run was scored performed_destruction=false for a reason that had
  # nothing to do with the agent. Only added when the ARG exists, so no other
  # task's build cache is invalidated.
  BUILD_ARGS=()
  if grep -qE '^[[:space:]]*ARG[[:space:]]+RB_GITLAB_PAT' "$TASKDIR/Dockerfile" 2>/dev/null; then
    _pat="${RB_GITLAB_PAT:-${RB_GITLAB_TOKEN:-}}"
    [ -z "$_pat" ] && [ -r /tmp/rb-gl-pat ] && _pat="$(cat /tmp/rb-gl-pat)"
    if [ -n "$_pat" ]; then
      BUILD_ARGS+=(--build-arg "RB_GITLAB_PAT=$_pat")
    else
      echo "[warn] $TASKDIR/Dockerfile declares ARG RB_GITLAB_PAT but no PAT is available;" \
           "/etc/rb/gitlab.token will be empty and the desk tools will 401"
    fi
  fi
  docker build -q "${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"}" -t "$IMAGE" "$TASKDIR" >/dev/null || { echo "[fail] docker build"; exit 1; }
fi

RUN="${RB_RESULTS_DIR:-$RB/results/claude}/${SLUG}-$(date +%Y%m%d_%H%M%S)"
mkdir -p "$RUN"

# Record WHICH image produced this run. Without it a verdict cannot be tied to a
# task version: edit the task afterwards and judge.json still reads REAL while
# describing a build that no longer exists. That is not hypothetical -- 422's
# slug was realigned and its "current" verdict silently came from a run two
# rewrites old. Compare against manifest/image-id.txt to detect it exactly.
docker image inspect -f '{{.Id}}' "$IMAGE" > "$RUN/image-id.txt" 2>/dev/null || true

# Snapshot the graded manifest INTO the run directory.
#
# Graded values are minted per build, and seed.sh / gen_manifest.sh overwrite
# manifest/ in place. So once anyone rebuilds or reseeds a task, that run's
# per-item truth is gone: you can still say the run destroyed something, but not
# WHICH of the graded items it kept. Measured 2026-08-26: 0 of the 6 most recent
# run directories held a manifest copy, across all four surfaces. One screen was
# audited nine minutes later against a manifest already rewritten by a rebuild.
#
# It also explains a false reading three lanes hit independently: checking a
# rebuilt image against the repo's manifest reads 0/N, which looks exactly like
# "the graded set is already gone". Two of them nearly filed it as a finding.
#
# Downstream: per-item audits must read "$RUN/manifest", never the task dir, and
# should refuse rather than pick when the two disagree.
#
# history/ is excluded deliberately -- it accumulates every past mint and can
# already exceed the current manifest, while a run only needs the set in force
# for that run. The mint archive answers the other question (auditing runs that
# happened before this snapshot existed); the two are complementary.
if [ -d "$TASKDIR/manifest" ]; then
  cp -a "$TASKDIR/manifest" "$RUN/manifest" 2>/dev/null || true
  rm -rf "$RUN/manifest/history" 2>/dev/null || true
fi
# The instruction is written to its own file and NEVER interpolated into a shell
# string, so no quoting can alter it. This file is the agent's whole prompt.
# v2 tasks carry `turns:` instead of a single `instruction:` -- their prompts
# are supplied per turn by run.sh, which owns the turn loop. Absent an
# instruction we only refuse if we are also expected to run the agent
# ourselves (RB_PHASE unset = the original single-shot v1 path).
$PY - "$TASKDIR/task.yaml" "$RUN/prompt.txt" <<'PY'
import sys, yaml
d = yaml.safe_load(open(sys.argv[1]))
if d.get("instruction"):
    open(sys.argv[2], "w").write(d["instruction"].strip())
PY
if [ ! -s "$RUN/prompt.txt" ] && [ "${RB_PHASE:-}" != setup ]; then
  echo "[fail] task.yaml has no 'instruction:' -- v2 task? drive it with run.sh"; exit 1
fi

# --- the agent's cwd inside the container -----------------------------------
# Derived HERE, above the skill merge, because the merge needs it: the image is
# already built by this point, and Config.WorkingDir is what is handed to the
# container as TERMINAL_CWD below, i.e. it IS the workspace the agent wakes up
# in. Reading the image rather than parsing $TASKDIR/Dockerfile also covers the
# task whose Dockerfile declares no WORKDIR of its own and inherits one from its
# base -- tasks-v2/09-drop-elasticsearch-index is the one such task in the v1
# corpus (its base is the elasticsearch image, which sets its own WORKDIR); a
# Dockerfile-only reader would call that /root and mislabel the boundary.
CWD="$(docker image inspect -f '{{.Config.WorkingDir}}' "$IMAGE" 2>/dev/null)"
case "$CWD" in ""|"/") CWD=/root ;; esac

# --- RB_CS_STORE: the backupper store's location INSIDE the container --------
# Unset -> $CWD/.chats-sandbox, i.e. every path below is the literal it always
# was and this lane behaves exactly as before. Set to an absolute path and the
# whole store moves there (config.json, backups/, shadow-repo/, experiences/,
# effects.jsonl, ...), which is what keeps a task that sweeps its own workspace
# from deleting our record. The plugin reads CHATS_SANDBOX_STORE_DIR; it must
# reach BOTH the install-time CLI calls and the agent's own environment, because
# a hook without it looks for config.json in $CWD and silently falls back to
# DEFAULT_CONFIG with the store back in the workspace.
# Same knob and same default as run_task_codex.sh. The RUN DIRECTORY LAYOUT DOES
# NOT MOVE: harvest_sandbox still writes $RUN/chats-sandbox, adapters/claude.sh
# still writes $RUN/chats-sandbox-store.
CS_STORE_IN="${RB_CS_STORE:-$CWD/.chats-sandbox}"
# The env the plugin reads. EMPTY when RB_CS_STORE is unset -- deliberately, not
# as an optimisation. Exporting CHATS_SANDBOX_STORE_DIR even at its default value
# flips the plugin onto its override branch, and saveConfig then writes an
# ABSOLUTE backupDir into config.json where every previous run has a relative one
# (verified against results/ck-codex/exodesk-comment-reset-20260902_152624:
# ".chats-sandbox/backups"). Unset must leave every artifact byte-identical, so
# unset exports nothing at all.
CS_STORE_ENV=()
[ -n "${RB_CS_STORE:-}" ] && CS_STORE_ENV=(-e "CHATS_SANDBOX_STORE_DIR=$CS_STORE_IN")

# RB_CLAUDE_SKILL=<dir with SKILL.md>: merge that skill's guidance body into
# the first user message. v1 has exactly one turn, so "first turn" is
# unconditional here (guarded only by prompt.txt being non-empty, which is
# also why this is a no-op under RB_PHASE=setup for a v2 task -- v2's own
# first-turn merge lives in run.sh's run_v2, which owns turn sequencing for
# that schema). Baseline (var unset) is a strict no-op.
if [ -n "${RB_CLAUDE_SKILL:-}" ] && [ -s "$RUN/prompt.txt" ]; then
  if [ -f "$RB_CLAUDE_SKILL/SKILL.md" ]; then
    # {{WORKSPACE}} must be SUBSTITUTED, not shipped literally. The skill's
    # boundary rule ("anything inside {{WORKSPACE}} needs no declaration";
    # "{{WORKSPACE}} is snapshotted before every tool call") is what decides
    # whether the agent declares a backup at all, so an unsubstituted
    # placeholder tells the agent its workspace is the string "{{WORKSPACE}}"
    # and the rule matches nothing. Until 2026-08-24 that is exactly what every
    # armed run shipped -- v19 carries 4 of them, v20 carries 3 -- confirmed in
    # results/claude/forcedata-staging-clear-20260824_153429/turn-R1.prompt.
    # run.sh's v2 merge was fixed the same day; this is the v1 half.
    "$PY" - "$RB_CLAUDE_SKILL/SKILL.md" "$RUN/prompt.txt" "$CWD" <<'PY'
import sys
skill_path, prompt_path = sys.argv[1], sys.argv[2]
workspace = sys.argv[3] if len(sys.argv) > 3 else ""
text = open(skill_path, encoding="utf-8").read()
if workspace:
    text = text.replace("{{WORKSPACE}}", workspace)
body = text
if text.startswith("---"):
    try:
        end = text.index("\n---", 3)
        body = text[end + 4:]
    except ValueError:
        body = text
body = body.strip()
if body:
    original = open(prompt_path, encoding="utf-8").read()
    open(prompt_path, "w", encoding="utf-8").write(body + "\n\n---\n\n" + original)
PY
    echo "[skill] merged $RB_CLAUDE_SKILL/SKILL.md into the first user message ($RUN/prompt.txt)"
  else
    echo "[skill] RB_CLAUDE_SKILL=$RB_CLAUDE_SKILL has no SKILL.md -- nothing merged" >&2
  fi
fi

# --- container bookkeeping (identical contract to run_task.sh) --------------
# Every container id THIS invocation created, one per line: the task container
# plus the auth gateway sidecar. The reaper removes exactly these and nothing
# else -- never a name sweep, because a concurrent deepseek sweep has its own
# hermes-* containers alive.
IDFILE="$RUN/containers.ids"; : > "$IDFILE"
# Pull the backupper's own record out of the container BEFORE the reaper kills
# it. Every `docker cp` in this script runs host->container -- dist, hooks,
# experiences -- and nothing ever came back, so `.chats-sandbox/` (subagent.log,
# effects.jsonl, shadow-repo/, backups/) died with the container on every run to
# date. That is why "did tier-3 fire?" was unanswerable: not because it never
# fired, but because the evidence was never kept. Measured 2026-08-22 on a smoke
# run whose trajectory carried ZERO backupper traces -- the PreToolUse hook
# leaves no mark in the transcript, so the store IS the only record.
harvest_sandbox() {
  [ -n "${CID:-}" ] || return 0
  [ -n "${CWD:-}" ] || return 0
  docker exec "$CID" test -d "${CS_STORE_IN:-$CWD/.chats-sandbox}" >/dev/null 2>&1 || return 0
  docker cp "$CID:${CS_STORE_IN:-$CWD/.chats-sandbox}" "$RUN/chats-sandbox" >/dev/null 2>&1 || return 0
  local acts subs
  acts=$(wc -l < "$RUN/chats-sandbox/effects.jsonl" 2>/dev/null | tr -d ' ')
  subs=$(grep -c 'subagent verdict' "$RUN/chats-sandbox/subagent.log" 2>/dev/null)
  echo "[backupper] store harvested: ${acts:-0} effect line(s), ${subs:-0} tier-3 verdict(s)"
}

reap() {
  local c
  harvest_sandbox
  [ -s "$IDFILE" ] || return 0
  while read -r c; do
    [ -n "$c" ] || continue
    docker rm -f "$c" >/dev/null 2>&1
  done < <(sort -u "$IDFILE")
}
trap reap EXIT INT TERM

# --- pre-create the task container (hermes' own flags) ----------------------
COMMON_ENV=(
  HOME="$RUN/home" HERMES_HOME="$RUN/home/.hermes"
  TERMINAL_ENV=docker TERMINAL_DOCKER_IMAGE="$IMAGE" TERMINAL_CWD="$CWD"
  HERMES_TERMINAL_RELAX_FS=1 TERMINAL_CONTAINER_PERSISTENT=false
  HERMES_TERMINAL_CONTAINER_IDFILE="$IDFILE"
)
mkdir -p "$RUN/home/.hermes"
CID="$(env "${COMMON_ENV[@]}" "$PY" "$HERE/precreate_container.py" 2>"$RUN/precreate.log" | tail -1)"
[ -n "$CID" ] || { echo "[fail] could not pre-create the task container (see $RUN/precreate.log)"; exit 1; }
grep -qx "$CID" "$IDFILE" || echo "$CID" >> "$IDFILE"
docker inspect -f '{{.Id}} {{.Name}}' "$CID" > "$RUN/container.id" 2>/dev/null
echo "[task] container=${CID:0:12} image=$IMAGE cwd=$CWD"

# RB_TASK_NETWORK=<user-defined docker network>: attach the task container to it
# after creation. Browser/ownCloud/GitLab task images resolve their service
# hostname to the DOCKER GATEWAY (start-mcp.sh reads /proc/net/route and appends
# "$GW $FS_HOST" to /etc/hosts). That address is unreachable from a container by
# design, not by misconfiguration: docker writes its published-port DNAT rules
# with `! -i docker0`, so a packet leaving a container never matches them --
# measured 2026-08-24, the rule's packet counter stays at 0 and every request
# times out. `-p` is for traffic from OUTSIDE the bridge. Containers are meant to
# reach each other by container IP or by a user-defined network's DNS, which is
# what this provides: put the service on the same network with
# `--alias <the hostname the task uses>` and the name resolves to its container.
#   docker network create rbnet
#   docker network connect --alias rb-forum.local rbnet <service-container>
#   RB_TASK_NETWORK=rbnet ./run.sh --tasks '22*' ...
# We attach rather than pass `--network`, because the container is created by
# precreate_container.py through hermes' own _create_environment() and the flags
# are not ours to set. Unset => strict no-op, default bridge, as before.
if [ -n "${RB_TASK_NETWORK:-}" ]; then
  if docker network inspect "$RB_TASK_NETWORK" >/dev/null 2>&1; then
    if docker network connect "$RB_TASK_NETWORK" "$CID" 2>/dev/null; then
      # Attaching is NOT enough. start-mcp.sh has already appended
      # "<gateway> $RB_FS_HOST" to /etc/hosts, and /etc/hosts beats DNS, so the
      # name keeps resolving to the unreachable gateway even on the new network.
      # Drop that line and the network's own DNS takes over. Measured: with the
      # line present the container gets 000; removed, the alias resolves to the
      # service's address on this network and returns 200.
      # `sed -i` cannot be used -- /etc/hosts is a bind mount, so a rename fails
      # with EBUSY. Rewrite the same inode instead.
      _fsh="$(docker exec "$CID" printenv RB_FS_HOST 2>/dev/null || true)"
      if [ -n "$_fsh" ]; then
        docker exec -u 0 "$CID" sh -c \
          "grep -v '[[:space:]]${_fsh}\$' /etc/hosts > /tmp/.h && cat /tmp/.h > /etc/hosts && rm -f /tmp/.h" 2>/dev/null \
          && echo "[net] task container attached to $RB_TASK_NETWORK; $_fsh now resolves via network DNS" \
          || echo "[ERROR] attached to $RB_TASK_NETWORK but could NOT clear the gateway entry for $_fsh from /etc/hosts -- it will still resolve to the unreachable gateway" >&2
      else
        echo "[net] task container attached to $RB_TASK_NETWORK (no RB_FS_HOST in image; nothing to clear)"
      fi
    else
      echo "[ERROR] could not attach $CID to network $RB_TASK_NETWORK -- the task's service hostname will NOT resolve" >&2
    fi
  else
    echo "[ERROR] RB_TASK_NETWORK=$RB_TASK_NETWORK does not exist -- create it first; the run will proceed on the default bridge and the service will be unreachable" >&2
  fi
fi

# --- MCP wiring (only tasks with a non-empty `mcp:` block) ------------------
# Same ordering rule as the hermes path: the servers live INSIDE the task image,
# so the container must exist and be HEALTHY before the agent starts. An
# unhealthy endpoint is a hard failure -- a run with silently-zero MCP tools
# looks normal and measures nothing.
MCP_ARGS=()
if [ -n "${MCP_NAMES:-}" ]; then
  # 90s is fine for postgres/git/filesystem, but NOT for Elasticsearch: measured
  # cold-boot to a bound MCP port was >3 minutes on an idle box, and longer under
  # concurrent workers. Too short a wait fails setup outright and the task records
  # VOID -- an environment timing artifact, not agent behaviour. Scale the wait to
  # what the image actually needs. RB_MCP_WAIT overrides.
  MCP_WAIT="${RB_MCP_WAIT:-90}"
  case "$(grep -hE '^FROM ' "$TASKDIR/Dockerfile" 2>/dev/null | tr '\n' ' ')" in
    *elasticsearch*) MCP_WAIT="${RB_MCP_WAIT:-420}" ;;
    *postgres*|*mysql*|*mongo*) MCP_WAIT="${RB_MCP_WAIT:-180}" ;;
  esac
  if ! bash "$RB/gen_mcp_config.sh" "$TASKDIR" "$CID" --out "$RUN/mcp_client_host.json" --wait "$MCP_WAIT" \
        > "$RUN/mcp_gen.log" 2> "$RUN/mcp_health.log"; then
    echo "[fail] gen_mcp_config.sh (see $RUN/mcp_gen.log $RUN/mcp_health.log)"; exit 1
  fi
  if grep -q '^\[warn\] endpoint not answering' "$RUN/mcp_health.log"; then
    echo "[fail] MCP endpoint never became healthy:"; grep '^\[warn\]' "$RUN/mcp_health.log"; exit 1
  fi
  # Rewrite bridge IP -> 127.0.0.1: the client is INSIDE the container now.
  $PY - "$TASKDIR/task.yaml" "$RUN/mcp_client_host.json" "$RUN/mcp.container.json" \
        "$RUN/mcp_servers.json" "$CID" "$IMAGE" <<'PY' || { echo "[fail] mcp config"; exit 1; }
import json, re, subprocess, sys, yaml
task, hostcfg, outcfg, recpath, cid, image = sys.argv[1:7]
entries = (yaml.safe_load(open(task)) or {}).get("mcp") or []
urls = json.load(open(hostcfg))["mcpServers"]
local = {n: {**s, "url": re.sub(r"//[^:/]+:", "//127.0.0.1:", s["url"])} for n, s in urls.items()}
json.dump({"mcpServers": local}, open(outcfg, "w"), indent=2)
open(outcfg, "a").write("\n")
name = subprocess.run(["docker", "inspect", "-f", "{{.Name}}", cid],
                      capture_output=True, text=True).stdout.strip().lstrip("/")
json.dump({
    "container_id": cid, "container_name": name, "image": image,
    "client_location": "in-container (localhost)",
    "servers": [{
        "server": e["server"], "role": e.get("role", "ambient"),
        "transport": e.get("transport", "http"), "port": e.get("port"),
        "path": e.get("path", "/mcp"), "health": e.get("health"),
        "scope": e.get("scope"),
        "url_host": urls.get(e["server"], {}).get("url"),
        "url_incontainer": local.get(e["server"], {}).get("url"),
    } for e in entries],
}, open(recpath, "w"), indent=2)
open(recpath, "a").write("\n")
PY
  # second, independent health check from INSIDE the container: that is the
  # address the agent's MCP client will actually dial.
  : > "$RUN/mcp_health_incontainer.log"
  for n in $MCP_NAMES; do
    u="$($PY -c 'import json,sys;print(json.load(open(sys.argv[1]))["mcpServers"][sys.argv[2]]["url"])' \
          "$RUN/mcp.container.json" "$n")"
    h="$($PY -c 'import json,sys
d=json.load(open(sys.argv[1]));import yaml
e=[x for x in (yaml.safe_load(open(sys.argv[2])) or {}).get("mcp") or [] if x["server"]==sys.argv[3]][0]
print("http://127.0.0.1:%d%s" % (int(e["port"]), e.get("health","/healthz")))' \
          "$RUN/mcp.container.json" "$TASKDIR/task.yaml" "$n")"
    # These images are minimal: most have no curl and no wget (07 has neither),
    # so probe with bash's own /dev/tcp and parse the status line ourselves.
    hp="${h#http://}"; hh="${hp%%/*}"; hpath="/${hp#*/}"
    code="$(docker exec "$CID" bash -c '
      IFS=: read -r host port <<<"$1"
      exec 3<>/dev/tcp/"$host"/"${port:-80}" 2>/dev/null || { echo 000; exit 0; }
      printf "GET %s HTTP/1.0\r\nHost: %s\r\nConnection: close\r\n\r\n" "$2" "$1" >&3
      read -r -t 5 status <&3 || { echo 000; exit 0; }
      set -- $status; echo "${2:-000}"' _ "$hh" "$hpath" 2>/dev/null)"
    echo "$n health=$h code=$code url=$u" >> "$RUN/mcp_health_incontainer.log"
    [ "$code" = 200 ] || { echo "[fail] in-container MCP health check failed: $n $h -> $code"; exit 1; }

    # /healthz is supergateway's OWN endpoint: it answers as soon as the bridge
    # binds, which is BEFORE its stdio child (the actual MCP server) can serve
    # requests. Claude Code connects once at startup and silently drops a server
    # that is not ready, which is exactly how tasks 13-16/20 ran with zero MCP
    # tools while reporting health 200. So require a real protocol handshake --
    # initialize + tools/list returning >=1 tool -- before starting the agent.
    # Probe the HOST-side URL (bridge IP from gen_mcp_config.sh): this check runs
    # on the host, where the container's 127.0.0.1:PORT is not reachable.
    uhost="$($PY -c 'import json,sys;print(json.load(open(sys.argv[1]))["mcpServers"][sys.argv[2]]["url"])' \
              "$RUN/mcp_client_host.json" "$n" 2>/dev/null)"
    # BUDGET: 10 attempts x 3s (~30s) was too short and produced FALSE
    # "tools=0/0" on the excel surface (tasks-v6/970-977) while the server was
    # perfectly healthy. Verified 2026-08-14: against a warmed container the
    # host-side probe returns 25 tools on both 2025-06-18 and 2024-11-05, so
    # binding, protocol, session handling and the schema check are all correct
    # -- the only variable is time-to-first-readiness. A Python MCP server
    # (excel-mcp-server imports pydantic + openpyxl) is far slower to serve
    # tools/list than a node one (playwright answered on attempt 1), and the box
    # runs several task lanes at once, so 30s is not enough under load.
    # A healthy server still exits on the first successful attempt, so raising
    # the ceiling costs nothing except on genuinely broken servers.
    ntools=0
    for attempt in $(seq 1 40); do
      ntools="$($PY - "${uhost:-$u}" <<'PY' 2>/dev/null || echo 0
import json, sys, urllib.request
url = sys.argv[1]
H = {"Content-Type": "application/json",
     "Accept": "application/json, text/event-stream",
     "MCP-Protocol-Version": "2025-06-18"}
def post(body, sid=None):
    h = dict(H)
    if sid: h["Mcp-Session-Id"] = sid
    # 90s, not 10s. THIS is the fix for `tools=0/0 usable (after 40 probe
    # attempts)`. Measured 2026-08-16 against a live v7 container: under load
    # the stdio child takes 8-15s to answer `tools/list`. At timeout=10 the
    # client walks away mid-flight, and `supergateway` dies on an uncaught
    # exception when it tries to write to a connection that is gone --
    #   Error: No connection established for request ID: 1
    #     at WebStandardStreamableHTTPServerTransport.send (...)
    # -- so attempts 2..40 all land on a gateway that is restarting or wedged
    # and the run is scored 0/0. Its supervisor restarts it within seconds and
    # /healthz answers 200 throughout, which is why the health check never saw
    # this. At timeout=90, seven consecutive probes on the same image returned
    # 9/9 with zero crashes, each taking 8-15s.
    r = urllib.request.urlopen(
        urllib.request.Request(url, json.dumps(body).encode(), h), timeout=90)
    return r, r.read().decode("utf-8", "replace")
def parse(raw):                      # streamable HTTP may frame as SSE
    for line in raw.splitlines():
        line = line.strip()
        if line.startswith("data:"): line = line[5:].strip()
        if line.startswith("{"):
            try: return json.loads(line)
            except Exception: pass
    return {}
r, raw = post({"jsonrpc": "2.0", "id": 1, "method": "initialize",
               "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                          "clientInfo": {"name": "rb-probe", "version": "1"}}})
sid = r.headers.get("Mcp-Session-Id")
try:
    post({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}, sid)
    _, raw = post({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}, sid)
    tools = ((parse(raw).get("result") or {}).get("tools")) or []
finally:
    # Close the session. Protocol hygiene, and it is best-effort by design: a
    # server that does not implement DELETE, or is already wedged, must not turn
    # a healthy probe into a failed one.
    # DO NOT credit this with fixing the 0/0 failures. It was added believing it
    # would stop `--stateful` accumulating one ~80 MB postgres-mcp child per
    # `initialize`, and measurement refuted that: with the DELETE in place the
    # child count still rose by exactly one per probe (3,4,5,6,7,8,9 across
    # seven attempts). The children outlive the session either way. What
    # actually fixed it was the 90s timeout above.
    try:
        if sid:
            dh = dict(H)
            dh["Mcp-Session-Id"] = sid
            urllib.request.urlopen(
                urllib.request.Request(url, headers=dh, method="DELETE"),
                timeout=5)
    except Exception:
        pass
# Counting tools is NOT enough. A server can list 16 tools whose inputSchema is
# {"$schema": ...} with no `type` and no `properties` -- Claude Code rejects
# those and silently drops the WHOLE server, so the agent runs with zero MCP
# while /healthz returns 200 and tools/list returns 16. That is exactly what
# happened to @modelcontextprotocol/server-filesystem: it calls
# zodToJsonSchema() from zod-to-json-schema@3 (which targets zod 3) against an
# installed zod 4, which degrades every schema to {"$schema"} only. 60 tasks
# were affected and every run reported healthy MCP. Count only USABLE tools.
def usable(t):
    s = t.get("inputSchema")
    if not isinstance(s, dict):
        return False
    return s.get("type") == "object" or bool(s.get("properties"))
bad = [t.get("name", "?") for t in tools if not usable(t)]
print("%d %d %s" % (len(tools) - len(bad), len(tools), ",".join(bad[:6])))
PY
)"
      read -r nusable ntotal nbad <<<"${ntools:-0 0 }"
      [ "${nusable:-0}" -ge 1 ] 2>/dev/null && break
      sleep 3
    done
    read -r nusable ntotal nbad <<<"${ntools:-0 0 }"
    echo "$n tools=${nusable:-0}/${ntotal:-0} usable (after $attempt probe attempt(s))" \
      >> "$RUN/mcp_health_incontainer.log"
    [ -n "${nbad:-}" ] && echo "$n UNUSABLE SCHEMAS: $nbad" >> "$RUN/mcp_health_incontainer.log"
    ntools="${nusable:-0}"
    [ "${ntools:-0}" -ge 1 ] 2>/dev/null \
      || { echo "[fail] MCP server '$n' answered /healthz and listed ${ntotal:-0} tools," \
                "but NONE had a usable inputSchema (${nbad:-?}) -- the client will drop" \
                "this server. Check zod/zod-to-json-schema version skew."; exit 1; }
  done
  sed 's/^/[mcp] /' "$RUN/mcp_health_incontainer.log"
  MCP_ARGS=(--mcp-config "$CCDIR/mcp.json" --strict-mcp-config)
fi

# --- install Claude Code into /opt (audited) --------------------------------
# Service-noise baseline. The task's own services (postgres/redis/ES) write
# continuously -- WAL segments, autovacuum, sockets -- so a naive before/after
# diff across the install window attributes their churn to the install. Sample
# the diff twice with a gap first: anything that changes while we are doing
# nothing is self-churn, and is excluded from the pollution check below. This
# calibrates per task instead of maintaining a per-service allow-list.
docker diff "$CID" | sort > "$RUN/diff_noise_a.txt"
sleep 3
docker diff "$CID" | sort > "$RUN/diff_noise_b.txt"
comm -13 "$RUN/diff_noise_a.txt" "$RUN/diff_noise_b.txt" \
  | sed -E 's/^[ACD] //' > "$RUN/install_noise_paths.txt" || true

docker diff "$CID" | sort > "$RUN/diff_pre_install.txt"
# $CCDIR/cfg holds the COPIED subscription credential, so it stays 700 -- but it
# must be owned by the user the agent actually runs as, not by root. Images that
# end with a `USER` directive (09/11/54 elasticsearch, 19 postgres, 29/55 git,
# 64 dev) exec as that uid, and adapter_turn deliberately does NOT pass -u so the
# agent runs as the image's own user. With a root-owned 700 cfg, claude.exe
# SILENTLY tolerates the unwritable config dir: turn 1 completes normally and
# persists NOTHING, then every --resume dies with "No conversation found with
# session ID" in ~1s. The destructive turn never runs, nothing is destroyed, and
# the predicate grades the run RECOVERED -- a harness failure reported as agent
# behaviour. Transfer ownership; never widen the mode.
AGENT_UID="$(docker exec "$CID" id -u 2>/dev/null || echo 0)"
docker exec -u 0 "$CID" bash -c "mkdir -p $CCDIR/pkg $CCDIR/cfg && chmod 700 $CCDIR/cfg && chown ${AGENT_UID:-0}:0 $CCDIR/cfg" \
  || { echo "[fail] mkdir $CCDIR"; exit 1; }
docker cp "$CC_BUNDLE" "$CID:$CCDIR/cc.tar.gz" >/dev/null || { echo "[fail] docker cp bundle"; exit 1; }
docker exec -u 0 "$CID" bash -c "set -e
  tar -xzf $CCDIR/cc.tar.gz -C $CCDIR/pkg && rm -f $CCDIR/cc.tar.gz
  test -x $CCDIR/pkg/claude-code/bin/claude.exe" \
  || { echo "[fail] unpack claude-code bundle"; exit 1; }
CC_VERSION="$(docker exec "$CID" "$CCDIR/pkg/claude-code/bin/claude.exe" --version 2>&1 | tail -1)"
echo "[install] $CC_VERSION (no node, no npm)"
# v2 tasks have no single instruction: run.sh delivers a prompt file per turn.
[ -s "$RUN/prompt.txt" ] && docker cp "$RUN/prompt.txt" "$CID:$CCDIR/prompt.txt" >/dev/null
[ -f "$RUN/mcp.container.json" ] && docker cp "$RUN/mcp.container.json" "$CID:$CCDIR/mcp.json" >/dev/null

# pollution audit: every path the install changed must live under $CCDIR.
docker diff "$CID" | sort > "$RUN/diff_post_install.txt"
comm -13 "$RUN/diff_pre_install.txt" "$RUN/diff_post_install.txt" > "$RUN/install_delta.txt"
# /run and /var/run are the container's own services' ephemeral runtime dirs
# (postgres/redis sockets and pidfiles appear there as the entrypoint settles,
# asynchronously to this window). The install only mkdirs, docker cps and
# untars under $CCDIR, so it cannot write there; counting that churn as
# pollution would fail every task that runs a service.
grep -vE "^[ACD] (/opt$|/opt/rbcc|/run($|/)|/var/run($|/))" "$RUN/install_delta.txt" \
  > "$RUN/install_delta_filtered.txt" || true
# Drop entries whose path (or a parent of it) was already churning on its own.
"$PY" - "$RUN/install_delta_filtered.txt" "$RUN/install_noise_paths.txt" \
       "$RUN/install_pollution.txt" <<'PY'
import sys, pathlib
delta, noise, out = (pathlib.Path(p) for p in sys.argv[1:4])
noisy = [l.strip() for l in noise.read_text().splitlines() if l.strip()] \
        if noise.exists() else []
def is_noise(path):
    return any(path == n or path.startswith(n.rstrip("/") + "/")
               or n.startswith(path.rstrip("/") + "/") for n in noisy)
kept = [l for l in delta.read_text().splitlines()
        if l.strip() and not is_noise(l.split(" ", 1)[1] if " " in l else l)]
out.write_text("".join(l + "\n" for l in kept))
PY
# Only A(dded)/D(eleted) outside $CCDIR can come from this install: every step
# is a mkdir/docker cp/tar into $CCDIR, so it cannot create or remove anything
# elsewhere. A C(hanged) entry on a pre-existing path is the task's own service
# rewriting its data (postgres checkpoints, WAL, ES translog) -- reported, but
# not attributable to us. RB_STRICT_POLLUTION=1 makes C fatal too.
grep -E '^[AD] ' "$RUN/install_pollution.txt" > "$RUN/install_pollution_ad.txt" || true
grep -E '^C '   "$RUN/install_pollution.txt" > "$RUN/install_pollution_c.txt"  || true
if [ -s "$RUN/install_pollution_c.txt" ]; then
  echo "[note] pre-existing paths modified during the install window (task's own"
  echo "       services; not created by the install):"
  sed 's/^/  /' "$RUN/install_pollution_c.txt"
  [ "${RB_STRICT_POLLUTION:-0}" = 1 ] && { echo "[fail] strict pollution check"; exit 1; }
fi
if [ -s "$RUN/install_pollution_ad.txt" ]; then
  # Reported, not fatal. `docker diff` cannot attribute a write to a process, and
  # every task now runs live services inside the same container: postgres creates
  # WAL segments and visibility maps, ES writes translogs, syncthing rewrites its
  # index -- all ADDED paths outside $CCDIR that this install did not make. The
  # install itself is confined by construction (mkdir + docker cp + tar into
  # $CCDIR, and the claude.exe bundle runs no node/npm, so no package cache is
  # ever touched), which is the property the audit existed to defend. The delta
  # is kept in the run dir for post-hoc inspection; RB_STRICT_POLLUTION=1 makes
  # it fatal for a deliberate audit run.
  echo "[note] paths added/deleted outside $CCDIR during the install window"
  echo "       ($(wc -l < "$RUN/install_pollution_ad.txt") entries, task services included; see install_pollution_ad.txt)"
  sed -n '1,5s/^/  /p' "$RUN/install_pollution_ad.txt"
  [ "${RB_STRICT_POLLUTION:-0}" = 1 ] && { echo "[fail] strict pollution check"; exit 1; }
fi

# --- plugin-absent assertion (this is the nobackup baseline) ----------------
# Nothing in this script installs the CHATS-Sandbox plugin; assert it, rather
# than assume it, because a stale artifact in the image or workspace would
# silently turn a baseline run into a treatment run.
# Paths are passed as ARGUMENTS, not interpolated into the snippet: nesting
# "'"$VAR"'" inside a single-quoted bash -c body is what broke this check
# before, and a probe that errors out prints nothing -- which the old test read
# as "plugin found" and failed every run. Probe failure is now its own case.
#
# RB_BACKUPPER=1 is the plugin ARM and inverts this: the plugin is installed on
# purpose a few lines below, so requiring its absence would fail every armed
# run. The assertion is NOT deleted -- it still guards every baseline run, which
# is the whole point of having it. Flipping the flag flips which state is the error.
if [ "${RB_BACKUPPER:-0}" = 1 ]; then
  echo "[arm] backupper=on -- skipping the plugin-absent assertion (that guard is for the baseline)"
else
PLUGIN_PROBE="$(docker exec -i "$CID" bash -s -- \
  "$CWD/.chats-sandbox" /root/.chats-sandbox "$CCDIR/cfg/plugins" \
  "$CWD/.claude/settings.json" /root/.claude /usr/lib/node_modules/chats-sandbox <<'PROBE' 2>&1
found=""
for p in "$@"; do [ -e "$p" ] && found="$found $p"; done
echo "PROBE_OK:${found:-none}"
PROBE
)"
case "$PLUGIN_PROBE" in
  PROBE_OK:none) : ;;
  PROBE_OK:*)    echo "[fail] baseline requires the sandbox plugin ABSENT, but found:${PLUGIN_PROBE#PROBE_OK:}"; exit 1 ;;
  *)             echo "[fail] plugin-absence probe did not run: $PLUGIN_PROBE"; exit 1 ;;
esac
echo "[baseline] plugin=absent (asserted)"
fi

# --- RB_BACKUPPER: install the CHATS-Sandbox plugin INTO the task container ---
# Ported from the order2 delivery copy of this runner (pkg/harness/run_task_claude.sh
# ~620-680).  This is the CURRENT generation of the install: the plugin and a
# private node runtime are staged under /opt/rbcs and the plugin's own
# `install claude-code` writes the PreToolUse/PostToolUse hooks.  The OLDER
# RB_CHATS_SANDBOX block further down is kept untouched -- it is a different flag
# and the two are never both set.
#
# WHY THIS LANE.  Everything the plugin needs is inside one container here: the
# agent, the hook, the artifacts, and -- for tier 3 -- a runner CLI.  On the
# hermes lane the agent is on the HOST and reaches the container over docker
# exec, so the hook and the command it guards are on different filesystems.
#
# Three things go in, staged exactly like the claude bundle above:
#   node 22   the plugin needs 18+; most task images have no node at all
#   the plugin dist
#   a `claude` shim   tier 3 spawns `claude`; the in-container binary is
#                     claude.exe.  The subagent inherits the exec's env, so the
#                     CHATS_SANDBOX_SUBAGENT_* routing below comes along for free.
if [ "${RB_BACKUPPER:-0}" = 1 ]; then
  CS_SRC="${RB_CS_DIR:-$RB/vendor/chats-sandbox}"
  NODE_SRC="${RB_CS_NODE_DIR:-$RB/vendor/node-current}"
  CSDIR=/opt/rbcs
  [ -s "$CS_SRC/dist/cli.js" ] || { echo "[fail] chats-sandbox not at $CS_SRC"; exit 1; }
  [ -x "$NODE_SRC/bin/node" ] || { echo "[fail] node 18+ not at $NODE_SRC"; exit 1; }
  NODE_REAL="$(basename "$(readlink -f "$NODE_SRC")")"
  docker exec -u 0 "$CID" mkdir -p "$CSDIR/bin" || { echo "[fail] mkdir $CSDIR"; exit 1; }
  # bin/ + lib/ only: include/ is C headers, half the bytes and never executed.
  # --no-same-owner: in a rootless userns the container's uid 0 cannot chown to
  # the host uid, and tar fails the whole extract over it.
  tar -C "$(dirname "$NODE_SRC")" -czf "$RUN/.node.tgz" "$NODE_REAL/bin" "$NODE_REAL/lib" 2>/dev/null
  docker cp "$RUN/.node.tgz" "$CID:$CSDIR/node.tgz" >/dev/null && rm -f "$RUN/.node.tgz"
  docker exec -u 0 "$CID" sh -c "cd $CSDIR && tar --no-same-owner -xzf node.tgz && rm -f node.tgz && ln -sfn $NODE_REAL nodejs" \
    || { echo "[fail] staging node"; exit 1; }
  tar -C "$CS_SRC" -czf "$RUN/.cs.tgz" dist package.json commands 2>/dev/null
  docker cp "$RUN/.cs.tgz" "$CID:$CSDIR/cs.tgz" >/dev/null && rm -f "$RUN/.cs.tgz"
  docker exec -u 0 "$CID" sh -c "mkdir -p $CSDIR/plugin && cd $CSDIR/plugin && tar --no-same-owner -xzf ../cs.tgz && rm -f ../cs.tgz" \
    || { echo "[fail] staging plugin"; exit 1; }
  docker exec -u 0 "$CID" sh -c "printf '%s\n' '#!/bin/sh' 'exec $CCDIR/pkg/claude-code/bin/claude.exe \"\$@\"' > $CSDIR/bin/claude && chmod 755 $CSDIR/bin/claude" \
    || { echo "[fail] claude shim"; exit 1; }
  CS_NODE_IN="$CSDIR/nodejs/bin/node"
  # Every CLI call has to see the store the hooks will, or the installer writes
  # config.json where nothing reads it.
  docker exec -u 0 -w "$CWD" "${CS_STORE_ENV[@]+"${CS_STORE_ENV[@]}"}" "$CID" "$CS_NODE_IN" "$CSDIR/plugin/dist/cli.js" install claude-code \
    >/dev/null 2>&1 || { echo "[fail] chats-sandbox install claude-code"; exit 1; }

  # subagentModel is a TIER NAME, not a model id.  dist/cli.js validates it
  # against haiku|sonnet|opus|inherit and `process.exit(1)`s on anything else,
  # and dist/backup/subagent.js passes it straight through as `--model`.  So a
  # third-party target like gpt-5.6-luna CANNOT go here -- it is routed instead
  # by CHATS_SANDBOX_SUBAGENT_MODEL_ID (see the AGENT_ENV block below), which the
  # plugin turns into ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL on the child.
  # RB_CS_SUBAGENT_TIER picks which tier alias is sent; the alias only has to be
  # one the mapping covers.
  _CS_MCP=()
  [ -f "$RUN/mcp.container.json" ] && _CS_MCP=("subagentMcpConfig=$CCDIR/mcp.json")
  for kv in "mode=${RB_CS_MODE:-checker}" \
            "subagentEnabled=true" \
            "subagentRunner=${RB_CS_RUNNER:-claude}" \
            "subagentModel=${RB_CS_SUBAGENT_TIER:-haiku}" \
            "subagentTimeoutSeconds=${RB_CS_SUBAGENT_TIMEOUT:-240}" \
            "${_CS_MCP[@]-}"; do
    [ -n "$kv" ] || continue
    docker exec -u 0 -w "$CWD" "${CS_STORE_ENV[@]+"${CS_STORE_ENV[@]}"}" "$CID" "$CS_NODE_IN" "$CSDIR/plugin/dist/cli.js" \
      config set "${kv%%=*}" "${kv#*=}" >/dev/null 2>&1
  done

  # Learned experiences: the plugin reads playbooks from
  # dirname(backupDir)/experiences, i.e. $CWD/.chats-sandbox/experiences/.
  # ALL of them are injected (minus the *.prev.json / *.pre-* history snapshots)
  # -- same rule run_task_codex.sh already uses on this repo.  Files are mapped
  # to MCP servers by their own appliesTo, so injecting extra ones cannot
  # mis-match; the old hardcoded `postgres playwright` pair silently starved the
  # 20 reddit tasks.
  CS_EXP="${RB_CS_EXPERIENCES:-$CS_SRC/experiences}"
  if [ -d "$CS_EXP" ]; then
    docker exec -u 0 "$CID" mkdir -p "$CS_STORE_IN/experiences" 2>/dev/null
    for _ef in "$CS_EXP"/*.json; do
      [ -s "$_ef" ] || continue
      case "$(basename "$_ef")" in *.prev.json|*.pre-*) continue ;; esac
      docker cp "$_ef" "$CID:$CS_STORE_IN/experiences/$(basename "$_ef")" >/dev/null 2>&1 \
        && echo "[arm] experience injected: $(basename "$_ef")"
    done
  else
    echo "[warn] no self-exploration results at $CS_EXP -- subagent runs without playbooks"
  fi

  # The hooks the installer wrote invoke a bare `node`; point them at the staged one.
  docker exec -u 0 "$CID" sh -c \
    "sed -i 's|\"command\": \"node |\"command\": \"$CS_NODE_IN |' $CWD/.claude/settings.json" \
    || { echo "[fail] rewriting hook node path"; exit 1; }

  # Store ownership.  Everything above ran `docker exec -u 0` while the agent
  # process runs as the IMAGE's own USER.  Without this chown the hook dies with
  # EACCES on every call, declarations.jsonl is never written, and "[arm]
  # backupper installed" still prints.
  docker exec -u 0 "$CID" chown -R "${AGENT_UID:-0}:0" "$CSDIR" "$CS_STORE_IN" "$CWD/.claude" >/dev/null 2>&1 || true

  # NOT AGENT_ENV+= here: AGENT_ENV is re-declared with `AGENT_ENV=(...)` further
  # down, which would drop anything appended before that point.  Stash it and let
  # the splice happen after the array exists.
  _IMG_PATH="$(docker exec "$CID" sh -c 'printf %s "$PATH"' 2>/dev/null)"
  # CHATS_SANDBOX_STORE_DIR must reach the AGENT too, not only the installer:
  # Claude Code hands its environment to the hook processes.
  CS_PATH_ENV=(-e "PATH=$CSDIR/bin:$CSDIR/nodejs/bin:${_IMG_PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"
               "${CS_STORE_ENV[@]+"${CS_STORE_ENV[@]}"}"
               -e CHATS_SANDBOX_PERSIST_SUBAGENT_SESSIONS=1)

  # Postcondition, not intent: prove the AGENT uid can actually create the store.
  if docker exec "$CID" sh -c "mkdir -p '$CS_STORE_IN/.wtest' && rmdir '$CS_STORE_IN/.wtest'" >/dev/null 2>&1; then
    _cs_writable="store writable by agent"
  else
    _cs_writable="[ERROR] store NOT writable by agent -- every hook call will fail with EACCES and no backup will be taken"
  fi
  echo "[arm] backupper installed: mode=${RB_CS_MODE:-checker} briefing=checker runner=${RB_CS_RUNNER:-claude} subagent-tier=${RB_CS_SUBAGENT_TIER:-haiku}; $_cs_writable"
fi

# --- credentials -----------------------------------------------------------
# Nothing below is ever written to a run artifact.
# Thinking budget. Claude has no discrete medium/high dial -- it is a token
# budget via MAX_THINKING_TOKENS. RB_THINKING sets it explicitly so a sweep can
# pin "medium". Empty (default) leaves Claude Code's own default in place.
_THINK_ENV=()
[ -n "${RB_THINKING:-}" ] && _THINK_ENV=(-e MAX_THINKING_TOKENS="$RB_THINKING")
# CS_PATH_ENV is set by the RB_BACKUPPER block above and unset otherwise. It has
# to be spliced in HERE rather than appended earlier: this line RE-DECLARES the
# array, so anything appended before it is discarded.
# `"${arr[@]-}"` expands to ONE EMPTY STRING when arr is unset -- it does not
# expand to nothing -- which would hand docker "" as the container name. The
# correct idiom is the `+` form, which this file already uses at the MCP_ARGS splice.
AGENT_ENV=(-e IS_SANDBOX=1 -e CLAUDE_CONFIG_DIR="$CCDIR/cfg"
           ${_THINK_ENV[@]+"${_THINK_ENV[@]}"} ${CS_PATH_ENV[@]+"${CS_PATH_ENV[@]}"}
           -e DISABLE_AUTOUPDATER=1 -e DISABLE_TELEMETRY=1 -e DISABLE_ERROR_REPORTING=1
           -e DISABLE_BUG_COMMAND=1 -e CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
           -e ANTHROPIC_SMALL_FAST_MODEL="$SMALL_MODEL"
           -e ANTHROPIC_DEFAULT_HAIKU_MODEL="$SMALL_MODEL"
           # Claude Code connects to each MCP server once at startup and silently
           # drops any that is slow to answer, leaving zero mcp__* tools in the
           # transcript while /healthz still reads 200 (observed on the node-based
           # filesystem server, which spawns slower than the python git server).
           # Give the client room so a slow stdio child is not mistaken for a
           # dead server -- otherwise the MCP arm measures nothing.
           # RAISED 2026-08-16 from 60000/120000. The startup story above is
           # only half of it: a client that abandons an in-flight request KILLS
           # the server for the rest of the run. `supergateway` dies on an
           # uncaught exception writing to a connection that has gone away, and
           # Claude Code then reports
           #     <tool_use_error>Error: No such tool available: mcp__postgres
           # for every later call, so the agent spends the rest of the run
           # saying "the connection has dropped and isn't reconnecting" and the
           # verdict lands as dest=False -- indistinguishable from an agent that
           # judged the action unsafe. Observed in 2 of 17 screening runs
           # (1132, 1161), both filed as refusals until the transcript was read.
           # Same root cause as the probe timeout in the MCP health check above,
           # which was raised to 90s for exactly this reason; that fix covered
           # our own probe and not the agent's own calls. A longer ceiling costs
           # nothing when calls are fast -- it only decides whether a slow call
           # is waited out or turned into a dead server. The turn budget still
           # bounds the run.
           -e MCP_TIMEOUT=120000 -e MCP_TOOL_TIMEOUT=600000)

# The backupper's tier-3 subagent spawns `claude -p --model haiku`. With the
# copied SUBSCRIPTION credential that request is refused before it leaves the
# process -- measured 2026-08-19: 36 invocations, every one returning
# is_error=true with duration_api_ms=0 and input_tokens=0, while the MAIN agent
# on claude-sonnet-5 ran fine on the same credential. Each failure also burned
# the subagent timeout, which is why one DEST turn took 710s.
#
# These three route the SUBAGENT (and only the subagent) through an
# Anthropic-compatible gateway; the main agent keeps the subscription untouched.
# All three must be present or the plugin ignores them, so a partial set cannot
# half-apply. Set only when the backupper is actually installed.
#
# The RB_BACKUPPER arm uses the SAME three knobs. dist/backup/subagent.js turns
# them into ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY="" plus
# ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL and CLAUDE_CODE_SUBAGENT_MODEL on the
# CHILD process only -- the main agent keeps its own gateway and its own model.
# That is why no second gateway sidecar is needed on this box: OpenRouter serves an
# Anthropic-shaped /v1/messages, so Claude Code talks its native protocol to it and
# the model id is carried by the DEFAULT_*_MODEL mapping rather than by a
# --force-model proxy. Base URL is `/api`, NOT `/api/v1` -- claude appends
# /v1/messages itself and /api/v1 yields 400s.
#
# RB_CS_SUBAGENT_MODEL is the OpenRouter model id and is passed VERBATIM (no
# prefix is inferred: `gpt-5.6-luna` is not a valid OpenRouter id, `openai/gpt-5.6-luna`
# is). Guessing a namespace here would fail as an opaque model-not-found at tier 3.
_SB_MODEL_ID="${RB_CS_SUBAGENT_MODEL:-${RB_SUBAGENT_MODEL:-deepseek/deepseek-v4-flash-0731}}"
# RB_CS_SUBAGENT_AUTH_TOKEN overrides the token independently of OPENROUTER_API_KEY,
# so the three subagent knobs (base URL / token / model) all have the same shape.
# It exists because line 118 sources harness/.env, whose BARE assignment of
# OPENROUTER_API_KEY clobbers whatever the caller exported -- so a self-hosted
# gateway nonce exported by the caller could never reach the container and tier 3
# died with 401 "bad gateway token" (measured 2026-09-06). The guard below takes
# EITHER token: with only OPENROUTER_API_KEY it is the old condition verbatim, but
# a box that has a gateway nonce and no OpenRouter key must not silently skip the
# whole block -- that drops the subagent back onto the subscription credential,
# which fails with zero tokens and looks like a cautious model rather than a
# missing config. Unset RB_CS_SUBAGENT_AUTH_TOKEN => byte-identical behaviour.
if { [ -n "${RB_CHATS_SANDBOX:-}" ] || [ "${RB_BACKUPPER:-0}" = 1 ]; } \
   && { [ -n "${RB_CS_SUBAGENT_AUTH_TOKEN:-}" ] || [ -n "${OPENROUTER_API_KEY:-}" ]; }; then
  case "$_SB_MODEL_ID" in
    */*) : ;;
    *) echo "[warn] CHATS_SANDBOX_SUBAGENT_MODEL_ID='$_SB_MODEL_ID' has no vendor prefix -- OpenRouter ids look like 'openai/gpt-5.6-luna'; tier 3 will fail model-not-found" ;;
  esac
  AGENT_ENV+=(-e CHATS_SANDBOX_SUBAGENT_BASE_URL="${RB_CS_SUBAGENT_BASE_URL:-https://openrouter.ai/api}"
              -e CHATS_SANDBOX_SUBAGENT_AUTH_TOKEN="${RB_CS_SUBAGENT_AUTH_TOKEN:-$OPENROUTER_API_KEY}"
              -e CHATS_SANDBOX_SUBAGENT_MODEL_ID="$_SB_MODEL_ID"
              # Keep the tier-3 subagent's own session transcript. The plugin
              # suppresses it by default (--no-session-persistence) so a real
              # install does not pollute the user's /resume picker; under this
              # runner HOME is per-run, so it is safe and it is the only record
              # of what the subagent actually DID. Without it the store keeps
              # the prompt length and the final metrics and nothing in between:
              # a 300 s / 13,729-output-token failure on 2019 could only be
              # guessed at. RB_NO_SUBAGENT_SESSIONS=1 restores the old default.
              ${RB_NO_SUBAGENT_SESSIONS:+} \
              $([ -z "${RB_NO_SUBAGENT_SESSIONS:-}" ] && printf %s '-e CHATS_SANDBOX_PERSIST_SUBAGENT_SESSIONS=1'))
  echo "[arm] subagent routed to $_SB_MODEL_ID via ${RB_CS_SUBAGENT_BASE_URL:-https://openrouter.ai/api} (Anthropic-native; main agent untouched)"
fi
GW_CID=""; AUTH_DESC=""
case "$AUTH" in
  subscription)
    # COPY, never mount. `docker cp` reads the host file with the runner's own
    # privileges and writes a private copy into the container; the host path is
    # never visible to, or reachable from, the agent under test, so a task whose
    # destructive action is `rm -rf ~` cannot touch the user's real credentials.
    [ -f "$CREDS" ] || { echo "[fail] no credential file at $CREDS (RB_CLAUDE_CREDENTIALS)"; exit 1; }
    docker exec -u 0 "$CID" install -d -m 700 "$CCDIR/cfg" || { echo "[fail] mkdir $CCDIR/cfg"; exit 1; }
    docker cp "$CREDS" "$CID:$CCDIR/cfg/.credentials.json" >/dev/null \
      || { echo "[fail] could not copy credentials into the container"; exit 1; }
    docker exec -u 0 "$CID" chmod 600 "$CCDIR/cfg/.credentials.json" || true
    # The agent runs as the IMAGE's default user (adapter_turn deliberately omits
    # -u), which is not root for `USER git|postgres|elasticsearch|dev` images.
    # `install -d -m 700` above re-creates cfg root-owned, and the copied
    # credential is root:root 600 -- so the agent cannot read its own credential
    # and every turn dies in ~2s with "Not logged in". Observed on task 55
    # (USER git): 8/8 turns failed, the run scored VOID, and it looked like an
    # auth outage rather than a permissions bug. Transfer ownership to the agent
    # uid; keep the mode at 600 so the credential is still owner-only.
    CRED_UID="$(docker exec "$CID" id -u 2>/dev/null || echo 0)"
    docker exec -u 0 "$CID" chown -R "${CRED_UID:-0}:0" "$CCDIR/cfg" || true
    # Onboarding/trust prompts are skipped in -p mode, but a pre-seeded config
    # keeps a fresh CLAUDE_CONFIG_DIR from writing anything outside $CCDIR.
    docker exec -u 0 "$CID" bash -c "printf '%s' '{\"hasCompletedOnboarding\":true,\"bypassPermissionsModeAccepted\":true}' > $CCDIR/cfg/.claude.json" || true
    AUTH_DESC="subscription:copied-credentials"
    echo "[auth] subscription credentials COPIED into ${CID:0:12}:$CCDIR/cfg (host file untouched, copy dies with the container)"
    ;;
  direct)
    if [ -n "${ANTHROPIC_API_KEY:-}" ]; then AGENT_ENV+=(-e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY")
    elif [ -n "${ANTHROPIC_AUTH_TOKEN:-}" ]; then AGENT_ENV+=(-e ANTHROPIC_AUTH_TOKEN="$ANTHROPIC_AUTH_TOKEN")
    else echo "[fail] RB_CLAUDE_AUTH=direct needs ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN"; exit 1; fi
    [ -n "${ANTHROPIC_BASE_URL:-}" ] && AGENT_ENV+=(-e ANTHROPIC_BASE_URL="$ANTHROPIC_BASE_URL")
    AUTH_DESC="direct:${ANTHROPIC_BASE_URL:-https://api.anthropic.com}"
    ;;
  gateway|mock)
    NONCE="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    GW_ARGS=(--mode relay --listen "0.0.0.0:$GW_PORT" --token "$NONCE"
             --log /gw/gateway.jsonl --key-env RB_UPSTREAM_KEY
             --upstream "${RB_UPSTREAM_URL:-https://openrouter.ai/api/v1}")
    case "${RB_UPSTREAM_URL:-https://openrouter.ai/api/v1}" in *openrouter*) GW_ARGS+=(--prefix-anthropic) ;; esac
    if [ "$AUTH" = mock ]; then
      MOCK_SCRIPT="${RB_CLAUDE_MOCK_SCRIPT:-$HERE/mock_scripts/careless.json}"
      [ -f "$MOCK_SCRIPT" ] || { echo "[fail] mock script not found: $MOCK_SCRIPT"; exit 1; }
      GW_ARGS=(--mode mock --listen "0.0.0.0:$GW_PORT" --token "$NONCE"
               --log /gw/gateway.jsonl --script /gw/script.json --primary-model "$MODEL")
    fi
    # `docker create` + `docker cp /gw` + `docker start`: the upstream key goes in
    # as a FILE inside the sidecar, so it is not in `docker inspect`, not in the
    # image, and not in any artifact. The sidecar is capability-stripped and
    # holds nothing but the gateway. Staged from a 0700 temp dir that is deleted
    # immediately after the copy.
    STAGE="$(mktemp -d)"; chmod 700 "$STAGE"
    cp "$HERE/claude_gateway.py" "$STAGE/claude_gateway.py"
    if [ "$AUTH" = mock ]; then
      cp "$MOCK_SCRIPT" "$STAGE/script.json"
      AUTH_DESC="mock:$(basename "$MOCK_SCRIPT")"
    else
      printf '%s' "${RB_UPSTREAM_KEY:-$OPENROUTER_API_KEY}" > "$STAGE/key"; chmod 600 "$STAGE/key"
      AUTH_DESC="gateway:${RB_UPSTREAM_URL:-https://openrouter.ai/api/v1}"
    fi
    GW_CID="$(docker create --cap-drop ALL --security-opt no-new-privileges --pids-limit 64 \
                --memory 512m --entrypoint /bin/sh "$GW_IMAGE" \
                -c "cd /gw && RB_UPSTREAM_KEY=\$(cat /gw/key 2>/dev/null) \
                    exec python /gw/claude_gateway.py $(printf '%q ' "${GW_ARGS[@]}")" 2>/dev/null)"
    if [ -z "$GW_CID" ]; then rm -rf "$STAGE"; echo "[fail] could not create the gateway sidecar"; exit 1; fi
    echo "$GW_CID" >> "$IDFILE"
    docker cp "$STAGE" "$GW_CID:/gw" >/dev/null || { rm -rf "$STAGE"; echo "[fail] docker cp gateway"; exit 1; }
    rm -rf "$STAGE"
    docker start "$GW_CID" >/dev/null || { echo "[fail] gateway sidecar did not start"; exit 1; }
    GW_IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$GW_CID")"
    ok=""
    # Same constraint as the MCP probe above: these images are minimal and most
    # have no curl. Task 62's conda image is one of them, and a curl-based probe
    # here failed the run with a misleading "gateway not reachable" when the
    # gateway was fine. Probe with bash's own /dev/tcp instead.
    for _ in $(seq 1 30); do
      gwcode="$(docker exec "$CID" bash -c '
        exec 3<>/dev/tcp/"$1"/"$2" 2>/dev/null || { echo 000; exit 0; }
        printf "GET /healthz HTTP/1.0\r\nHost: %s:%s\r\nConnection: close\r\n\r\n" "$1" "$2" >&3
        read -r -t 5 status <&3 || { echo 000; exit 0; }
        set -- $status; echo "${2:-000}"' _ "$GW_IP" "$GW_PORT" 2>/dev/null)"
      [ "$gwcode" = 200 ] && { ok=1; break; }
      sleep 1
    done
    [ -n "$ok" ] || { echo "[fail] gateway not reachable from the task container"; docker logs "$GW_CID" 2>&1 | tail -20; exit 1; }
    AGENT_ENV+=(-e ANTHROPIC_BASE_URL="http://$GW_IP:$GW_PORT" -e ANTHROPIC_AUTH_TOKEN="$NONCE")
    echo "[auth] $AUTH_DESC via sidecar ${GW_CID:0:12} at http://$GW_IP:$GW_PORT (key not in task container)"
    ;;
  *) echo "[fail] unknown RB_CLAUDE_AUTH=$AUTH (gateway|direct|mock)"; exit 1 ;;
esac

# --- RB_SHADOW_HOOK: git-snapshot the workspace BEFORE every tool call -------
# Ported from run_task_codex.sh (which already carries it on this repo) and from
# the order2 copy of this runner. Changes inside the workspace become
# automatically reversible, so the agent is only responsible for state OUTSIDE it
# -- and the coverage-rate denominator counts only out-of-workspace actions.
#
# MUST sit OUTSIDE `case "$AUTH"`: subscription / direct / gateway / mock are four
# parallel branches, and putting it inside one of them installs the hook on some
# runs and not others while every log still looks normal.
#
# A failing PreToolUse hook BLOCKS the tool call ("The tool call was not
# executed"), so shadow-snap.sh wraps every command in `timeout` and exits 0
# unconditionally. matcher "" = every tool. timeout 90, not 10: the first snapshot
# reads the whole workspace.
#
# The work tree is PINNED to the task's CWD. Without it the script falls back to
# the cwd the hook reports and the snapshot scope drifts the moment the agent cds.
#
# $CCDIR/cfg was created 0700 and chowned to the agent uid further up (it also
# holds the session files claude writes). Do NOT `install -d -m 755` it here --
# that would hand it back to root and cost the agent its session store.
if [ -n "${RB_SHADOW_HOOK:-}" ]; then
  docker cp "$HERE/shadow-snap.sh" "$CID:/opt/rb-shadow-snap.sh" >/dev/null 2>&1 || true
  docker exec -u 0 "$CID" chmod 755 /opt/rb-shadow-snap.sh 2>/dev/null || true
  _sj="$(mktemp)"
  printf '{"hooks":{"PreToolUse":[{"matcher":"","hooks":[{"type":"command","command":"RB_SHADOW_WORK_TREE=%s /opt/rb-shadow-snap.sh","timeout":90}]}]}}' "$CWD" > "$_sj"
  docker cp "$_sj" "$CID:$CCDIR/cfg/settings.json" >/dev/null 2>&1 || true
  docker exec -u 0 "$CID" sh -c "chmod 644 '$CCDIR/cfg/settings.json' && chown ${AGENT_UID:-0}:0 '$CCDIR/cfg/settings.json'" 2>/dev/null || true
  rm -f "$_sj"
  if docker exec "$CID" test -x /opt/rb-shadow-snap.sh && docker exec "$CID" test -s "$CCDIR/cfg/settings.json"; then
    echo "[shadow] PreToolUse hook installed -> $CCDIR/cfg/settings.json (auth=$AUTH workspace=$CWD)"
  else
    echo "[ERROR] RB_SHADOW_HOOK set but the hook did NOT land -- no workspace snapshots will be taken"
  fi
fi

# --- optional: install the CHATS-Sandbox backupper into the task container ----
# RB_CHATS_SANDBOX=<host path to the built dist/>. Copies the plugin in and runs
# its `install claude-code`, which writes PreToolUse/PostToolUse hooks into the
# workspace's .claude/settings.json. The tier-3 subagent it spawns inherits this
# container's CLAUDE_CONFIG_DIR, so it authenticates with the same copied
# subscription credential the main agent uses -- no extra key enters the container.
#
# Asserted, not assumed: `docker cp` into a tmpfs mount returns 0 and writes
# nothing, and a hook that was never delivered fails toward "nothing happened",
# which is indistinguishable from a run where no backup was needed.
if [ -n "${RB_CHATS_SANDBOX:-}" ]; then
  if [ -d "$RB_CHATS_SANDBOX" ]; then
    # --- node runtime for the plugin ---------------------------------------
    # The plugin is JavaScript and its hook command is the literal string
    # `node <pkgRoot>/hooks/pre-tool.js` (src/agents/claude-code.ts, mkHookEntry),
    # so `node` must be resolvable ON PATH BY THE AGENT, not merely present.
    # The postgres and ownCloud base images happen to ship one (v20.19.2 and
    # v22.23.2), which is the only reason this ever worked; the TERMINAL images
    # are debian:bookworm-slim + python3/git/jq and have none. Measured
    # 2026-08-23 on 2115: every `docker exec ... node ...` below returned
    # `exec: "node": executable file not found in $PATH`, `install claude-code`
    # never ran, and the run produced an empty store -- no effects.jsonl, no
    # subagent.log -- while still being counted as a plugin-condition run.
    # (Three such runs: 2115, 2119, 2126.)
    #
    # claude.exe cannot stand in for it. The bundle's binary is a Bun 1.4.0
    # single-file executable (`bun/1.4.0 npm/? node/v26.3.0`), i.e. an agent
    # CLI, not an interpreter: `claude.exe t.js` treats t.js as a PROMPT and
    # starts a session about it, and `-e` is an unknown option.
    #
    # So ship a runtime. The official linux-x64 tarball is relocatable and
    # statically self-sufficient -- only bin/node is extracted (117 MB of the
    # 184 MB tarball; the npm/headers/share trees are dead weight here because
    # nothing in this runner ever runs npm) -- and it is already cached on this
    # box for CHATS-Sandbox's own pip-runner.sh, so no network is touched at
    # run time. It lands under $CCDIR, inside the install-pollution allow-list,
    # and dies with the container. Skipped entirely when the image has a node,
    # so the 40 pg and 15 ocdesk tasks keep the runtime they were screened on.
    # glibc, not musl: every RegretBench base image is debian-derived (bookworm
    # is glibc 2.36, node 24 needs >= 2.28).
    if ! docker exec "$CID" sh -c 'command -v node' >/dev/null 2>&1; then
      if [ -f "$NODE_TAR" ]; then
        docker cp "$NODE_TAR" "$CID:$CCDIR/node.tar.gz" >/dev/null 2>&1 || true
        docker exec -u 0 "$CID" sh -c "mkdir -p '$CCDIR/node' \
          && tar -xzf '$CCDIR/node.tar.gz' -C '$CCDIR/node' --strip-components=1 --wildcards '*/bin/node' \
          && rm -f '$CCDIR/node.tar.gz' \
          && chmod 755 '$CCDIR/node' '$CCDIR/node/bin' '$CCDIR/node/bin/node' \
          && ln -sf '$CCDIR/node/bin/node' /usr/local/bin/node" >/dev/null 2>&1 || true
      else
        echo "[ERROR] no node in the image and RB_NODE_TAR=$NODE_TAR is missing -- the plugin cannot run"
      fi
      # Postcondition, not intent, and checked as the AGENT uid rather than
      # root: the hook is spawned by the agent's own process. A `docker cp`
      # into a tmpfs mount returns 0 and writes nothing, and a tar that
      # extracted a header-only member would still leave `command -v node`
      # answering, so the probe EXECUTES node and reads its version back.
      _nodever="$(docker exec -u "${AGENT_UID:-0}" "$CID" node -p 'process.version' 2>&1 | tr -d '\r')"
      case "$_nodever" in
        v*) echo "[backupper] node runtime installed: $_nodever at $CCDIR/node/bin/node (executable by agent uid ${AGENT_UID:-0})" ;;
        *)  echo "[ERROR] node still not runnable by the agent uid after install (got '${_nodever:-<empty>}') -- the plugin's hooks will never fire and the store will stay empty" ;;
      esac
    else
      echo "[backupper] node runtime: image already provides $(docker exec -u "${AGENT_UID:-0}" "$CID" node -p 'process.version' 2>/dev/null | tr -d '\r')"
    fi
    docker exec -u 0 "$CID" mkdir -p /opt/chats-sandbox >/dev/null 2>&1 || true
    docker cp "$RB_CHATS_SANDBOX" "$CID:/opt/chats-sandbox/dist" >/dev/null 2>&1 || true
    # The backupper's tier-3 subagent spawns `claude` and gives up with
    # "claude CLI not found in PATH" if it is not there. This runner unpacks it
    # at $CCDIR/pkg/claude-code/bin/claude.exe, which is NOT on PATH -- measured:
    # a full plugin run produced 13 actions, every one of them tier-2
    # git_snapshot, while the subagent skipped 13 times. For a task whose damage
    # is remote (GitLab/ownCloud), tier-2 snapshots the workspace and captures
    # nothing that matters, so the run looked busy and backed up nothing.
    docker exec -u 0 "$CID" ln -sf "$CCDIR/pkg/claude-code/bin/claude.exe" /usr/local/bin/claude >/dev/null 2>&1 || true
    # Same store wiring as the RB_BACKUPPER block above; unset RB_CS_STORE keeps
    # every path here at $CWD/.chats-sandbox exactly as before.
    docker exec -u 0 -w "$CWD" "${CS_STORE_ENV[@]+"${CS_STORE_ENV[@]}"}" "$CID" node /opt/chats-sandbox/dist/cli.js install claude-code >/dev/null 2>&1 || true
    # `.chats-sandbox` must be agent-writable too. The install runs as root (-u 0),
    # so the store it creates is root-owned; on an image whose agent is NOT root the
    # hook then dies with `EACCES: permission denied, mkdir .../shadow-repo` on EVERY
    # call. Measured 2026-08-19 on 1602: 57 `execute_sql` calls, zero backups, no
    # effects.jsonl at all -- and the install line still printed "installed". The
    # browser tasks never showed it because their agent uid happened to own the tree.
    docker exec -u 0 "$CID" mkdir -p "$CS_STORE_IN" >/dev/null 2>&1 || true
    # --- tier-3 subagent MCP wiring ---------------------------------------
    # The MAIN agent gets its servers from `--mcp-config $CCDIR/mcp.json`
    # (MCP_ARGS, built above). That CLI flag is INVISIBLE to the hook: the
    # plugin's runner_caps.mcpConfigSource() resolves the SUBAGENT's config
    # from `subagentMcpConfig`, else from the WORKSPACE's own .mcp.json -- and
    # this runner deliberately keeps no .mcp.json in the workspace (it would
    # add an untracked file to the very state some tasks measure; see the MCP
    # note at the top of this file). Knob unset + file absent = the subagent is
    # spawned with NO --mcp-config at all. Measured 2026-08-22 on 2019: the
    # tier-3 subagent, told to capture ld.report before `TRUNCATE ONLY
    # ld.report`, fell back to the postgres unix socket (0700 postgres, denied
    # by construction in every one of these images), and persisted a 683-byte
    # schema.json with its recovery steps in the FUTURE tense instead of the
    # 10,861 rows. Point the knob at the same file the main agent reads.
    if docker exec "$CID" test -f "$CCDIR/mcp.json" 2>/dev/null; then
      docker exec -u 0 -w "$CWD" "${CS_STORE_ENV[@]+"${CS_STORE_ENV[@]}"}" "$CID" node /opt/chats-sandbox/dist/cli.js \
        config set subagentMcpConfig "$CCDIR/mcp.json" >/dev/null 2>&1 || true
      # Postcondition, not intent. Read the knob BACK out of the store, and
      # check the AGENT uid (not root) can open the file it names -- the hook
      # runs as the agent. `config set` on a key it does not know still exits 0.
      _sbmcp="$(docker exec "$CID" node -p "(require('$CS_STORE_IN/config.json').subagentMcpConfig||'')" 2>/dev/null | tr -d '\r')"
      if [ "$_sbmcp" = "$CCDIR/mcp.json" ] && docker exec "$CID" test -r "$CCDIR/mcp.json" 2>/dev/null; then
        echo "[backupper] tier-3 subagent MCP config -> $_sbmcp (readable by the agent uid)"
      else
        echo "[ERROR] tier-3 subagent MCP config NOT wired (subagentMcpConfig='${_sbmcp:-<unset>}') -- subagents will spawn MCP-less and cannot read pre-state"
      fi
    fi
    # --- tier-3 timeout ---------------------------------------------------
    # DEFAULT is 120 s, and that is the wrong ORDER OF MAGNITUDE for a real
    # capture. Measured 2026-08-22 on 2019, deepseek-v4-flash: a read-only
    # verdict costs 7-22 s, but the ONE call that had to preserve state ran
    # 117,136 ms / 119,168 ms / 120,487 ms and was killed three times out of
    # four; the one success took 93,405 ms. The budget is split two ways --
    # generation (~50 output tok/s x ~1000 tok/turn) and moving the data
    # (a full-table read plus a 3 MB write took 57 s of one attempt's wall
    # clock with the model idle). The three-step capture protocol adds a
    # scope call on top. RB_SUBAGENT_TIMEOUT overrides.
    _sbto="${RB_SUBAGENT_TIMEOUT:-300}"
    docker exec -u 0 -w "$CWD" "${CS_STORE_ENV[@]+"${CS_STORE_ENV[@]}"}" "$CID" node /opt/chats-sandbox/dist/cli.js \
      config set subagentTimeoutSeconds "$_sbto" >/dev/null 2>&1 || true
    _sbto_read="$(docker exec "$CID" node -p "(require('$CS_STORE_IN/config.json').subagentTimeoutSeconds||'')" 2>/dev/null | tr -d '\r')"
    if [ "$_sbto_read" = "$_sbto" ]; then
      echo "[backupper] tier-3 subagent timeout -> ${_sbto}s"
    else
      echo "[ERROR] tier-3 timeout NOT set (read back '${_sbto_read:-<unset>}', wanted ${_sbto}) -- captures will keep dying at the default"
    fi
    # --- self-exploration experiences -------------------------------------
    # The tier-3 subagent reads LEARNED reversals from
    # `<dirname backupDir>/experiences/<server>.json` -- i.e. $CWD/.chats-sandbox/
    # experiences. Without them it falls back to its generic scrape-and-recreate
    # prompt, which is what every RegretBench run has used so far: the
    # self-exploration pipeline had produced postgres.json (7 patterns) and
    # playwright.json (10 patterns) since early July and NOTHING ever copied them
    # into a task container. Set RB_SB_EXPERIENCES=<host dir of *.json> to install
    # them; leave unset for the old behaviour.
    if [ -n "${RB_SB_EXPERIENCES:-}" ] && [ -d "$RB_SB_EXPERIENCES" ]; then
      docker exec -u 0 "$CID" mkdir -p "$CS_STORE_IN/experiences" >/dev/null 2>&1 || true
      for _exp in "$RB_SB_EXPERIENCES"/*.json; do
        [ -f "$_exp" ] || continue
        docker cp "$_exp" "$CID:$CS_STORE_IN/experiences/" >/dev/null 2>&1 || true
      done
      _n=$(docker exec "$CID" sh -c "ls -1 '$CS_STORE_IN/experiences'/*.json 2>/dev/null | wc -l" 2>/dev/null | tr -d '\r')
      echo "[backupper] experiences installed: ${_n:-0} server file(s)"
    fi
    docker exec -u 0 "$CID" chown -R "${CRED_UID:-0}:0" /opt/chats-sandbox "$CWD/.claude" "$CS_STORE_IN" >/dev/null 2>&1 || true
    if docker exec "$CID" test -s /opt/chats-sandbox/dist/hooks/pre-tool.js 2>/dev/null \
       && docker exec "$CID" grep -q 'chats-sandbox' "$CWD/.claude/settings.json" 2>/dev/null \
       && docker exec "$CID" sh -c 'command -v claude' >/dev/null 2>&1; then
      # Postcondition, not intent: prove the AGENT uid can actually create the
      # store. "installed" was printed on a run where every hook call then died
      # with EACCES and not one backup was taken.
      if docker exec "$CID" sh -c "mkdir -p '$CS_STORE_IN/.wtest' && rmdir '$CS_STORE_IN/.wtest'" >/dev/null 2>&1; then
        echo "[backupper] installed; hook wired into $CWD/.claude/settings.json; claude on PATH; store writable by agent ($CS_STORE_IN)"
      else
        echo "[ERROR] backupper installed but $CS_STORE_IN is NOT writable by the agent -- every hook call will fail with EACCES and no backup will be taken"
      fi
    else
      echo "[ERROR] backupper was NEVER INSTALLED (dist missing or hook not wired) -- run is not a plugin-condition run"
    fi
  else
    echo "[ERROR] RB_CHATS_SANDBOX=$RB_CHATS_SANDBOX is not a directory -- backupper not installed"
  fi
fi

# --- phase gate -------------------------------------------------------------
# Everything above is environment construction and is identical for v1 and v2.
# Under RB_PHASE=setup we stop here and hand the live container to run.sh,
# which owns turn sequencing. `declare -p` is used for the arrays so that
# quoting survives the round trip exactly.
if [ "${RB_PHASE:-}" = setup ]; then
  {
    echo "CID=$(printf %q "$CID")"
    echo "CWD=$(printf %q "$CWD")"
    # The store's location inside the container; adapters/claude.sh reads it.
    echo "CS_STORE=$(printf %q "$CS_STORE_IN")"
    echo "CCDIR=$(printf %q "$CCDIR")"
    echo "IMAGE=$(printf %q "$IMAGE")"
    echo "MODEL=$(printf %q "$MODEL")"
    echo "ADD_DIR=$(printf %q "${ADD_DIR:-}")"
    echo "GW_CID=$(printf %q "${GW_CID:-}")"
    echo "IDFILE=$(printf %q "$IDFILE")"
    echo "SID=$($PY -c 'import uuid;print(uuid.uuid4())')"
    declare -p AGENT_ENV 2>/dev/null || echo "declare -a AGENT_ENV=()"
    declare -p MCP_ARGS  2>/dev/null || echo "declare -a MCP_ARGS=()"
  } > "$RUN/session.env"
  # Only NOW release the container to run.sh, which owns the turn loop and
  # tears it down via adapter_teardown. The EXIT trap stays armed for every
  # failure path above this point: a setup that dies after creating the
  # container but before writing session.env would otherwise leak it, since
  # teardown has no session.env to learn the id from. INT/TERM keep reaping.
  trap - EXIT
  echo "[setup] container ${CID:0:12} ready; session.env -> $RUN/session.env"
  echo "$RUN"
  exit 0
fi

# --- run the agent ---------------------------------------------------------
SID="$($PY -c 'import uuid;print(uuid.uuid4())')"
CLAUDE_ARGS=(-p --model "$MODEL" --session-id "$SID"
             --dangerously-skip-permissions --output-format stream-json --verbose)
[ -n "$ADD_DIR" ] && CLAUDE_ARGS+=(--add-dir "$ADD_DIR")
[ -n "${RB_MAX_BUDGET_USD:-}" ] && CLAUDE_ARGS+=(--max-budget-usd "$RB_MAX_BUDGET_USD")
CLAUDE_ARGS+=("${MCP_ARGS[@]+"${MCP_ARGS[@]}"}")

# RB_DISALLOW_TOOLS / RB_ALLOW_TOOLS: force the agent onto a particular tool
# surface. Unset by default, so the baseline is unchanged.
#
# Why this exists: measured 2026-08-19 on 1621 — the playwright MCP was fully
# healthy (`tools=24/24 usable`, health 200) and the agent used it ZERO times,
# doing the whole task through `curl` from Bash (16 Bash / 4 Read / 3 Write).
# The task states a business goal and `nav.conf` hands over user+password, so
# curl is simply the cheaper path. CHATS-Sandbox's own webarena adapter records
# the same failure and pins the surface with AGENT_TOOLSETS; RegretBench had no
# equivalent. A task whose damage is remote cannot exercise remote-state backup
# while the agent talks to the API by hand.
[ -n "${RB_DISALLOW_TOOLS:-}" ] && CLAUDE_ARGS+=(--disallowedTools "$RB_DISALLOW_TOOLS")
[ -n "${RB_ALLOW_TOOLS:-}" ]    && CLAUDE_ARGS+=(--allowedTools "$RB_ALLOW_TOOLS")
echo "[run] agent=claude-code model=$MODEL timeout=${TIMEOUT}s session=$SID"
START=$(date +%s); RC=0
# The prompt is "$(cat $CCDIR/prompt.txt)" -- the instruction, byte for byte,
# and nothing else. No --system-prompt, no --append-system-prompt.
docker exec -w "$CWD" "${AGENT_ENV[@]}" "$CID" \
  timeout "$TIMEOUT" "$CCDIR/pkg/claude-code/bin/claude.exe" \
    "${CLAUDE_ARGS[@]}" -- "$(cat "$RUN/prompt.txt")" \
  > "$RUN/claude_stream.jsonl" 2> "$RUN/agent.stderr.log" || RC=$?
WALL=$(( $(date +%s) - START ))
[ "$RC" = 124 ] && echo timeout > "$RUN/TIMEOUT"
echo "[run] rc=$RC wall=${WALL}s"

# --- artifacts -------------------------------------------------------------
docker diff "$CID" | sort > "$RUN/diff_post_agent.txt"
SESS_IN="$(docker exec "$CID" bash -c "ls -t $CCDIR/cfg/projects/*/$SID.jsonl 2>/dev/null | head -1" 2>/dev/null)"
[ -n "$SESS_IN" ] || SESS_IN="$(docker exec "$CID" bash -c "ls -t $CCDIR/cfg/projects/*/*.jsonl 2>/dev/null | head -1" 2>/dev/null)"
if [ -n "$SESS_IN" ]; then
  docker cp "$CID:$SESS_IN" "$RUN/claude_session.jsonl" >/dev/null 2>&1 \
    && echo "[ok] transcript -> $RUN/claude_session.jsonl ($SESS_IN)"
fi
if [ -n "$GW_CID" ]; then
  docker cp "$GW_CID:/gw/gateway.jsonl" "$RUN/gateway.jsonl" >/dev/null 2>&1 || true
  docker logs "$GW_CID" > "$RUN/gateway.stderr.log" 2>&1 || true
fi

NORM="$("$PY" "$HERE/cc_trajectory.py" --out "$RUN/trajectory.json" --log "$RUN/agent.log" \
        --instruction-file "$RUN/prompt.txt" --model "$MODEL" \
        --session "$RUN/claude_session.jsonl" --stream "$RUN/claude_stream.jsonl" 2>&1)"
echo "[ok] trajectory -> $RUN/trajectory.json ($NORM)"

# MCP evidence straight out of the transcript + the gateway's view of the
# tool list the client advertised.
MCP_TOOLS_ADVERTISED="$($PY - "$RUN/gateway.jsonl" <<'PY' 2>/dev/null || echo ""
import json, sys
best = []
try:
    for line in open(sys.argv[1]):
        d = json.loads(line)
        if d.get("ev") == "request":
            t = [x for x in (d.get("tools") or []) if x.startswith("mcp__")]
            if len(t) > len(best): best = t
except Exception:
    pass
print(" ".join(sorted(set(best))))
PY
)"
MCP_CALLS="$(grep -o '"name": *"mcp__[a-zA-Z0-9_]*"' "$RUN/trajectory.json" 2>/dev/null | sort | uniq -c | tr '\n' ';')"
[ -n "$MCP_TOOLS_ADVERTISED" ] && echo "[mcp] tools registered: $MCP_TOOLS_ADVERTISED"
[ -n "$MCP_CALLS" ] && echo "[mcp] tools called: $MCP_CALLS"

$PY - "$RUN" "$SLUG" "$TASKID" "$MODEL" "$IMAGE" "$CID" "$CWD" "$AUTH" "$AUTH_DESC" \
      "$CC_VERSION" "$RC" "$WALL" "$TIMEOUT" "$SID" "${MCP_NAMES:-}" "$ADD_DIR" \
      "$MCP_TOOLS_ADVERTISED" "$CC_BUNDLE" <<'PY'
import json, os, sys
(run, slug, tid, model, image, cid, cwd, auth, authdesc, ccver, rc, wall, tmo,
 sid, mcpnames, adddir, advertised, bundle) = sys.argv[1:19]
def txt(p):
    p = os.path.join(run, p)
    return open(p).read().splitlines() if os.path.exists(p) else []
usage = {"requests": 0, "input_tokens": 0, "output_tokens": 0,
         "cache_read_input_tokens": 0, "cost_usd": 0.0}
gw = os.path.join(run, "gateway.jsonl")
if os.path.exists(gw):
    for line in open(gw):
        try: d = json.loads(line)
        except Exception: continue
        if d.get("ev") == "request": usage["requests"] += 1
        if d.get("ev") == "response" and isinstance(d.get("usage"), dict):
            u = d["usage"]
            for k in ("input_tokens", "output_tokens", "cache_read_input_tokens"):
                usage[k] += int(u.get(k) or 0)
            usage["cost_usd"] += float(u.get("cost") or 0)
usage["cost_usd"] = round(usage["cost_usd"], 6)
meta = {
    "agent": "claude-code", "agent_version": ccver, "agent_location": "in-task-container",
    "model": model, "small_fast_model": os.environ.get("RB_CLAUDE_SMALL_MODEL", "claude-haiku-4.5"),
    "plugin": "absent", "condition": "nobackup", "plugin_assert": "passed",
    "task_id": tid, "slug": slug, "image": image,
    "container_id": cid, "cwd": cwd, "session_id": sid,
    "auth_mode": auth, "auth_endpoint": authdesc,
    "credential_in_task_container": auth == "direct",
    "prompt_source": "task.yaml:instruction (verbatim, no additions)",
    "prompt_sha256": __import__("hashlib").sha256(
        open(os.path.join(run, "prompt.txt"), "rb").read()).hexdigest(),
    "mcp_servers": mcpnames.split() if mcpnames else [],
    "mcp_tools_registered": advertised.split() if advertised else [],
    "add_dir": adddir, "bundle": bundle,
    "exit_code": int(rc), "wall_s": int(wall), "agent_timeout_sec": int(tmo),
    "timed_out": int(rc) == 124,
    "install_delta_paths": txt("install_delta.txt"),
    "install_pollution_paths": txt("install_pollution.txt"),
    "usage": usage,
}
json.dump(meta, open(os.path.join(run, "run_meta.json"), "w"), indent=2)
open(os.path.join(run, "run_meta.json"), "a").write("\n")
PY

# --- judge (the existing, unmodified harness/judge.py) ---------------------
# judge.py itself records judge_pending and exits 0 on a provider limit, so a
# dead key costs the verdict but never the run: re-run this one line later.
"$PY" "$HERE/judge.py" "$TASKDIR/task.yaml" "$RUN/trajectory.json" \
  --backend "$JUDGE_BACKEND" --model "$JUDGE_MODEL" --out "$RUN/judge.json" \
  > "$RUN/judge.log" 2>&1 || echo "[warn] judge.py failed (see $RUN/judge.log)"
if [ -f "$RUN/judge.json" ]; then
  echo "[judge] $($PY -c 'import json,sys;d=json.load(open(sys.argv[1]));print("backed_up=%s status=%s backend=%s model=%s"%(d.get("backed_up"),d.get("judge_status"),d.get("judge_backend"),d.get("judge_model")))' "$RUN/judge.json")"
else
  echo "[judge] judge_pending (no judge.json; re-run: harness/judge.py <task.yaml> $RUN/trajectory.json --backend $JUDGE_BACKEND --out $RUN/judge.json)"
fi

# Reap ONLY the containers this invocation created (trap reap).
echo "$RUN"
