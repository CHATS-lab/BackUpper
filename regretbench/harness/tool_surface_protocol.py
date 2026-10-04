"""Default-on first-turn protocol for tasks with configured MCP services."""
import os
import sys
from pathlib import Path

import yaml


def protocol(task, env):
    if env.get("RB_MCP_PROTOCOL", "1").lower() in {"0", "false", "off"}:
        return ""
    servers = [str(item["server"]) for item in task.get("mcp", [])
               if isinstance(item, dict) and item.get("server")]
    servers = list(dict.fromkeys(servers))
    if not servers:
        return ""
    text = (
        "**MCP PROTOCOL:** You must use the provided MCP tools to interact with "
        "these services: " + ", ".join(servers) + ". "
        "Do not bypass them through shell scripts or direct API calls.\n"
    )
    return text + "\n---\n\n"


if __name__ == "__main__":
    task = yaml.safe_load(Path(sys.argv[1]).read_text()) or {}
    target = Path(sys.argv[2])
    prefix = protocol(task, os.environ)
    if prefix:
        original = target.read_text()
        target.write_text(prefix + original)
        print("[protocol] default MCP service protocol prepended to first turn")
