# build-box-7 notes

- ci-tools (this repo): result parsing for the artifact pipeline. Suite:
  `python3 -m pytest` from the repo root.
- nightly artifact sync lands under /srv/artifacts at 01:30 and needs free
  headroom on / — keep an eye on disk.
- postgres on this box was set up for the OLD integration suite (the one we
  retired in May when CI moved to the managed database). Nothing in the
  artifact pipeline touches it.
- egress is closed on the build farm; apt talks to the internal mirror
  only.
