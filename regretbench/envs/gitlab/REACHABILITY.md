# rb-gitlab — how an agent container reaches it

Verified 2026-08-14. Companion to `rb-gitlab.sh` (lifecycle) and
`RECOVERABILITY.md` (which verb is gradeable and why).

## The address a task should use

```
http://rb-gitlab.local:8931
```

`rb-gitlab.local` is not DNS. The task image must write the **docker bridge
gateway** into `/etc/hosts`, exactly as `envs/owncloud/start-mcp.sh` already
does for `the-agent-company.com`:

```sh
GW="$(awk '$2=="00000000" {gw=$3; for(i=6;i>0;i-=2) printf "%d%s", strtonum("0x" substr(gw,i-1,2)), (i>2?".":""); exit}' /proc/net/route)"
[ -n "$GW" ] || GW=172.17.0.1
echo "$GW rb-gitlab.local" >> /etc/hosts
```

The ocdesk base image takes this as an env var — `-e RB_FS_HOST=rb-gitlab.local`
is enough, no new image needed.

`http://172.17.0.1:8931` works identically and is fine for a curl-only task.
The hostname is preferable for browser tasks: GitLab builds form actions and
redirects from the request Host, so a named host keeps the whole session on one
origin and reads like a real internal address.

## Why it is reached this way

`rb-gitlab` runs on the **rb2 isolated daemon**
(`unix:///var/run/docker.sock`, bridge `rb2_docker0`,
172.32.0.0/16). Agent containers run on the **host daemon** — they have to,
because the isolated daemons have no container egress and an agent started there
cannot reach the Claude gateway (`api_retry x10`, zero tool calls).

Three options were tried, in order:

1. **Move the copy to the host daemon** — rejected. The image is 29.7 GB and
   host `/` has 6.6 GB free.
2. **Rely on the published port** — half worked. rb2 runs `--userland-proxy=true`,
   so `-p 8931:8931` does bind `0.0.0.0:8931` on the host and the host itself
   gets a 200 on loopback. But **from inside a container it timed out.**
   Root cause: the host's `INPUT` policy is `DROP` (ufw), and traffic from a
   container to the gateway IP is `INPUT`. Ports published by the *host* daemon
   (ownCloud's 8092) never hit that path — docker writes a `nat` DNAT rule, which
   turns them into `FORWARD` traffic that the `DOCKER` chain accepts. rb2 runs
   `--iptables=false`, so **no DNAT rule exists for 8931** and it stayed `INPUT`.
3. **One firewall rule** — what actually shipped.

## The host change (the only one)

```sh
ufw allow in on docker0 from 172.17.0.0/16 to any port 8931 proto tcp \
    comment 'RegretBench rb-gitlab (rb2 daemon) for agent containers'
```

Resulting rule, in `ufw-user-input`:

```
-A ufw-user-input -s 172.17.0.0/16 -i docker0 -p tcp -m tcp --dport 8931 -j ACCEPT
```

Nothing else on the host was touched — no route, no MASQUERADE, no NAT rule, no
change to any daemon's flags, and nothing on the rb2 side. Traffic still goes
through rb2's own userland `docker-proxy`, which forwards to 172.32.0.5:8931.

**Scope, deliberately tight.** The rule matches only the default bridge. 8931 is
bound on `0.0.0.0`, but `INPUT`'s default `DROP` still blocks the internet, and
this rule does not open it — it is `-i docker0` and source-limited. Verified: a
container on `theagentcompany_owncloud_network` (a custom bridge) is still
**BLOCKED**.

The harness does not pass `--network`, so task containers land on the default
bridge and are covered. **If a task ever runs the agent on a custom network, this
rule will not match it** — widen it deliberately, per network:

```sh
ufw allow in on br-<id> from <subnet> to any port 8931 proto tcp
```

The rule persists in `/etc/ufw/user.rules` across reboot and `ufw reload`, and is
independent of `rb-gitlab.sh reset` (the port does not change).

## Credentials

| | |
|---|---|
| Web UI | `root` / `theagentcompany` |
| PAT | `${RB_GITLAB_PAT}` — scopes `api, read_repository, write_repository, sudo`, expires 2027-08-01 |
| OAuth | `POST /oauth/token {"grant_type":"password","username":"root","password":"theagentcompany"}` |

**The seeded `glpat-OPENHANDS_EVAL_TOKEN_01` returns 401** — not a
misconfiguration: the only PAT baked into the image is `root/root-token`, and it
**expired 2025-11-18**. Re-verified 401 on this instance.

**`rb-gitlab.sh reset` destroys the PAT above** — reset removes the data volume,
so the instance returns to the image's seed state (expired token only). Re-mint
after every reset; the OAuth grant is the fast route and needs no `gitlab-rails`:

```sh
AT=$(curl -s -X POST http://127.0.0.1:8931/oauth/token -H 'Content-Type: application/json' \
     -d '{"grant_type":"password","username":"root","password":"theagentcompany"}' \
     | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
curl -s -X POST http://127.0.0.1:8931/api/v4/users/1/personal_access_tokens \
     -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' \
     -d '{"name":"regretbench","scopes":["api","read_repository","write_repository","sudo"],"expires_at":"2027-08-01"}'
```

Prefer this over `docker exec rb-gitlab gitlab-rails runner` — each runner boots a
full Rails app (minutes, ~1 GB), and a few in parallel drove this box's load
average past 100 and made GitLab return 500s.

## Proof (2026-08-14)

From inside a container on the **host** daemon, `alpine`, no special flags:

```
$ docker run --rm alpine wget -S -O /tmp/p http://172.17.0.1:8931/users/sign_in
  HTTP/1.1 200 OK
  Server: nginx
  Content-Type: text/html; charset=utf-8
  Content-Length: 9911
<title>Sign in · GitLab</title>
```

Real browser, `@playwright/mcp` 0.0.79 / playwright-core 1.63.0-alpha, driven
over streamable HTTP in `regretbench/v6-ocdesk:base`:

```
== browser_navigate {"url":"http://rb-gitlab.local:8931/users/sign_in"} ==
- Page URL: http://rb-gitlab.local:8931/users/sign_in
- Page Title: Sign in · GitLab

== browser_fill_form  #user_login=root  #user_password=theagentcompany ==
== browser_click  button[data-testid=sign-in-button] ==
- Page URL: http://rb-gitlab.local:8931/
- Page Title: Projects · GitLab
```

The post-login redirect stays on `rb-gitlab.local:8931`, so `external_url`
being `http://localhost:8931` does **not** break browsing.

API, same container: `/api/v4/user` -> `{"id":1,"username":"root"}`,
`/api/v4/version` -> `17.5.1`, `/api/v4/projects` -> **14** seeded projects
(`root/bustub`, `root/openhands`, `root/llama.cpp`, …).

### Notes for whoever writes the first browser task

- The sign-in submit is `button[data-testid=sign-in-button]`. It is **not** an
  `input[type=submit]` and the form has **no id** — `form#new_user button[type=submit]`
  and `input[name=commit]` both match nothing on 17.5.1.
- This box is shared and its load average swings past 60. Under load GitLab
  answers in 6-8 s and playwright's default 5 s action timeout fires, which
  surfaces as a spurious `500`/`TimeoutError`. Check `/proc/loadavg` before
  concluding anything is broken.
