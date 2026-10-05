#!/usr/bin/env bash
# run_task_codex.sh <task-dir> [model]
#
# Setup step of the codex harness. adapters.sh (codex) calls it once per run to
# create the task container, install the agent and write $RUN/session.env;
# run.sh then drives the turns. It follows run_task_claude.sh; the differences:
#   * codex-cli is a single static binary (RB_CODEX_BUNDLE, not shipped),
#     copied into the container with no package manager involved.
#   * The API key is passed through the container environment (there is no
#     sidecar gateway), or RB_CODEX_AUTH=chatgpt copies a subscription login.
#   * Model, provider, approval/sandbox policy and MCP servers are written to
#     $CODEX_HOME/config.toml. approval_policy="never" and
#     sandbox_mode="danger-full-access" only stop codex from refusing or asking;
#     the container keeps the docker flags applied by `harness_util.py precreate-container`.
#   * Continuation is `codex exec resume --last` in a per-run CODEX_HOME.
#   * adapter_turn translates codex's --json events with `trajectory.py codex`
#     into $RUN/claude_stream.jsonl, so the downstream scripts are shared.
#   * There is no plugin-absence probe (it is specific to Claude Code).
#
# Env:
#   RB_CODEX_MODEL              default openai/gpt-5.6-terra
#   RB_CODEX_PROVIDER           default openrouter
#   RB_CODEX_REASONING_EFFORT   default medium
#   RB_CODEX_BUNDLE             required: path to codex-cli-<version>-linux-x64.bin
#   RB_CODEX_VENDOR_TGZ         codex's vendor files (rg etc.); default is the
#                               codex-vendor tarball beside RB_CODEX_BUNDLE.
#                               Optional, but without it the container has no rg.
#   RB_CODEX_CONTEXT_WINDOW     model_context_window written into config.toml
#   RB_RESULTS_DIR              default $RB/results/codex
#   RB_RUN_DIR                  use this run dir instead of minting one (adapter passes it)
#   RB_BU_STORE                 absolute in-container path of the BackUpper store
#   RB_CODEX_ADD_DIR            default "/" (as RB_CLAUDE_ADD_DIR)
#   RB_SKIP_BUILD=1             skip `docker build`
#   RB_STRICT_POLLUTION=1       make the install-pollution report fatal
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"; RB="$(cd "$HERE/.." && pwd)"
TASKDIR="${1:?usage: run_task_codex.sh <task-dir> [model]}"; TASKDIR="$(cd "$TASKDIR" && pwd)"
MODEL="${2:-${RB_CODEX_MODEL:-openai/gpt-5.6-terra}}"
PROVIDER="${RB_CODEX_PROVIDER:-openrouter}"
# RB_CODEX_AUTH=chatgpt uses a codex subscription login instead of an API key;
# config.toml then has no provider table and the model id no vendor prefix.
CODEX_AUTH="${RB_CODEX_AUTH:-apikey}"
CODEX_AUTH_FILE="${RB_CODEX_AUTH_FILE:-$HOME/.codex/auth.json}"
REASONING_EFFORT="${RB_CODEX_REASONING_EFFORT:-medium}"
# Python 3.10+ with PyYAML (required by hermes' terminal_tool).
PY="${RB_PY:-python3}"
if ! "$PY" -c 'import yaml' 2>/dev/null; then
  echo "[fail] \$RB_PY ($PY) is not a Python 3.10+ with PyYAML"; exit 1
fi
# The Codex CLI is not shipped; RB_CODEX_BUNDLE is the official linux-x64 binary.
CODEX_BUNDLE="${RB_CODEX_BUNDLE:-}"
if [ -z "$CODEX_BUNDLE" ]; then
  echo "[fail] RB_CODEX_BUNDLE is unset -- point it at a codex-cli-<version>-linux-x64.bin (see regretbench/run_regretbench.sh --help)"
  exit 1
fi
# The vendor tarball is found beside the bundle, by the version in its file name.
_CODEX_VER="$(basename "$CODEX_BUNDLE")"
_CODEX_VER="${_CODEX_VER#codex-cli-}"
_CODEX_VER="${_CODEX_VER%-linux-x64.bin}"
CODEX_VENDOR_TGZ="${RB_CODEX_VENDOR_TGZ:-$(dirname "$CODEX_BUNDLE")/codex-vendor-${_CODEX_VER}-linux-x64.tar.gz}"
ADD_DIR="${RB_CODEX_ADD_DIR:-/}"
CCDIR=/opt/rbcodex                     # everything this runner installs lives here
if [ "$CODEX_AUTH" != chatgpt ] && [ -z "${OPENROUTER_API_KEY:-}" ]; then
  echo "[fail] no OPENROUTER_API_KEY; set RB_CODEX_AUTH=chatgpt to use a codex subscription"; exit 1
fi
if [ ! -x "$CODEX_BUNDLE" ]; then
  echo "[fail] codex bundle not found/executable: $CODEX_BUNDLE"; exit 1
fi

# shellcheck source=setup_lib.sh
. "$HERE/setup_lib.sh"
rb_task_meta || exit 1
rb_ensure_image || exit 1
rb_mint_run codex
rb_install_reaper
rb_resolve_cwd || exit 1
rb_precreate || exit 1

# --- vendor files (codex-path/rg etc.) ---------------------------------------
# codex's prompts prefer `rg`, which most images lack. The vendor tree keeps its
# layout under $CCDIR/pkg/codex (codex resolves it relative to the binary), and
# rg is also linked into /usr/local/bin because codex's login shell resets PATH.
# Runs before the install audit, since /usr/local/bin lies outside $CCDIR.
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
rb_audit_install_begin
AGENT_UID="$(docker exec "$CID" id -u 2>/dev/null || echo 0)"
docker exec -u 0 "$CID" bash -c "mkdir -p $CCDIR/pkg/codex/bin $CCDIR/cfg && chmod 700 $CCDIR/cfg && chown -R ${AGENT_UID:-0}:0 $CCDIR" \
  || { echo "[fail] mkdir $CCDIR"; exit 1; }
docker cp "$CODEX_BUNDLE" "$CID:$CCDIR/pkg/codex/bin/codex" >/dev/null \
  || { echo "[fail] docker cp codex bundle"; exit 1; }
docker exec -u 0 "$CID" bash -c "chmod +x $CCDIR/pkg/codex/bin/codex && chown ${AGENT_UID:-0}:0 $CCDIR/pkg/codex/bin/codex" \
  || { echo "[fail] chmod codex binary"; exit 1; }

CODEX_VERSION="$(docker exec "$CID" "$CCDIR/pkg/codex/bin/codex" --version 2>&1 | tail -1)"
echo "[install] $CODEX_VERSION (static binary + vendor codex-path/codex-resources)"

rb_audit_install_end "$CCDIR" || exit 1

# --- MCP wiring (only tasks with a non-empty `mcp:` block) ------------------
# Same health checks as run_task_claude.sh; the servers are passed to codex as
# [mcp_servers.*] tables in config.toml.
MCP_TOML=""
if [ -n "${MCP_NAMES:-}" ]; then
  rb_mcp_gen_config || exit 1
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
    # codex's default timeouts are too short for a cold browser server.
    out.append('[mcp_servers.%s]\nurl = "%s"\n'
               'startup_timeout_sec = 60.0\ntool_timeout_sec = 120.0\n' % (n, url))
print("\n".join(out))
PY
)"
  rb_mcp_check_incontainer || exit 1
fi

# RB_CODEX_BASE_URL must serve the OpenAI Responses API (OpenRouter does).
CODEX_KEY_IN_CONTAINER="${OPENROUTER_API_KEY:-}"

# --- config.toml (model/provider/reasoning/approval/sandbox/mcp) -----------
# CODEX_HOME=$CCDIR/cfg, owned by the image's user, which the agent runs as.
docker exec -u 0 "$CID" bash -c "install -d -m 700 -o ${AGENT_UID:-0} -g 0 $CCDIR/cfg" \
  || { echo "[fail] mkdir $CCDIR/cfg"; exit 1; }
# codex guesses the context window for model names outside its catalog, so it
# is set explicitly.
CODEX_CTX_WINDOW="${RB_CODEX_CONTEXT_WINDOW:-1000000}"

$PY - "$RUN/config.toml" "$MODEL" "$PROVIDER" "$REASONING_EFFORT" "$MCP_TOML" \
     "${RB_CODEX_BASE_URL:-https://openrouter.ai/api/v1}" \
     "${RB_CODEX_ENV_KEY:-OPENROUTER_API_KEY}" \
     "${RB_CODEX_WIRE_API:-responses}" \
     "$CODEX_CTX_WINDOW" "$CODEX_AUTH" <<'PY'
import sys

out, model, provider, effort, mcp_toml, base_url, env_key, wire_api, ctx, auth = sys.argv[1:11]
if auth == "chatgpt":
    # A subscription login takes no provider table.
    body = '''model = "%s"
model_reasoning_effort = "%s"
approval_policy = "never"
sandbox_mode = "danger-full-access"
''' % (model, effort)
else:
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
if ctx.strip():
    # A top-level key, so it must precede any [table].
    body = body.replace(
        'sandbox_mode = "danger-full-access"\n',
        'sandbox_mode = "danger-full-access"\nmodel_context_window = %s\n' % ctx.strip(), 1)
if mcp_toml.strip():
    body += "\n" + mcp_toml + "\n"
open(out, "w").write(body)
PY
docker cp "$RUN/config.toml" "$CID:$CCDIR/cfg/config.toml" >/dev/null \
  || { echo "[fail] docker cp config.toml"; exit 1; }
docker exec -u 0 "$CID" chown "${AGENT_UID:-0}:0" "$CCDIR/cfg/config.toml" || true
if [ "$CODEX_AUTH" = "chatgpt" ]; then
  if [ ! -s "$CODEX_AUTH_FILE" ]; then
    echo "[fail] RB_CODEX_AUTH=chatgpt but $CODEX_AUTH_FILE does not exist or is empty"; exit 1
  fi
  docker cp "$CODEX_AUTH_FILE" "$CID:$CCDIR/cfg/auth.json" >/dev/null \
    || { echo "[fail] docker cp auth.json"; exit 1; }
  docker exec -u 0 "$CID" bash -c "chmod 600 $CCDIR/cfg/auth.json && chown ${AGENT_UID:-0}:0 $CCDIR/cfg/auth.json" || true
fi
echo "[cfg] model=$MODEL auth=$CODEX_AUTH provider=$PROVIDER reasoning_effort=$REASONING_EFFORT -> $CCDIR/cfg/config.toml"

# --- RB_BACKUPPER: install the BackUpper in the task container --------------
#   * `codex exec` runs hooks only with --dangerously-bypass-hook-trust, which
#     adapters.sh (codex) passes.
#   * Codex ignores a rewritten tool input, so the package itself runs tier 1 in
#     backup-only mode under codex (it copies what a call would destroy).
if [ "${RB_BACKUPPER:-0}" = 1 ]; then
  BU_EXTRA_PATH="$CCDIR/pkg/codex/codex-path"
  bu_install_in_container codex codex "${RB_BU_SUBAGENT_MODEL:-gpt-5.6-luna}" || exit 1

  # --- the tier-4 subagent's own CODEX_HOME --------------------------------
  # A private CODEX_HOME, so that the next turn's `resume --last` does not pick
  # up the subagent's session. The `codex` shim below selects it.
  docker exec -u 0 "$CID" sh -c "install -d -m 700 -o ${AGENT_UID:-0} -g 0 $CCDIR/subcfg" || true
  # The subagent's provider comes only from this config.toml. It is a copy of
  # the main agent's, switched to RB_BU_SUBAGENT_BASE_URL when both that URL and
  # RB_BU_SUBAGENT_AUTH_TOKEN are set.
  _SUBCFG_SRC="$RUN/config.toml"
  if [ -n "${RB_BU_SUBAGENT_BASE_URL:-}" ] && [ -n "${RB_BU_SUBAGENT_AUTH_TOKEN:-}" ]; then
    if ! "$PY" - "$RUN/config.toml" "$RUN/subcfg-config.toml" "$RB_BU_SUBAGENT_BASE_URL" <<'_TOML_'
import sys

src, dst, base = sys.argv[1:4]
body = open(src).read()
# Split at the first [table]: top-level keys must precede it.
i = body.find('\n[')
if i >= 0:
    head, tail = body[:i], body[i:]
else:
    head, tail = body, ''
kept = [line for line in head.split('\n') if not line.startswith('model_provider')]
head = '\n'.join(kept).rstrip('\n') + '\nmodel_provider = "bu_subagent"\n'
provider = ('\n\n[model_providers.bu_subagent]\n'
            'name = "bu_subagent"\n'
            'base_url = "%s"\n'
            'env_key = "BU_SUBAGENT_KEY"\n'
            'wire_api = "responses"\n' % base)
open(dst, 'w').write(head + tail.rstrip('\n') + provider)
_TOML_
    then
      echo "[fail] rewriting subcfg config.toml"; exit 1
    fi
    _SUBCFG_SRC="$RUN/subcfg-config.toml"
    echo "[arm] subagent provider -> $RB_BU_SUBAGENT_BASE_URL (wire_api=responses)"
  fi
  docker cp "$_SUBCFG_SRC" "$CID:$CCDIR/subcfg/config.toml" >/dev/null
  docker exec -u 0 "$CID" chown "${AGENT_UID:-0}:0" "$CCDIR/subcfg/config.toml" || true
  # Under a subscription the subagent needs its own copy of the login, unless
  # it was switched to a custom provider above (the two must not be combined).
  if [ "$CODEX_AUTH" = "chatgpt" ] && [ "$_SUBCFG_SRC" = "$RUN/config.toml" ]; then
    docker cp "$CODEX_AUTH_FILE" "$CID:$CCDIR/subcfg/auth.json" >/dev/null \
      || { echo "[fail] docker cp subcfg/auth.json"; exit 1; }
    docker exec -u 0 "$CID" bash -c "chmod 600 $CCDIR/subcfg/auth.json && chown ${AGENT_UID:-0}:0 $CCDIR/subcfg/auth.json" || true
  fi
  docker exec -u 0 "$CID" sh -c "printf '%s\n' '#!/bin/sh' \
    'export CODEX_HOME=$CCDIR/subcfg' \
    'exec $CCDIR/pkg/codex/bin/codex \"\$@\"' > $BUDIR/bin/codex && chmod 755 $BUDIR/bin/codex && chown ${AGENT_UID:-0}:0 $BUDIR/bin/codex" \
    || { echo "[fail] codex subagent shim"; exit 1; }
  # The subagent provider's env_key (see subcfg above).
  if [ -n "${RB_BU_SUBAGENT_AUTH_TOKEN:-}" ]; then
    BU_PATH_ENV+=(-e "BU_SUBAGENT_KEY=$RB_BU_SUBAGENT_AUTH_TOKEN")
  fi
  echo "[arm] $BU_SUMMARY"
fi
echo "[cfg] model_context_window=$CODEX_CTX_WINDOW (1M)"

# --- credentials -------------------------------------------------------------
# codex reads its key from the variable named by config.toml's env_key, so the
# key is visible inside the container (as with RB_CLAUDE_AUTH=direct).

# codex uses the system CA store, which some images lack; stage the host's roots
# and point SSL_CERT_FILE at them in the agent's environment only.
_CA_ENV=()
if [ -r /etc/ssl/certs/ca-certificates.crt ]; then
  if ! docker exec "$CID" test -s /etc/ssl/certs/ca-certificates.crt 2>/dev/null; then
    docker cp /etc/ssl/certs/ca-certificates.crt "$CID:$CCDIR/ca-certificates.crt" >/dev/null 2>&1 \
      && docker exec -u 0 "$CID" chown "${AGENT_UID:-0}:0" "$CCDIR/ca-certificates.crt" 2>/dev/null
    _CA_ENV=(-e SSL_CERT_FILE="$CCDIR/ca-certificates.crt")
    echo "[ca] image has no system CA bundle -- staged host roots at $CCDIR/ca-certificates.crt (agent env only)"
  fi
fi
# PATH for the codex process: codex-path (rg) first, then the image's own PATH.
_IMG_PATH="$(docker exec "$CID" sh -c 'printf %s "$PATH"' 2>/dev/null)"
[ -n "$_IMG_PATH" ] || _IMG_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
_PATH_ENV=()
if docker exec "$CID" test -x "$CCDIR/pkg/codex/codex-path/rg" 2>/dev/null; then
  _PATH_ENV=(-e PATH="$CCDIR/pkg/codex/codex-path:$_IMG_PATH")
fi
AGENT_ENV=(-e OPENROUTER_API_KEY="$CODEX_KEY_IN_CONTAINER" -e CODEX_HOME="$CCDIR/cfg"
           "${_CA_ENV[@]}" "${_PATH_ENV[@]}"
           "${BU_PATH_ENV[@]+"${BU_PATH_ENV[@]}"}"
           -e RUST_LOG=info)
if [ "$CODEX_AUTH" = chatgpt ]; then
  AUTH_DESC="subscription"
  echo "[auth] codex subscription login copied into ${CID:0:12}"
else
  AUTH_DESC="direct:${RB_CODEX_BASE_URL:-https://openrouter.ai/api/v1}"
  echo "[auth] OPENROUTER_API_KEY passed directly into ${CID:0:12} (env_key from config.toml)"
fi

# --- hand-off ----------------------------------------------------------------
# Write the per-run state to session.env; run.sh owns the turn loop from here.
# BU_STORE is the store's location inside the container (setup_lib.sh).
rb_write_session_env CID CWD "BU_STORE=$BU_STORE_IN" CCDIR IMAGE MODEL PROVIDER CODEX_AUTH \
  REASONING_EFFORT ADD_DIR IDFILE CODEX_VERSION AUTH_DESC @AGENT_ENV
trap - EXIT
# Refuse to continue if RB_UPSTREAM_KEY appears in session.env.
if [ -n "${RB_UPSTREAM_KEY:-}" ] && grep -qF -- "$RB_UPSTREAM_KEY" "$RUN/session.env" 2>/dev/null; then
  echo "[fail] plaintext upstream key found in session.env -- refusing to continue, fix the auth path first"
  exit 1
fi
echo "[setup] container ${CID:0:12} ready; session.env -> $RUN/session.env"
echo "$RUN"
