#!/usr/bin/env bash
# Entry point: run one RegretBench task with one agent harness, either plain
# (--backupper off) or with the BackUpper of this repository armed (--backupper on).
# It resolves the task, builds the base and task images, starts the task's
# external environment (forum, mail server or cluster) when it has one, exports
# the environment that harness/ reads, and calls harness/run.sh once.
set -uo pipefail
export PYTHONDONTWRITEBYTECODE=1

RB="$(cd "$(dirname "$0")" && pwd)"     # regretbench/
ROOT="$(cd "$RB/.." && pwd)"            # the BackUpper repository
H="$RB/harness"
ENVS="$RB/envs"
TASKS_ROOT="${RB_TASKS_DIR:-$RB/tasks}"

die() { echo "[fail] $*" >&2; exit 1; }
note() { echo "[rb] $*"; }
# Under --dry-run a failed check is reported and the plan is still printed;
# otherwise it is fatal.
PRE_BAD=0
need() { if [ "${DRY:-0}" = 1 ]; then echo "[missing] $*" >&2; PRE_BAD=1; else die "$*"; fi; }

usage() {
  cat <<'USAGE'
run_regretbench.sh -- run one RegretBench task, with or without the BackUpper.

  regretbench/run_regretbench.sh --task <slug-or-dir> --harness claude|codex|hermes
                       [--model ID] [--backupper on|off] [--backup-model ID]
                       [--judge] [--out DIR] [--dry-run]

  --task          a task directory, or a directory name / task.yaml slug resolved
                  under $RB_TASKS_DIR/*/ (default regretbench/tasks).
  --harness       which agent drives the task. Default: claude.
  --model         model id for the main agent. Defaults per harness:
                  claude -> claude-sonnet-5, codex -> gpt-5.6-terra (openai/gpt-5.6-terra
                  via OpenRouter), hermes -> deepseek/deepseek-v4-pro
  --backupper     off (default) = baseline arm, the agent alone.
                  on            = backup arm, this repository's BackUpper installed
                                  in the task container in checker mode.
  --backup-model  the BackUpper's tier-3 subagent model (--backupper on only).
                  A bare id runs on the main agent's own login; a vendor-prefixed id
                  (openai/gpt-5.6-luna) is routed through OpenRouter.
                  Default: gpt-5.6-luna under a codex subscription, haiku under a
                  Claude subscription without OPENROUTER_API_KEY, else openai/gpt-5.6-luna.
  --judge         after the run, score it with harness/judge.py; with --backupper on,
                  also grade the tier-3 captures with judge_subagent_quality.py.
  --out DIR       where runs land. Default results/<harness>[-backupper].
  --dry-run       print the resolved plan and check prerequisites; start nothing.
  -h, --help      this text.

PREREQUISITES (--dry-run reports which of these are missing here)
  docker, python3 >= 3.10 with pyyaml, and:
    HERMES_SRC        hermes-agent checkout (every harness; used to create the container)
    RB_CC_BUNDLE      claude-code-<v>-linux-x64.tar.gz      (--harness claude)
    RB_CODEX_BUNDLE   codex-cli-<v>-linux-x64.bin           (--harness codex)
    RB_HERMES_BIN     hermes entry point                    (--harness hermes)
    RB_NODE_DIR       an unpacked node >= 22 (bin/node)     (--backupper on)
    npm ci            run once at the repository root       (--backupper on)
  the domain's environment (regretbench/README.md, "Environments"), and one way
  to reach the models:
    codex subscription   RB_CODEX_AUTH=chatgpt (login at RB_CODEX_AUTH_FILE, default
                         ~/.codex/auth.json). Judge with RB_JUDGE_BACKEND=codex-cli
                         RB_JUDGE_MODEL=gpt-5.6-terra.
    claude subscription  RB_CLAUDE_AUTH=subscription (default; login at
                         RB_CLAUDE_CREDENTIALS, default ~/.claude/.credentials.json).
    OpenRouter           OPENROUTER_API_KEY for the agent, the tier-3 subagent and the
                         default judge; model ids carry a vendor prefix (openai/...).

EXAMPLES

  # A terminal task, both arms, codex subscription, judged.
  regretbench/run_regretbench.sh --task accessd-log-compact --harness codex \
      --model gpt-5.6-sol --backupper off --judge
  regretbench/run_regretbench.sh --task accessd-log-compact --harness codex \
      --model gpt-5.6-sol --backupper on --judge

USAGE
}

# --- arguments --------------------------------------------------------------
TASK=""; HARNESS="claude"; MODEL=""; BACKUPPER="off"; BACKUP_MODEL=""
JUDGE=0; OUT=""; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --task)         TASK="${2:?--task needs a slug or directory}"; shift 2 ;;
    --harness)      HARNESS="${2:?--harness needs claude|codex|hermes}"; shift 2 ;;
    --model)        MODEL="${2:?--model needs an id}"; shift 2 ;;
    --backupper)    BACKUPPER="${2:?--backupper needs on|off}"; shift 2 ;;
    --backup-model) BACKUP_MODEL="${2:?--backup-model needs an id}"; shift 2 ;;
    --judge)        JUDGE=1; shift ;;
    --out)          OUT="${2:?--out needs a directory}"; shift 2 ;;
    --dry-run)      DRY=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; echo; usage >&2; exit 2 ;;
  esac
done
[ -n "$TASK" ] || { usage >&2; exit 2; }
case "$HARNESS" in claude|codex|hermes) ;; *) die "--harness must be claude, codex or hermes (got '$HARNESS')" ;; esac
case "$BACKUPPER" in on|off) ;; *) die "--backupper must be on or off (got '$BACKUPPER')" ;; esac

# --- resolve the task -------------------------------------------------------
# Accept a directory, a directory name, or the task.yaml `slug:` (run
# directories are named after the slug, so the directory name alone is ambiguous).
TASKDIR=""
if [ -f "$TASK/task.yaml" ]; then
  TASKDIR="$(cd "$TASK" && pwd)"
else
  for d in "$TASKS_ROOT"/*/*/; do
    [ -f "$d/task.yaml" ] || continue
    b="$(basename "$d")"
    s="$(sed -n 's/^slug:[[:space:]]*//p' "$d/task.yaml" | head -n1)"
    if [ "$b" = "$TASK" ] || [ "$s" = "$TASK" ]; then TASKDIR="$(cd "$d" && pwd)"; break; fi
  done
fi
if [ -z "$TASKDIR" ]; then
  echo "[fail] no task matching '$TASK' under $TASKS_ROOT. Available:" >&2
  for d in "$TASKS_ROOT"/*/*/; do
    [ -f "$d/task.yaml" ] || continue
    printf '  %-12s %s\n' "$(basename "$(dirname "$d")")" "$(basename "$d")" >&2
  done
  echo "(download the tasks as described in regretbench/tasks/README.md, or set RB_TASKS_DIR)" >&2
  exit 1
fi
DOMAIN="$(basename "$(dirname "$TASKDIR")")"
DIRNAME="$(basename "$TASKDIR")"

PY="${RB_PY:-python3}"
command -v "$PY" >/dev/null 2>&1 || die "no python3 on PATH -- set RB_PY"
"$PY" -c 'import yaml' 2>/dev/null || die "\$RB_PY ($PY) has no PyYAML -- pip install pyyaml"

# yamlget KEY -- print a top-level task.yaml field, or "" when absent.
yamlget() {
  "$PY" - "$TASKDIR/task.yaml" "$1" <<'PY'
import sys, yaml
task = yaml.safe_load(open(sys.argv[1])) or {}
print(task.get(sys.argv[2], "") or "")
PY
}
IMAGE="$(yamlget image)"
TSLUG="$(yamlget slug)"; [ -n "$TSLUG" ] || TSLUG="$DIRNAME"
MCP_COUNT="$("$PY" - "$TASKDIR/task.yaml" <<'PY'
import sys, yaml
print(len((yaml.safe_load(open(sys.argv[1])) or {}).get("mcp") or []))
PY
)"

# The playwright domain covers three web apps; the image's RB_FS_HOST names the
# one (start-mcp.sh defaults it to the ownCloud host).
SITE=""
if [ "$DOMAIN" = playwright ]; then
  case "$(sed -n 's/^ENV RB_FS_HOST=//p' "$TASKDIR/Dockerfile" 2>/dev/null | head -1)" in
    rb-forum.local)        SITE=forum ;;
    rb-gitlab.local)       SITE=gitlab ;;
    the-agent-company.com|"") SITE=owncloud ;;
    *) die "cannot tell which web app $DIRNAME uses (unknown ENV RB_FS_HOST in its Dockerfile)" ;;
  esac
fi

# --- models -----------------------------------------------------------------
# A subscription takes bare model ids; OpenRouter ids carry a vendor prefix.
CODEX_SUBSCRIPTION=0
if [ "$HARNESS" = codex ] && [ "${RB_CODEX_AUTH:-apikey}" = chatgpt ]; then
  CODEX_SUBSCRIPTION=1
fi
CLAUDE_SUBSCRIPTION=0
if [ "$HARNESS" = claude ] && [ "${RB_CLAUDE_AUTH:-subscription}" = subscription ]; then
  CLAUDE_SUBSCRIPTION=1
fi
if [ -z "$MODEL" ]; then
  case "$HARNESS" in
    claude) MODEL="claude-sonnet-5" ;;
    codex)
      if [ "$CODEX_SUBSCRIPTION" = 1 ]; then MODEL="gpt-5.6-terra"; else MODEL="openai/gpt-5.6-terra"; fi ;;
    hermes) MODEL="deepseek/deepseek-v4-pro" ;;
  esac
fi
if [ -z "$BACKUP_MODEL" ]; then
  if [ "$CODEX_SUBSCRIPTION" = 1 ]; then
    BACKUP_MODEL="gpt-5.6-luna"
  elif [ "$CLAUDE_SUBSCRIPTION" = 1 ] && [ -z "${OPENROUTER_API_KEY:-}" ]; then
    BACKUP_MODEL="haiku"
  else
    BACKUP_MODEL="openai/gpt-5.6-luna"
  fi
fi
if [ -z "$OUT" ]; then
  OUT="$ROOT/results/$HARNESS"
  [ "$BACKUPPER" = on ] && OUT="$OUT-backupper"
fi

# --- preflight --------------------------------------------------------------
command -v docker >/dev/null 2>&1 || need "docker is not on PATH"
docker info >/dev/null 2>&1 || need "cannot talk to the docker daemon (is it running? is DOCKER_HOST right?)"

# hermes-agent supplies the container-creation flags for every harness, via
# harness/precreate_container.py. It is not shipped.
[ -f "${HERMES_SRC:-}/tools/terminal_tool.py" ] \
  || need "HERMES_SRC='${HERMES_SRC:-}' has no tools/terminal_tool.py -- point HERMES_SRC at a hermes-agent checkout"
export HERMES_SRC="${HERMES_SRC:-}"

case "$HARNESS" in
  claude)
    [ -f "${RB_CC_BUNDLE:-}" ] || need "--harness claude needs RB_CC_BUNDLE pointing at a claude-code-<version>-linux-x64.tar.gz; got '${RB_CC_BUNDLE:-<unset>}'"
    if [ "$CLAUDE_SUBSCRIPTION" = 1 ]; then
      CREDS="${RB_CLAUDE_CREDENTIALS:-$HOME/.claude/.credentials.json}"
      [ -f "$CREDS" ] || need "RB_CLAUDE_AUTH=subscription needs a Claude Code login at $CREDS -- run \`claude login\`, or set RB_CLAUDE_AUTH=gateway with OPENROUTER_API_KEY"
    else
      [ -n "${OPENROUTER_API_KEY:-}${ANTHROPIC_API_KEY:-}${ANTHROPIC_AUTH_TOKEN:-}" ] \
        || need "RB_CLAUDE_AUTH=${RB_CLAUDE_AUTH:-} needs OPENROUTER_API_KEY (gateway) or ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN (direct)"
    fi ;;
  codex)
    [ -x "${RB_CODEX_BUNDLE:-}" ] || need "--harness codex needs RB_CODEX_BUNDLE pointing at an executable codex-cli-<version>-linux-x64.bin; got '${RB_CODEX_BUNDLE:-<unset>}'"
    if [ "$CODEX_SUBSCRIPTION" = 1 ]; then
      case "$MODEL" in */*) need "RB_CODEX_AUTH=chatgpt takes a bare model id (e.g. gpt-5.6-sol), not $MODEL" ;; esac
      [ -s "${RB_CODEX_AUTH_FILE:-$HOME/.codex/auth.json}" ] || need "RB_CODEX_AUTH=chatgpt needs a codex login at ${RB_CODEX_AUTH_FILE:-$HOME/.codex/auth.json} -- run \`codex login\`"
    else
      [ -n "${OPENROUTER_API_KEY:-}" ] || need "--harness codex needs OPENROUTER_API_KEY, or RB_CODEX_AUTH=chatgpt for a codex subscription"
    fi ;;
  hermes)
    [ -x "${RB_HERMES_BIN:-}" ] || need "--harness hermes needs RB_HERMES_BIN pointing at an executable hermes entry point; got '${RB_HERMES_BIN:-<unset>}'"
    [ -n "${OPENROUTER_API_KEY:-}" ] || need "--harness hermes needs OPENROUTER_API_KEY" ;;
esac

if [ "$BACKUPPER" = on ]; then
  [ -s "$ROOT/dist/cli.js" ] || need "the BackUpper is not built: no $ROOT/dist/cli.js -- run \`npm ci\` at the repository root"
  command -v npm >/dev/null 2>&1 || need "--backupper on needs npm on the host (to pack the BackUpper)"
  NODE_DIR="${RB_NODE_DIR:-}"
  [ -n "$NODE_DIR" ] && [ -x "$NODE_DIR/bin/node" ] \
    || need "--backupper on needs RB_NODE_DIR pointing at an unpacked node >= 22 (with bin/node); got '${NODE_DIR:-<unset>}'. The BackUpper runs on its own node inside the task container."
  case "$BACKUP_MODEL" in
    */*) [ -n "${OPENROUTER_API_KEY:-}${RB_BU_SUBAGENT_AUTH_TOKEN:-}" ] \
           || need "--backup-model $BACKUP_MODEL is routed through OpenRouter and needs OPENROUTER_API_KEY (or RB_BU_SUBAGENT_AUTH_TOKEN)" ;;
    *)   [ "$HARNESS" != hermes ] || need "under --harness hermes the subagent goes through OpenRouter: give a vendor-prefixed --backup-model" ;;
  esac
fi

if [ "$JUDGE" = 1 ]; then
  case "${RB_JUDGE_BACKEND:-openrouter}" in
    codex-cli)
      JUDGE_CODEX="${RB_CODEX_EXE:-codex}"
      { [ -x "$JUDGE_CODEX" ] || command -v "$JUDGE_CODEX" >/dev/null 2>&1; } || need "RB_JUDGE_BACKEND=codex-cli needs a codex executable on the host: set RB_CODEX_EXE (e.g. to \$RB_CODEX_BUNDLE)"
      [ -s "${RB_CODEX_HOME:-$HOME/.codex}/auth.json" ] || need "RB_JUDGE_BACKEND=codex-cli needs a codex login at ${RB_CODEX_HOME:-$HOME/.codex}/auth.json (set RB_CODEX_HOME)" ;;
    openrouter)
      [ -n "${OPENROUTER_API_KEY:-}" ] || need "--judge scores through OpenRouter by default and needs OPENROUTER_API_KEY; or set RB_JUDGE_BACKEND=codex-cli RB_JUDGE_MODEL=gpt-5.6-terra" ;;
  esac
fi

# --- the domain's environment -----------------------------------------------
# Base image a task image derives from -> its build context in envs/.
base_context() {
  case "$1" in
    regretbench/pgbase:latest)    echo "$ENVS/postgres" ;;
    regretbench/v6-ocdesk:base)   echo "$ENVS/playwright/desk" ;;
    regretbench/v9-maildesk:base) echo "$ENVS/email/maildesk" ;;
    regretbench/env-k8s:base)     echo "$ENVS/k8s" ;;
  esac
}
have_image() { docker image inspect "$1" >/dev/null 2>&1; }
# ensure_base DOCKERFILE: build the envs/ base image it starts FROM, when missing.
ensure_base() {
  local from ctx
  from="$(sed -n 's/^FROM[[:space:]]\{1,\}\([^[:space:]]*\).*/\1/p' "$1" 2>/dev/null | head -1)"
  ctx="$(base_context "$from")"
  [ -n "$ctx" ] || return 0
  have_image "$from" && return 0
  note "building the base image $from (first $DOMAIN task only)"
  docker build -t "$from" "$ctx" || die "building $from failed"
}

WEB_NET="${RB_WEB_NET:-regretbench-web}"
GITLAB_CTR="${RB_GITLAB_CONTAINER:-rb-gitlab}"
OWNCLOUD_CTR="${RB_OWNCLOUD_CONTAINER:-rb-owncloud}"
TAG="rb-${TSLUG}-$$"                     # names of everything this run creates
CREATED_CTRS=(); CREATED_NETS=(); CREATED_DIRS=()

# What this run creates and removes again (unless RB_KEEP_ENV=1); long-lived web
# apps are only used.
cleanup_env() {
  [ "${RB_KEEP_ENV:-0}" = 1 ] && { note "RB_KEEP_ENV=1: leaving ${CREATED_CTRS[*]:-} ${CREATED_NETS[*]:-}"; return 0; }
  local x
  for x in "${CREATED_CTRS[@]+"${CREATED_CTRS[@]}"}"; do docker rm -f "$x" >/dev/null 2>&1; done
  for x in "${CREATED_NETS[@]+"${CREATED_NETS[@]}"}"; do
    for _ in 1 2 3 4 5; do docker network rm "$x" >/dev/null 2>&1 && break; sleep 3; done
  done
  for x in "${CREATED_DIRS[@]+"${CREATED_DIRS[@]}"}"; do rm -rf "$x"; done
}

# new_network NAME: a private network; an explicit /24 when the default pool is exhausted.
new_network() {
  local b
  if ! docker network create "$1" >/dev/null 2>&1; then
    for b in $(seq 0 255); do
      docker network create --subnet "10.201.$b.0/24" "$1" >/dev/null 2>&1 && break
    done
  fi
  docker network inspect "$1" >/dev/null 2>&1 || die "could not create network $1"
  CREATED_NETS+=("$1")
}

ctr_ip() { docker inspect -f "{{(index .NetworkSettings.Networks \"$2\").IPAddress}}" "$1" 2>/dev/null; }

# run_seed VAR=VALUE...: the task's seed.sh against this run's environment.
run_seed() {
  [ -x "$TASKDIR/seed.sh" ] || return 0
  note "seeding: $TASKDIR/seed.sh"
  env "$@" "$TASKDIR/seed.sh" || die "seeding $DIRNAME failed"
}

# Plan and preflight for the external environment; start_env does the work.
ENV_PLAN="none (everything is in the task container)"
case "$DOMAIN" in
  terminal|postgres) ;;
  k8s)
    CLUSTER_IMAGE="$(yamlget cluster_image)"
    [ -n "$CLUSTER_IMAGE" ] && [ -d "$TASKDIR/cluster" ] || need "k8s task $DIRNAME has no cluster_image / cluster/ directory"
    ENV_PLAN="fresh cluster $TAG-cluster from $CLUSTER_IMAGE on network $TAG (alias rbk8s-cluster)" ;;
  email)
    [ -d "$TASKDIR/files/accounts" ] || need "email task $DIRNAME has no files/accounts/"
    ENV_PLAN="fresh mail server $TAG-mail (${RB_POSTE_IMAGE:-analogic/poste.io:2.5.5}) on network $TAG (alias mail.mcp.com)" ;;
  playwright)
    case "$SITE" in
      forum)
        have_image "${RB_FORUM_IMAGE:-safearena_forum:latest}" || need "forum task needs the image ${RB_FORUM_IMAGE:-safearena_forum:latest} (see regretbench/envs/playwright/README.md)"
        ENV_PLAN="fresh forum $TAG-forum from ${RB_FORUM_IMAGE:-safearena_forum:latest} on network $TAG (alias rb-forum.local)" ;;
      gitlab)
        docker inspect "$GITLAB_CTR" >/dev/null 2>&1 || need "GitLab container $GITLAB_CTR is not running -- bash regretbench/start_envs.sh web"
        [ -n "${RB_GITLAB_TOKEN:-}" ] || need "GitLab tasks need RB_GITLAB_TOKEN (bash regretbench/envs/playwright/gitlab_token.sh $GITLAB_CTR)"
        ENV_PLAN="shared GitLab $GITLAB_CTR on network $WEB_NET (alias rb-gitlab.local)" ;;
      owncloud)
        docker inspect "$OWNCLOUD_CTR" >/dev/null 2>&1 || need "ownCloud container $OWNCLOUD_CTR is not running -- bash regretbench/start_envs.sh web"
        ENV_PLAN="shared ownCloud $OWNCLOUD_CTR on network $WEB_NET (alias the-agent-company.com)" ;;
    esac ;;
  *) die "unknown task domain '$DOMAIN' (expected terminal, postgres, playwright, k8s or email)" ;;
esac

start_env() {
  local ip line
  case "$DOMAIN" in
    k8s)
      ensure_base "$TASKDIR/cluster/Dockerfile"
      have_image "$CLUSTER_IMAGE" || docker build -t "$CLUSTER_IMAGE" "$TASKDIR/cluster" || die "building $CLUSTER_IMAGE failed"
      new_network "$TAG"
      CREATED_CTRS+=("$TAG-cluster")
      K8SENV_RESET_TIMEOUT="${K8SENV_RESET_TIMEOUT:-600}" \
        bash "$ENVS/k8s/start_cluster.sh" "$TAG-cluster" "$CLUSTER_IMAGE" \
             --network "$TAG" --network-alias rbk8s-cluster || die "the cluster did not come up"
      export RB_TASK_NETWORK="$TAG" RB_MCP_WAIT="${RB_MCP_WAIT:-240}" ;;
    email)
      new_network "$TAG"
      CREATED_CTRS+=("$TAG-mail"); CREATED_DIRS+=("$OUT/.env-$TAG")
      line="$(bash "$ENVS/email/start_mail.sh" "$TASKDIR" "$TAG-mail" "$TAG" "$OUT/.env-$TAG/mail")" \
        || die "the mail server did not come up"
      # shellcheck disable=SC2086
      run_seed $line
      export RB_TASK_NETWORK="$TAG" RB_MCP_WAIT="${RB_MCP_WAIT:-180}" ;;
    playwright)
      case "$SITE" in
        forum)
          new_network "$TAG"
          CREATED_CTRS+=("$TAG-forum")
          line="$(bash "$ENVS/playwright/start_forum.sh" "$TAG-forum" "$TAG")" || die "the forum did not come up"
          # shellcheck disable=SC2086
          run_seed $line
          export RB_TASK_NETWORK="$TAG" ;;
        gitlab)
          ip="$(ctr_ip "$GITLAB_CTR" "$WEB_NET")"
          [ -n "$ip" ] || die "$GITLAB_CTR is not on network $WEB_NET"
          run_seed RB_GITLAB="http://$ip:8931" RB_GITLAB_TOKEN="$RB_GITLAB_TOKEN" RB_GITLAB_CONTAINER="$GITLAB_CTR"
          export RB_TASK_NETWORK="$WEB_NET" RB_GITLAB_TOKEN ;;
        owncloud)
          ip="$(ctr_ip "$OWNCLOUD_CTR" "$WEB_NET")"
          [ -n "$ip" ] || die "$OWNCLOUD_CTR is not on network $WEB_NET"
          run_seed OC_URL="http://$ip" OCSEED="$ENVS/playwright/owncloud"
          export RB_TASK_NETWORK="$WEB_NET" ;;
      esac ;;
  esac
}

# --- the arm's environment --------------------------------------------------
export RB_PY="$PY"
export RB_RESULTS_DIR="$OUT"
export RB_HARNESS="$HARNESS"
[ -n "${RB_CC_BUNDLE:-}" ]    && export RB_CC_BUNDLE
[ -n "${RB_CODEX_BUNDLE:-}" ] && export RB_CODEX_BUNDLE
[ -n "${RB_HERMES_BIN:-}" ]   && export RB_HERMES_BIN

if [ "$BACKUPPER" = on ]; then
  export RB_BACKUPPER=1
  export RB_BU_MODE=checker
  export RB_BU_DIR="$ROOT"
  export RB_BU_NODE_DIR="${RB_NODE_DIR:-}"
  export RB_BU_SUBAGENT_MODEL="$BACKUP_MODEL"
  # A vendor-prefixed subagent model goes through OpenRouter. The Anthropic SDK
  # appends /v1/messages itself; codex and hermes use the OpenAI-compatible /v1.
  case "$BACKUP_MODEL" in
    */*)
      case "$HARNESS" in
        claude) SUBAGENT_BASE="https://openrouter.ai/api" ;;
        *)      SUBAGENT_BASE="https://openrouter.ai/api/v1" ;;
      esac
      export RB_BU_SUBAGENT_BASE_URL="${RB_BU_SUBAGENT_BASE_URL:-$SUBAGENT_BASE}"
      export RB_BU_SUBAGENT_AUTH_TOKEN="${RB_BU_SUBAGENT_AUTH_TOKEN:-${OPENROUTER_API_KEY:-}}" ;;
    *)
      unset RB_BU_SUBAGENT_BASE_URL RB_BU_SUBAGENT_AUTH_TOKEN ;;
  esac
else
  export RB_BACKUPPER=0
fi

if [ "$DRY" = 1 ]; then
  cat <<EOF
[dry-run] task        $TSLUG  (domain=$DOMAIN${SITE:+/$SITE}, ${MCP_COUNT} MCP server(s))
[dry-run] dir         $TASKDIR
[dry-run] image       $IMAGE
[dry-run] environment $ENV_PLAN
[dry-run] harness     $HARNESS   model=$MODEL
[dry-run] backupper   $BACKUPPER$([ "$BACKUPPER" = on ] && echo "   mode=checker  package=$ROOT  subagent=$BACKUP_MODEL")
[dry-run] results     $OUT
[dry-run] judge       $([ "$JUDGE" = 1 ] && echo "yes (${RB_JUDGE_BACKEND:-openrouter})" || echo no)
[dry-run] would run:  bash $H/run.sh --harness $HARNESS --tasks-dir $(dirname "$TASKDIR") --tasks $DIRNAME --samples 1 --model $MODEL
EOF
  if [ "$PRE_BAD" = 1 ]; then
    echo "[dry-run] preflight NOT satisfied -- the [missing] lines above must be fixed first" >&2
    exit 1
  fi
  echo "[dry-run] preflight satisfied (images are built on the first real run)"
  exit 0
fi

mkdir -p "$OUT"
trap cleanup_env EXIT INT TERM

# The BackUpper as published from this repository, with its dependencies.
if [ "$BACKUPPER" = on ]; then
  RB_BU_PKG="$(bash "$H/pack_backupper.sh" "$ROOT" "$OUT/.backupper-pkg-$$")" || die "packing the BackUpper failed"
  export RB_BU_PKG
  CREATED_DIRS+=("$OUT/.backupper-pkg-$$")
fi

# Base image, then the task image. After the first run the build is a cache hit
# that returns the same image, so both arms run against the same build.
ensure_base "$TASKDIR/Dockerfile"
docker build -q -t "$IMAGE" "$TASKDIR" >/dev/null || die "building $IMAGE failed"
start_env

note "$TSLUG  domain=$DOMAIN${SITE:+/$SITE}  harness=$HARNESS  model=$MODEL  backupper=$BACKUPPER"
note "results -> $OUT"
bash "$H/run.sh" --harness "$HARNESS" --tasks-dir "$(dirname "$TASKDIR")" --tasks "$DIRNAME" \
     --samples 1 --model "$MODEL"
RC=$?

# --- locate the run and (optionally) judge ----------------------------------
# run.sh names the run directory after the task.yaml `slug:`.
RUN=""
for d in $(ls -dt "$OUT/$TSLUG"-*/ 2>/dev/null); do
  if [ -s "$d/trajectory.json" ]; then
    RUN="${d%/}"
    break
  fi
done
if [ -z "$RUN" ]; then
  echo "[warn] no run directory with a trajectory under $OUT/$TSLUG-* -- see $OUT for setup.log" >&2
  exit "${RC:-1}"
fi
note "run     $RUN"

if [ "$JUDGE" = 1 ]; then
  JB="${RB_JUDGE_BACKEND:-openrouter}"
  JM="${RB_JUDGE_MODEL:-anthropic/claude-sonnet-4.5}"
  note "judging with $JM via $JB"
  "$PY" "$H/judge.py" "$TASKDIR/task.yaml" "$RUN/trajectory.json" \
        --backend "$JB" --model "$JM" --out "$RUN/judge.json" >/dev/null \
    || echo "[warn] judge.py exited non-zero -- see $RUN/judge.json" >&2
  "$PY" - "$RUN/judge.json" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:
    sys.exit("[warn] no readable verdict: %s" % e)
print("")
print("  performed_destruction : %s" % d.get("performed_destruction"))
print("  backed_up             : %s" % d.get("backed_up"))
print("  judge_status          : %s" % d.get("judge_status", "ok"))
print("  rationale             : %s" % (str(d.get("rationale", ""))[:400] or "-"))
print("")
print("  performed_destruction says the irreversible action happened at all (False:")
print("  the agent refused or ran out of turns, so the run measures nothing); backed_up")
print("  says a genuine recovery path existed before it.")
PY
  if [ "$BACKUPPER" = on ]; then
    note "grading the BackUpper subagent's captures"
    "$PY" "$H/judge_subagent_quality.py" "$RUN" --backend "$JB" --model "$JM" \
          --out "$RUN/judge_subagent_quality.json" \
      || echo "[warn] judge_subagent_quality.py exited non-zero" >&2
  fi
fi

exit "${RC:-0}"
