#!/usr/bin/env python3
"""Point the GitLab tasks' seeding helpers at your GitLab container.

Seven GitLab tasks backdate records with `docker exec <gitlab> gitlab-psql`
(files/glcommon.py). The helper names the container and the docker daemon of the
original setup; this rewrites both to the caller's environment: the default
docker daemon, and the container named by RB_GITLAB_CONTAINER at seed time.

    python3 regretbench/envs/playwright/patch_tasks.py regretbench/tasks/playwright

Idempotent; prints each file it changed.
"""
import pathlib
import sys

REPLACEMENTS = [
    ("env = dict(os.environ, DOCKER_HOST=RB2)", "env = dict(os.environ)"),
    ('"docker", "exec", "rb-gitlab"', '"docker", "exec", os.environ["RB_GITLAB_CONTAINER"]'),
]


def main():
    root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "regretbench/tasks/playwright")
    for path in sorted(root.glob("*/files/glcommon.py")):
        text = original = path.read_text()
        for old, new in REPLACEMENTS:
            text = text.replace(old, new)
        if text != original:
            path.write_text(text)
            print("patched", path)


if __name__ == "__main__":
    main()
