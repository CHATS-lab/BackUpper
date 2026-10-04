#!/usr/bin/env python
"""Create the task container ahead of the agent process and print its id.

The container is created through hermes' own ``_get_env_config()`` /
``_create_environment()``, so the ``docker run`` flags match what hermes would
have used; the agent process then adopts it via HERMES_TERMINAL_DOCKER_ADOPT.
The container id is printed on stdout and the caller owns its teardown.
"""

import os
import subprocess
import sys

# hermes-agent is not shipped: HERMES_SRC points at a checkout of it (the
# directory that contains tools/terminal_tool.py).
HERMES_SRC = os.environ.get("HERMES_SRC", "")
if not os.path.isfile(os.path.join(HERMES_SRC, "tools", "terminal_tool.py")):
    sys.exit("precreate_container: no tools/terminal_tool.py under HERMES_SRC=%r -- set HERMES_SRC "
             "to a hermes-agent checkout (see regretbench/README.md)" % HERMES_SRC)
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

# Container creation runs with output captured, so report the swallowed
# stdout/stderr before re-raising; the exit status alone says nothing.
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

# Mark the container as adopted so the environment's cleanup() detaches on
# interpreter exit instead of tearing it down.
env._adopted = True

print(cid)
