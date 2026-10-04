# task_env.sh -- connect a freshly created task container to the task's external
# environment. Sourced by run_task_claude.sh, run_task_codex.sh and run_task.sh,
# right after the container is created and before the agent or any MCP probe runs.
#
# attach_task_network CID
#   RB_TASK_NETWORK (set by run_regretbench.sh for playwright, k8s and email
#   tasks) names the docker network on which the task's service (web app, mail
#   server, cluster) answers under its own hostname. The container joins it, and
#   the image's /etc/hosts entry for RB_FS_HOST, which points at the docker
#   gateway, is dropped so the name resolves through the network's DNS.
#
# inject_gitlab_pat CID
#   GitLab task images carry the literal placeholder ${RB_GITLAB_PAT} in their
#   workspace configuration, or a /etc/rb/gitlab.token file. Both are replaced
#   with RB_GITLAB_TOKEN, the token of the GitLab instance this run uses. The
#   token travels through a 0600 file, never through argv or the container
#   environment, and is never logged.

attach_task_network() {
  local cid="$1" fsh
  [ -n "${RB_TASK_NETWORK:-}" ] || return 0
  if ! docker network inspect "$RB_TASK_NETWORK" >/dev/null 2>&1; then
    echo "[ERROR] RB_TASK_NETWORK=$RB_TASK_NETWORK does not exist -- the task's service will be unreachable" >&2
    return 1
  fi
  if ! docker network connect "$RB_TASK_NETWORK" "$cid" 2>/dev/null; then
    echo "[ERROR] could not attach the task container to $RB_TASK_NETWORK -- the task's service will be unreachable" >&2
    return 1
  fi
  fsh="$(docker exec "$cid" printenv RB_FS_HOST 2>/dev/null || true)"
  if [ -z "$fsh" ]; then
    echo "[net] task container attached to $RB_TASK_NETWORK"
    return 0
  fi
  # /etc/hosts is a bind mount, so it is rewritten in place rather than with `sed -i`.
  if docker exec -u 0 "$cid" sh -c \
       "grep -v '[[:space:]]${fsh}\$' /etc/hosts > /tmp/.h && cat /tmp/.h > /etc/hosts && rm -f /tmp/.h" 2>/dev/null; then
    echo "[net] task container attached to $RB_TASK_NETWORK; $fsh resolves through its DNS"
  else
    echo "[ERROR] attached to $RB_TASK_NETWORK but could not drop the /etc/hosts entry for $fsh" >&2
    return 1
  fi
}

inject_gitlab_pat() {
  local cid="$1" rc tmp out n
  # grep exit status: 0 = placeholder present, 1 = absent, anything else = unknown (treated as present).
  rc="$(docker exec "$cid" sh -c 'grep -rlF "$1" /srv >/dev/null 2>&1; echo $?' sh '${RB_GITLAB_PAT}' 2>/dev/null | tail -1)"
  if [ "${rc:-x}" = 1 ] && ! docker exec "$cid" test -f /etc/rb/gitlab.token 2>/dev/null; then
    return 0
  fi
  if [ -z "${RB_GITLAB_TOKEN:-}" ]; then
    echo "[gitlab] !! the image expects a GitLab token but RB_GITLAB_TOKEN is empty -- API calls will return 401"
    return 0
  fi
  tmp="$(mktemp)" || return 0
  chmod 600 "$tmp"
  printf '%s' "$RB_GITLAB_TOKEN" > "$tmp"
  docker cp "$tmp" "$cid:/tmp/.rb_glpat" >/dev/null 2>&1
  rm -f "$tmp"
  out="$(docker exec -i -u 0 "$cid" python3 - <<'PY' 2>&1
import os
import stat

PLACE = "${RB_GITLAB_PAT}"
try:
    with open("/tmp/.rb_glpat") as fh:
        tok = fh.read().strip()
finally:
    try:
        os.unlink("/tmp/.rb_glpat")
    except OSError:
        pass

n = 0
for root, dirs, files in os.walk("/srv"):
    dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(root, d))]
    for name in files:
        p = os.path.join(root, name)
        try:
            st = os.lstat(p)
            if not stat.S_ISREG(st.st_mode) or st.st_size > 1000000:
                continue
            with open(p, encoding="utf-8") as fh:
                data = fh.read()
        except (OSError, UnicodeDecodeError, ValueError):
            continue
        if PLACE not in data:
            continue
        tmp = p + ".rbpat.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(data.replace(PLACE, tok))
        os.chmod(tmp, stat.S_IMODE(st.st_mode))
        os.chown(tmp, st.st_uid, st.st_gid)
        os.rename(tmp, p)
        n += 1
        print("EXPANDED %s" % p)
if os.path.isfile("/etc/rb/gitlab.token"):
    with open("/etc/rb/gitlab.token", "w") as fh:
        fh.write(tok + "\n")
    os.chmod("/etc/rb/gitlab.token", 0o644)
    n += 1
    print("EXPANDED /etc/rb/gitlab.token")
print("COUNT %d" % n)
PY
)"
  printf '%s\n' "$out" | sed -n 's|^EXPANDED |[gitlab] token written to |p'
  n="$(printf '%s\n' "$out" | sed -n 's/^COUNT \([0-9][0-9]*\)$/\1/p' | tail -1)"
  [ "${n:-0}" -gt 0 ] || echo "[gitlab] !! the token was not written anywhere -- API calls will return 401"
}
