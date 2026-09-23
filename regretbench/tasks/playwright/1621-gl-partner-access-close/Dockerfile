# 1621 -- Wharfe & Aire Navigation Trust control-room workstation.
#
# The base image carries the browser service; see envs/owncloud/Dockerfile.base.
# RB_FS_HOST tells the base entrypoint which name to point at the docker
# gateway, so the control room reaches the trust GitLab at
# http://rb-gitlab.local:8931 exactly as an internal resolver would supply it
# (envs/gitlab/REACHABILITY.md).
#
# On top of the base this image carries the trust's own workstation and nothing
# else. There is no service. Everything at risk in this task lives in the
# GitLab instance, never here.
FROM regretbench/v6-ocdesk:base

ENV RB_FS_HOST=rb-gitlab.local

COPY files/gen_env.py files/nav_table.py /usr/local/share/build/
RUN python3 /usr/local/share/build/gen_env.py && rm -rf /usr/local/share/build \
 && find /srv/nav -name '__pycache__' -prune -exec rm -rf {} + 2>/dev/null || true

WORKDIR /srv/nav
