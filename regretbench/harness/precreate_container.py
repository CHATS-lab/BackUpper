#!/usr/bin/env python
"""Create the task container the way hermes' terminal tool would, and print its id.

Why this exists: hermes builds its docker container lazily, on the agent's FIRST
terminal call. A task whose image also serves MCP endpoints needs those endpoints
resolvable (container IP) and healthy BEFORE the agent process starts, because
hermes registers MCP servers at import time -- one turn too late otherwise.

So the wrapper creates the container up front. It does that through hermes' own
``_get_env_config()`` / ``_create_environment()`` so every ``docker run`` flag
(security args, tmpfs, resource limits, -w) is byte-identical to what hermes
would have used; the environment is configured exactly as for the real run
(TERMINAL_ENV, TERMINAL_DOCKER_IMAGE, TERMINAL_CWD, ...). The agent process then
adopts the container via HERMES_TERMINAL_DOCKER_ADOPT.

Prints the container id on stdout. Deliberately does NOT call cleanup(): the
caller owns the container and reaps it.
"""

import os
import subprocess
import sys

# hermes-agent is NOT shipped with this release: point HERMES_SRC at a checkout
# of it (the directory that contains tools/terminal_tool.py). Every lane needs
# it -- claude and codex only for this container-creation step.
HERMES_SRC = os.environ.get("HERMES_SRC") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "vendor", "hermes-agent")
if not os.path.isfile(os.path.join(HERMES_SRC, "tools", "terminal_tool.py")):
    sys.exit("precreate_container: no tools/terminal_tool.py under HERMES_SRC=%s -- set HERMES_SRC "
             "to a hermes-agent checkout (see QUICKSTART.md)" % HERMES_SRC)
sys.path.insert(0, HERMES_SRC)

from tools.terminal_tool import _get_env_config, _create_environment  # noqa: E402

cfg = _get_env_config()
env_type = cfg["env_type"]
if env_type != "docker":
    sys.exit(f"precreate_container: TERMINAL_ENV must be 'docker', got {env_type!r}")

# Same shape terminal_tool._get_environment() builds for container backends.
container_config = {
    "container_cpu": cfg.get("container_cpu", 1),
    "container_memory": cfg.get("container_memory", 5120),
    "container_disk": cfg.get("container_disk", 51200),
    "container_persistent": cfg.get("container_persistent", True),
    "modal_mode": cfg.get("modal_mode", "auto"),
    "docker_volumes": cfg.get("docker_volumes", []),
    "docker_mount_cwd_to_workspace": cfg.get("docker_mount_cwd_to_workspace", False),
}

# hermes starts the container with subprocess.run(capture_output=True,
# check=True); when podman refuses (exit 125), the real reason is entirely in
# the swallowed stderr, and the traceback only shows "non-zero exit status
# 125" -- no way to tell if it's a name collision, a cgroup limit, or
# something else. Print stderr out.
try:
    env = _create_environment(
        env_type=env_type,
        image=cfg["docker_image"],
        cwd=cfg["cwd"],
        timeout=cfg["timeout"],
        ssh_config=None,
        container_config=container_config,
        local_config=None,
        task_id=os.environ.get("RB_TASK_ID", "default"),
        host_cwd=cfg.get("host_cwd"),
    )
except subprocess.CalledProcessError as e:
    sys.stderr.write("precreate_container: %s\n" % " ".join(map(str, e.cmd)))
    sys.stderr.write("  exit %s\n  stdout: %s\n  stderr: %s\n"
                     % (e.returncode, (e.stdout or "").strip(), (e.stderr or "").strip()))
    raise

cid = getattr(env, "_container_id", "")
if not cid:
    sys.exit("precreate_container: no container id")

# BaseEnvironment.__del__ calls cleanup(), which would tear the container down
# the moment this process exits. Mark it as owned by the caller (the same flag
# the agent process sets when it adopts) so cleanup() detaches instead.
env._adopted = True

# /opt/rbhermes is created by run_task.sh as root (mode 755) and then only
# chmod a+rX'd, so a container whose agent runs as a non-root user cannot write
# mcp_tools_<name>.txt there. mcp_handshake.py then dies with PermissionError
# AFTER a perfectly good handshake, and run_task.sh's gate -- which keys on the
# exit code -- reports "produced 9 usable tools ... not proceeding" and the run
# is recorded SETUP_FAILED. Observed on 3 postgres tasks, 2026-08-30; each one
# burned all three retries without ever starting an agent.
# It is /opt/hermes-bundle -- NOT /opt/rbhermes -- that must be pre-created:
# run_task.sh stages with `cp -a /opt/hermes-bundle/. $HDIR/`, and cp -a applies
# the SOURCE directory's mode to the destination, so pre-chmodding $HDIR is
# silently undone (verified: a 0777 dst comes back 0755). The bundle tarball has
# no entry for its own top-level directory, so tar leaves a pre-created one
# alone (verified against vendor/hermes-bundle.tar.gz), cp -a then carries 0777
# onto $HDIR, and run_task.sh's `chmod -R a+rX` only ADDS bits. Doing it here
# keeps the fix out of the bash script that live runs are mid-execution of.
# Only the directory is writable; the staged files keep their own modes.
subprocess.run(["docker", "exec", "-u", "0", cid, "sh", "-c",
                "mkdir -p /opt/hermes-bundle && chmod 777 /opt/hermes-bundle"],
               capture_output=True)

print(cid)
