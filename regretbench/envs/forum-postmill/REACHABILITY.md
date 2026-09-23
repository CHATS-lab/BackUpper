# How an agent container reaches the Postmill instance — measured 2026-08-22 (lane B)

**This affects all three forum lanes.** Every task image in the batch is built
`FROM regretbench/v6-ocdesk:base`, whose entrypoint maps `RB_FS_HOST` to the
**docker bridge gateway** (`172.17.0.1`). On this box that address does not work
from inside a container.

## What was measured

| from | to | result |
|---|---|---|
| host | `127.0.0.1:9861` (forum published loopback-only) | **200** |
| container | `172.17.0.1:9861` | **000 / connect fail** |
| host | `172.17.0.1:80` (a test service published on the gateway address) | **200** |
| container | `172.17.0.1:80` (same service) | **ETIMEDOUT** |
| container | `172.17.0.8:80` (the forum container's own bridge IP) | **200** |

## Why

Every docker DNAT rule on this host carries `! -i docker0`:

```
$ iptables -t nat -S DOCKER
-A DOCKER -d 127.0.0.1/32 ! -i docker0 -p tcp -m tcp --dport 9999 -j DNAT --to-destination 172.17.0.2:80
-A DOCKER -d 127.0.0.1/32 ! -i docker0 -p tcp -m tcp --dport 9861 -j DNAT --to-destination 172.17.0.8:80
...
$ iptables -S INPUT
-P INPUT DROP
```

So traffic that a container sends to a published address is **not** DNATed (it
arrived on `docker0`), falls through to `INPUT`, and `INPUT` policy is `DROP`
with no ufw allowance for `docker0`. This is the same failure
`envs/gitlab/REACHABILITY.md` documents for rb-gitlab, and it was fixed there
with **one ufw rule**. No such rule exists for any forum port.

## The two ways to make a run work — pick one, centrally

1. **One host firewall rule** (the rb-gitlab precedent), then publish the
   run-time forum container on the gateway address at port 80 so the turns'
   `http://rb-forum.local/` resolves with no port:

   ```sh
   docker run -d --name rb-forum-run -p 172.17.0.1:80:80 safearena_forum:latest
   ufw allow in on docker0 from 172.17.0.0/16 to 172.17.0.1 port 80 proto tcp \
       comment 'RegretBench forum batch, agent containers'
   ```

   `RB_FS_HOST=rb-forum.local` in the task images then works unchanged.

2. **No host change**: point `rb-forum.local` at the forum container's own
   bridge IP instead of the gateway. Container-to-container on the default
   bridge already works (measured, 200). This needs either a per-run
   `-e RB_FORUM_IP=…` that the base entrypoint honours, or the forum container
   and the agent container on a user-defined network with a DNS alias.

**Nothing was changed on the host.** This is recorded, not acted on: a firewall
change is not a lane's decision.
