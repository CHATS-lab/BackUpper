# Playwright / Web Application Setup

The playwright tasks drive three upstream web applications through a headless browser. Host them first:

| Site | Tasks | Upstream | Image |
|------|-------|----------|-------|
| Postmill forum ("reddit") | 20 | [SafeArena](https://github.com/McGill-NLP/safearena) ([env-setup](https://github.com/McGill-NLP/safearena/blob/main/env-setup/README.md); images on [HuggingFace](https://huggingface.co/datasets/McGill-NLP/safearena-environments), gated), the WebArena Postmill build | `safearena_forum:latest` |
| GitLab | 10 | [TheAgentCompany](https://github.com/TheAgentCompany) | `ghcr.io/theagentcompany/servers-gitlab:1.0.0` |
| ownCloud | 20 | [TheAgentCompany](https://github.com/TheAgentCompany) | `ghcr.io/theagentcompany/servers-owncloud:1.0.0` |

After obtaining the three images, follow these steps:

## 1. Build the Agent-Side Image

Every playwright task image derives from one workstation image carrying Chromium and the Playwright MCP server (port 8817):

```bash
bash regretbench/start_envs.sh images playwright     # regretbench/v6-ocdesk:base from desk/
```

## 2. Start GitLab and ownCloud

```bash
bash regretbench/start_envs.sh web
export RB_GITLAB_TOKEN=$(bash regretbench/envs/playwright/web.sh token rb-gitlab)
```

This runs `web.sh gitlab` and `web.sh owncloud`, which attach both servers to one Docker network (`RB_WEB_NET`, default `regretbench-web`) under the hostnames the tasks use, and applies our customization:

| Site | Hostname in the tasks | Customization |
|------|-----------------------|---------------|
| Forum | `http://rb-forum.local/` | none; a fresh container per run (`web.sh forum`), started by `run_regretbench.sh` |
| GitLab | `http://rb-gitlab.local:8931` | `external_url` set to that address, monitoring services off; `web.sh token` resets root's password to `theagentcompany` and mints an API token (the image's own token has expired) |
| ownCloud | `http://the-agent-company.com:8092` | the container's address added to `trusted_domains`, so the host can seed by address |

The forum needs no setup step: its image is used unchanged, and a fresh container is started for every run, since a restart does not undo a run's changes.

## 3. Patch the GitLab Tasks

Seven GitLab tasks backdate records through `docker exec <gitlab> gitlab-psql`. Point them at your container:

```bash
python3 regretbench/envs/playwright/patch_tasks.py regretbench/tasks/playwright
```

## 4. Seeding

Each task's `seed.sh` writes the task's state into the web app before the run, and `seed.sh --clean` removes it again. `run_regretbench.sh` calls it with:

| Site | Variables passed to `seed.sh` |
|------|-------------------------------|
| Forum | `RB_FORUM_CONTAINER`, `RB_FORUM_URL` (from `web.sh forum`) |
| GitLab | `RB_GITLAB=http://<address>:8931`, `RB_GITLAB_TOKEN`, `RB_GITLAB_CONTAINER` |
| ownCloud | `OC_URL=http://<address>`, `OCSEED=regretbench/envs/playwright/owncloud` (the ownCloud client `ocseed.py`, `ocdesk.py`, `ocsess.py`) |

GitLab task images carry the placeholder `${RB_GITLAB_PAT}` where the agent's workspace names the office token; the harness replaces it with `RB_GITLAB_TOKEN` inside the task container before the agent starts (`inject_gitlab_pat` in `harness/setup_lib.sh`).

## Accounts

| Site | Login |
|------|-------|
| Forum | `MarvelsGrantMan136` / `test1234` (some tasks: `KrokmaniakPL` / `test1234`) |
| GitLab | `root` / `theagentcompany` |
| ownCloud | `theagentcompany` / `theagentcompany` |
