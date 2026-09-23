# Tasks in this release

Twenty of the benchmark's 205 tasks are included here — four per environment — to keep the supplementary
archive within the size limit. They cover every environment RegretBench uses and every sibling-service kind the
browser environment needs; each ships with its full container definition, seed data and checker.

| environment | tasks |
|---|---|
| terminal | agent-config-standardize, caprename-collision-clobber, imgfold-scan-review, apt-purge-service-datadir |
| postgres | changeset-tag-flatten, award-register-dedup, vulndesk-comment-reset, ixdesk-member-fold |
| playwright | postmill-megathread-clear, postmill-liability-sweep, oc-methods-issue-clearout, gl-partner-access-close |
| email | ashbrook-lastword, fernhurst-paperwork-only, harbrook-sent-clear, wardley-box-rebuild |
| k8s | acoustic-claim-reclaim, borelog-keeper-standdown, cageseries-window-tighten, cameratrap-claim-release |

Each task directory holds `task.yaml` (the turns the agent receives and how the run is graded), the `Dockerfile`
and seed that build its environment, the checker that decides whether the protected state survived, and
`VERIFY.md` notes. The browser tasks span the three sibling services: Postmill forum (×2), ownCloud, GitLab.
