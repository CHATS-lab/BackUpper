# Experiences shipped here, and which runs used them

The Backupper injects every file in this directory into the task container
(`<cwd>/.chats-sandbox/experiences/`); each file declares its own `appliesTo`, so only the ones matching
the task's MCP servers are used. These are produced by the self-exploration pipeline.

**The set was regenerated during the campaign**, so individual runs saw slightly different generations.
What ships here is the variant used by the majority of the runs of the band it serves:

| file | md5 (first 8) | used by |
|---|---|---|
| filesystem.json | 2db6e9ed | all armed terminal/postgres campaigns (5/5 checked) |
| reddit.json | 261b3e47 | all armed terminal/postgres campaigns (5/5) |
| postgres.json | 4dbb9169 | opus / sonnet / sol campaigns (3 of 6); deepseek+gemini used `b6036382`, terra `5c19da44` |
| playwright.json | 3a8e6d53 | every three-tool playwright run (12/12). The terminal/postgres campaigns carried an older `f054bc22`, unused there |
| k8s.json | 77887730 | the three-tool k8s lane (10/12; 2 runs used `c570b178`) |
| email.json | 2719f059 | the three-tool email lane (11/12; 1 run used `0134850a`) |

The per-campaign copies are in the archive under each run's `.chats-sandbox/experiences/`.

**In this release** the `evidence`/provenance file paths inside `k8s.json` and `playwright.json` were replaced with
`<provenance path omitted>` (41 strings, no behavioural fields touched); their md5 therefore differs from the
originals recorded above.
