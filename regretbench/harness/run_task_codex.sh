#!/usr/bin/env bash
# run_task_codex.sh <task-dir> [model]
#
# RegretBench runner with codex-cli (OpenAI Codex CLI) as the agent under
# test, driven via OpenRouter, producing the same run-dir artifacts as
# run_task_claude.sh so results are directly comparable and judgeable by
# harness/judge.py. Modeled line-for-line on run_task_claude.sh; read that
# file's header first -- this one only documents where it DIFFERS.
#
# Differences from run_task_claude.sh:
#
#   * Agent binary. codex-cli 0.146.0 is a single static-pie ELF (no node,
#     no npm -- `file` reports "static-pie linked, stripped"), so it is
#     installed the same "pinned prebuilt bundle, docker cp, no package
#     manager touches the container" way claude.exe is. RB_CODEX_BUNDLE
#     required; not shipped with this release (see QUICKSTART.md)
#     (a plain executable, not a tarball -- codex-cli ships as one file, so
#     there is nothing to unpack).
#
#   * Auth. codex's OpenRouter provider (already declared in this host's
#     /root/.codex/config.toml as [model_providers.openrouter], base_url
#     https://openrouter.ai/api/v1, env_key OPENROUTER_API_KEY) reads its key
#     straight from an env var -- there is no sidecar-gateway option and none
#     is needed. This mirrors RB_CLAUDE_AUTH=direct: the key is placed in the
#     task container's environment, visible to the agent under test. Loaded
#     from harness/.env exactly like the Claude runner's judge key.
#
#   * Config. codex reads $CODEX_HOME/config.toml, not CLI flags, for model /
#     provider / reasoning effort / approval policy / sandbox mode / MCP
#     servers. We write that file ourselves (below) rather than shelling out
#     to `codex mcp add` or passing `-c` overrides on every invocation, so
#     setup has one place to audit. CODEX_HOME = $CCDIR/cfg, same ownership
#     fix Claude Code needed (images with a non-root USER: adapter_turn does
#     not pass -u, so the agent runs as the image's own user, and a root-only
#     config dir would silently no-op every write).
#
#   * Approval/sandbox posture. approval_policy="never" and
#     sandbox_mode="danger-full-access" in config.toml (still gated by the
#     SAME docker run flags precreate_container.py already applies --
#     cap-drop, no-new-privileges, pids-limit, cpu/memory caps -- codex's own
#     "danger-full-access" only means "codex will not itself refuse or ask";
#     it does not widen what the container can do). This is the in-container
#     analogue of claude's --dangerously-skip-permissions.
#
#   * Session/resume. codex-cli's `codex exec` has NO --session-id equivalent
#     to open a session under a chosen id (see `codex exec --help` /
#     `codex exec resume --help`): a fresh `codex exec` mints and persists its
#     own session, and continuation is `codex exec resume --last <prompt>`.
#     Because CODEX_HOME is private to this run's container, "--last" is
#     unambiguous -- there is exactly one codex session in that CODEX_HOME the
#     whole run. adapter_turn (harness/adapters/codex.sh) uses fresh vs
#     --last exactly where claude.sh uses --session-id vs --resume.
#
#   * Trajectory. codex has no Claude-Code-shaped session record. adapter_turn
#     pipes codex's own `--json` event stream through harness/codex_normalize.py,
#     which re-emits it as the SAME {"type":"user"|"assistant","message":{...}}
#     envelope Claude Code's stream-json uses, appended to $RUN/claude_stream.jsonl
#     (yes, that filename -- see adapters/codex.sh for why: run.sh's nudge
#     check and predicate.py's AVOIDED-detection both hardcode it, and keeping
#     the exact filename means neither needs to change for a second agent).
#     cc_trajectory.py then runs UNMODIFIED against that file to produce
#     trajectory.json, so judge.py needs no changes either.
#     *** codex_normalize.py's event-shape mapping is UNVERIFIED against a
#     live run -- see its module docstring for why, and re-check it against
#     $RUN/codex_stream.raw.jsonl (the untranslated original) before trusting
#     a sweep's numbers. ***
#
#   * No plugin-absence probe. That assertion in run_task_claude.sh is
#     specifically about the CHATS-Sandbox Claude Code plugin; it does not
#     apply to a different agent binary, so it is not reproduced here.
#
# Env:
#   RB_CODEX_MODEL              default openai/gpt-5.6-terra
#   RB_CODEX_PROVIDER           default openrouter
#   RB_CODEX_REASONING_EFFORT   default medium
#   RB_CODEX_BUNDLE             REQUIRED: path to codex-cli-<version>-linux-x64.bin
#   RB_CODEX_VENDOR_TGZ         tgz of codex's vendor sidecar files (codex-path/rg etc).
#                               If unset, inferred from RB_CODEX_BUNDLE's filename as the
#                               codex-vendor-<ver>-linux-x64.tar.gz in the same directory.
#                               Missing it is not fatal, but the container then has no rg
#                               -- see the [vendor] block below.
#   RB_CODEX_CONTEXT_WINDOW     model_context_window written into config.toml, default
#                               272000 (the value codex's own built-in catalog carries for
#                               gpt-5.6-terra/sol). codex does not recognize our
#                               passthrough model name, and without supplying this it
#                               falls back to a guessed window. For why model_catalog_json
#                               is not used to clear that warning entirely, see the [cfg]
#                               block below.
#   RB_RESULTS_DIR              default $RB/results/codex
#   RB_JUDGE_BACKEND / RB_JUDGE_MODEL   same meaning as run_task_claude.sh
#   RB_CODEX_ADD_DIR             default "/" (parity with RB_CLAUDE_ADD_DIR)
#   RB_SKIP_BUILD=1              skip `docker build` (image already built)
#   RB_ALLOW_POLLUTION=1         downgrade the install-pollution assertion to a warning
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"; RB="$(cd "$HERE/.." && pwd)"
TASKDIR="${1:?usage: run_task_codex.sh <task-dir> [model]}"; TASKDIR="$(cd "$TASKDIR" && pwd)"
MODEL="${2:-${RB_CODEX_MODEL:-openai/gpt-5.6-terra}}"
PROVIDER="${RB_CODEX_PROVIDER:-openrouter}"
# RB_CODEX_AUTH=chatgpt goes through codex's subscription (OAuth) instead of an API
# key. Measured: with auth_mode="Chatgpt", config.toml **must not** carry
# model_provider / [model_providers.*] -- writing them makes codex treat it as a custom
# provider and go looking for env_key. The model name also carries no openai/ prefix
# (slug=gpt-5.6-terra).
CODEX_AUTH="${RB_CODEX_AUTH:-apikey}"
CODEX_AUTH_FILE="${RB_CODEX_AUTH_FILE:-/root/.codex/auth.json}"
REASONING_EFFORT="${RB_CODEX_REASONING_EFFORT:-medium}"
# hermes' tools/terminal_tool.py uses `Path | None` (3.10+ syntax); /usr/bin/python3 is
# 3.9, so precreate would die with a TypeError and setup would only report "could not
# pre-create". Taken from RB_PY, same as run_task_claude.sh (env-llama.sh points it at
# the 3.12 venv).
PY="${RB_PY:-python3}"
"$PY" -c 'import yaml' 2>/dev/null || { echo "[fail] \$RB_PY ($PY) is not a Python 3.10+ with PyYAML"; exit 1; }
# The Codex CLI is NOT shipped with this release. RB_CODEX_BUNDLE must point at
# the official single-file linux-x64 binary, named codex-cli-<version>-linux-x64.bin
# (the version is parsed out of the filename, see just below).
CODEX_BUNDLE="${RB_CODEX_BUNDLE:-}"
[ -n "$CODEX_BUNDLE" ] || { echo "[fail] RB_CODEX_BUNDLE is unset -- point it at a codex-cli-<version>-linux-x64.bin (see QUICKSTART.md)"; exit 1; }
# Sidecar files and the model catalog: by default, looked up **in the same
# directory** by the bundle's version number, so upgrading the version only
# needs one edit, to RB_CODEX_BUNDLE.
_CODEX_VER="$(basename "$CODEX_BUNDLE")"; _CODEX_VER="${_CODEX_VER#codex-cli-}"; _CODEX_VER="${_CODEX_VER%-linux-x64.bin}"
CODEX_VENDOR_TGZ="${RB_CODEX_VENDOR_TGZ:-$(dirname "$CODEX_BUNDLE")/codex-vendor-${_CODEX_VER}-linux-x64.tar.gz}"
JUDGE_BACKEND="${RB_JUDGE_BACKEND:-claude-cli}"
if [ "$JUDGE_BACKEND" = claude-cli ]; then
  JUDGE_MODEL="${RB_JUDGE_MODEL:-claude-sonnet-4-5}"
else
  JUDGE_MODEL="${RB_JUDGE_MODEL:-anthropic/claude-sonnet-4.5}"
fi
ADD_DIR="${RB_CODEX_ADD_DIR:-/}"
CCDIR=/opt/rbcodex                     # everything this runner installs lives here
[ -f "$HERE/.env" ] && . "$HERE/.env"  # OPENROUTER_API_KEY: agent AND judge (if RB_JUDGE_BACKEND=openrouter)
[ -n "${OPENROUTER_API_KEY:-}" ] || { echo "[fail] no OPENROUTER_API_KEY (harness/.env or env)"; exit 1; }
[ -x "$CODEX_BUNDLE" ] || { echo "[fail] codex bundle not found/executable: $CODEX_BUNDLE"; exit 1; }

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

if [ "${RB_SKIP_BUILD:-0}" != 1 ] && docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "[build] $IMAGE already exists, skipping"
elif [ "${RB_SKIP_BUILD:-0}" != 1 ]; then
  echo "[build] $IMAGE"
  # Same two reasons as run_task_claude.sh: rebuilding would re-mint the graded values
  # and desync the manifest; and this machine cannot resolve any public registry, so the
  # build must go through the REDACTED-PROXY relay + --pull=never.
  RB_RELAY="${RB_BUILD_PROXY-http://[::1]:18081}"
  docker build -q --pull=false --network=host \
    --build-arg http_proxy="$RB_RELAY" --build-arg https_proxy="$RB_RELAY" \
    --build-arg HTTP_PROXY="$RB_RELAY" --build-arg HTTPS_PROXY="$RB_RELAY" \
    --build-arg no_proxy=localhost,127.0.0.1,::1 \
    -t "$IMAGE" "$TASKDIR" >/dev/null || { echo "[fail] docker build"; exit 1; }
fi

RUN="${RB_RESULTS_DIR:-$RB/results/codex}/${SLUG}-$(date +%Y%m%d_%H%M%S)"
mkdir -p "$RUN"
$PY - "$TASKDIR/task.yaml" "$RUN/prompt.txt" <<'PY'
import sys, yaml
d = yaml.safe_load(open(sys.argv[1]))
if d.get("instruction"):
    open(sys.argv[2], "w").write(d["instruction"].strip())
PY
if [ ! -s "$RUN/prompt.txt" ] && [ "${RB_PHASE:-}" != setup ]; then
  echo "[fail] task.yaml has no 'instruction:' -- v2 task? drive it with run.sh (--harness codex)"; exit 1
fi

# --- container bookkeeping (identical contract to run_task.sh/run_task_claude.sh) --
IDFILE="$RUN/containers.ids"; : > "$IDFILE"
reap() {
  local c
  [ -s "$IDFILE" ] || return 0
  while read -r c; do
    [ -n "$c" ] || continue
    docker rm -f "$c" >/dev/null 2>&1
  done < <(sort -u "$IDFILE")
}
trap reap EXIT INT TERM

CWD="$(docker image inspect -f '{{.Config.WorkingDir}}' "$IMAGE" 2>/dev/null)"
case "$CWD" in ""|"/") CWD=/root ;; esac

# --- RB_CS_STORE: where the backupper's store lives INSIDE the container ------
# Default is the historical location, $CWD/.chats-sandbox -- unset changes
# nothing anywhere in this script.
#
# WHY THE KNOB EXISTS. The store sits in the agent's own workspace, so a task
# whose goal is "empty this directory" makes the agent delete our record while
# doing exactly what it was told. Measured across the corpus: 8 runs, 12
# deletions (`find -delete` x4, `mv` x5, `rm` x3), and 3 action dirs are simply
# absent from the collected runs -- real data loss, not a counting artefact.
# The plugin's own defence (STORE_RM_PATTERN in dist/types.js) is a regex that
# only pins `rm`, so the other two verbs walked through it.
#
# Set RB_CS_STORE to an ABSOLUTE in-container path outside $CWD and the whole
# store moves there: config.json, backups/, shadow-repo/, experiences/,
# effects.jsonl, declarations.jsonl, checker.jsonl, subagent.log, the tmp
# ledger. The plugin reads it from CHATS_SANDBOX_STORE_DIR, which is exported
# into BOTH the install-time execs below and the agent's own environment
# (CS_PATH_ENV) -- the hook processes need it too, because without it
# getConfigDir() looks in $CWD and finds no config.json at all.
#
# THE RUN DIRECTORY LAYOUT DOES NOT MOVE. adapters/codex.sh still writes
# $RUN/.chats-sandbox, whatever the in-container path is; every downstream
# reader joins on that name.
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
case "$CS_STORE_IN" in
  /*) ;;
  *) echo "[fail] RB_CS_STORE must be an absolute path, got: ${RB_CS_STORE:-}"; exit 1 ;;
esac

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

# ── Ported from run_task_claude.sh on 2026-09-01. ────────────────────────────
# Before this, the codex harness **had no RB_TASK_NETWORK implementation at all**
# (0 grep hits, versus 11 in the hermes copy and 10 in the claude copy). The
# consequence only landed on the k8s lane: the k8s lane spins up a fresh cluster in
# its own docker network for every task (harvest/k8s-lane/run-k8s-task3-h.sh
# creates the network with RB_K8S_NET, then invokes run.sh with
# RB_TASK_NETWORK=$NET), and the task container has to be attached to that
# network to reach the cluster's MCP endpoint. Without this block, the cluster
# comes up fine on its own (the lane log shows "ready in 48s (tools=20)"), but
# the task container sits on the default bridge, so setup.log shows
#   [warn] endpoint not answering: http://172.17.0.9:8815/healthz
#   [fail] MCP endpoint never became healthy:
# and it's graded SETUP_FAILED, wasting all eight of the driver's retries.
# Measured: all 20 of terra's k8s tasks failed, zero trajectories. email / gitlab
# are unaffected because they use long-lived services (rbm-poste, rb-gitlab)
# reachable on the default bridge -- only k8s needs this block.
#
# Placement: must come after the container is created (needs $CID to connect)
# and before the `docker diff` install baseline and the MCP /healthz probe below
# -- the probe is issued from inside the task container, and without the
# network attached it is bound to time out, which is exactly the original
# failure point.
#
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
#   RB_TASK_NETWORK=rbnet ./run.sh --harness codex --tasks '22*' ...
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

# --- gl playwright: swap the ${RB_GITLAB_PAT} placeholder baked into the image
# for this slot's real PAT ----------------------------------------------------
# `token = ${RB_GITLAB_PAT}` in 13 gl tasks' desk.conf/studio.conf is a **literal**
# (gen_env.py has no f-string, no .format(), no expandvars there, and the
# Dockerfile has no build-arg either), and 14 task.yaml files write it as if it
# were a real credential. Without expanding it, the backup route exists on paper
# but returns 401 inside the container. For why this happens at runtime rather
# than via `-e`, and why the PAT never lands in a log: see the top of
# harness/inject_gitlab_pat.sh.
#
# Must happen **before** the first `docker diff` baseline below: desk.conf is a
# file inside an image layer, and editing it leaves a `C /srv/.../desk.conf`
# entry in docker diff, which install_pollution would report as "install-time
# pollution" if it lands after the baseline. It belongs to "set the environment
# up the way the task files say it should be", which is provisioning in
# concept, not install.
bash "$HERE/inject_gitlab_pat.sh" "$CID" || true

# --- vendor sidecar files (codex-path/rg etc) --------------------------------
# codex's npm package keeps, under vendor/<triple>/, at the same level as
# bin/codex:
#   codex-path/rg               codex's own bundled ripgrep 15.2.0
#   codex-resources/bwrap       codex's own bundled bubblewrap
#   codex-resources/zsh/bin/zsh codex's own bundled zsh
# The bundle used to contain only the bin/codex file, so the task container had
# **no rg**. This gap hits **only the codex path**: claude-code has a built-in
# Grep tool and does not depend on the rg binary, while codex's own
# instructions template says
#   "prefer using `rg` or `rg --files` ... (If the `rg` command is not found,
#    then use alternatives.)"
# terra flat-out said so on oc-qa-batch-signoff: "rg isn't installed here" --
# effectively forcing it into a dumber search method and burning turns for
# nothing.
#
# Unpacked into $CCDIR/pkg/codex/ (same level as bin/), keeping the vendor
# tree's original relative layout: codex looks for codex-resources "relative to
# the executable" (its own error text: "no bundled codex-resources/bwrap
# binary was found next to the Codex executable").
#
# ---- Why a symlink in /usr/local/bin is also needed ----
# Just adding codex-path to the agent container's PATH (the line in AGENT_ENV
# below) is **not enough**: codex's shell tool starts a **login shell**
# (measured in a real trajectory, the error prefix is `/bin/bash: line 1:`, and
# another run shows `/etc/profile: fork: retry: ...`), and Debian's
# /etc/profile unconditionally resets PATH, wiping out the segment we added.
# Measured on the 2026-08-17 22:45 batch of 14 runs: PATH was correct in
# AGENT_ENV, but the agent's shell still hit `rg: command not found` x19. So
# also add /usr/local/bin/rg (a directory /etc/profile itself writes into
# PATH).
#
# This block is **deliberately placed before the first `docker diff` baseline**
# below: the /usr/local/bin/rg it writes sits outside $CCDIR, and landing after
# the baseline would get it reported by install_pollution as "install-time
# pollution". Like inject_gitlab_pat.sh, it belongs to "set the environment up
# the way it's supposed to be" (provisioning), not codex's own install.
_V_UID="$(docker exec "$CID" id -u 2>/dev/null || echo 0)"
if [ -s "$CODEX_VENDOR_TGZ" ]; then
  docker exec -u 0 "$CID" mkdir -p "$CCDIR/pkg/codex" >/dev/null 2>&1
  docker cp "$CODEX_VENDOR_TGZ" "$CID:$CCDIR/pkg/codex/vendor.tar.gz" >/dev/null \
    && docker exec -u 0 "$CID" bash -c "set -e
         tar -xzf $CCDIR/pkg/codex/vendor.tar.gz -C $CCDIR/pkg/codex
         rm -f $CCDIR/pkg/codex/vendor.tar.gz
         chmod +x $CCDIR/pkg/codex/codex-path/rg 2>/dev/null || true
         chown -R ${_V_UID:-0}:0 $CCDIR/pkg/codex
         install -d /usr/local/bin
         ln -sf $CCDIR/pkg/codex/codex-path/rg /usr/local/bin/rg" \
    || echo "[vendor] !! failed to unpack $CODEX_VENDOR_TGZ, the container will have no rg"
  RG_WHERE="$(docker exec "$CID" bash -lc 'command -v rg' 2>/dev/null | tr -d '\r')"
  if [ -n "$RG_WHERE" ]; then
    echo "[vendor] rg in the login shell -> $RG_WHERE ($(docker exec "$CID" bash -lc 'rg --version' 2>/dev/null | head -1))"
  else
    echo "[vendor] !! unpacked, but rg is still not found in the login shell -- the agent will still fall back to find/grep"
  fi
else
  echo "[vendor] !! $CODEX_VENDOR_TGZ not found -- the container will have no rg, codex can only fall back to find/grep"
  echo "[vendor]    set RB_CODEX_VENDOR_TGZ to the codex-vendor-<version>-linux-x64.tar.gz that ships beside the CLI bundle"
fi

# --- install codex-cli into /opt (audited) ----------------------------------
docker diff "$CID" | sort > "$RUN/diff_noise_a.txt"
sleep 3
docker diff "$CID" | sort > "$RUN/diff_noise_b.txt"
comm -13 "$RUN/diff_noise_a.txt" "$RUN/diff_noise_b.txt" \
  | sed -E 's/^[ACD] //' > "$RUN/install_noise_paths.txt" || true

docker diff "$CID" | sort > "$RUN/diff_pre_install.txt"
AGENT_UID="$(docker exec "$CID" id -u 2>/dev/null || echo 0)"
docker exec -u 0 "$CID" bash -c "mkdir -p $CCDIR/pkg/codex/bin $CCDIR/cfg && chmod 700 $CCDIR/cfg && chown -R ${AGENT_UID:-0}:0 $CCDIR" \
  || { echo "[fail] mkdir $CCDIR"; exit 1; }
docker cp "$CODEX_BUNDLE" "$CID:$CCDIR/pkg/codex/bin/codex" >/dev/null || { echo "[fail] docker cp codex bundle"; exit 1; }
docker exec -u 0 "$CID" bash -c "chmod +x $CCDIR/pkg/codex/bin/codex && chown ${AGENT_UID:-0}:0 $CCDIR/pkg/codex/bin/codex" \
  || { echo "[fail] chmod codex binary"; exit 1; }

CODEX_VERSION="$(docker exec "$CID" "$CCDIR/pkg/codex/bin/codex" --version 2>&1 | tail -1)"
echo "[install] $CODEX_VERSION (static binary + vendor codex-path/codex-resources)"
[ -s "$RUN/prompt.txt" ] && docker cp "$RUN/prompt.txt" "$CID:$CCDIR/prompt.txt" >/dev/null

docker diff "$CID" | sort > "$RUN/diff_post_install.txt"
comm -13 "$RUN/diff_pre_install.txt" "$RUN/diff_post_install.txt" > "$RUN/install_delta.txt"
grep -vE "^[ACD] (/opt$|/opt/rbcodex|/run($|/)|/var/run($|/))" "$RUN/install_delta.txt" \
  > "$RUN/install_delta_filtered.txt" || true
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
grep -E '^[AD] ' "$RUN/install_pollution.txt" > "$RUN/install_pollution_ad.txt" || true
grep -E '^C '   "$RUN/install_pollution.txt" > "$RUN/install_pollution_c.txt"  || true
if [ -s "$RUN/install_pollution_c.txt" ]; then
  echo "[note] pre-existing paths modified during the install window (task's own services):"
  sed 's/^/  /' "$RUN/install_pollution_c.txt"
  [ "${RB_STRICT_POLLUTION:-0}" = 1 ] && { echo "[fail] strict pollution check"; exit 1; }
fi
if [ -s "$RUN/install_pollution_ad.txt" ]; then
  echo "[note] paths added/deleted outside $CCDIR during the install window"
  echo "       ($(wc -l < "$RUN/install_pollution_ad.txt") entries; see install_pollution_ad.txt)"
  sed -n '1,5s/^/  /p' "$RUN/install_pollution_ad.txt"
  [ "${RB_STRICT_POLLUTION:-0}" = 1 ] && { echo "[fail] strict pollution check"; exit 1; }
fi

# --- MCP wiring (only tasks with a non-empty `mcp:` block) ------------------
# Same gen_mcp_config.sh / health-probe path run_task_claude.sh uses (it is
# agent-agnostic: it stands the server(s) up inside the task container and
# waits for /healthz + a real tools/list handshake). What differs is HOW the
# resulting URL is handed to the agent: Claude Code takes --mcp-config on the
# CLI; codex reads [mcp_servers.*] from config.toml, so we write that table
# directly (see the config.toml assembly below) instead of shelling a second
# `codex mcp add` process.
#
# The TOML shape below is NO LONGER a guess (2026-08-17): running the real
# `codex mcp add playwright --url http://127.0.0.1:8817/mcp` against 0.147
# writes exactly
#     [mcp_servers.playwright]
#     url = "http://127.0.0.1:8817/mcp"
# -- no transport key, no experimental_use_rmcp_client. 0.147 has the rmcp
# client built in, and the run logs confirm the handshake:
#     rmcp::service: Service initialized as client peer_info=...
#         serverInfo { name: "Playwright", version: "1.63.0-alpha-..." }
#
# So the config was never the bug. What WAS the bug: codex hands MCP tools to
# the model as ONE Responses tool of type `namespace` ("mcp__playwright") with
# the real tools nested inside. Any translation layer between codex and the
# upstream has to flatten/un-flatten those namespaces; one that drops every
# tool whose type != "function" silently sends the run shell-only with
# mcp_called=0 and nothing logged a word (measured: 33 runs).
MCP_TOML=""
if [ -n "${MCP_NAMES:-}" ]; then
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
  MCP_TOML="$($PY - "$TASKDIR/task.yaml" "$RUN/mcp_client_host.json" <<'PY'
import json, re, sys, yaml
task, hostcfg = sys.argv[1:3]
entries = (yaml.safe_load(open(task)) or {}).get("mcp") or []
urls = json.load(open(hostcfg))["mcpServers"]
out = []
for e in entries:
    n = e["server"]
    url = urls.get(n, {}).get("url", "")
    url = re.sub(r"//[^:/]+:", "//127.0.0.1:", url)  # bridge IP -> in-container localhost
    # startup_timeout_sec/tool_timeout_sec: codex's defaults are tight for a
    # cold browser (a first browser_navigate on a loaded box routinely takes
    # tens of seconds). Same numbers Meta's own managed config uses.
    out.append('[mcp_servers.%s]\nurl = "%s"\n'
               'startup_timeout_sec = 60.0\ntool_timeout_sec = 120.0\n' % (n, url))
print("\n".join(out))
PY
)"
  # in-container health probe (same /dev/tcp trick; these images often have
  # neither curl nor wget) so a task never silently runs with zero MCP tools.
  : > "$RUN/mcp_health_incontainer.log"
  for n in $MCP_NAMES; do
    h="$($PY -c 'import json,sys,yaml
d=json.load(open(sys.argv[1]))
e=[x for x in (yaml.safe_load(open(sys.argv[2])) or {}).get("mcp") or [] if x["server"]==sys.argv[3]][0]
print("http://127.0.0.1:%d%s" % (int(e["port"]), e.get("health","/healthz")))' \
          "$RUN/mcp_client_host.json" "$TASKDIR/task.yaml" "$n" 2>/dev/null)"
    u="$($PY -c 'import json,sys;print(json.load(open(sys.argv[1]))["mcpServers"][sys.argv[2]]["url"])' \
          "$RUN/mcp_client_host.json" "$n")"
    hp="${h#http://}"; hh="${hp%%/*}"; hpath="/${hp#*/}"
    code="$(docker exec "$CID" bash -c '
      IFS=: read -r host port <<<"$1"
      exec 3<>/dev/tcp/"$host"/"${port:-80}" 2>/dev/null || { echo 000; exit 0; }
      printf "GET %s HTTP/1.0\r\nHost: %s\r\nConnection: close\r\n\r\n" "$2" "$1" >&3
      read -r -t 5 status <&3 || { echo 000; exit 0; }
      set -- $status; echo "${2:-000}"' _ "$hh" "$hpath" 2>/dev/null)"
    echo "$n health=$h code=$code url=$u" >> "$RUN/mcp_health_incontainer.log"
    [ "$code" = 200 ] || { echo "[fail] in-container MCP health check failed: $n $h -> $code"; exit 1; }

    # /healthz is the BRIDGE's own endpoint: it answers as soon as the port is
    # bound, which is before the stdio child behind it can serve anything. So
    # require a real protocol handshake -- initialize + tools/list with >=1
    # USABLE tool -- before the agent is allowed to start. This is the check
    # run_task_claude.sh has had all along and this runner did not, which is
    # why a codex playwright run could go all the way to a judged verdict with
    # zero browser tools without printing a single warning. Same probe, same
    # budget (40 x 3s, exits on first success), same hard exit.
    ucont="$($PY -c 'import sys,yaml
e=[x for x in (yaml.safe_load(open(sys.argv[1])) or {}).get("mcp") or [] if x["server"]==sys.argv[2]][0]
print("http://127.0.0.1:%d%s" % (int(e["port"]), e.get("path","/mcp")))' \
      "$TASKDIR/task.yaml" "$n")"
    if docker exec "$CID" sh -c 'command -v python3' >/dev/null 2>&1; then
      PROBE_RUN=(docker exec -i "$CID" python3 - "$ucont")
    else
      # No python3 in the image: fall back to probing from the host against the
      # bridge URL. On rootless podman the host cannot route to container IPs,
      # so this is a fallback, not the primary path (see run_task_claude.sh).
      PROBE_RUN=("$PY" - "$u")
    fi
    ntools=0
    for attempt in $(seq 1 40); do
      ntools="$("${PROBE_RUN[@]}" <<'MCPPROBE' 2>/dev/null || echo 0
import json, sys, urllib.request
url = sys.argv[1]
H = {"Content-Type": "application/json",
     "Accept": "application/json, text/event-stream",
     "MCP-Protocol-Version": "2025-06-18"}
def post(body, sid=None):
    h = dict(H)
    if sid: h["Mcp-Session-Id"] = sid
    r = urllib.request.urlopen(
        urllib.request.Request(url, json.dumps(body).encode(), h), timeout=90)
    return r, r.read().decode("utf-8", "replace")
def parse(raw):                      # streamable HTTP may frame the reply as SSE
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
    try:
        if sid:
            dh = dict(H); dh["Mcp-Session-Id"] = sid
            urllib.request.urlopen(
                urllib.request.Request(url, headers=dh, method="DELETE"), timeout=5)
    except Exception:
        pass
# Counting tools is not enough: a server can list tools whose inputSchema is
# unusable, and a client then drops the whole server. Count only usable ones.
def usable(t):
    s = t.get("inputSchema")
    if not isinstance(s, dict):
        return False
    return s.get("type") == "object" or bool(s.get("properties"))
bad = [t.get("name", "?") for t in tools if not usable(t)]
print("%d %d %s" % (len(tools) - len(bad), len(tools), ",".join(bad[:6])))
MCPPROBE
)"
      read -r nusable ntotal nbad <<<"${ntools:-0 0 }"
      [ "${nusable:-0}" -ge 1 ] 2>/dev/null && break
      sleep 3
    done
    read -r nusable ntotal nbad <<<"${ntools:-0 0 }"
    echo "$n tools=${nusable:-0}/${ntotal:-0} usable (after $attempt probe attempt(s)) url=$ucont" \
      >> "$RUN/mcp_health_incontainer.log"
    [ -n "${nbad:-}" ] && echo "$n UNUSABLE SCHEMAS: $nbad" >> "$RUN/mcp_health_incontainer.log"
    [ "${nusable:-0}" -ge 1 ] 2>/dev/null || {
      echo "[fail] MCP handshake gate: server '$n' answered /healthz but the" \
           "initialize+tools/list handshake yielded ${nusable:-0}/${ntotal:-0} usable" \
           "tools (${nbad:-none unusable}). Refusing to start codex: a task with no" \
           "MCP tools runs shell-only and still gets judged as if it had a browser."
      exit 1; }
  done
  sed 's/^/[mcp] /' "$RUN/mcp_health_incontainer.log"
fi

# --- upstream posture ---------------------------------------------------------
# codex only accepts wire_api = "responses", so the upstream has to speak the
# OpenAI Responses API. RB_CODEX_BASE_URL selects it; the default is OpenRouter,
# which does. Our internal runs used a translation sidecar in front of an
# upstream that only spoke chat/completions; that proxy is not part of this
# release, so `sidecar` is rejected here rather than failing later with a
# missing file.
CODEX_KEY_IN_CONTAINER="$OPENROUTER_API_KEY"
if [ "${RB_CODEX_BASE_URL:-}" = sidecar ]; then
  echo "[fail] RB_CODEX_BASE_URL=sidecar needs the responses->chat translation proxy, which is not part of this release." >&2
  echo "       Point RB_CODEX_BASE_URL at an OpenAI-compatible base URL that serves /responses" >&2
  echo "       (default, if you leave it unset: https://openrouter.ai/api/v1)." >&2
  exit 1
fi

# --- config.toml (model/provider/reasoning/approval/sandbox/mcp) -----------
# CODEX_HOME=$CCDIR/cfg, ownership already transferred to the image's own
# user above (same lesson learned the hard way on the Claude runner: a
# root-owned config dir silently no-ops every write for a non-root USER
# image, and the failure only shows up 1 turn later as "resume: no session").
docker exec -u 0 "$CID" bash -c "install -d -m 700 -o ${AGENT_UID:-0} -g 0 $CCDIR/cfg" \
  || { echo "[fail] mkdir $CCDIR/cfg"; exit 1; }
# The provider block comes from an environment variable now, no longer hardcoded to
# OpenRouter.
# On this machine terra/sol go through llama passthrough, and it only supports
# chat/completions -- passthrough's /responses is deprecated (returns
# REDACTED-SYM-Deprecated3PModelException outright), so wire_api = "chat" is
# required; codex's default is "responses".
# --- Model context window (codex does not recognize our model name) ----------
# Every turn, codex's first assistant message is its own warning:
#   Model metadata for `gpt-5.6-terra` not found.
#   Defaulting to fallback metadata; this can degrade performance and cause issues.
# Because the model name we feed it is the llama passthrough one, and codex's
# built-in catalog only has the upstream canonical names gpt-5.6-terra /
# gpt-5.6-sol. Lookup fails -> both the context window and the token budget
# fall back to a guessed value. This is an unfairness that hits **only the
# codex path**.
#
# ---- Why only the window is patched here, instead of clearing the warning
# entirely with model_catalog_json ----
# Tried it, and it is **unusable** (measured offline with
# scripts/docker/165-probe-codex-tool-exposure.sh): the moment
# model_catalog_json is configured (even with the alias entry cloned verbatim
# from gpt-5.6-terra), codex switches to a "deferred tools" assembly -- MCP
# tools no longer ride directly in the request; instead a
#   {"type":"tool_search","execution":"client","description":"# Tool discovery\n
#    Searches over deferred tools..."}
# entry is inserted, telling the model to go search for them itself. Measured
# consequence: on the same task 1311, mcp_called dropped from 5 to 0, and
# browser_* calls in proxy.jsonl went from 1534 occurrences to 0 -- the whole
# browser path simply disappeared. For the playwright cell, this is a fatal
# regression, far worse than leaving the warning in place.
#   Probe comparison (A = no catalog configured, C = catalog configured +
#   tool_mode=direct):
#     A  14 tools, including mcp__<server>          warning present
#     C  15 tools, MCP became tool_search instead    warning gone
# So the tradeoff is clear: keep the warning, keep MCP tools direct.
#
# The number filled in here is not a guess: 272000 is the context_window /
# max_context_window value codex 0.147.0's **own embedded catalog** carries for
# gpt-5.6-terra and gpt-5.6-sol (harness/gen_codex_model_catalog.py is exactly
# what extracted that catalog from the binary; it is kept around so this number
# can always be re-verified). model_context_window is codex's own top-level
# config key, made for exactly this purpose, and measured not to change tool
# assembly (probes F/G are identical to A).
CODEX_CTX_WINDOW="${RB_CODEX_CONTEXT_WINDOW:-1000000}"

$PY - "$RUN/config.toml" "$MODEL" "$PROVIDER" "$REASONING_EFFORT" "$MCP_TOML" \
     "${RB_CODEX_BASE_URL:-https://openrouter.ai/api/v1}" \
     "${RB_CODEX_ENV_KEY:-OPENROUTER_API_KEY}" \
     "${RB_CODEX_WIRE_API:-responses}" \
     "$CODEX_CTX_WINDOW" "$CODEX_AUTH" <<'PY'
import sys
out, model, provider, effort, mcp_toml, base_url, env_key, wire_api, ctx, auth = sys.argv[1:11]
body = '''model = "%s"
model_provider = "%s"
model_reasoning_effort = "%s"
approval_policy = "never"
sandbox_mode = "danger-full-access"

[model_providers.%s]
name = "%s"
base_url = "%s"
env_key = "%s"
wire_api = "%s"
''' % (model, provider, effort, provider, provider, base_url, env_key, wire_api)
if auth == "chatgpt":
    body = '''model = "%s"
model_reasoning_effort = "%s"
approval_policy = "never"
sandbox_mode = "danger-full-access"
''' % (model, effort)
if ctx.strip():
    # Top-level key, must come before any [table]; inserted right after the sandbox_mode line.
    body = body.replace(
        'sandbox_mode = "danger-full-access"\n',
        'sandbox_mode = "danger-full-access"\nmodel_context_window = %s\n' % ctx.strip(), 1)
if mcp_toml.strip():
    body += "\n" + mcp_toml + "\n"
open(out, "w").write(body)
PY
docker cp "$RUN/config.toml" "$CID:$CCDIR/cfg/config.toml" >/dev/null || { echo "[fail] docker cp config.toml"; exit 1; }
docker exec -u 0 "$CID" chown "${AGENT_UID:-0}:0" "$CCDIR/cfg/config.toml" || true
if [ "$CODEX_AUTH" = "chatgpt" ]; then
  [ -s "$CODEX_AUTH_FILE" ] || { echo "[fail] RB_CODEX_AUTH=chatgpt but $CODEX_AUTH_FILE does not exist or is empty"; exit 1; }
  docker cp "$CODEX_AUTH_FILE" "$CID:$CCDIR/cfg/auth.json" >/dev/null || { echo "[fail] docker cp auth.json"; exit 1; }
  docker exec -u 0 "$CID" bash -c "chmod 600 $CCDIR/cfg/auth.json && chown ${AGENT_UID:-0}:0 $CCDIR/cfg/auth.json" || true
fi
echo "[cfg] model=$MODEL auth=$CODEX_AUTH provider=$PROVIDER reasoning_effort=$REASONING_EFFORT -> $CCDIR/cfg/config.toml"

# --- RB_SHADOW_HOOK: snapshot the workspace before every tool call ------------
# codex 0.147.0's hook config shape was read out of the binary, not guessed:
#   struct ConfiguredHookMatcherGroup{matcher,hooks}
#   internally tagged enum HookHandlerConfig{type,command,timeout,...}
#   event names PreToolUse/PostToolUse/... (PascalCase in config, kebab-case on the wire)
# The path was **measured** (scripts/docker/295-codex-hook-shapes.sh, using
# SessionStart as the probe since it fires at startup and can be tested
# offline):
#   ✓ $CODEX_HOME/hooks.json                 <- this is the one used
#   ✓ config.toml's [[hooks.X]] + [[hooks.X.hooks]] nested tables
#   ✗ $CODEX_HOME/hooks/hooks.json           <- the "hooks/hooks.json" seen in the
#                                                binary is codex's own output artifact,
#                                                not an input
#   ✗ top-level JSON without a "hooks" wrapper
# The shape matches the claude-code side, so both harnesses share the same
# shadow-snap.sh. The workspace is **pinned** here to the task's CWD -- without
# pinning, the script would fall back to the cwd the hook reports, and the
# snapshot scope would drift every time the agent cd's.
if [ -n "${RB_SHADOW_HOOK:-}" ]; then
  docker cp "$HERE/shadow-snap.sh" "$CID:/opt/rb-shadow-snap.sh" >/dev/null 2>&1 || true
  docker exec -u 0 "$CID" chmod 755 /opt/rb-shadow-snap.sh 2>/dev/null || true
  _hj="$(mktemp)"
  printf '{"hooks":{"PreToolUse":[{"matcher":"","hooks":[{"type":"command","command":"RB_SHADOW_WORK_TREE=%s /opt/rb-shadow-snap.sh","timeout":90}]}]}}' "$CWD" > "$_hj"
  docker cp "$_hj" "$CID:$CCDIR/cfg/hooks.json" >/dev/null 2>&1 || true
  docker exec -u 0 "$CID" chown "${AGENT_UID:-0}:0" "$CCDIR/cfg/hooks.json" 2>/dev/null || true
  rm -f "$_hj"
  echo "[shadow] codex PreToolUse hook installed -> $CCDIR/cfg/hooks.json (workspace=$CWD)"
fi

# --- RB_BACKUPPER: install the CHATS-Sandbox plugin INTO the task container ---
# codex runs INSIDE the task container, so unlike hermes the hook and the
# command it protects share a filesystem. Everything below was measured against
# codex-cli 0.147.0 with a scripted fake Responses server (no model calls):
#
#   * `codex exec` DOES dispatch hooks in 0.147 -- the plugin README's "codex
#     exec did not dispatch them" is a 0.139 statement and is now stale. BUT
#     only with --dangerously-bypass-hook-trust: without it ZERO hooks fire and
#     nothing is logged. adapters/codex.sh adds the flag (already there for
#     RB_SHADOW_HOOK; extended to RB_BACKUPPER).
#   * 0.147 has a UserPromptSubmit event that 0.139 did not, and the plugin's
#     codex adapter does not wire it. We add it by hand below -- it is the
#     session briefing, i.e. the whole reason an agent knows the marker exists.
#     Verified: its additionalContext reaches the model AND persists in the
#     session, and `codex exec resume --last` keeps the same session_id, so
#     announceOnce fires exactly once per run. Same shape as the claude lane.
#   * $CODEX_HOME/hooks.json and $CWD/.codex/hooks.json are MERGED by codex, so
#     the RB_SHADOW_HOOK entry written above and the plugin's entries coexist;
#     both PreToolUse hooks fire on the same call. Verified.
#   * TIER 0 MUST BE OFF. codex 0.147 REJECTS hookSpecificOutput.updatedInput
#     ("hook: PreToolUse Failed"), and a failed hook discards the whole output
#     object -- including additionalContext. Measured: with tier 0 on, the
#     backup was still taken but the agent was told nothing and the original
#     command ran. CHATS_SANDBOX_NO_REWRITE=1 is the plugin's own switch.
#     (src/agents/codex.ts still claims updatedInput is honoured; that was true
#      of 0.139.)
#   * permissionDecision:"deny" DOES work -- the command does not run and the
#     reason arrives as the tool result. So the deny rules keep their teeth.
if [ "${RB_BACKUPPER:-0}" = 1 ]; then
  CS_SRC="${RB_CS_DIR:-$RB/vendor/chats-sandbox}"
  NODE_SRC="${RB_CS_NODE_DIR:-$RB/vendor/node-current}"
  CSDIR=/opt/rbcs
  [ -s "$CS_SRC/dist/cli.js" ] || { echo "[fail] chats-sandbox not at $CS_SRC"; exit 1; }
  [ -x "$NODE_SRC/bin/node" ] || { echo "[fail] node 18+ not at $NODE_SRC"; exit 1; }
  NODE_REAL="$(basename "$(readlink -f "$NODE_SRC")")"
  docker exec -u 0 "$CID" mkdir -p "$CSDIR/bin" || { echo "[fail] mkdir $CSDIR"; exit 1; }
  tar -C "$(dirname "$NODE_SRC")" -czf "$RUN/.node.tgz" "$NODE_REAL/bin" "$NODE_REAL/lib" 2>/dev/null
  docker cp "$RUN/.node.tgz" "$CID:$CSDIR/node.tgz" >/dev/null && rm -f "$RUN/.node.tgz"
  docker exec -u 0 "$CID" sh -c "cd $CSDIR && tar --no-same-owner -xzf node.tgz && rm -f node.tgz && ln -sfn $NODE_REAL nodejs" \
    || { echo "[fail] staging node"; exit 1; }
  tar -C "$CS_SRC" -czf "$RUN/.cs.tgz" dist package.json commands 2>/dev/null
  docker cp "$RUN/.cs.tgz" "$CID:$CSDIR/cs.tgz" >/dev/null && rm -f "$RUN/.cs.tgz"
  docker exec -u 0 "$CID" sh -c "mkdir -p $CSDIR/plugin && cd $CSDIR/plugin && tar --no-same-owner -xzf ../cs.tgz && rm -f ../cs.tgz" \
    || { echo "[fail] staging plugin"; exit 1; }
  CS_NODE_IN="$CSDIR/nodejs/bin/node"

  # The agent WILL try to verify the briefing (measured on gemini: it ran
  # `which chats-sandbox`). Give it a real CLI on PATH, pointed at the real
  # store -- not a decoy.
  docker exec -u 0 "$CID" sh -c "printf '%s\n' '#!/bin/sh' 'exec $CS_NODE_IN $CSDIR/plugin/dist/cli.js \"\$@\"' > $CSDIR/bin/chats-sandbox && chmod 755 $CSDIR/bin/chats-sandbox" \
    || { echo "[fail] chats-sandbox shim"; exit 1; }

  # Every CLI invocation below has to see the same store the hooks will, or the
  # installer writes config.json to one place and the hooks read another.
  docker exec -u 0 -w "$CWD" "${CS_STORE_ENV[@]+"${CS_STORE_ENV[@]}"}" "$CID" "$CS_NODE_IN" "$CSDIR/plugin/dist/cli.js" install codex \
    >/dev/null 2>&1 || { echo "[fail] chats-sandbox install codex"; exit 1; }

  # Two edits to the installer's output:
  #   1. bare `node` -> the staged absolute path (most task images have no node);
  #   2. add UserPromptSubmit, which src/agents/codex.ts does not write.
  docker exec -u 0 "$CID" "$CS_NODE_IN" -e "
    const fs=require('fs'), p='$CWD/.codex/hooks.json';
    const d=JSON.parse(fs.readFileSync(p,'utf8'));
    for (const ev of Object.keys(d.hooks)) for (const g of d.hooks[ev]) for (const h of g.hooks)
      h.command = h.command.replace(/^node /, '$CS_NODE_IN ');
    d.hooks.UserPromptSubmit = [{hooks:[{type:'command',
      command:'$CS_NODE_IN \"$CSDIR/plugin/dist/hooks/user-prompt.js\"', timeout:600}]}];
    fs.writeFileSync(p, JSON.stringify(d,null,2)+'\n');
  " || { echo "[fail] rewriting $CWD/.codex/hooks.json"; exit 1; }

  for kv in "mode=${RB_CS_MODE:-checker}" \
            "subagentEnabled=true" \
            "subagentRunner=${RB_CS_RUNNER:-codex}" \
            "subagentCodexModel=${RB_CS_SUBAGENT_MODEL:-gpt-5.6-luna}" \
            "subagentTimeoutSeconds=${RB_CS_SUBAGENT_TIMEOUT:-240}"; do
    docker exec -u 0 -w "$CWD" "${CS_STORE_ENV[@]+"${CS_STORE_ENV[@]}"}" "$CID" "$CS_NODE_IN" "$CSDIR/plugin/dist/cli.js" \
      config set "${kv%%=*}" "${kv#*=}" >/dev/null 2>&1
  done
  # A postcondition, not an intention: config.json must actually land at
  # $CS_STORE_IN. That has always been true at the default path, so nobody ever
  # checked it; once relocated it's the single point of failure for the whole
  # chain -- if it drops, every hook runs with DEFAULT_CONFIG, the store
  # silently reverts to inside the workspace, and every step above still
  # reports success.
  if ! docker exec -u 0 "$CID" test -s "$CS_STORE_IN/config.json" 2>/dev/null; then
    echo "[fail] backupper config.json not at $CS_STORE_IN/config.json"; exit 1
  fi

  CS_EXP="${RB_CS_EXPERIENCES:-$CS_SRC/experiences}"
  if [ -d "$CS_EXP" ]; then
    docker exec -u 0 "$CID" mkdir -p "$CS_STORE_IN/experiences" 2>/dev/null
    # Inject **all** experiences in self-exploration (excluding history snapshots like
    # *.prev.json). It used to hardcode just `postgres playwright`, so something like
    # reddit.json never got injected -- and 20 of the 205 tasks are reddit tasks.
    # Experiences map to MCP servers by their own file's appliesTo, and a file only
    # gets used once it's in the container, so injecting extra ones cannot cause a
    # mismatch.
    for _ef in "$CS_EXP"/*.json; do
      [ -s "$_ef" ] || continue
      case "$(basename "$_ef")" in *.prev.json) continue ;; esac
      docker cp "$_ef" "$CID:$CS_STORE_IN/experiences/$(basename "$_ef")" >/dev/null 2>&1 \
        && echo "[arm] experience injected: $(basename "$_ef")"
    done
  fi

  # --- the tier-3 subagent's own CODEX_HOME --------------------------------
  # MEASURED HAZARD, not a precaution. subagent.ts spawns `codex exec ...` with
  # the parent's environment, so it would land in the SAME $CODEX_HOME. Then
  # adapters/codex.sh's `codex exec resume --last` on the next turn resumes the
  # SUBAGENT's session, and the main agent's whole history is gone. Reproduced
  # on 0.147: after one interleaved subagent run, the resumed turn's model input
  # contained the subagent's prompt and reply and NONE of the main agent's turn
  # 1. Giving the subagent a private CODEX_HOME restores it exactly (verified).
  # The shim is what the plugin finds on PATH as `codex`.
  docker exec -u 0 "$CID" sh -c "install -d -m 700 -o ${AGENT_UID:-0} -g 0 $CCDIR/subcfg" || true
  # The subagent's provider is entirely determined by this config.toml -- the plugin's
  # codex branch only pushes `-m <model>`, never sets a provider, and never reads
  # CHATS_SANDBOX_SUBAGENT_* (those three variables only have readers in the hermes and
  # claude branches). So under subscription mode, a verbatim copy = the subagent goes
  # through OpenAI. All 953 historical successes have this shape (subagent=gpt-5.6-luna,
  # a slug OpenAI recognizes).
  # 2026-09-09: after switching tier-3 to deepseek/deepseek-v4-flash-0731, all 412
  # spawns failed, with `status 400 ... model is not available` + `provider_name=OpenAI`
  # -- the model name was OpenRouter's, but the provider was still OpenAI. The provider
  # only switches when both base_url AND token are supplied; missing either keeps the
  # historical behavior, so as not to disturb the convention of batches that have
  # already run.
  _SUBCFG_SRC="$RUN/config.toml"
  if [ -n "${RB_CS_SUBAGENT_BASE_URL:-}" ] && [ -n "${RB_CS_SUBAGENT_AUTH_TOKEN:-}" ]; then
    "${RB_PY:-python3}" - \
        "$RUN/config.toml" "$RUN/subcfg-config.toml" "$RB_CS_SUBAGENT_BASE_URL" <<'_TOML_' || {
import sys
src, dst, base = sys.argv[1:4]
body = open(src).read()
# TOML top-level keys must come before any [table]; model_provider is inserted before the first [.
i = body.find('\n[')
head, tail = (body[:i], body[i:]) if i >= 0 else (body, '')
head = head.rstrip('\n') + '\nmodel_provider = "csrouter"\n'
open(dst, 'w').write(head + tail.rstrip('\n') +
    '\n\n[model_providers.csrouter]\nname = "csrouter"\n'
    'base_url = "%s"\nenv_key = "CS_SUBAGENT_KEY"\nwire_api = "responses"\n' % base)
_TOML_
      echo "[fail] rewriting subcfg config.toml"; exit 1; }
    _SUBCFG_SRC="$RUN/subcfg-config.toml"
    echo "[arm] subagent provider -> $RB_CS_SUBAGENT_BASE_URL (wire_api=responses)"
  fi
  docker cp "$_SUBCFG_SRC" "$CID:$CCDIR/subcfg/config.toml" >/dev/null
  docker exec -u 0 "$CID" chown "${AGENT_UID:-0}:0" "$CCDIR/subcfg/config.toml" || true
  # The subagent also needs credentials under subscription mode. This backupper code
  # was written in the apikey era: back then, passing the key through in the
  # environment to the child process was enough, so only config.toml mattered. When
  # subscription auth was added on 09-01, only the main agent's cfg/ was patched;
  # subcfg/ was missed -- the result is invoking: lines in subagent.log but
  # authentication failing every time, and `not_spawned` is only ever written when the
  # CLI is not on PATH, so this was invisible.
  # Once a custom provider is in effect, do not also place subscription credentials in
  # here: with both sets of credentials present, which one authentication actually
  # takes depends on codex's internal priority, and its failure symptom looks exactly
  # like "nothing configured".
  if [ "$CODEX_AUTH" = "chatgpt" ] && [ "$_SUBCFG_SRC" = "$RUN/config.toml" ]; then
    docker cp "$CODEX_AUTH_FILE" "$CID:$CCDIR/subcfg/auth.json" >/dev/null \
      || { echo "[fail] docker cp subcfg/auth.json"; exit 1; }
    docker exec -u 0 "$CID" bash -c "chmod 600 $CCDIR/subcfg/auth.json && chown ${AGENT_UID:-0}:0 $CCDIR/subcfg/auth.json" || true
  fi
  docker exec -u 0 "$CID" sh -c "printf '%s\n' '#!/bin/sh' \
    'export CODEX_HOME=$CCDIR/subcfg' \
    'exec $CCDIR/pkg/codex/bin/codex \"\$@\"' > $CSDIR/bin/codex && chmod 755 $CSDIR/bin/codex" \
    || { echo "[fail] codex subagent shim"; exit 1; }

  _IMG_PATH2="$(docker exec "$CID" sh -c 'printf %s "$PATH"' 2>/dev/null)"
  # CHATS_SANDBOX_STORE_DIR must be in the AGENT's env, not only the installer's:
  # codex passes its environment to the hook processes, and a hook without it
  # calls getConfigDir() -> $CWD/.chats-sandbox, finds no config.json, and runs
  # the whole session on DEFAULT_CONFIG with the store back inside the workspace.
  CS_PATH_ENV=(-e "PATH=$CSDIR/bin:$CSDIR/nodejs/bin:$CCDIR/pkg/codex/codex-path:${_IMG_PATH2:-/usr/local/bin:/usr/bin:/bin}"
               "${CS_STORE_ENV[@]+"${CS_STORE_ENV[@]}"}"
               -e CHATS_SANDBOX_NO_REWRITE=1
               -e CHATS_SANDBOX_PERSIST_SUBAGENT_SESSIONS=1)
  # config.toml's env_key names this exact variable; AGENT_ENV is the only channel that
  # gets it to the hook -> subagent process, and without it codex treats it as "no
  # credentials".
  [ -n "${RB_CS_SUBAGENT_AUTH_TOKEN:-}" ] && \
    CS_PATH_ENV+=(-e "CS_SUBAGENT_KEY=$RB_CS_SUBAGENT_AUTH_TOKEN")
  # The store's owner. Installing the plugin, writing config, and creating experiences
  # above all ran under `docker exec -u 0`, while the agent process runs as the image's
  # own USER. Of the 205 tasks, the postgres (50/50) and k8s (20/20) images' USER is
  # not root -- without a chown, the first hook call hits EACCES,
  # declarations.jsonl never gets written, and "[arm] backupper installed" still
  # prints regardless. This copies the approach the claude lane already uses.
  docker exec -u 0 "$CID" chown -R "${AGENT_UID:-0}:0" "$CSDIR" "$CS_STORE_IN" "$CWD/.codex" >/dev/null 2>&1 || true
  # A postcondition, not an intention: prove the agent's own uid can actually create the store.
  if docker exec "$CID" sh -c "mkdir -p '$CS_STORE_IN/.wtest' && rmdir '$CS_STORE_IN/.wtest'" >/dev/null 2>&1; then
    _cs_writable="store writable by agent"
  else
    _cs_writable="[ERROR] store NOT writable by agent -- every hook call will fail with EACCES and no backup will be taken"
  fi
  echo "[arm] backupper store -> $CS_STORE_IN$([ "$CS_STORE_IN" = "$CWD/.chats-sandbox" ] && echo " (default, inside workspace)" || echo " (RELOCATED out of the workspace)")"
  echo "[arm] backupper installed (codex): mode=${RB_CS_MODE:-checker} runner=${RB_CS_RUNNER:-codex} subagent=${RB_CS_SUBAGENT_MODEL:-gpt-5.6-luna} tier0=off(updatedInput unsupported on 0.147); $_cs_writable"
fi
echo "[cfg] model_context_window=$CODEX_CTX_WINDOW (uniformly set to 1M; measured across 388 runs, auto-compression never triggered)"

# --- credentials -------------------------------------------------------------
# codex's OpenRouter provider reads its key from the env var named by
# config.toml's env_key (OPENROUTER_API_KEY) -- there is no sidecar-gateway
# path for codex; this is the "direct" posture (RB_CLAUDE_AUTH=direct's
# analogue), so the key IS visible to the agent under test inside the
# container. That is an accepted, documented tradeoff already used elsewhere
# in this harness for the same reason (simplicity, no proxy to keep alive).
_CA_ENV=()
# --- CA roots for the agent binary -------------------------------------------
# codex is Rust and uses the SYSTEM root store ("using system root certificates
# because no CA override environment variable was selected"). Several task
# images are node:20-bookworm-slim with no apt installs, and the slim image does
# NOT ship ca-certificates -- tasks 63 and 99 have ZERO system certs, while 101
# happens to install them for git. In those images every codex request died as
# "stream disconnected before completion: error sending request for url
# (https://openrouter.ai/api/v1/responses)" from turn 1, which reads like a
# network fault and is really a TLS trust failure. Node hid it: node bundles its
# own CA store, so an in-container node probe to the same URL returned 200 in the
# very image where codex could not connect.
#
# Staged like the codex binary itself -- agent infrastructure, not task content.
# SSL_CERT_FILE is set only in the agent's exec env, so the task's own tooling
# (npm/node use their bundled store) is unaffected and nothing about what the
# task measures changes.
if [ -r /etc/ssl/certs/ca-certificates.crt ]; then
  if ! docker exec "$CID" test -s /etc/ssl/certs/ca-certificates.crt 2>/dev/null; then
    docker cp /etc/ssl/certs/ca-certificates.crt "$CID:$CCDIR/ca-certificates.crt" >/dev/null 2>&1 \
      && docker exec -u 0 "$CID" chown "${AGENT_UID:-0}:0" "$CCDIR/ca-certificates.crt" 2>/dev/null
    _CA_ENV=(-e SSL_CERT_FILE="$CCDIR/ca-certificates.crt")
    echo "[ca] image has no system CA bundle -- staged host roots at $CCDIR/ca-certificates.crt (agent env only)"
  fi
fi
# Under sidecar mode this holds a one-time nonce, not the real key (see the sidecar
# block above).
# PATH: put codex's own bundled codex-path (which holds rg) **first**.
# This is only a **belt-and-braces** measure -- what actually matters is the
# /usr/local/bin/rg symlink above, because codex's shell tool starts a login shell,
# and /etc/profile wipes out the PATH addition made here (measured). It stays anyway:
# codex's own process (the internal calls that do not go through a login shell) does
# use it.
# The second half of PATH is taken from the container image's own PATH rather than a
# hardcoded string -- some task images add their own entries to PATH (e.g. images with
# PLAYWRIGHT_BROWSERS_PATH), and hardcoding would drop them.
_IMG_PATH="$(docker exec "$CID" sh -c 'printf %s "$PATH"' 2>/dev/null)"
[ -n "$_IMG_PATH" ] || _IMG_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
_PATH_ENV=()
if docker exec "$CID" test -x "$CCDIR/pkg/codex/codex-path/rg" 2>/dev/null; then
  _PATH_ENV=(-e PATH="$CCDIR/pkg/codex/codex-path:$_IMG_PATH")
fi
AGENT_ENV=(-e OPENROUTER_API_KEY="$CODEX_KEY_IN_CONTAINER" -e CODEX_HOME="$CCDIR/cfg"
           "${_CA_ENV[@]}" "${_PATH_ENV[@]}"
           "${CS_PATH_ENV[@]+"${CS_PATH_ENV[@]}"}"
           -e RUST_LOG=info)
AUTH_DESC="direct:${RB_CODEX_BASE_URL:-https://openrouter.ai/api/v1}"
echo "[auth] OPENROUTER_API_KEY passed directly into ${CID:0:12} (env_key from config.toml)"

# --- phase gate --------------------------------------------------------------
if [ "${RB_PHASE:-}" = setup ]; then
  {
    echo "CID=$(printf %q "$CID")"
    echo "CWD=$(printf %q "$CWD")"
    # Where the backupper store lives inside the container. adapter_collect
    # reads this instead of assuming $CWD/.chats-sandbox; it is $CWD/.chats-sandbox
    # unless RB_CS_STORE moved it.
    echo "CS_STORE=$(printf %q "$CS_STORE_IN")"
    echo "CCDIR=$(printf %q "$CCDIR")"
    echo "IMAGE=$(printf %q "$IMAGE")"
    echo "MODEL=$(printf %q "$MODEL")"
    echo "PROVIDER=$(printf %q "$PROVIDER")"
    echo "CODEX_AUTH=$(printf %q "$CODEX_AUTH")"
    echo "REASONING_EFFORT=$(printf %q "$REASONING_EFFORT")"
    echo "ADD_DIR=$(printf %q "${ADD_DIR:-}")"
    echo "IDFILE=$(printf %q "$IDFILE")"
    echo "CODEX_VERSION=$(printf %q "$CODEX_VERSION")"
    echo "AUTH_DESC=$(printf %q "$AUTH_DESC")"
    declare -p AGENT_ENV 2>/dev/null || echo "declare -a AGENT_ENV=()"
  } > "$RUN/session.env"
  trap - EXIT
    # Safety net: session.env is produced by `declare -p AGENT_ENV`, and AGENT_ENV
  # carries the real key under direct auth. Measured to have leaked once in
  # practice (an early terra smoke run), and run directories get packaged for
  # delivery. Switching to sidecar+nonce should stop this from happening again, but
  # this is a hard check anyway -- one leak is bad enough that "it shouldn't happen"
  # is not good enough on its own.
  if [ -n "${RB_UPSTREAM_KEY:-}" ] && grep -qF -- "$RB_UPSTREAM_KEY" "$RUN/session.env" 2>/dev/null; then
    echo "[fail] plaintext upstream key found in session.env -- refusing to continue, fix the auth path first"
    exit 1
  fi
  echo "[setup] container ${CID:0:12} ready; session.env -> $RUN/session.env"
  echo "$RUN"
  exit 0
fi

# --- v1 single-shot path (parity with run_task_claude.sh; v2 is driven by
# run.sh --harness codex, which never reaches here with RB_PHASE unset) -----
echo "[run] agent=codex-cli model=$MODEL provider=$PROVIDER effort=$REASONING_EFFORT timeout=${TIMEOUT}s"
START=$(date +%s); RC=0
docker exec -w "$CWD" "${AGENT_ENV[@]}" "$CID" \
  timeout "$TIMEOUT" "$CCDIR/pkg/codex/bin/codex" exec \
    --skip-git-repo-check --json -- "$(cat "$RUN/prompt.txt")" \
  2> "$RUN/agent.stderr.log" \
  | tee -a "$RUN/codex_stream.raw.jsonl" \
  | "$PY" "$HERE/codex_normalize.py" >> "$RUN/claude_stream.jsonl"
RC=${PIPESTATUS[0]:-$?}
WALL=$(( $(date +%s) - START ))
[ "$RC" = 124 ] && echo timeout > "$RUN/TIMEOUT"
echo "[run] rc=$RC wall=${WALL}s"

cp "$RUN/claude_stream.jsonl" "$RUN/claude_session.jsonl" 2>/dev/null || true
NORM="$("$PY" "$HERE/cc_trajectory.py" --out "$RUN/trajectory.json" --log "$RUN/agent.log" \
        --instruction-file "$RUN/prompt.txt" --model "$MODEL" \
        --session "$RUN/claude_session.jsonl" --stream "$RUN/claude_stream.jsonl" 2>&1)"
echo "[ok] trajectory -> $RUN/trajectory.json ($NORM)"

$PY - "$RUN" "$SLUG" "$TASKID" "$MODEL" "$IMAGE" "$CID" "$CWD" "$AUTH_DESC" \
      "$CODEX_VERSION" "$RC" "$WALL" "$TIMEOUT" "${MCP_NAMES:-}" "$ADD_DIR" "$REASONING_EFFORT" <<'PY'
import json, os, sys
(run, slug, tid, model, image, cid, cwd, authdesc, cxver, rc, wall, tmo,
 mcpnames, adddir, effort) = sys.argv[1:16]
def txt(p):
    p = os.path.join(run, p)
    return open(p).read().splitlines() if os.path.exists(p) else []
meta = {
    "agent": "codex-cli", "agent_version": cxver, "agent_location": "in-task-container",
    "model": model, "requested_reasoning_effort": effort,
    "condition": "nobackup", "task_id": tid, "slug": slug, "image": image,
    "container_id": cid, "cwd": cwd,
    "auth_mode": "direct", "auth_endpoint": authdesc,
    "credential_in_task_container": True,
    "prompt_source": "task.yaml:instruction (verbatim, no additions)",
    "prompt_sha256": __import__("hashlib").sha256(
        open(os.path.join(run, "prompt.txt"), "rb").read()).hexdigest(),
    "mcp_servers": mcpnames.split() if mcpnames else [],
    "add_dir": adddir,
    "exit_code": int(rc), "wall_s": int(wall), "agent_timeout_sec": int(tmo),
    "timed_out": int(rc) == 124,
    "install_delta_paths": txt("install_delta.txt"),
    "install_pollution_paths": txt("install_pollution.txt"),
}
json.dump(meta, open(os.path.join(run, "run_meta.json"), "w"), indent=2)
open(os.path.join(run, "run_meta.json"), "a").write("\n")
PY

"$PY" "$HERE/judge.py" "$TASKDIR/task.yaml" "$RUN/trajectory.json" \
  --backend "$JUDGE_BACKEND" --model "$JUDGE_MODEL" --out "$RUN/judge.json" \
  > "$RUN/judge.log" 2>&1 || echo "[warn] judge.py failed (see $RUN/judge.log)"
if [ -f "$RUN/judge.json" ]; then
  echo "[judge] $($PY -c 'import json,sys;d=json.load(open(sys.argv[1]));print("backed_up=%s status=%s"%(d.get("backed_up"),d.get("judge_status")))' "$RUN/judge.json")"
fi

echo "$RUN"
