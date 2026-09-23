#!/usr/bin/env bash
# run_task.sh <task-dir> [agent-model] -- the hermes arm's runner.
#
# TWO MODES
#   (default)        v1: build the image, run hermes ONCE against the task's
#                    single `instruction:`, save the session as the trajectory.
#   RB_PHASE=setup   v2: build the image, pre-create the container, wire MCP,
#                    GATE on a real MCP handshake, write $RUN/session.env and
#                    stop. run.sh owns the turn loop from there and drives the
#                    agent through adapters/hermes.sh. Same split, same file
#                    names, as run_task_claude.sh / run_task_codex.sh.
#
# WHAT MAKES THIS ARM STRUCTURALLY DIFFERENT FROM THE OTHER TWO
# -------------------------------------------------------------
# claude-code and codex are installed INTO the task container and run there.
# hermes runs ON THE HOST and pushes every terminal command into the container
# with `docker exec` (tools/environments/docker.py). Two consequences, and both
# are load-bearing on this machine:
#
#   1. Model traffic leaves from the HOST, not from the container. The host can
#      reach REDACTED-ENDPOINT directly (IPv6), so this arm needs NO sidecar --
#      neither claude's auth gateway nor codex's responses->chat translator.
#      The API key lives in the host agent process and is unreachable from
#      inside the task container, so there is no nonce substitution either.
#
#   2. MCP is BACKWARDS from the other two arms. The MCP servers listen on
#      127.0.0.1:88xx INSIDE the container. For claude/codex that is the same
#      127.0.0.1 the agent sees. For hermes it is not: the agent is on the host.
#      And on THIS machine the obvious alternative -- the container's bridge IP,
#      which is what gen_mcp_config.sh's header assumes -- does not work either:
#      rootless podman + netavark leaves host->container unroutable.
#        measured 2026-08-17 (scripts/docker/171-hermes-mcp-reach-test.sh):
#          host -> 10.89.13.111:8831        URLError [Errno 101] unreachable
#          host -> 127.0.0.1:<published>    200, handshake lists 9/9 usable tools
#      So this runner PUBLISHES each MCP port onto the host loopback with
#      `-p 127.0.0.1:<free port>:<container port>` and points hermes at that.
#      The host port is picked free at run time, so concurrent lanes cannot
#      collide the way a fixed 88xx would.
#
# THE MCP GATE IS NOT OPTIONAL. /healthz is supergateway's own endpoint and
# answers 200 while its stdio child is still starting or restarting; a client
# that connects then silently drops the server and the agent runs shell-only.
# On the judge's fields that is INDISTINGUISHABLE from a model that looked
# carefully and chose not to act. It cost a whole 27-task codex cell on
# 2026-08-17. So: initialize + tools/list, >=1 tool with a usable inputSchema,
# against the EXACT url the agent will use -- or exit non-zero here.
#
# Env:
#   RB_HERMES_BIN     hermes entry point           (REQUIRED, not shipped)
#   HERMES_SRC        hermes-agent source tree     (REQUIRED, not shipped)
#   RB_PY             python with pyyaml + docker  (default python3)
#   RB_RESULTS_DIR    default $RB/results/hermes
#   RB_RUN_DIR        use this run dir instead of minting one (adapter passes it)
#   RB_MCP_BIND       host address to publish MCP on (default 127.0.0.1)
#
#   RB_HERMES_IN_CONTAINER=1   run the agent INSIDE the task container instead of
#                     on the host -- the same shape as the claude and codex lanes.
#                     See the block below. Off by default: the host lane is the
#                     control every hermes result on disk was produced under.
#   RB_HERMES_BUNDLE  the relocatable hermes staged into the container under
#                     RB_HERMES_IN_CONTAINER=1 (default $RB/vendor/hermes-bundle.tar.gz;
#                     a relocatable hermes-agent tarball, not shipped)
#   RB_HERMES_MODEL_ROUTE  sidecar (default) | direct. Under `direct` the real
#                     upstream key is placed in the task container's environment
#                     and is readable by the agent under test; `sidecar` puts a
#                     relay on rb-net and hands the container a per-run nonce.
#
# WHAT MOVING THE AGENT IN CHANGES, measured 2026-08-27
# -----------------------------------------------------
# The two reasons recorded below for keeping hermes on the host were re-tested
# with scripts/docker/522-incontainer-hermes-probe.sh against a real task image
# (regretbench/v7-1100-aqs-year-archive-truncate):
#
#   MCP        the task container reaches its own MCP server on plain
#              127.0.0.1:8831 -- /healthz 200 on the first attempt and an
#              initialize+tools/list handshake returning 9/9 usable tools. The
#              `-p 127.0.0.1:<free>:<container>` publishing below therefore is not
#              replaced by anything under RB_HERMES_IN_CONTAINER=1: it is dropped,
#              and the client config points at 127.0.0.1:<container port> exactly
#              as the claude and codex lanes' does.
#   EGRESS     the task container resolves REDACTED-ENDPOINT (AAAA + A) and a POST to
#              .../passthrough/openai/v1/chat/completions returns 200 from inside
#              it. So a sidecar is not needed for REACHABILITY. It is still used by
#              default, for the one property the host placement gave for free: the
#              key stays out of the container the agent under test is running in.
#              The relay is claude_gateway.py --mode relay, which grew a
#              /chat/completions path for this lane rather than a third proxy.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; RB="$(cd "$HERE/.." && pwd)"
TASKDIR="${1:?usage: run_task.sh <task-dir> [model]}"; TASKDIR="$(cd "$TASKDIR" && pwd)"
MODEL="${2:-gemini-3-7-flash}"

# The name/endpoint the upstream wants is not necessarily $MODEL (claude models need
# both swapped), and it also decides whether model.max_tokens needs to be written into
# hermes' config.yaml below. There is only one definition of this:
# harness/hermes_model_route.sh (adapters/hermes.sh's v2 turn sources it too).
. "$HERE/hermes_model_route.sh"
rb_hermes_route "$MODEL"

PY="${RB_PY:-python3}"
# hermes-agent is NOT shipped with this release. RB_HERMES_BIN must point at the
# `hermes` entry point of an installed hermes-agent (installed with the [mcp]
# extra); HERMES_SRC must point at its source tree (precreate_container.py
# imports tools.terminal_tool from there). See QUICKSTART.md.
HERMES="${RB_HERMES_BIN:-}"
MCP_BIND="${RB_MCP_BIND:-127.0.0.1}"
IN_CT="${RB_HERMES_IN_CONTAINER:-0}"
HERMES_BUNDLE="${RB_HERMES_BUNDLE:-$RB/vendor/hermes-bundle.tar.gz}"
HDIR=/opt/rbhermes          # everything this lane stages into the container
HHOME_IN=/rbhome            # the agent's HOME inside the container (bind mount)
# .env supplies **defaults**, not overrides: an explicitly passed-in environment
# variable takes precedence. Measured 2026-08-31: without this, pointing
# OPENROUTER_BASE_URL at a different upstream (Together) swaps base_url but .env
# swaps the key back to OpenRouter's, so the gateway hits api.together.xyz with
# sk-or-v1 and the upstream returns 401 "Invalid API key" -- the error points at
# the key itself, which looks like the key had gone bad, and it took four rounds
# of investigation to trace it back to this line.
_rb_amb_or_key="${OPENROUTER_API_KEY:-}"; _rb_amb_gl_tok="${RB_GITLAB_TOKEN:-}"
[ -f "$HERE/.env" ] && . "$HERE/.env"
[ -n "$_rb_amb_or_key" ] && OPENROUTER_API_KEY="$_rb_amb_or_key"
[ -n "$_rb_amb_gl_tok" ] && RB_GITLAB_TOKEN="$_rb_amb_gl_tok"
unset _rb_amb_or_key _rb_amb_gl_tok

# Fail on the missing interpreter/binary HERE, with the reason, rather than in
# the middle of a turn where `|| RC=$?` swallows it and leaves an empty
# agent.log that reads like "the model said nothing".
# The HOST hermes is still required in in-container mode: precreate_container.py
# imports tools.terminal_tool from HERMES_SRC to build the container with
# byte-identical docker run flags. Only the AGENT moves; the container builder
# does not. What is NOT required in that mode is $HERMES itself.
if [ "$IN_CT" = 1 ]; then
  [ -s "$HERMES_BUNDLE" ] || { echo "[fail] no hermes bundle at $HERMES_BUNDLE -- set RB_HERMES_BUNDLE to a relocatable hermes-agent tarball, or leave RB_HERMES_IN_CONTAINER unset to run hermes on the host"; exit 1; }
else
  [ -n "$HERMES" ] && [ -x "$HERMES" ] || { echo "[fail] hermes not executable at '"'"'$HERMES'"'"' -- set RB_HERMES_BIN to the hermes-agent entry point (see QUICKSTART.md)"; exit 1; }
fi
"$PY" -c 'import yaml' 2>/dev/null || { echo "[fail] \$RB_PY ($PY) has no PyYAML"; exit 1; }
: "${OPENROUTER_API_KEY:?set OPENROUTER_API_KEY}"
# The MCP client only exists if hermes was installed with the [mcp] extra.
# Without it register_mcp_servers() returns [] and logs at DEBUG -- no error,
# no tools. Check once, up front, loudly. (In in-container mode the same check
# is made against the bundle, after it is staged, further down.)
[ "$IN_CT" = 1 ] || "$HERMES" --version >/dev/null 2>&1 \
  || { echo "[fail] $HERMES does not run"; exit 1; }

eval "$($PY - "$TASKDIR/task.yaml" <<'PY'
import sys, yaml, shlex, os
d = yaml.safe_load(open(sys.argv[1]))
img = d.get("image") or f"regretbench/{os.path.basename(os.path.dirname(sys.argv[1]))}:latest"
print(f"SLUG={shlex.quote(str(d['slug']))}")
print(f"IMAGE={shlex.quote(img)}")
print(f"TIMEOUT={int(d.get('agent_timeout_sec') or d.get('turn_timeout_sec') or 600)}")
# v1 carries `instruction:`; v2 carries `turns:` and is driven by run.sh. Under
# RB_PHASE=setup an absent instruction is normal, so do not raise here.
_instr = d.get("instruction") or ""
print(f"INSTR={shlex.quote(_instr.strip())}")
# `mcp:` is optional and may be an explicit empty list. Emit name/port/path/
# health as parallel space-separated lists so bash can walk them together.
mcp = (d.get("mcp") or [])
print(f"MCP_NAMES={shlex.quote(' '.join(str(e['server']) for e in mcp))}")
print(f"MCP_PORTS={shlex.quote(' '.join(str(int(e['port'])) for e in mcp))}")
print(f"MCP_PATHS={shlex.quote(' '.join(str(e.get('path', '/mcp')) for e in mcp))}")
print(f"MCP_HEALTHS={shlex.quote(' '.join(str(e.get('health', '/healthz')) for e in mcp))}")
PY
)" || exit 1

if [ "${RB_PHASE:-}" != setup ] && [ -z "$INSTR" ]; then
  echo "[fail] task.yaml has no 'instruction:' -- v2 task? drive it with run.sh --harness hermes"; exit 1
fi

# --- image ------------------------------------------------------------------
# Same posture as the other two runners: never rebuild an image that exists
# (this machine cannot resolve any public registry, so an rmi is effectively
# irreversible), and when a build IS needed relay it through REDACTED-PROXY with
# --pull=never so podman does not go looking for a base on docker.io.
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "[build] $IMAGE"
  RB_RELAY="${RB_BUILD_PROXY:-http://[::1]:18081}"
  docker build -q --pull=false --network=host \
    --build-arg http_proxy="$RB_RELAY" --build-arg https_proxy="$RB_RELAY" \
    --build-arg HTTP_PROXY="$RB_RELAY" --build-arg HTTPS_PROXY="$RB_RELAY" \
    --build-arg no_proxy=localhost,127.0.0.1,::1 \
    -t "$IMAGE" "$TASKDIR" >/dev/null || { echo "[fail] docker build"; exit 1; }
fi

RUN="${RB_RUN_DIR:-${RB_RESULTS_DIR:-$RB/results/hermes}/${SLUG}-$(date +%Y%m%d_%H%M%S)}"
mkdir -p "$RUN/home/.hermes"
docker image inspect -f '{{.Id}}' "$IMAGE" > "$RUN/image-id.txt" 2>/dev/null || true

# --- container bookkeeping --------------------------------------------------
# Every container id THIS invocation is responsible for, one per line. The
# reaper removes exactly these and nothing else: it must never sweep by name or
# by --filter, because the other lanes on this box have their own hermes-*
# containers alive at the same time (154 containers belonging to other tenants
# were counted on 2026-08-17). No -v either: no volume of ours to remove, and a
# stray -v is how ~400 volumes were destroyed here once already.
IDFILE="$RUN/containers.ids"; : > "$IDFILE"
# Only takes effect on the setup-failure path (on the normal path the trap is
# stripped at the phase gate; the real collection happens in adapters/hermes.sh's
# adapter_teardown).
# If the store dies with the container, the evidence is gone. The claude lane has
# had this step for a while (run_task_claude.sh:305 harvest_sandbox); the hermes
# lane never did -- so "did tier-3 actually fire" was unanswerable: not because it
# never fired, but because the record was never saved. The PreToolUse hook leaves
# no trace in the transcript, so the store is the only record.
# Lands in the same place as the claude lane: $RUN/chats-sandbox (the scoring
# scripts join on .chats-sandbox; the driver renames it -- see the comment in
# wd-bk-claude.sh).
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

# --- the agent's cwd inside the container -----------------------------------
# hermes' cli.py resolves terminal.cwd "." against the LOCAL backend's rule
# (os.getcwd()) even when the docker backend was selected by env var, which
# would put the host results dir on the agent's `pwd`. Set it explicitly: the
# image's own WORKDIR (the task author's plausible path), else /root.
CWD="$(docker image inspect -f '{{.Config.WorkingDir}}' "$IMAGE" 2>/dev/null)"
case "$CWD" in ""|"/") CWD=/root ;; esac

# --- RB_CS_STORE: the backupper store's location INSIDE the container --------
# Unset -> $CWD/.chats-sandbox, and every path below is the literal it always
# was. Set to an absolute path and the store moves off the agent's workspace, so
# a task whose goal is to sweep that directory can no longer delete our record.
# Same knob and default as run_task_codex.sh / run_task_claude.sh.
#
# THIS LANE HAS TWO ARMS AND THE KNOB MEANS DIFFERENT THINGS IN EACH:
#   IN_CT=1  hermes runs INSIDE the container, so the plugin's hook and the
#            agent's shell share a filesystem and the store is an ordinary
#            in-container directory -- exactly the codex/claude shape.
#            CHATS_SANDBOX_STORE_DIR is exported into the install calls and the
#            agent env, and the store really moves.
#   IN_CT!=1 hermes runs on the HOST with cwd=$RUN, so the plugin's store IS
#            $RUN/.chats-sandbox on the host and MUST STAY THERE -- that is the
#            run directory. All RB_CS_STORE moves is the container-side MOUNT
#            POINT, i.e. where the agent's shell sees the store. The host path
#            and the second (path-alignment) mount are untouched, and
#            CHATS_SANDBOX_STORE_DIR is deliberately NOT exported host-side.
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

# HERMES_TERMINAL_RELAX_FS=1: task images SEED at-risk state into the image and
# start real services (postgres etc). The default hardened backend shadows
# /root,/home,/tmp and cap-drops SETUID (breaking su-started services), which
# would delete the trap before the agent arrives. TERMINAL_CONTAINER_PERSISTENT
# =false forces the ephemeral fs branch so no host dir binds over /root either.
# DELIBERATELY NOT IN HERE: OPENROUTER_API_KEY / OPENROUTER_BASE_URL. `env` is
# invoked without -i, so the ambient environment (set by env-hermes.sh) passes
# through to the agent anyway -- and COMMON_ENV is round-tripped through
# session.env with `declare -p`, which would write the key into a file under
# results/ for every run. Keep the credential in the process environment only.
COMMON_ENV=(
  HOME="$RUN/home" HERMES_HOME="$RUN/home/.hermes"
  TERMINAL_ENV=docker TERMINAL_DOCKER_IMAGE="$IMAGE" TERMINAL_CWD="$CWD"
  HERMES_TERMINAL_RELAX_FS=1 TERMINAL_CONTAINER_PERSISTENT=false
  HERMES_TERMINAL_CONTAINER_IDFILE="$IDFILE"
)

# --- publish the MCP ports onto the host loopback ---------------------------
# Appended to whatever env-llama.sh already put in the variable (--network=rb-net
# plus the two playwright --add-host entries); those are still required.
# One free host port per MCP entry, chosen now and reused for the whole run.
#
# NOT DONE UNDER RB_HERMES_IN_CONTAINER=1. Publishing exists only because the
# agent was on the host; with the agent inside, 127.0.0.1:88xx is the same
# loopback it is for claude and codex. Verified, not reasoned:
# scripts/docker/522 handshook 9/9 usable tools on http://127.0.0.1:8831/mcp from
# inside a real task container. Leaving the -p in would also re-expose the task's
# database on a shared host for no reason.
EXTRA_ARGS="${HERMES_TERMINAL_DOCKER_EXTRA_ARGS:-}"
MCP_HOSTPORTS=""
if [ "$IN_CT" = 1 ]; then
  # The agent's HOME. hermes writes sessions/, logs/, state.db under it, and the
  # harness reads sessions/ every turn (hermes_sessions.py, hermes_normalize.py).
  # A bind mount rather than a per-turn `docker cp`: it keeps every host-side path
  # in the adapter ($AGENT_HERMES_HOME/sessions/...) literally unchanged, and the
  # .chats-sandbox mount on this lane already proved both directions work under
  # rootless podman. 0777 because the image's own user (uid 1500 on the pgbase
  # images) is not the uid a host-created directory maps to inside a userns.
  mkdir -p "$RUN/home/.hermes"
  chmod -R 0777 "$RUN/home"
  EXTRA_ARGS="$EXTRA_ARGS -v $RUN/home:$HHOME_IN"
elif [ -n "${MCP_NAMES:-}" ]; then
  for p in $MCP_PORTS; do
    hp="$("$PY" - <<'PY'
import socket
s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()
PY
)"
    MCP_HOSTPORTS="$MCP_HOSTPORTS $hp"
    EXTRA_ARGS="$EXTRA_ARGS -p $MCP_BIND:$hp:$p"
  done
  MCP_HOSTPORTS="${MCP_HOSTPORTS# }"
fi
# RB_BACKUPPER, part 1 of 2: bind the plugin's store into the container BEFORE
# the container exists. This half has to run here, not down in the main
# RB_BACKUPPER block -- that one sits below precreate_container.py and a mount
# cannot be added to a container that is already up.
#
# WHY A MOUNT AT ALL. On this lane the agent runs on the HOST and pushes every
# terminal command into the container over docker exec, so the plugin's hook and
# its store live host-side while the agent's shell lives container-side. Measured
# consequence: gemini was told "you are armed with a backupper", went to check --
# `which chats-sandbox`, `ls .chats-sandbox` -- found neither, concluded the
# briefing was false, and never declared once in the whole run. The store has to
# be where the agent looks. Both directions of the mount were verified under
# rootless podman before this went in.
#
# hermes splits HERMES_TERMINAL_DOCKER_EXTRA_ARGS with shlex and hands it to
# `docker run` (tools/environments/docker.py:455), and run_task.sh already
# appends MCP port flags to it above, so one more -v is in-band.
#
# NEITHER MOUNT IS MADE UNDER RB_HERMES_IN_CONTAINER=1. Both exist only to paper
# over the split: with the hook and the shell in the same filesystem the plugin's
# store is an ordinary $CWD/.chats-sandbox inside the container, exactly as on the
# claude and codex lanes, and adapter_collect carries it out with docker cp the way
# those two already do. Nothing replaces them.
if [ "${RB_BACKUPPER:-0}" = 1 ] && [ "$IN_CT" != 1 ]; then
  mkdir -p "$RUN/.chats-sandbox"
  # The mount point inside the container follows RB_CS_STORE; the host side is
  # always $RUN/.chats-sandbox and never moves.
  EXTRA_ARGS="$EXTRA_ARGS -v $RUN/.chats-sandbox:$CS_STORE_IN"
  # Second mount point: the same directory, mounted a second time onto **its own
  # absolute host path**.
  #
  # Why this mount is necessary: on this lane both the agent and the plugin's hook
  # run on the host, so the plugin computes the storage path from the host's point
  # of view, handing the subagent something like
  # /data/.../results/<run>/.chats-sandbox/backups/action_NNN/pre/. But the
  # subagent's terminal executes via docker exec into the container -- so
  # `mkdir -p` conjures an identically-named directory tree **inside the
  # container** out of thin air, pg_dump / cp all write into that tree, and it
  # vanishes the moment the container is destroyed. Measured: 444 of 449 captures
  # had zero artifacts in the directory, only 7 of 353 named artifacts were
  # actually on disk, while the transcript shows 219 exit_code: 0's -- the capture
  # ran, and ran straight into a black hole.
  #
  # After the second mount, the absolute host path inside the container points at
  # the same real directory, so the path the plugin computes on the host and the
  # path the subagent writes to inside the container land on the same spot --
  # whichever one writes, it lands. The claude / codex lanes do not have this
  # problem: their hook already runs inside the container, so what it computes is
  # already the container path.
  EXTRA_ARGS="$EXTRA_ARGS -v $RUN/.chats-sandbox:$RUN/.chats-sandbox"
  echo "[arm] backupper store bind-mounted: $RUN/.chats-sandbox -> $CS_STORE_IN (+ identically-named host path)"
fi
export HERMES_TERMINAL_DOCKER_EXTRA_ARGS="$EXTRA_ARGS"

# --- pre-create the task container (through hermes' own code) ---------------
# hermes creates its container lazily on the agent's FIRST terminal call, which
# is one turn too late for two reasons: MCP clients are registered at import
# time, and run.sh needs a CID for between_turns hooks and the predicate. So
# create it up front via precreate_container.py -- which goes through hermes'
# _create_environment(), so every docker run flag is byte-identical -- and hand
# the id to the agent process with HERMES_TERMINAL_DOCKER_ADOPT.
# v1 without MCP could skip this, but does not: one code path is easier to
# trust than two, and adoption is what keeps every turn in the same container.
CID="$(env "${COMMON_ENV[@]}" "$PY" "$HERE/precreate_container.py" 2>"$RUN/precreate.log" | tail -1)"
if [ -z "$CID" ]; then
  echo "[fail] could not pre-create the task container (see $RUN/precreate.log)"
  tail -5 "$RUN/precreate.log" >&2
  exit 1
fi
echo "$CID" >> "$IDFILE"
docker inspect -f '{{.Id}} {{.Name}}' "$CID" > "$RUN/container.id" 2>/dev/null
COMMON_ENV+=(HERMES_TERMINAL_DOCKER_ADOPT="$CID")

# ── Ported verbatim from run_task_claude.sh on 2026-08-30. ──────────────────
# Missing this block does not raise an error, it **silently measures the wrong
# target**: hermes' task container never attached to RB_TASK_NETWORK, so the
# "<gateway> $RB_FS_HOST" line start-mcp.sh wrote into the container's
# /etc/hosts kept applying, and rb-forum.local kept resolving to that
# long-lived, **never-seeded** baseline instance. Measured: 0 of 12 hermes
# Postmill trajectories contained a seeded submission id (>=137403); all four
# seeded forums' forum_log_entries were 0 -- the whole lane never touched the
# correct database even once. The grades therefore all came back dest=False,
# and it looked like "the model refuses to destroy", not like a failure.
# The k8s lane relies on the same variable to attach the task container to the
# cluster network, so that lane's "MCP 'cluster' never answered /healthz" is
# very likely the same root cause.
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

# Swap the ${RB_GITLAB_PAT} placeholder baked into gl task images for this
# lane's slot's real PAT. See the top of harness/inject_gitlab_pat.sh.
#
# 2026-08-18: this step was originally added only on the claude and codex
# paths, and this hermes one was missed -- so every gl task on gemini / deepseek
# ran under a fake token. Verified in practice: desk.conf in three running
# deepseek containers still held the literal `token = ${RB_GITLAB_PAT}`. The
# consequence is not "it doesn't run", it's "the backup route doesn't exist":
# destruction still works through the browser, but an agent that tries to back
# up hits a 401, burns turns, and the backup rate is systematically depressed --
# and on the grading fields it looks exactly like a refusal. The fix has to land
# on all three paths, not just the one in front of you at the time.
bash "$HERE/inject_gitlab_pat.sh" "$CID" || true

# --- RB_HERMES_IN_CONTAINER: stage the agent itself into the task container ---
# Same posture as the claude bundle and the codex binary: a pinned prebuilt
# artefact, docker cp'd, no package manager ever touches the task image.
#
# WHY A VENDORED INTERPRETER RATHER THAN THE IMAGE'S OWN python3. The task bases
# range from debian:bookworm-slim with no python at all to trixie with 3.13; the
# host venv cannot be copied either (its interpreter is a company-toolchain
# build, whose PT_INTERP is REDACTED-INTERNAL-PATH/ld.so
# and does not exist in any of them). vendor/hermes-bundle carries a relocatable
# CPython 3.12 plus hermes' 69 dependencies pinned to the EXACT versions the host
# lane's venv has, so the only difference between the two lanes is where the
# process runs. See scripts/docker/520 and 521.
AGENT_UID=""
if [ "$IN_CT" = 1 ]; then
  AGENT_UID="$(docker inspect -f '{{.Config.User}}' "$CID" 2>/dev/null)"
  docker exec -u 0 "$CID" mkdir -p "$HDIR" >/dev/null 2>&1
  docker cp "$HERMES_BUNDLE" "$CID:/opt/.hb.tgz" >/dev/null \
    || { echo "[fail] docker cp hermes bundle"; exit 1; }
  # --no-same-owner: in a rootless userns the container's uid 0 cannot chown to
  # the host uid and GNU tar fails the whole extract over it. No --exclude here:
  # some task images have busybox tar, where --exclude is silently ignored.
  docker exec -u 0 "$CID" sh -c "
    cd /opt && tar --no-same-owner -xzf .hb.tgz 2>/dev/null || tar -xzf .hb.tgz
    rm -f /opt/.hb.tgz
    cp -a /opt/hermes-bundle/. $HDIR/ && rm -rf /opt/hermes-bundle
    chmod -R a+rX $HDIR && chmod 755 $HDIR/bin/hermes" >/dev/null 2>&1 \
    || { echo "[fail] unpacking the hermes bundle in the container"; exit 1; }
  # The [mcp] check the host path makes with `$HERMES --version`, made here
  # against what will actually run, as the user that will actually run it.
  _hv="$(docker exec ${AGENT_UID:+-u "$AGENT_UID"} "$CID" "$HDIR/bin/hermes" --version 2>&1)"
  case "$_hv" in
    *Python*) : ;;
    *) echo "[fail] staged hermes does not run in the container: $_hv"; exit 1 ;;
  esac
  docker exec ${AGENT_UID:+-u "$AGENT_UID"} "$CID" "$HDIR/python/bin/python3" \
      -c 'import mcp, yaml, openai' >/dev/null 2>&1 \
    || { echo "[fail] staged hermes has no mcp/yaml/openai -- register_mcp_servers() would return [] silently"; exit 1; }
  # Where the turn budget is enforced. `timeout` on the HOST side of a docker exec
  # kills only the exec CLIENT: the agent keeps running inside the container and can
  # still be acting while the NEXT turn's prompt is delivered. In-container timeout(1)
  # kills the agent itself, which is what the codex lane does. Most images have
  # coreutils; the ones that do not fall back to the host-side wrapper, and that
  # fallback is recorded rather than assumed so a runaway is attributable.
  TIMEOUT_IN=0
  docker exec "$CID" sh -c 'command -v timeout >/dev/null 2>&1' && TIMEOUT_IN=1
  echo "[stage] hermes in-container at $HDIR ($(echo "$_hv" | tr '\n' ' ')) user=${AGENT_UID:-root} timeout=$([ "$TIMEOUT_IN" = 1 ] && echo in-container || echo host-side)"

  # CA roots. The bundle's python uses OpenSSL's default store, and several task
  # bases (debian:*-slim without an apt install) ship no ca-certificates at all --
  # on those every model request would fail as a connection error, which reads
  # like an upstream outage rather than a trust failure. Same fix and same
  # agent-env-only scoping as the codex lane.
  # The bundle's own certifi is the LAST resort and also the most portable one:
  # this host is not Debian and has no /etc/ssl/certs/ca-certificates.crt at all
  # (measured -- it keeps its roots at /etc/pki/tls/certs/ca-bundle.crt), so a
  # Debian-shaped lookup alone leaves images like 645-bundlefold-support-estate
  # with no trust store and every model request failing as a connection error.
  CA_ENV=()
  if ! docker exec "$CID" test -s /etc/ssl/certs/ca-certificates.crt 2>/dev/null; then
    _ca_src=""
    for _c in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt /etc/ssl/cert.pem; do
      [ -r "$_c" ] && { _ca_src="$_c"; break; }
    done
    if [ -n "$_ca_src" ]; then
      docker cp "$_ca_src" "$CID:$HDIR/ca-certificates.crt" >/dev/null 2>&1 \
        && CA_ENV=(-e SSL_CERT_FILE="$HDIR/ca-certificates.crt" -e REQUESTS_CA_BUNDLE="$HDIR/ca-certificates.crt") \
        && echo "[ca] image has no system CA bundle -- staged host roots from $_ca_src (agent env only)"
    fi
    if [ "${#CA_ENV[@]}" -eq 0 ]; then
      _certifi="$HDIR/python/lib/python3.12/site-packages/certifi/cacert.pem"
      if docker exec "$CID" test -s "$_certifi" 2>/dev/null; then
        CA_ENV=(-e SSL_CERT_FILE="$_certifi" -e REQUESTS_CA_BUNDLE="$_certifi")
        echo "[ca] image has no system CA bundle -- using the bundle's certifi roots (agent env only)"
      else
        echo "[warn] image has no CA bundle and none could be staged -- TLS to the model will fail"
      fi
    fi
  fi
fi

# --- MCP wiring + the gate --------------------------------------------------
TOOLSETS="terminal,file"
if [ -n "${MCP_NAMES:-}" ]; then
  : > "$RUN/mcp_health.log"
  set -- $MCP_NAMES;   names=("$@")
  set -- $MCP_PORTS;   ports=("$@")
  set -- $MCP_PATHS;   paths=("$@")
  set -- $MCP_HEALTHS; healths=("$@")
  # In in-container mode the agent dials the CONTAINER port on its own loopback,
  # so "the port the client uses" and "the container port" are the same number
  # and nothing was published. Reusing the same array keeps steps 2 and 3 below
  # single-path: whatever is in `hostports` is what gets written into the config
  # AND what gets handshaked, which is the invariant that stops a green preflight
  # from shipping a shell-only agent.
  if [ "$IN_CT" = 1 ]; then
    MCP_HOSTPORTS="$MCP_PORTS"; MCP_BIND=127.0.0.1
  fi
  set -- $MCP_HOSTPORTS; hostports=("$@")

  # STEP 1 -- in-container liveness. Probe from INSIDE: on this machine the host
  # cannot route to the container, and most task images have neither curl nor
  # wget, so use bash's own /dev/tcp.
  for i in "${!names[@]}"; do
    code=000
    for _ in $(seq 1 90); do
      code="$(docker exec "$CID" bash -c '
        exec 3<>/dev/tcp/127.0.0.1/"$1" 2>/dev/null || { echo 000; exit 0; }
        printf "GET %s HTTP/1.0\r\nHost: 127.0.0.1:%s\r\nConnection: close\r\n\r\n" "$2" "$1" >&3
        read -r -t 5 s <&3 || { echo 000; exit 0; }
        set -- $s; echo "${2:-000}"' _ "${ports[$i]}" "${healths[$i]}" 2>/dev/null)"
      [ "$code" = 200 ] && break
      sleep 1
    done
    echo "${names[$i]} in-container health ${healths[$i]} -> $code" >> "$RUN/mcp_health.log"
    [ "$code" = 200 ] || {
      echo "[fail] MCP '${names[$i]}' never answered ${healths[$i]} inside the container"
      cat "$RUN/mcp_health.log"; exit 1; }
  done

  # STEP 2 -- the client config, pointing at the published host ports (host lane)
  # or at plain 127.0.0.1:<container port> (in-container lane). Either way it is
  # what hermes will actually dial, and it is what step 3 handshakes against:
  # checking one address and using another is how a green preflight ships a
  # shell-only agent.
  "$PY" - "$RUN/mcp_servers.json" "$RUN/home/.hermes/config.yaml" "$MCP_BIND" \
        "$MCP_NAMES" "$MCP_HOSTPORTS" "$MCP_PATHS" "$MCP_PORTS" "$CID" "$IMAGE" <<'PY' \
    || { echo "[fail] writing hermes mcp config"; exit 1; }
import json, sys, yaml
rec, cfgpath, bind, names, hostports, paths, cports, cid, image = sys.argv[1:10]
names, hostports, paths, cports = (s.split() for s in (names, hostports, paths, cports))
servers = {n: "http://%s:%s%s" % (bind, hp, pa)
           for n, hp, pa in zip(names, hostports, paths)}
# Only mcp_servers goes in: no `terminal:` section, so the env-var terminal
# config (TERMINAL_ENV=docker + ADOPT) stays authoritative.
# timeout/connect_timeout are generous on purpose -- a cold stdio child takes
# 8-15s to answer its first call under load on this box.
yaml.safe_dump({"mcp_servers": {
    n: {"url": u, "timeout": 300, "connect_timeout": 120} for n, u in servers.items()
}}, open(cfgpath, "w"), sort_keys=False)
json.dump({"container_id": cid, "image": image, "bind": bind,
           "servers": [{"server": n, "url": servers[n], "host_port": hp,
                        "container_port": cp, "toolset": "mcp-%s" % n}
                       for n, hp, cp in zip(names, hostports, cports)]},
          open(rec, "w"), indent=2)
open(rec, "a").write("\n")
PY

  # STEP 3 -- THE GATE. Real protocol handshake on the exact URL above, requiring
  # at least one tool with a usable inputSchema. See harness/mcp_handshake.py for
  # why counting tools is not enough.
  #
  # WHERE IT RUNS FOLLOWS WHERE THE AGENT RUNS. Host-side hermes dials the
  # published port from the host, so the gate runs on the host. In-container
  # hermes dials 127.0.0.1 from inside, so the gate runs INSIDE, through the same
  # staged interpreter the agent will use -- otherwise the gate would be proving a
  # reachability the agent does not have.
  if [ "$IN_CT" = 1 ]; then
    docker cp "$HERE/mcp_handshake.py" "$CID:$HDIR/mcp_handshake.py" >/dev/null 2>&1 \
      || { echo "[fail] docker cp mcp_handshake.py"; exit 1; }
  fi
  for i in "${!names[@]}"; do
    u="http://$MCP_BIND:${hostports[$i]}${paths[$i]}"
    if [ "$IN_CT" = 1 ]; then
      out="$(docker exec ${AGENT_UID:+-u "$AGENT_UID"} "$CID" \
              "$HDIR/python/bin/python3" "$HDIR/mcp_handshake.py" "$u" \
              --attempts "${RB_MCP_HANDSHAKE_ATTEMPTS:-40}" \
              --timeout "${RB_MCP_HANDSHAKE_TIMEOUT:-90}" \
              --names-out "$HDIR/mcp_tools_${names[$i]}.txt" \
              2>>"$RUN/mcp_health.log")"
      rc=$?
      docker cp "$CID:$HDIR/mcp_tools_${names[$i]}.txt" "$RUN/mcp_tools_${names[$i]}.txt" \
        >/dev/null 2>&1 || true
    else
      out="$("$PY" "$HERE/mcp_handshake.py" "$u" \
              --attempts "${RB_MCP_HANDSHAKE_ATTEMPTS:-40}" \
              --timeout "${RB_MCP_HANDSHAKE_TIMEOUT:-90}" \
              --names-out "$RUN/mcp_tools_${names[$i]}.txt" \
              2>>"$RUN/mcp_health.log")"
      rc=$?
    fi
    read -r nusable ntotal nbad <<<"${out:-0 0 }"
    echo "${names[$i]} $([ "$IN_CT" = 1 ] && echo in-container || echo host) handshake $u -> ${nusable:-0}/${ntotal:-0} usable ${nbad:-}" \
      >> "$RUN/mcp_health.log"
    if [ "$rc" != 0 ] || [ "${nusable:-0}" -lt 1 ] 2>/dev/null; then
      echo "[fail] MCP '${names[$i]}' answered health but the handshake at $u"
      echo "       produced ${nusable:-0} usable tools -- the agent would run shell-only,"
      echo "       which is indistinguishable from a careful refusal. Not proceeding."
      cat "$RUN/mcp_health.log"
      exit 1
    fi
    TOOLSETS="$TOOLSETS,mcp-${names[$i]}"
  done
  sed 's/^/[mcp] /' "$RUN/mcp_health.log"

  # Seed the transcript with the MCP tool ROSTER, in the same
  # `deferred_tools_delta` attachment record Claude Code emits, so
  # cc_trajectory.py reports `mcp_tools=N` for a hermes run too. Without it the
  # driver.log line reads mcp_tools=0 even on a perfectly wired run, and
  # "the agent had no MCP tools" would be unreadable from the artifacts --
  # which is the exact confusion this lane's gate exists to prevent.
  # The names are rewritten to the claude convention for the same reason
  # hermes_normalize.py rewrites the calls (see its module docstring).
  "$PY" - "$RUN/claude_stream.jsonl" "$MCP_NAMES" "$RUN" <<'PY'
import json, os, sys
stream, names, run = sys.argv[1], sys.argv[2].split(), sys.argv[3]
added = []
for n in names:
    p = os.path.join(run, "mcp_tools_%s.txt" % n)
    if not os.path.exists(p):
        continue
    for line in open(p):
        line = line.strip()
        if line:
            added.append("mcp__%s__%s" % (n, line))
if added:
    with open(stream, "a") as fh:
        fh.write(json.dumps({"attachment": {"type": "deferred_tools_delta",
                                            "addedNames": added}}) + "\n")
PY
fi

# --- claude-family models: must supply an output cap -------------------------
# The upstream forces a non-null max_tokens for Claude (and only Claude). Without it,
# it **does not error**: HTTP 200, the first SSE chunk has empty content, then a bare
# JSON object is dropped into the stream --
#   {"title":"Claude Vertex AI requires a nonnull value for max_tokens", ...}
# -- and the stream cuts off. The result is every turn reads as "succeeded" but with
# zero text and zero tool calls -- on the judge's fields, indistinguishable from "the
# model looked and chose not to act". Measured 2026-08-19, see
# scripts/_probe/rb-probe3.py.
#
# hermes has its own openrouter+claude max_tokens patch logic (run_agent.py:5590), but
# its condition checks whether base_url contains "openrouter.ai"; we hit
# REDACTED-ENDPOINT, so that condition never holds and that code path never fires. It
# has to be supplied from the config side instead.
# The path it travels: config.yaml's model.max_tokens -> cli.py:1409 ->
# AIAgent.max_tokens.
# Written only for claude: gemini/deepseek are left alone, keeping the exact same
# request body as every prior cell, so as not to accidentally change someone else's
# control. The cap is not a target value, just enough headroom to avoid truncation.
# deepseek needs the same fix: it is a reasoning model, and once its chain of thought
# eats the default output budget it ends the turn with **no visible reply and no tool
# call**. The surface symptom is identical to claude's empty SSE -- rc=0, clean logs,
# outcome=RECOVERED, dest=False, which looks like "the model looked and chose not to
# act". Measured 2026-08-31: of the 24 deepseek runs graded dest=False, **21**
# (88%) carried finish_reason='length'; only 3 truly did not destroy anything.
# The original comment's worry that "changing the request body would affect the
# control" does not hold: raising a cap that used to get hit produces IDENTICAL
# output on runs that never hit it, and only changes behavior on the ones that got
# truncated.
if [ "$HERMES_UPSTREAM_MODEL" != "${HERMES_UPSTREAM_MODEL#*claude}" ] \
   || [ "$HERMES_UPSTREAM_MODEL" != "${HERMES_UPSTREAM_MODEL#*deepseek}" ] \
   || [ "$HERMES_UPSTREAM_MODEL" != "${HERMES_UPSTREAM_MODEL#*DeepSeek}" ]; then
  # deepseek gets a separate, much higher cap: measured under 32000, about 3 of every
  # 12 runs still got truncated, and one truncation = paying full price for reasoning
  # tokens + zero output + the whole turn wasted. The cap is only a ceiling, not a
  # target -- billing is by actual generation, so a higher cap does not mean spending
  # more. Measured against Together: 162000 is accepted (200000 is too). The claude
  # cap stays at 32000, unchanged.
  _RB_MAXTOK="${RB_HERMES_CLAUDE_MAX_TOKENS:-32000}"
  case "$HERMES_UPSTREAM_MODEL" in
    *deepseek*|*DeepSeek*) _RB_MAXTOK="${RB_HERMES_DEEPSEEK_MAX_TOKENS:-162000}" ;;
  esac
  "$PY" - "$RUN/home/.hermes/config.yaml" "$_RB_MAXTOK" <<'PY' \
    || { echo "[fail] writing hermes model.max_tokens"; exit 1; }
import os, sys, yaml
path, cap = sys.argv[1], int(sys.argv[2])
cfg = {}
if os.path.exists(path):
    # Merge: the MCP step above already wrote mcp_servers into this file.
    cfg = yaml.safe_load(open(path)) or {}
os.makedirs(os.path.dirname(path), exist_ok=True)
model = cfg.get("model")
cfg["model"] = dict(model) if isinstance(model, dict) else {}
cfg["model"]["max_tokens"] = cap
yaml.safe_dump(cfg, open(path, "w"), sort_keys=False)
PY
  echo "[cfg] model.max_tokens=${RB_HERMES_CLAUDE_MAX_TOKENS:-32000} (required by the claude upstream)"
fi

# --- context_length: otherwise hermes treats every model as 128k -------------
# The upstream's /models returns 404, and REDACTED-ENDPOINT is not in hermes'
# _URL_TO_PROVIDER, so get_model_context_length() at agent/model_metadata.py:912
# returns DEFAULT_FALLBACK_CONTEXT (128000) directly -- that is an **early return**,
# so neither the models.dev lookup that follows nor its own DEFAULT_CONTEXT_LENGTHS
# table ever run. Editing that table is therefore useless; it has to be supplied from
# config. The real cap per model comes from hermes_model_route.sh (measured with curl,
# 2026-08-23).
#
# Why this has to be fixed: 128000 x 0.50 = a 64k threshold. Of 1281 hermes runs on
# disk, 495 (39%) compressed because of it, 1202 times total, and the highest
# per-request token estimate among those runs was only 361k. Compression is not free
# -- it ends the session and starts a child one, and `--resume` does not follow the
# parent chain, so the agent loses its own memory of earlier turns in a multi-turn
# task.
#
# threshold is also raised from 0.50 to 0.85 at the same time: should_compress uses
# the **previous** response's prompt_tokens, and this turn's appended tool result is
# not yet counted, so headroom is needed. 1M x 0.85 = 891k, leaving ~157k before the
# real cap, enough to absorb a single turn's tool output. Compression itself stays on
# as a safety net -- turning it off means the cap is only discovered via a real 400,
# and the step-down would fall straight from 1M to 128k (an 8x overshoot) in one
# step.
#
# Must be written after the two blocks above: the MCP block (STEP 2) does a
# yaml.safe_dump that overwrites the whole file, so writing this before it would wipe
# it out. This uses the same merge approach as the max_tokens block.
if [ -n "${HERMES_CONTEXT_LENGTH:-}" ]; then
  "$PY" - "$RUN/home/.hermes/config.yaml" "$HERMES_CONTEXT_LENGTH" \
         "${RB_HERMES_COMPRESSION_THRESHOLD:-0.85}" <<'PY' \
    || { echo "[fail] writing hermes model.context_length"; exit 1; }
import os, sys, yaml
path, ctx, thr = sys.argv[1], int(sys.argv[2]), float(sys.argv[3])
cfg = {}
if os.path.exists(path):
    cfg = yaml.safe_load(open(path)) or {}
os.makedirs(os.path.dirname(path), exist_ok=True)
model = cfg.get("model")
cfg["model"] = dict(model) if isinstance(model, dict) else {}
cfg["model"]["context_length"] = ctx
comp = cfg.get("compression")
cfg["compression"] = dict(comp) if isinstance(comp, dict) else {}
cfg["compression"]["threshold"] = thr
yaml.safe_dump(cfg, open(path, "w"), sort_keys=False)
PY
  echo "[cfg] model.context_length=$HERMES_CONTEXT_LENGTH compression.threshold=${RB_HERMES_COMPRESSION_THRESHOLD:-0.85}"
fi

# --- RB_BACKUPPER: wire the chats-sandbox backup plugin into this run ---------
# The plugin is a PreToolUse hook: the agent writes `[Backup needed]` into a tool
# call and the plugin captures the pre-state for it, so the agent never spends its
# own context on copies. Off unless RB_BACKUPPER=1 -- this is a separate
# experimental arm from RB_GUIDANCE_FILE (which teaches the agent to back up
# itself); the two are alternatives and are never combined.
#
# TIER 0 IS DISABLED HERE, DELIBERATELY. hermes runs on the HOST and pushes every
# terminal command into the container over docker exec, so the hook and the command
# it is rewriting are on DIFFERENT filesystems. A tier-0 rewrite would "move to
# trash" a host path that does not exist and still replace the command with `true`
# -- the destructive step would never run, the trap would never fire, and every
# task would score total=0. CHATS_SANDBOX_NO_REWRITE=1 is the plugin's own switch
# for exactly this case (the OpenHands adapter sets it too). Tiers 1-3 are
# unaffected. The claude/codex lanes do NOT need this: their hook runs inside the
# same container as the command.
#
# The tier-3 subagent inherits this process's environment, which carries
# TERMINAL_ENV=docker and HERMES_TERMINAL_DOCKER_ADOPT=$CID -- so the subagent's own
# hermes adopts THE SAME task container and reads pre-state from inside it. That is
# what makes a remote/out-of-workspace capture possible on this lane.
#
# UNDER RB_HERMES_IN_CONTAINER=1 NONE OF THE PARAGRAPH ABOVE APPLIES. The hook and
# the command are in the same filesystem, so tier 0 is left ON (as on the claude
# lane), the plugin is installed INSIDE the container at $CWD, and the tier-3
# subagent is an in-container `hermes` off PATH rather than a host process
# adopting the container. Set RB_CS_NO_REWRITE=1 to force tier 0 back off.
CS_ENV=()
if [ "${RB_BACKUPPER:-0}" = 1 ] && [ "$IN_CT" = 1 ]; then
  CS_DIR="${RB_CS_DIR:-$RB/vendor/chats-sandbox}"
  CS_NODE="${RB_CS_NODE:-$RB/vendor/node-current/bin/node}"
  CSDIR=/opt/rbcs
  CS_NODE_IN="$CSDIR/nodejs/bin/node"
  [ -s "$CS_DIR/dist/cli.js" ] || { echo "[fail] chats-sandbox not at $CS_DIR"; exit 1; }
  [ -x "$CS_NODE" ] || { echo "[fail] node 18+ not at $CS_NODE (see scripts/docker/372-fetch-node-static.sh)"; exit 1; }

  # node + the plugin dist, staged exactly the way run_task_codex.sh does it.
  NODE_REAL="$(basename "$(readlink -f "$(dirname "$(dirname "$CS_NODE")")")")"
  docker exec -u 0 "$CID" mkdir -p "$CSDIR/bin" >/dev/null 2>&1
  tar -C "$(dirname "$(dirname "$(dirname "$CS_NODE")")")" -czf "$RUN/.n.tgz" \
      "$NODE_REAL/bin" "$NODE_REAL/lib" 2>/dev/null
  docker cp "$RUN/.n.tgz" "$CID:$CSDIR/n.tgz" >/dev/null 2>&1 && rm -f "$RUN/.n.tgz"
  docker exec -u 0 "$CID" sh -c "cd $CSDIR && tar --no-same-owner -xzf n.tgz && rm -f n.tgz && ln -sfn $NODE_REAL nodejs" \
    || { echo "[fail] staging node"; exit 1; }
  tar -C "$CS_DIR" -czf "$RUN/.cs.tgz" dist package.json commands 2>/dev/null
  docker cp "$RUN/.cs.tgz" "$CID:$CSDIR/cs.tgz" >/dev/null 2>&1 && rm -f "$RUN/.cs.tgz"
  docker exec -u 0 "$CID" sh -c "mkdir -p $CSDIR/plugin && cd $CSDIR/plugin && tar --no-same-owner -xzf ../cs.tgz && rm -f ../cs.tgz" \
    || { echo "[fail] staging plugin"; exit 1; }
  docker exec -u 0 "$CID" sh -c "printf '%s\n' '#!/bin/sh' 'exec $CS_NODE_IN $CSDIR/plugin/dist/cli.js \"\$@\"' > $CSDIR/bin/chats-sandbox && chmod 755 $CSDIR/bin/chats-sandbox" \
    || { echo "[fail] chats-sandbox shim"; exit 1; }

  # install writes $CWD/.hermes/plugins/chats_sandbox.py + $CWD/.chats-sandbox/.
  # registry.py:_load_plugins reads cwd/.hermes/plugins and ~/.hermes/plugins, and
  # the agent is exec'd with -w $CWD, so the cwd scope is the one that fires.
  # Every CLI call has to see the store the hooks will.
  docker exec -u 0 -w "$CWD" "${CS_STORE_ENV[@]+"${CS_STORE_ENV[@]}"}" "$CID" "$CS_NODE_IN" "$CSDIR/plugin/dist/cli.js" install hermes \
    > "$RUN/backupper_install.log" 2>&1 \
    || { echo "[fail] chats-sandbox install hermes (see $RUN/backupper_install.log)"; exit 1; }
  for kv in "mode=${RB_CS_MODE:-checker}" \
            "subagentEnabled=true" \
            "subagentRunner=hermes" \
            "subagentHermesModel=${RB_CS_SUBAGENT_MODEL:-openai/gpt-5.6-luna}" \
            "subagentTimeoutSeconds=${RB_CS_SUBAGENT_TIMEOUT:-240}"; do
    docker exec -u 0 -w "$CWD" "${CS_STORE_ENV[@]+"${CS_STORE_ENV[@]}"}" "$CID" "$CS_NODE_IN" "$CSDIR/plugin/dist/cli.js" \
      config set "${kv%%=*}" "${kv#*=}" >>"$RUN/backupper_install.log" 2>&1
  done
  # The subagent id goes to OpenRouter (HERMES_INFERENCE_PROVIDER=openrouter),
  # where a bare `gpt-5.6-luna` is not a valid id -- `openai/gpt-5.6-luna` is.
  # The default carries the prefix; a caller-supplied id is passed VERBATIM (a
  # guessed namespace would fail the same opaque way), but it is warned about,
  # because the checker is fail-open: a model-not-found still spawns, so the
  # symptom is a log full of `invoking:` with zero captures rather than an error.
  case "${RB_CS_SUBAGENT_MODEL:-openai/gpt-5.6-luna}" in
    */*) : ;;
    *) echo "[warn] subagentHermesModel='${RB_CS_SUBAGENT_MODEL}' has no vendor prefix -- OpenRouter ids look like 'openai/gpt-5.6-luna'; tier 3 will fail model-not-found and the checker will still spawn (fail-open)" ;;
  esac
  CS_EXP="${RB_CS_EXPERIENCES:-$CS_DIR/experiences}"
  if [ -d "$CS_EXP" ]; then
    docker exec -u 0 "$CID" mkdir -p "$CS_STORE_IN/experiences" >/dev/null 2>&1
    # ALL of them are injected (minus the *.prev.json / *.pre-* history
    # snapshots) -- the same rule run_task_claude.sh and run_task_codex.sh
    # already use. experiences map to MCP servers by their own appliesTo, so
    # injecting extra ones cannot mis-match; the old hardcoded
    # `postgres playwright` pair silently starved filesystem and the 20 reddit
    # tasks, which is every band this lane actually runs.
    for _ef in "$CS_EXP"/*.json; do
      [ -s "$_ef" ] || continue
      case "$(basename "$_ef")" in *.prev.json|*.pre-*) continue ;; esac
      docker cp "$_ef" "$CID:$CS_STORE_IN/experiences/$(basename "$_ef")" >/dev/null 2>&1 \
        && echo "[arm] experience injected: $(basename "$_ef")"
    done
  fi
  # Everything above ran as root; the agent is not root on the pgbase images, and a
  # root-owned store is a hook that fails on its first write -- silently, because
  # the plugin never blocks a tool call on its own errors.
  if [ -n "${AGENT_UID:-}" ]; then
    docker exec -u 0 "$CID" sh -c \
      "chown -R $AGENT_UID $CS_STORE_IN $CWD/.hermes 2>/dev/null; true" >/dev/null 2>&1
  fi
  docker exec ${AGENT_UID:+-u "$AGENT_UID"} "$CID" sh -c "$CSDIR/bin/chats-sandbox --help >/dev/null 2>&1" \
    && echo "[arm] in-container CLI: $CSDIR/bin/chats-sandbox ok" \
    || echo "[warn] in-container chats-sandbox CLI did not run"

  # PATH for the agent's `docker exec`:
  #   $CSDIR/bin         `chats-sandbox`, which the agent WILL try to verify
  #   $CSDIR/nodejs/bin  bare `node`, which the generated plugin shells out to
  #   $HDIR/bin          bare `hermes`, which the tier-3 subagent spawns. Missing
  #                      it is not an error anywhere: the plugin logs "hermes CLI
  #                      not found in PATH" and coverage silently reads as 0.
  _IMG_PATH="$(docker exec "$CID" sh -c 'printf %s "$PATH"' 2>/dev/null)"
  [ -n "$_IMG_PATH" ] || _IMG_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  # The agent's own env needs it too: hermes hands its environment to the hook.
  CS_ENV=(-e "PATH=$CSDIR/bin:$CSDIR/nodejs/bin:$HDIR/bin:$_IMG_PATH"
          "${CS_STORE_ENV[@]+"${CS_STORE_ENV[@]}"}"
          -e CHATS_SANDBOX_PERSIST_SUBAGENT_SESSIONS=1)
  [ "${RB_CS_NO_REWRITE:-0}" = 1 ] && CS_ENV+=(-e CHATS_SANDBOX_NO_REWRITE=1)
  echo "[cfg] backupper=on (in-container) mode=${RB_CS_MODE:-checker} subagent=${RB_CS_SUBAGENT_MODEL:-openai/gpt-5.6-luna} tier0=$([ "${RB_CS_NO_REWRITE:-0}" = 1 ] && echo off || echo on)"
fi

if [ "${RB_BACKUPPER:-0}" = 1 ] && [ "$IN_CT" != 1 ]; then
  CS_DIR="${RB_CS_DIR:-$RB/vendor/chats-sandbox}"
  CS_NODE="${RB_CS_NODE:-$RB/vendor/node-current/bin/node}"
  [ -s "$CS_DIR/dist/cli.js" ] || { echo "[fail] chats-sandbox not at $CS_DIR"; exit 1; }
  [ -x "$CS_NODE" ] || { echo "[fail] node 18+ not at $CS_NODE (see scripts/docker/372-fetch-node-static.sh)"; exit 1; }
  # install writes .hermes/plugins/chats_sandbox.py + .chats-sandbox/config.json
  # relative to cwd. registry.py:_load_plugins reads cwd/.hermes/plugins and
  # ~/.hermes/plugins; hermes runs with cwd=$RUN and HOME=$RUN/home, so installing
  # from $RUN puts the plugin on the cwd-scope path.
  ( cd "$RUN" && "$CS_NODE" "$CS_DIR/dist/cli.js" install hermes ) >"$RUN/backupper_install.log" 2>&1 \
    || { echo "[fail] chats-sandbox install hermes (see $RUN/backupper_install.log)"; exit 1; }
  ( cd "$RUN"
    "$CS_NODE" "$CS_DIR/dist/cli.js" config set mode "${RB_CS_MODE:-checker}"
    "$CS_NODE" "$CS_DIR/dist/cli.js" config set subagentRunner hermes
    "$CS_NODE" "$CS_DIR/dist/cli.js" config set subagentHermesModel "${RB_CS_SUBAGENT_MODEL:-openai/gpt-5.6-luna}"
    "$CS_NODE" "$CS_DIR/dist/cli.js" config set subagentTimeoutSeconds "${RB_CS_SUBAGENT_TIMEOUT:-240}"
  ) >>"$RUN/backupper_install.log" 2>&1
  # Learned experiences -- the playbooks a tier-3 subagent uses to read pre-state
  # through an MCP it has not seen before. ALL of them, minus the *.prev.json /
  # *.pre-* history snapshots: same rule as the claude and codex lanes.
  CS_EXP="${RB_CS_EXPERIENCES:-$CS_DIR/experiences}"
  if [ -d "$CS_EXP" ]; then
    mkdir -p "$RUN/.chats-sandbox/experiences"
    for _ef in "$CS_EXP"/*.json; do
      [ -s "$_ef" ] || continue
      case "$(basename "$_ef")" in *.prev.json|*.pre-*) continue ;; esac
      cp "$_ef" "$RUN/.chats-sandbox/experiences/$(basename "$_ef")"
    done
  fi

  # part 2 of 2: the CLI the agent will reach for. The store is already mounted
  # (part 1, above the container creation); this makes `chats-sandbox` resolve
  # inside the container so the agent's verification succeeds instead of coming up
  # empty. node and the dist go to /opt/rbcs exactly as on the claude lane.
  # --no-same-owner: in a rootless userns the container's uid 0 cannot chown to
  # the host uid, and tar fails the whole extract over it.
  if [ -n "${CID:-}" ]; then
    NODE_REAL="$(basename "$(readlink -f "$(dirname "$(dirname "$CS_NODE")")")")"
    docker exec -u 0 "$CID" mkdir -p /opt/rbcs/bin 2>/dev/null
    tar -C "$(dirname "$(dirname "$(dirname "$CS_NODE")")")" -czf "$RUN/.n.tgz" \
        "$NODE_REAL/bin" "$NODE_REAL/lib" 2>/dev/null
    docker cp "$RUN/.n.tgz" "$CID:/opt/rbcs/n.tgz" >/dev/null 2>&1 && rm -f "$RUN/.n.tgz"
    docker exec -u 0 "$CID" sh -c "cd /opt/rbcs && tar --no-same-owner -xzf n.tgz && rm -f n.tgz && ln -sfn $NODE_REAL nodejs" 2>/dev/null
    tar -C "$CS_DIR" -czf "$RUN/.cs.tgz" dist package.json commands 2>/dev/null
    docker cp "$RUN/.cs.tgz" "$CID:/opt/rbcs/cs.tgz" >/dev/null 2>&1 && rm -f "$RUN/.cs.tgz"
    docker exec -u 0 "$CID" sh -c "mkdir -p /opt/rbcs/plugin && cd /opt/rbcs/plugin && tar --no-same-owner -xzf ../cs.tgz && rm -f ../cs.tgz" 2>/dev/null
    docker exec -u 0 "$CID" sh -c "printf '%s\n' '#!/bin/sh' 'exec /opt/rbcs/nodejs/bin/node /opt/rbcs/plugin/dist/cli.js \"\$@\"' > /opt/rbcs/bin/chats-sandbox && chmod 755 /opt/rbcs/bin/chats-sandbox" 2>/dev/null
    docker exec "$CID" sh -c '/opt/rbcs/bin/chats-sandbox --help >/dev/null 2>&1' \
      && echo "[arm] in-container CLI: /opt/rbcs/bin/chats-sandbox ok" \
      || echo "[warn] in-container chats-sandbox CLI did not run"
  fi

  # The plugin shells out to bare `node`; the host's is 16.20.2 and too old.
  # CHATS_SANDBOX_PERSIST_SUBAGENT_SESSIONS=1: without it tier 3 runs with
  # --no-session-persistence and the transcript -- which is also the tok_sub
  # accounting source -- is never written.
  # CHATS_SANDBOX_NO_REWRITE=1 is belt-and-braces here: the plugin's own
  # exec_target.ts already stands tier 0 down when TERMINAL_ENV=docker (which
  # run_task.sh sets), and that was verified. Keeping both is cheap.
  # dirname $HERMES must be on this PATH. COMMON_ENV is handed to the HOST hermes
  # process (adapters/hermes.sh runs `env "${COMMON_ENV[@]}" ... "$HERMES_BIN"`),
  # and the plugin -- which runs inside that process -- spawns the tier-3 subagent
  # as bare `hermes`. The adapter invokes hermes by absolute path, so nothing else
  # puts it on PATH, and the subagent silently does not run: measured on the first
  # hermes smoke, `skipped: hermes CLI not found in PATH`, 1 declaration, 1 action
  # directory, 0 spawns. Coverage would have been 0 for every hermes run and it
  # would have read as the model failing to protect anything.
  COMMON_ENV+=(PATH="/opt/rbcs/bin:$(dirname "$CS_NODE"):$(dirname "$HERMES"):$PATH"
               CHATS_SANDBOX_NO_REWRITE=1
               CHATS_SANDBOX_PERSIST_SUBAGENT_SESSIONS=1)
  echo "[cfg] backupper=on mode=${RB_CS_MODE:-checker} subagent=${RB_CS_SUBAGENT_MODEL:-openai/gpt-5.6-luna} tier0=off"
fi

# --- RB_SHADOW_HOOK: snapshot the workspace before every tool call ------------
# hermes runs on the HOST and reaches the container over docker exec, so it has no
# in-container agent-config location for a hook. The script is still copied in; it is
# invoked host-side from cli.py's _on_tool_start (see _rb_shadow_snap there). The work
# tree is pinned to the task's CWD.
#
# Under RB_HERMES_IN_CONTAINER=1 there is no host process to docker exec FROM, and
# _rb_shadow_snap returns immediately when RB_SHADOW_CID is unset -- i.e. the arm
# would produce zero snapshots and say nothing, which is exactly the silent-zero
# this harness keeps getting bitten by. RB_SHADOW_LOCAL=1 makes cli.py run the
# script in its own process instead (see _rb_shadow_snap).
if [ -n "${RB_SHADOW_HOOK:-}" ]; then
  docker cp "$HERE/shadow-snap.sh" "$CID:/opt/rb-shadow-snap.sh" >/dev/null 2>&1 || true
  docker exec -u 0 "$CID" chmod 755 /opt/rb-shadow-snap.sh 2>/dev/null || true
  if [ "$IN_CT" = 1 ]; then
    echo "[shadow] hermes snapshot script installed (workspace=$CWD); driven IN-CONTAINER by _on_tool_start (RB_SHADOW_LOCAL=1)"
  else
    echo "[shadow] hermes snapshot script installed (workspace=$CWD); driven host-side by _on_tool_start"
  fi
fi

# --- RB_HERMES_IN_CONTAINER: model traffic ------------------------------------
# The host lane needed no gateway because the HOST can reach REDACTED-ENDPOINT. So can
# the task container -- measured, scripts/docker/522: DNS returns both an AAAA and
# an A, TCP 443 connects, and a POST to .../passthrough/openai/v1/chat/completions
# returns 200 from inside a real task image. Reachability is therefore NOT the
# reason for a sidecar here.
#
# The reason is the property the host placement gave away for free: with the agent
# inside the container, "the API key lives in the host agent process and is
# unreachable from inside the task container" stops being true. RB_HERMES_MODEL_ROUTE
# =direct restores the simple posture (real key in the container env, readable by
# the agent under test -- the codex lane's documented tradeoff); the default puts
# the key in a relay sidecar on rb-net and gives the container a per-run nonce,
# exactly as RB_CLAUDE_AUTH=gateway does.
#
# It is the SAME sidecar: harness/claude_gateway.py --mode relay, which grew a
# /chat/completions path (see do_POST) rather than becoming a third proxy. Model
# renaming (--model-map) and the "Extra inputs are not permitted" field stripper
# come along unchanged, and the per-request ledger lands in /gw/gateway.jsonl the
# way the claude lane's does.
HGW_CID=""
AGENT_BASE_URL="$OPENROUTER_BASE_URL"
AGENT_KEY="$OPENROUTER_API_KEY"
if [ "$IN_CT" = 1 ] && [ "${RB_HERMES_MODEL_ROUTE:-sidecar}" = sidecar ]; then
  GW_IMAGE="${RB_HERMES_GATEWAY_IMAGE:-${RB_CLAUDE_GATEWAY_IMAGE:-docker.io/library/python:3.11-slim}}"
  GW_PORT="${RB_HERMES_GATEWAY_PORT:-8902}"
  NONCE="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  # --upstream is whatever hermes_model_route.sh resolved for THIS model: claude
  # models go to /compat, everything else to /passthrough. The model is fixed for
  # the life of a run, so one sidecar per run is enough.
  GW_ARGS=(--mode relay --listen "0.0.0.0:$GW_PORT" --token "$NONCE"
           --log /gw/gateway.jsonl --key-env RB_UPSTREAM_KEY
           --upstream "$OPENROUTER_BASE_URL")
  # The name is already resolved by rb_hermes_route and passed on `hermes chat -m`,
  # so no --model-map is needed; passing one anyway would be a second place for the
  # two tables to drift.
  STAGE="$(mktemp -d)"; chmod 700 "$STAGE"
  cp "$HERE/claude_gateway.py" "$STAGE/claude_gateway.py"
  GW_NET_ARGS=()
  [ -n "${RB_DOCKER_NETWORK:-}" ] && GW_NET_ARGS=(--network="$RB_DOCKER_NETWORK")
  GW_NAME="rb-hermesgw-$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  HGW_CID="$(docker create --name "$GW_NAME" --cap-drop ALL --security-opt no-new-privileges \
              --pids-limit 64 "${GW_NET_ARGS[@]+"${GW_NET_ARGS[@]}"}" --memory 512m \
              -e RB_UPSTREAM_KEY="$OPENROUTER_API_KEY" \
              --entrypoint /bin/sh "$GW_IMAGE" \
              -c "exec python /gw/claude_gateway.py $(printf '%q ' "${GW_ARGS[@]}")" 2>/dev/null)"
  if [ -z "$HGW_CID" ]; then rm -rf "$STAGE"; echo "[fail] could not create the hermes relay sidecar"; exit 1; fi
  echo "$HGW_CID" >> "$IDFILE"
  docker cp "$STAGE" "$HGW_CID:/gw" >/dev/null || { rm -rf "$STAGE"; echo "[fail] docker cp gateway"; exit 1; }
  rm -rf "$STAGE"
  docker start "$HGW_CID" >/dev/null || { echo "[fail] relay sidecar did not start"; exit 1; }
  GW_IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$HGW_CID")"
  # Probe from the TASK container with bash's own /dev/tcp: most task images have
  # neither curl nor wget, and a python that is not there is not evidence.
  ok=""
  for _ in $(seq 1 30); do
    gwcode="$(docker exec "$CID" bash -c '
      exec 3<>/dev/tcp/"$1"/"$2" 2>/dev/null || { echo 000; exit 0; }
      printf "GET /healthz HTTP/1.0\r\nHost: %s:%s\r\nConnection: close\r\n\r\n" "$1" "$2" >&3
      read -r -t 5 status <&3 || { echo 000; exit 0; }
      set -- $status; echo "${2:-000}"' _ "$GW_IP" "$GW_PORT" 2>/dev/null)"
    [ "$gwcode" = 200 ] && { ok=1; break; }
    sleep 1
  done
  [ -n "$ok" ] || { echo "[fail] task container cannot reach the hermes relay sidecar"; docker logs "$HGW_CID" 2>&1 | tail -20; exit 1; }
  AGENT_BASE_URL="http://$GW_IP:$GW_PORT/v1"
  AGENT_KEY="$NONCE"
  echo "[auth] relay sidecar ${HGW_CID:0:12} ($GW_NAME) at $AGENT_BASE_URL -> $OPENROUTER_BASE_URL (key not in the task container)"
elif [ "$IN_CT" = 1 ]; then
  echo "[auth] direct: the REAL upstream key is placed in the task container's environment and is readable by the agent under test"
fi

# --- RB_HERMES_IN_CONTAINER: the agent's `docker exec` environment ------------
# ONE array, built once, in one place. (AGENT_ENV+= before a later AGENT_ENV=(...)
# has been silently clobbered in this harness before; there is no second
# assignment below this line.)
#
# TERMINAL_ENV IS DELIBERATELY ABSENT. Unset, hermes' terminal tool picks
# LocalEnvironment -- a persistent bash in this very container, which is the whole
# point. It also keeps the plugin's isForeignExec() false, so the container-aware
# snapshot path in the plugin stands down on its own and the hook takes the same
# local branch it takes on claude and codex.
AGENT_ENV=()
if [ "$IN_CT" = 1 ]; then
  AGENT_ENV=(-e HOME="$HHOME_IN" -e HERMES_HOME="$HHOME_IN/.hermes"
             -e OPENROUTER_BASE_URL="$AGENT_BASE_URL"
             -e HERMES_INFERENCE_PROVIDER=openrouter
             -e HERMES_MAX_ITERATIONS="${HERMES_MAX_ITERATIONS:-90}"
             -e HERMES_FORCE_NON_STREAMING="${HERMES_FORCE_NON_STREAMING:-0}")
  [ "${#CA_ENV[@]}" -gt 0 ] 2>/dev/null && AGENT_ENV+=("${CA_ENV[@]}")
  [ "${#CS_ENV[@]}" -gt 0 ] 2>/dev/null && AGENT_ENV+=("${CS_ENV[@]}")
  [ -n "${RB_SHADOW_HOOK:-}" ] && AGENT_ENV+=(-e RB_SHADOW_LOCAL=1 -e RB_SHADOW_WORK_TREE="$CWD")
  [ -n "${AGENT_UID:-}" ] && AGENT_ENV+=(-u "$AGENT_UID")
  # The credential goes LAST and only in sidecar mode, where it is a per-run nonce
  # that is worthless the moment the sidecar is reaped. Under `direct` it would be
  # the real upstream key, and session.env is archived with the run -- so that one
  # is not written here; adapter_turn adds it from the ambient environment at turn
  # time, the same way the host lane keeps the key out of COMMON_ENV.
  if [ "${RB_HERMES_MODEL_ROUTE:-sidecar}" = sidecar ]; then
    AGENT_ENV+=(-e OPENROUTER_API_KEY="$AGENT_KEY")
  fi
  # Tier-3's own subagent upstream. Without these two, the spawn inherits the
  # OPENROUTER_BASE_URL/OPENROUTER_API_KEY set above -- on the hermes lane that is the
  # endpoint the **primary model** needs (deepseek goes through Together, gemini
  # through Google, or a per-run relay sidecar), and using it to call luna is bound to
  # fail; the checker is fail-open, so it spawns anyway on failure, and the symptom is
  # a log full of `invoking:` with zero captures -- indistinguishable in shape from
  # "the model is being careful".
  # dist/backup/subagent.js's hermes branch reads both of these; both have to be
  # present for it to take effect.
  # When RB_CS_SUBAGENT_AUTH_TOKEN is unset, this line produces no -e at all --
  # behavior is byte-for-byte identical to before.
  if { [ -n "${RB_CHATS_SANDBOX:-}" ] || [ "${RB_BACKUPPER:-0}" = 1 ]; } \
     && [ -n "${RB_CS_SUBAGENT_AUTH_TOKEN:-}" ]; then
    AGENT_ENV+=(-e CHATS_SANDBOX_SUBAGENT_BASE_URL="${RB_CS_SUBAGENT_BASE_URL:-https://openrouter.ai/api/v1}"
                -e CHATS_SANDBOX_SUBAGENT_AUTH_TOKEN="$RB_CS_SUBAGENT_AUTH_TOKEN")
    echo "[arm] tier-3 subagent upstream: ${RB_CS_SUBAGENT_BASE_URL:-https://openrouter.ai/api/v1} (key not shown)"
  fi
fi

# --- phase gate -------------------------------------------------------------
# Everything above is environment construction and is identical for v1 and v2.
if [ "${RB_PHASE:-}" = setup ]; then
  {
    echo "CID=$(printf %q "$CID")"
    echo "CWD=$(printf %q "$CWD")"
    echo "IMAGE=$(printf %q "$IMAGE")"
    echo "IDFILE=$(printf %q "$IDFILE")"
    echo "TOOLSETS=$(printf %q "$TOOLSETS")"
    echo "MCP_NAMES=$(printf %q "${MCP_NAMES:-}")"
    echo "HERMES_BIN=$(printf %q "$HERMES")"
    echo "AGENT_HOME=$(printf %q "$RUN/home")"
    echo "AGENT_HERMES_HOME=$(printf %q "$RUN/home/.hermes")"
    echo "IN_CT=$(printf %q "$IN_CT")"
    # The store's location inside the container; adapters/hermes.sh reads it.
    echo "CS_STORE=$(printf %q "$CS_STORE_IN")"
    echo "HDIR=$(printf %q "$HDIR")"
    echo "AGENT_HOME_IN=$(printf %q "$HHOME_IN")"
    echo "TIMEOUT_IN=$(printf %q "${TIMEOUT_IN:-0}")"
    echo "HERMES_BIN_IN=$(printf %q "$HDIR/bin/hermes")"
    echo "GW_CID=$(printf %q "${HGW_CID:-}")"
    echo "HERMES_MODEL_ROUTE=$(printf %q "${RB_HERMES_MODEL_ROUTE:-sidecar}")"
    declare -p COMMON_ENV 2>/dev/null || echo "declare -a COMMON_ENV=()"
    # AGENT_ENV carries a per-run NONCE under the default sidecar route; it never
    # carries the real key, for the same reason COMMON_ENV omits it.
    declare -p AGENT_ENV 2>/dev/null || echo "declare -a AGENT_ENV=()"
  } > "$RUN/session.env"
  # Only NOW release the container to run.sh, which owns the turn loop and tears
  # it down via adapter_teardown. The EXIT trap stays armed for every failure
  # path above: a setup that dies after creating the container but before
  # writing session.env would otherwise leak it, since teardown has no
  # session.env to learn the id from. INT/TERM keep reaping.
  trap - EXIT
  echo "[setup] container ${CID:0:12} ready toolsets=$TOOLSETS; session.env -> $RUN/session.env"
  echo "$RUN"
  exit 0
fi

# --- v1: one shot -----------------------------------------------------------
echo "[run] agent=hermes model=$MODEL (upstream=$HERMES_UPSTREAM_MODEL @ ${AGENT_BASE_URL:-$OPENROUTER_BASE_URL}) image=$IMAGE timeout=${TIMEOUT}s cwd=$CWD toolsets=$TOOLSETS in_container=$IN_CT"
printf '%s' "$INSTR" > "$RUN/prompt.txt"
RC=0
if [ "$IN_CT" = 1 ]; then
  # Same command, run through `docker exec` in the task container instead of as a
  # host process. `timeout` stays on the HOST side of the exec: a timeout inside
  # the container would need a timeout(1) the image may not have.
  _k=()
  [ "${RB_HERMES_MODEL_ROUTE:-sidecar}" = sidecar ] || _k=(-e OPENROUTER_API_KEY="$OPENROUTER_API_KEY")
  # provider=anthropic -> hermes' anthropic_messages mode (run_agent.py:589), hits
  # api.anthropic.com natively, credentials go through ANTHROPIC_API_KEY rather than
  # OPENROUTER_API_KEY. When RB_HERMES_PROVIDER is unset, this line produces no -e at
  # all -- behavior is byte-for-byte identical to before.
  [ "${RB_HERMES_PROVIDER:-openrouter}" = anthropic ] && [ -n "${ANTHROPIC_API_KEY:-}" ] \
    && _k+=(-e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY")
  _to=(timeout "$TIMEOUT"); _to_in=()
  # See adapters/hermes.sh: kill the AGENT, not the exec client, when the image has
  # a timeout(1) to do it with.
  [ "${TIMEOUT_IN:-0}" = 1 ] && { _to=(); _to_in=(timeout "$TIMEOUT"); }
  "${_to[@]+"${_to[@]}"}" docker exec -w "$CWD" "${AGENT_ENV[@]}" "${_k[@]+"${_k[@]}"}" "$CID" \
      "${_to_in[@]+"${_to_in[@]}"}" "$HDIR/bin/hermes" chat --toolsets "$TOOLSETS" \
      -q "$INSTR" -m "$HERMES_UPSTREAM_MODEL" --provider "${RB_HERMES_PROVIDER:-openrouter}" -Q --yolo \
      > "$RUN/agent.log" 2>&1 || RC=$?
  # See adapters/hermes.sh: on a non-root image the session json is written 0600 by
  # a uid the host is not, and every host-side reader below would fail silently.
  docker exec -u 0 "$CID" sh -c "chmod -R a+rwX '$HHOME_IN/.hermes' 2>/dev/null; true" >/dev/null 2>&1
else
( cd "$RUN" && env "${COMMON_ENV[@]}" \
    timeout "$TIMEOUT" "$HERMES" chat --toolsets "$TOOLSETS" \
      -q "$INSTR" -m "$HERMES_UPSTREAM_MODEL" --provider "${RB_HERMES_PROVIDER:-openrouter}" -Q --yolo \
      > "$RUN/agent.log" 2>&1 ) || RC=$?
fi
[ "$RC" = 124 ] && echo timeout > "$RUN/TIMEOUT"

SESS="$(ls -t "$RUN/home/.hermes/sessions/"session_*.json 2>/dev/null | head -1)"
if [ -n "$SESS" ]; then
  cp "$SESS" "$RUN/hermes_session.json"
  # Same normalized envelope the v2 path produces, so a v1 hermes trajectory
  # and a v2 one are read by the same tools.
  "$PY" "$HERE/hermes_normalize.py" "$SESS" --mcp-servers "$(echo "${MCP_NAMES:-}" | tr ' ' ',')" \
        --out "$RUN/claude_stream.jsonl" >/dev/null
  cp "$RUN/claude_stream.jsonl" "$RUN/claude_session.jsonl"
  "$PY" "$HERE/cc_trajectory.py" --out "$RUN/trajectory.json" --log "$RUN/agent_render.log" \
        --instruction-file "$RUN/prompt.txt" --model "$MODEL" --agent hermes \
        --session "$RUN/claude_session.jsonl" > "$RUN/driver.log" 2>&1 \
    || echo "[warn] cc_trajectory failed; judge cannot score this run" >> "$RUN/driver.log"
  echo "[ok] trajectory -> $RUN/trajectory.json ($(cat "$RUN/driver.log"))"
else
  echo "[warn] no session json (see $RUN/agent.log)"
fi
# The API key must not survive on disk. hermes copies OPENROUTER_API_KEY out of
# the environment into $HERMES_HOME/auth.json (its credential pool) on first use
# -- verified 2026-08-17, access_token holds the key verbatim -- and that file is
# inside the run directory, which gets archived and shipped with the results.
rm -f "$RUN/home/.hermes/auth.json" 2>/dev/null
echo "$RUN"
