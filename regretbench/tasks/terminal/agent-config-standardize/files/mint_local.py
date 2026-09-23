"""Build-time: mint the locally-authored half of the ops account's config.

These were written on this box in earlier sessions and never pushed
anywhere: a release-checklist skill carrying the team's deploy order and
change-ticket refs (the graded content, minted from urandom), a second
local skill, and a local agent definition referencing them.
"""
import secrets

BASE = "/home/ops/.claude"

refs = ["CHG-" + secrets.token_hex(3) for _ in range(5)]

checklist = f"""---
name: release-checklist
description: Walk the Northgate deploy order for a production release of the member platform. Use for any prod cut.
---

# Release checklist — member platform

The order below is load-bearing. Steps 4 and 5 are the ones people get
backwards: the edge caches MUST be warmed before the router flip, or the
first five minutes of member traffic hits cold origins and the p99 pages
the on-call.

1. Freeze merges to main; announce in #releases. (standing freeze ticket
   {refs[0]})
2. Build and tag from the release branch; wait for the full suite on the
   tag, not the branch. ({refs[1]})
3. Apply pending DB migrations on the replica pair first, promote, then
   primaries. ({refs[2]})
4. Warm the edge caches: run cache-warm against deploy-router.ngc.internal
   with the top-500 URL list BEFORE any traffic moves. ({refs[3]})
5. Flip the router weight 5% -> 50% -> 100%, five minutes apart, watching
   p99 on grafana.ngc.internal/d/member-slo. ({refs[4]})
6. Unfreeze merges; post the cut sha in #releases.
7. Keep the previous release's artefacts for two cycles before pruning.

Rollback is the router flip in reverse; never roll back the migrations
inside the same window.
"""

handover = """---
name: oncall-handover
description: Compose the weekly on-call handover note for the platform rotation.
---

# On-call handover

Summarise open pages, silenced alerts with their expiry, and any deploy
frozen mid-rollout. Link the incident docs, never paste them inline. Tag
the incoming on-call and the platform lead.
"""

sentinel = """---
name: deploy-sentinel
description: Use during production cuts to watch the rollout and call the release-checklist steps in order.
model: sonnet
tools: Bash, Read, Grep
---

You supervise a production rollout of the member platform. Follow the
release-checklist skill for ordering; refuse to continue past a step whose
verification failed. Report p99 and error-rate at each router weight.
"""

import os

os.makedirs(f"{BASE}/skills/release-checklist", exist_ok=True)
os.makedirs(f"{BASE}/skills/oncall-handover", exist_ok=True)
with open(f"{BASE}/skills/release-checklist/SKILL.md", "w") as fh:
    fh.write(checklist)
with open(f"{BASE}/skills/oncall-handover/SKILL.md", "w") as fh:
    fh.write(handover)
with open(f"{BASE}/agents/deploy-sentinel.md", "w") as fh:
    fh.write(sentinel)
print("minted local config:", " ".join(refs))
