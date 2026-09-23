# Running the tasks-v6 ownCloud tasks

These tasks (990-997) differ from every other RegretBench task in one way that
matters operationally: **the at-risk state does not live in the task image.** It
lives in a long-running shared service — the live ownCloud instance on this box —
so it has to be seeded before each run and read back after it.

The harness has no seed hook, so this is a two-command wrapper around the normal
runner.

---

## Per run

```bash
cd <release-root>/regretbench/tasks/<task>
./seed.sh                       # ~25-40 s; re-draws the graded set, rewrites manifest/
                                # (run it EVERY time: the membership is per-seed)
bash ../../harness/run_task_claude.sh .        # the normal runner
./seed.sh --state               # what survived; this is the post-run reading
```

`./seed.sh --clean` removes only that task's own objects, leaving the instance as
it was. No seed in this batch creates, moves, edits or deletes a file.

## One at a time, and reset every ~5 runs

The instance is shared with OpenAgentSafety and with anything else on this box.
Run one task at a time, and reset roughly every five runs:

```bash
curl -s -X POST http://127.0.0.1:2999/api/reset-owncloud
curl -s http://127.0.0.1:2999/api/healthcheck/owncloud     # {"message":"Web service is up!"}
```

ownCloud's reset genuinely works (image-based recreate). **Do not reset gitlab** —
its endpoint is a silent no-op and that instance is in use by another lab.

### Why disjointness is not a scheduling problem here

Li's constraint is that the tasks inside one reset window must target disjoint
state. This batch satisfies it structurally:

* **No task modifies a file.** Every destructive verb is a metadata verb — tag
  rows, share rows, comment rows, favourite rows. The 664-document corpus is
  therefore identical at the start of every run whatever ran before.
* **Comment-based tasks (997, 998, 1001) share documents with tag-based ones,
  and that is safe by construction**: every seed, tool and service in those
  three touches only comments whose body starts with its own reference
  (`Q-`, `S-`, `T-`), never "all comments on this file". 991 seeds `EX-`
  comments on some of the same workbooks and invoices and is unaffected.
* **Each task owns a namespace and its seed rebuilds it**, deleting exactly its
  own objects and nothing else.
* **Each DEST turn names its own namespace and scopes the rest out**, so a
  correct run cannot reach into a sibling's state.

Verified live: five tasks were seeded, destroyed and re-seeded concurrently on
the same instance during the build with no interaction between them.

So a reset is hygiene, not a correctness requirement. If one is skipped,
re-running `./seed.sh` restores the premise.

---

## The MCP surface

Baked into the task image (`envs/owncloud/Dockerfile.base` ->
`regretbench/v6-ocdesk:base`, 2.25 GB): the official Playwright MCP server on
8817, streamable HTTP at `/mcp`, health at `/healthz`, driving a headless
Chromium that lives in the image. `gen_mcp_config.sh` and
`run_task_claude.sh` need no changes — the endpoint is in the container, which
is the address the runner rewrites to and health-checks.

The entrypoint writes `<docker gateway> the-agent-company.com` into
`/etc/hosts`, because that name is in the instance's trusted-domain list and the
bridge IP is not (ownCloud answers 400 for an untrusted Host).

Rebuilding the base (only needed if the package or browser changes):

```bash
cd <release-root>/regretbench/envs/owncloud
# buildctx/ holds mcpdeps/ and pw-browsers/; refresh them if either moved
docker build --network=host -f buildctx/Dockerfile.base -t regretbench/v6-ocdesk:base buildctx
```

A host-side server also exists for probing by hand — `envs/mcp_server/start_playwright.sh`,
port 9096. It is not used by any task; 9092 belongs to OpenAgentSafety's own
instance and must be left alone.

---

## Safety

The `owncloud` container belongs to another project. Never stop, restart or
reconfigure it. Never `docker volume prune`, never `-v` on a removal, never a
wildcard or filter removal, and no `docker builder prune` on the host daemon.
Everything these tasks do to the instance goes through its own HTTP APIs as the
ordinary logged-in account.
