#!/usr/bin/env bash
# inject_gitlab_pat.sh <container-id>
#
# Expand the placeholder ${RB_GITLAB_PAT} baked into the gl playwright task image, **at
# runtime**, into the real PAT for this lane's own GitLab slot. Done in the window after the
# task container has been created but before the agent has started.
#
# ---- Why this is needed ----
# In the files/gen_env.py of 13 gl tasks, DESKCONF/STUDIOCONF are plain triple-quoted strings:
#     token = ${RB_GITLAB_PAT}
# Not an f-string, no .format(), gen_env.py has no os.environ/getenv/expandvars, and the
# Dockerfile has no build-arg either. So the content of /srv/<desk>/desk.conf in the image is
# **literally** `token = ${RB_GITLAB_PAT}`. Yet all 14 task.yaml files write it up as a real
# credential ("the office token that `desk.conf` already carries", and several spots even say
# measured 200). Using this literal string as PRIVATE-TOKEN, GitLab always returns 401 -- the
# task file is lying, the backup route exists on paper but not in the container. terra
# genuinely burned turns on this (up to 27 401s on a single task).
#
# ---- Why runtime injection, not baked in at build time ----
# Each GitLab slot has its own PAT (.gl_pat.1 .. .gl_pat.6 at the repo root). A single task
# image needs to serve all 6 slots at once; baking one in at build time can only bake in one,
# and the other 5 lanes would still get 401.
#
# ---- Why not go through `-e RB_GITLAB_PAT=...` (123-slot-map.sh's lane_docker_args) ----
# 1. That would put the real PAT into the container environment, so it would show up in
#    `docker inspect` and in /proc/1/environ, and the agent could see it with
#    `env | grep -i token`. run_task_claude.sh explicitly wrote down the same tradeoff when
#    handling subscription credentials: "the key goes into the sidecar as a FILE: never into
#    docker inspect, never into the image, never into any artifact" -- we follow the same
#    rule here.
# 2. The story task.yaml tells is "the office token lives in desk.conf." Stuffing in another
#    environment variable would hand the agent a route the task file never wrote, which is
#    more than just "turning the lie into the truth."
# 3. Even after -e, a substitution **still** has to happen inside the container (the ${...}
#    in desk.conf won't expand itself), so -e would just be a purely redundant extra exposure
#    surface.
# So the PAT only ever travels: host environment -> host temp file (0600) -> docker cp ->
# in-container substitution -> deleted inside the container in that same exec.
#
# The substitution is done as a full string replace, not hardcoded to
# /srv/issuedesk/desk.conf: 1316 actually writes studio.conf, and the ROOT differs across the
# 14 tasks (/srv/platform, /srv/heatops, /srv/repairsdesk, ...). So it scans under /srv and
# replaces whichever file carries the placeholder.
#
# Never log the token: only the paths and count of files changed. The caller's
# (run_task_*.sh) entire stdout gets redirected by adapters/*.sh into <run>/setup.log, so not
# a single byte can leak here.
#
# BLAST RADIUS:
#   * Commands are only sent to **the one container id given as an argument**: docker exec
#     x2-3 plus docker cp x1. That container is this run's own task container, created
#     seconds earlier by precreate_container.py.
#   * Never creates or deletes a container, never touches volumes/images/networks, never
#     prunes, never uses --filter/wildcards, never touches any other tenant's container on
#     this host.
#   * Inside the container, only modifies regular files under /srv that already contain the
#     placeholder, via temp-file + os.rename atomic replace, preserving the original
#     mode/owner. Aside from /tmp/.rb_glpat, which it writes and then deletes itself, it
#     creates or removes no files.
set -uo pipefail

CID="${1:?usage: inject_gitlab_pat.sh <container-id>}"
PLACEHOLDER='${RB_GITLAB_PAT}'

# RB_GITLAB_PAT takes priority (its name matches the placeholder, explicit); otherwise fall
# back to RB_GITLAB_TOKEN, which the lane already exported (the one
# 125-run-playwright-lane.sh reads from .gl_pat.<glslot>).
PAT="${RB_GITLAB_PAT:-${RB_GITLAB_TOKEN:-}}"

# Whether the placeholder is actually present in the container. If it is, it must be handled;
# if it definitely isn't, exit quietly (this covers oc tasks, and gl tasks like 1312 that
# never carried a token to begin with).
# Check grep's exit code, not its output: 0=present, 1=absent, anything else (or docker exec
# itself failing) = unknown. When unknown, treat it as "present" -- better to run a wasted
# substitution than to silently eat another round of 401s.
RC="$(docker exec "$CID" sh -c 'grep -rlF "$1" /srv >/dev/null 2>&1; echo $?' \
        sh "$PLACEHOLDER" 2>/dev/null | tail -1)"
if [ "${RC:-x}" = 1 ]; then
  exit 0
fi

if [ -z "$PAT" ]; then
  # Not a hard failure (when running a task manually and standalone, this may legitimately
  # be unset), but it must complain loudly -- otherwise it's another silent round of 401s.
  echo "[gitlab] !! container has the ${PLACEHOLDER} placeholder, but RB_GITLAB_PAT/RB_GITLAB_TOKEN are both empty -- gl API calls will 401"
  exit 0
fi

TMP="$(mktemp)" || { echo "[gitlab] !! mktemp failed, skipping PAT injection (gl API calls will 401)"; exit 0; }
chmod 600 "$TMP"
printf '%s' "$PAT" > "$TMP"
trap 'rm -f "$TMP"' EXIT            # No matter how this exits, this copy must be gone from the host

if ! docker cp "$TMP" "$CID:/tmp/.rb_glpat" >/dev/null 2>&1; then
  echo "[gitlab] !! docker cp of the PAT into the container failed, desk.conf still has the placeholder (gl API calls will 401)"
  exit 0
fi
rm -f "$TMP"

# The in-container substitution script. Passed via stdin, not argv; the PAT travels via a
# file, also not via argv. So the token never shows up in host ps, container ps, or
# docker inspect.
read -r -d '' RB_PATCH_PY <<'PY'
import os
import stat

PATF = "/tmp/.rb_glpat"
PLACE = "${RB_GITLAB_PAT}"

try:
    with open(PATF) as fh:
        tok = fh.read().strip()
finally:
    try:
        os.unlink(PATF)          # gone before the agent even starts
    except OSError:
        pass

if not tok:
    print("COUNT 0")
    raise SystemExit(0)

n = 0
for root, dirs, files in os.walk("/srv"):
    dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(root, d))]
    for name in files:
        p = os.path.join(root, name)
        try:
            st = os.lstat(p)
            if not stat.S_ISREG(st.st_mode) or st.st_size > 1000000:
                continue
            with open(p, "r", encoding="utf-8") as fh:
                data = fh.read()
        except (OSError, UnicodeDecodeError, ValueError):
            continue
        if PLACE not in data:
            continue
        tmp = p + ".rbpat.tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write(data.replace(PLACE, tok))
            os.chmod(tmp, stat.S_IMODE(st.st_mode))
            try:
                os.chown(tmp, st.st_uid, st.st_gid)
            except OSError:
                pass
            os.rename(tmp, p)     # atomic replace, never leaves a half-written file
        except OSError:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            continue
        n += 1
        print("EXPANDED %s" % p)
print("COUNT %d" % n)
PY

if docker exec "$CID" sh -c 'command -v python3' >/dev/null 2>&1; then
  OUT="$(printf '%s\n' "$RB_PATCH_PY" | docker exec -i -u 0 "$CID" python3 - 2>&1)"
else
  # Fallback: the image has no python3. The token only goes into the container's own sed
  # argv, and the agent hasn't started yet at this point.
  OUT="$(docker exec -u 0 "$CID" sh -c '
    tok=$(cat /tmp/.rb_glpat); rm -f /tmp/.rb_glpat
    [ -n "$tok" ] || { echo "COUNT 0"; exit 0; }
    n=0
    for f in $(grep -rlF "$1" /srv 2>/dev/null); do
      if sed -i "s|\\${RB_GITLAB_PAT}|$tok|g" "$f" 2>/dev/null; then
        echo "EXPANDED $f"; n=$((n+1))
      fi
    done
    echo "COUNT $n"
  ' sh "$PLACEHOLDER" 2>&1)"
fi

# Only let through the two line shapes we agreed on ourselves. The in-container script never
# prints the token; this is a belt-and-suspenders check.
echo "$OUT" | grep -E '^EXPANDED /' | sed 's|^EXPANDED |[gitlab] expanded placeholder: |'
N="$(echo "$OUT" | sed -n 's/^COUNT \([0-9][0-9]*\)$/\1/p' | tail -1)"
if [ -z "${N:-}" ] || [ "$N" = 0 ]; then
  echo "[gitlab] !! ${PLACEHOLDER} was not expanded anywhere -- the gl task's API route will still 401"
else
  echo "[gitlab] ${PLACEHOLDER} -> this slot's real PAT, expanded in $N files (token not logged)"
fi
exit 0
