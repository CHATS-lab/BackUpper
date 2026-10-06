# RegretBench — Evaluation Framework

This directory contains the evaluation framework for the **RegretBench** benchmark. Each task runs a real agent CLI (Claude Code, Codex or Hermes) inside a Docker container, once on its own and once with this repository's [BackUpper](../README.md) installed.

## RegretBench Benchmark

205 multi-turn tasks across five domains. In every task a legitimate instruction leads the agent to destroy state that cannot be recovered afterwards. A task does not ask whether the agent refuses; it asks whether the state the step is about to destroy was preserved before the step ran.

| Domain     | MCP Server | Port | Environment | Tasks |
|------------|------------|------|-------------|-------|
| Terminal   | —          | —    | task container only | 65 |
| PostgreSQL | `postgres` ([postgres-mcp](https://pypi.org/project/postgres-mcp/) 0.3.0) | 8831–8846 | database inside the task container | 50 |
| Playwright | `playwright` ([@playwright/mcp](https://www.npmjs.com/package/@playwright/mcp) 0.0.79) | 8817 | Postmill forum (20), GitLab (10), ownCloud (20) | 50 |
| Kubernetes | `cluster` ([mcp-server-kubernetes](https://www.npmjs.com/package/mcp-server-kubernetes) 4.1.4) | 8815 | single-node k3s cluster | 20 |
| Email      | one per mailbox ([emails-mcp](https://pypi.org/project/emails-mcp/) 0.1.12) | 8901, 8902 | poste.io mail server | 20 |

Every MCP server runs inside the task container (or, for Kubernetes, inside the cluster container and forwarded into the task container), bridged to streamable HTTP by [supergateway](https://www.npmjs.com/package/supergateway).

### Dataset

Download from [HuggingFace](https://huggingface.co/datasets/CHATS-Lab/RegretBench). The dataset is gated: request access on its page, then log in (`pip install huggingface-hub` provides `hf`):

```bash
hf auth login
hf download CHATS-Lab/RegretBench --repo-type dataset --local-dir RegretBench
# large seed files are stored xz-compressed; restore them before building any task
(cd RegretBench && find workspaces -name '*.xz' -exec xz -d {} +)
cp -r RegretBench/workspaces/* regretbench/tasks/
```

Or leave them in place and set `RB_TASKS_DIR=/path/to/RegretBench/workspaces`. See [`tasks/README.md`](tasks/README.md).

Each task directory contains:

| File | Description |
|------|-------------|
| `task.yaml` | Turns shown to the agent, MCP servers (`mcp:`), between-turn hooks, and the grading context for the judge |
| `Dockerfile`, `files/` | The task container: the agent's workspace, and for postgres the database |
| `seed.sh` | Playwright and email: seeds the task's state into the web app or mailboxes before the run |
| `cluster/` | Kubernetes: the cluster image, whose build mints the task's cluster state |

## Setup

### 1. Install Dependencies

```bash
# From the repo root: build BackUpper (needed for --backupper on)
npm ci

# Python 3.10+ with PyYAML, and Docker
pip install pyyaml

# hermes-agent supplies the container-creation flags for every harness
git clone https://github.com/NousResearch/hermes-agent.git
```

The agent CLIs are not shipped. Download the official Linux builds:

| Variable | Needed for | Value |
|---|---|---|
| `HERMES_SRC` | every run | the hermes-agent checkout (contains `tools/terminal_tool.py`) |
| `RB_CODEX_BUNDLE` | `--harness codex` | `codex-cli-<version>-linux-x64.bin`; the `codex-vendor-<version>-linux-x64.tar.gz` beside it adds `rg` |
| `RB_CC_BUNDLE` | `--harness claude` | `claude-code-<version>-linux-x64.tar.gz` |
| `RB_HERMES_BIN` | `--harness hermes` | a hermes entry point installed with the `[mcp]` extra |
| `RB_NODE_DIR` | `--backupper on` | an unpacked Node.js ≥ 22 (`bin/node`); BackUpper runs on it inside the task container |

### 2. Environment Variables

Pick one way to reach the models.

```bash
# Codex subscription (no API key): main agent, tier-4 subagent and judge share the login
export RB_CODEX_AUTH=chatgpt                      # login at ~/.codex/auth.json
export RB_JUDGE_BACKEND=codex-cli RB_JUDGE_MODEL=gpt-5.6-terra

# Claude subscription (the default for --harness claude)
export RB_CLAUDE_AUTH=subscription                # login at ~/.claude/.credentials.json

# OpenRouter: one key for the agent, the tier-4 subagent and the default judge
export OPENROUTER_API_KEY="YOUR_OPENROUTER_KEY"
```

> Under a subscription, model ids carry no vendor prefix (`gpt-5.6-sol`); through OpenRouter they do (`openai/gpt-5.6-sol`).

| Variable | Default | Purpose |
|---|---|---|
| `RB_TASKS_DIR` | `regretbench/tasks` | Where the tasks are |
| `RB_CODEX_AUTH_FILE` | `~/.codex/auth.json` | Codex login copied into the task container |
| `RB_CLAUDE_CREDENTIALS` | `~/.claude/.credentials.json` | Claude Code login copied into the task container (access token only) |
| `RB_CODEX_EXE`, `RB_CODEX_HOME` | `codex`, `~/.codex` | Codex CLI and login used by the `codex-cli` judge on the host |
| `RB_JUDGE_BACKEND` | `openrouter` | `openrouter`, `codex-cli` or `claude-cli` |
| `RB_JUDGE_MODEL` | `anthropic/claude-sonnet-4.5` | Judge model |
| `RB_BU_SUBAGENT_BASE_URL`, `RB_BU_SUBAGENT_AUTH_TOKEN` | OpenRouter, `OPENROUTER_API_KEY` | Endpoint for a vendor-prefixed `--backup-model` |
| `RB_PY` | `python3` | Python interpreter for the harness |

### 3. Start Environments

```bash
bash regretbench/start_envs.sh images        # base images of every domain
bash regretbench/start_envs.sh web           # GitLab + ownCloud for the playwright tasks
export RB_GITLAB_TOKEN=$(bash regretbench/envs/playwright/web.sh token rb-gitlab)
```

`run_regretbench.sh` builds a missing base image on first use, and starts a fresh environment of its own for every forum, Kubernetes and email run (removed afterwards). Only GitLab and ownCloud are long-lived and shared between runs. Everything machine-specific can be overridden via environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `RB_WEB_NET` | `regretbench-web` | Docker network of GitLab and ownCloud |
| `RB_GITLAB_CONTAINER` | `rb-gitlab` | GitLab container (`rb-gitlab.local:8931`) |
| `RB_GITLAB_DATA` | `~/.regretbench/gitlab` | GitLab data, config and logs |
| `RB_GITLAB_TOKEN` | — | GitLab API token, from `envs/playwright/web.sh token` |
| `RB_OWNCLOUD_CONTAINER` | `rb-owncloud` | ownCloud container (`the-agent-company.com`) |
| `RB_FORUM_IMAGE` | `safearena_forum:latest` | Postmill forum image |
| `RB_GITLAB_IMAGE` | `ghcr.io/theagentcompany/servers-gitlab:1.0.0` | GitLab image |
| `RB_OWNCLOUD_IMAGE` | `ghcr.io/theagentcompany/servers-owncloud:1.0.0` | ownCloud image |
| `RB_POSTE_IMAGE` | `analogic/poste.io:2.5.5` | Mail server image |
| `RB_MAIL_USERS_JSON` | — | Toolathlon's `configs/users_data.json`, to create its 503 `mcp.com` mailboxes as well |
| `K8SENV_RESET_TIMEOUT` | `600` | Seconds allowed for a cluster to boot and seed |
| `RB_MCP_WAIT` | 90 (postgres 180, email 180, k8s 240) | Seconds allowed for the task's MCP servers to answer |
| `RB_KEEP_ENV` | `0` | `1` keeps a run's forum, mail server or cluster for inspection |

Environment details per domain:

| Domain | Base image (build context) | External environment |
|---|---|---|
| Terminal | — | — |
| PostgreSQL | `regretbench/pgbase:latest` ([`envs/postgres/`](envs/postgres/)) | — (PostgreSQL 17 and postgres-mcp in the task container) |
| Playwright | `regretbench/v6-ocdesk:base` ([`envs/playwright/desk/`](envs/playwright/desk/)) | upstream web apps, see [Playwright / Web Application Setup](#playwright--web-application-setup) |
| Kubernetes | `regretbench/env-k8s:base` ([`envs/k8s/`](envs/k8s/)), for each task's `cluster/` image | `envs/k8s/start_cluster.sh`: a privileged k3s v1.36.3 container per run, alias `rbk8s-cluster` |
| Email | `regretbench/v9-maildesk:base` ([`envs/email/maildesk/`](envs/email/maildesk/)) | `envs/email/start_mail.sh`: a [poste.io](https://poste.io) 2.5.5 server per run, alias `mail.mcp.com`; see [`envs/email/README.md`](envs/email/README.md) |

> The Kubernetes cluster container needs `--privileged`. On hosts that run many clusters, raise `fs.inotify.max_user_watches` and `fs.inotify.max_user_instances`.

### 4. Agent Configuration

`harness/config.yaml` holds the per-harness defaults (model, results directory, per-turn timeout). Every value can be overridden on the command line:

```bash
regretbench/run_regretbench.sh --task <task> --harness codex --model gpt-5.6-sol \
    --backupper on --backup-model gpt-5.6-luna
```

| Harness | Where the agent runs | Default model |
|---|---|---|
| `claude` | Claude Code inside the task container | `claude-sonnet-5` |
| `codex` | Codex CLI inside the task container | `gpt-5.6-terra` |
| `hermes` | hermes on the host, executing commands in the task container | `deepseek/deepseek-v4-pro` |

## Running Evaluation

### Single Task

```bash
regretbench/run_regretbench.sh \
  --task accessd-log-compact \
  --harness codex \
  --model gpt-5.6-sol \
  --backupper on \
  --judge
```

Use `--backupper off` (the default) to run without BackUpper. Add `--dry-run` to any command to print the plan and every missing prerequisite without starting anything.

With `--backupper on` the launcher packs BackUpper from the repository root (`npm pack`, plus its production dependencies), copies it and a Node runtime into the task container under `/opt/rbbu`, and runs the package's own `backupper install claude-code|codex` in the agent's workspace (under Hermes, `backupper install hermes` on the host). It then sets `mode=checker`, `subagentRunner=auto` (the tier-4 subagent runs on the same CLI and login as the agent) and `subagentModels` to the `--backup-model`. The bundled capture playbooks (`experiences/`) are seeded by the install; `RB_BU_EXPERIENCES=<dir>` replaces them. Under Codex, tier 1 runs in backup-only mode, because Codex does not apply rewritten tool inputs.

### Batch Evaluation

```bash
for t in regretbench/tasks/terminal/*/; do
  regretbench/run_regretbench.sh --task "$t" --harness codex --model gpt-5.6-sol --backupper on --judge
done
```

Runs of one arm land in `results/<harness>[-backupper]/<task-slug>-<timestamp>/`; `--out DIR` changes the root. Run playwright tasks on the same GitLab or ownCloud instance one at a time.

### Post-Evaluation (LLM-as-Judge)

```bash
python3 regretbench/harness/judge.py main regretbench/tasks/<domain>/<task>/task.yaml \
    <run>/trajectory.json --backend codex-cli --model gpt-5.6-terra --out <run>/judge.json
python3 regretbench/harness/judge.py subagent-quality <run> --backend codex-cli --model gpt-5.6-terra
```

`judge.py` grades the trajectory blind and records **`performed_destruction`** (the irreversible action happened; `false` means the run measures nothing) and **`backed_up`** (a genuine recovery path existed before it). In the backup arm, `judge.py subagent-quality` grades every tier-4 capture: would it restore what the action destroyed? A provider limit yields `judge_status: judge_pending`; re-run the judge on the stored run. The prompts are in [`prompts.md`](prompts.md).

Each run directory contains:

| File | Description |
|------|-------------|
| `trajectory.json` | The agent's transcript, normalised to `{"messages": [...]}` |
| `turn-<id>.prompt` | The text delivered for each turn |
| `setup.log`, `driver.log` | What the harness did; `setup.log` records the BackUpper install |
| `backupper-store/` | Backup arm: BackUpper's store (declarations, checker verdicts, action folders, subagent log); under Codex and Hermes the bulky backup copies are replaced by `*.manifest.txt` file lists |
| `subagent-sessions/` | Backup arm under Codex: the tier-4 subagent's transcripts |
| `judge.json`, `judge_subagent_quality.json` | The verdicts (with `--judge`) |

## Resetting Environments Between Runs

Forum, Kubernetes and email runs need no reset: each run gets a new container from the image, removed when the run ends. GitLab and ownCloud tasks reset their own state: the task's `seed.sh` cleans and re-seeds only the task's projects, files, tags and shares on the shared instance before each run.

```bash
regretbench/tasks/playwright/<task>/seed.sh --clean   # remove one task's state from GitLab/ownCloud
```

## Playwright / Web Application Setup

The playwright tasks use the Postmill forum from [SafeArena](https://github.com/McGill-NLP/safearena) and the GitLab and ownCloud servers of [TheAgentCompany](https://github.com/TheAgentCompany). See [`envs/playwright/README.md`](envs/playwright/README.md) for integration instructions.

## Architecture

- **`run_regretbench.sh`**: Entry point. Resolves the task, builds the base and task images, starts the task's environment, sets up the arm, runs `harness/run.sh`, and judges.
- **`start_envs.sh`**: Builds the base images and starts the shared web applications.
- **`harness/run.sh`**: The turn loop shared by every agent: delivers each turn, runs `between_turns` hooks, sends one contentless "continue" when the agent stops to ask on the destructive turn (`asks_confirmation.py`).
- **`harness/adapters.sh`** and **`harness/run_task_<harness>.sh`** (shared steps in `setup_lib.sh`): Create the task container (`harness_util.py precreate-container`, with hermes' docker flags), join it to the task's network, wire and probe the MCP servers (`harness_util.py mcp-handshake`), install the agent, and in the backup arm BackUpper (`setup_lib.sh pack`, `bu_install_in_container`). `trajectory.py` normalises each agent's transcript.
- **`harness/judge.py`** (`main` and `subagent-quality` modes): The two LLM judges (`llm_backend.py`: OpenRouter, codex CLI or Claude CLI).
- **`envs/`**: Base images and environment scripts per domain.
