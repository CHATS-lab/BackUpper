# rb-mail — what the environment is, and how to get back to the original state

This is the mail environment for the **RegretBench email band (2301-2399, 41 tasks)**.
The agent in each task accesses two mailboxes over MCP; **not a single email lives in the task container — they're all on this mail server.**

---

## 1. The `poste-data/` in the archive is not the original state

`poste-data/` is the **live data directory** of the `rbm-poste` container. The server
was running when it was packaged, so it captures **the scene as it stood at that
moment** — already modified by tasks that had run. All three sqlite databases checked
out `integrity_check = ok` both before and after packaging, so the data is intact, but
**it is not a clean baseline**.

To get back to the original state, use one of the two paths below.

---

## 2. Route A: restore from a snapshot (~25 seconds, recommended)

Prerequisite: the `rbm-poste` container is already running.

```sh
./reset-mail.sh                    # restore to snapshots/base.tgz
./reset-mail.sh <some-snapshot.tgz>   # restore to a specific snapshot
./reset-mail.sh --snapshot out.tgz # the reverse: save the current state as a new snapshot
```

What it does is **restore every mailbox on the whole server, byte for byte**: raw
message bodies, UIDs, INTERNALDATE, flags, folder structure, attachments. Before
restoring, it uses s6 to stop dovecot / haraka first (otherwise dovecot's in-memory
index would write itself back over the restored content), then restarts them after
restoring and waits for IMAP to come up — exiting non-zero if it doesn't.

### The difference between the five snapshots in `snapshots/`

| File | Mailboxes | Emails | What it is |
|---|---|---|---|
| **`base.tgz`** | **524** | **0** | **Default baseline; used by `reset-mail.sh` with no arguments. Has the most mailboxes** |
| `base-pre20260825b.tgz` | 504 | 0 | The version before base, 20 fewer mailboxes |
| `pristine.tgz` | 504 | 0 | Empty state saved right after the build |
| `clean.tgz` | 504 | 7 | With 7 sample emails |
| `phd-task.tgz` | 504 | 3 | Mid-task state from a specific task, not a baseline |

**Use `base.tgz` (the default) to get the original state.** The other four are
historical archives.

> Snapshots contain only `/data/domains` (mailbox content). The account table,
> roundcube, and DAV are not included — those are set up by `setup-mail.sh`, and
> restoring mail does not touch them.

---

## 3. Route B: rebuild from scratch (~a few minutes)

```sh
./setup-mail.sh
```

**This first runs `docker rm -f rbm-poste rbm-client`, then deletes `poste-data/`
entirely and rebuilds it.** If there's something in the current state you want to
keep, run `./reset-mail.sh --snapshot backup.tgz` first.

Result: `analogic/poste.io:2.5.5`, domain `mcp.com`, **503 mailboxes + admin**,
ports `10005(web) 2525(smtp) 1143(imap) 1587(submission)`, plaintext auth turned on.
Accounts and passwords come from `Toolathlon-main/configs/users_data.json`;
`users.nul` is a plaintext lookup table for the same accounts (synthetic data, not
real people).

### Why TLS is turned off

poste.io enforces TLS by default, and **these config files get reset every time the
container restarts.** `reapply_plaintext_config()` in `reset-mail.sh` reapplies the
following after every restore: dovecot's `ssl = yes` / `auth_allow_cleartext = yes`,
`tls_required = false` on both haraka instances, and opening up the internal relay.
**If MCP can't connect after a container restart, run `reset-mail.sh` once first —
that's usually the reason.**

---

## 4. Two gotchas already worked around in the scripts — don't step back into them when editing

- **Use only `s6-svc` to restart services, not `pgrep`/`kill`.** The pattern
  `haraka.*smtp` also matches the shell that's running it, so you'd kill the shell
  along with it.
- **Probe IMAP from inside the `rbm-client` container.** poste's `/bin/sh` is dash and
  has no `/dev/tcp`, so probing from inside poste will always fail.

---

## 5. base image source

`env/` is the build source for `regretbench/v9-maildesk:base`:

| File | Purpose |
|---|---|
| `Dockerfile.base` | The image itself |
| `start-mcp.sh` | ENTRYPOINT: iterates `/opt/rbmail/accounts/*.json`, **starts one emails-mcp per account**, bridged to streamable HTTP via supergateway. Port comes from the account file's own `_rb_port` |
| `rbmail.py` / `mailtask.py` / `rbdoc.py` | Desktop-side helper libraries |

Health checks go through `/healthz`, not `/mcp` — **hitting `/mcp` consumes a
session**. Attachments and exports land in the desktop's own working directory, so
when the agent downloads or exports something, the file shows up where a real person
would look for it.
