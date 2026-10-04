# Email Setup

The email tasks use the [poste.io](https://poste.io) mail server image `analogic/poste.io:2.5.5` (domain `mcp.com`), deployed as in [Toolathlon](https://github.com/hkust-nlp/Toolathlon) (`deployment/poste/`). No hosting is needed beyond pulling the image:

```bash
docker pull analogic/poste.io:2.5.5
```

`run_regretbench.sh` starts a fresh server for every email run and removes it afterwards. The steps it runs are below.

## 1. Build the Agent-Side Image

Every email task image derives from one workstation image that runs one [emails-mcp](https://pypi.org/project/emails-mcp/) 0.1.12 server per mailbox (ports 8901, 8902):

```bash
bash regretbench/start_envs.sh images email     # regretbench/v9-maildesk:base from maildesk/
```

## 2. Start the Mail Server

```bash
bash regretbench/envs/email/start_mail.sh <task-dir> <container-name> <network> <data-dir>
```

`start_mail.sh` starts poste.io on `<network>` under the hostname `mail.mcp.com` with an empty `/data`, and applies our customization:

- **Plaintext authentication.** poste.io ships TLS-required defaults; the task accounts connect without TLS (IMAP 143, submission 587). The script relaxes dovecot and haraka accordingly and restarts them through s6.
- **Accounts.** It creates the domain `mcp.com`, the admin `mcpposte_admin@mcp.com`, and the task's own mailboxes from `<task-dir>/files/accounts/*.json`. With `RB_MAIL_USERS_JSON` pointing at Toolathlon's `configs/users_data.json`, Toolathlon's 503 mailboxes are created as well.

It prints `RBMAIL_HOST` and `RBMAIL_PORT`.

## 3. Seeding

The task's `seed.sh` writes its mail into the task's mailboxes over IMAP (`RBMAIL_HOST`, `RBMAIL_PORT`); `seed.sh --clean` empties them.
