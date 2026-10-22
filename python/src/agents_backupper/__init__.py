"""Python entry point for BackUpper.

BackUpper is written in TypeScript. This package ships the published npm build
(agents-backupper and its dependencies) under ``_node/`` and runs its CLI with
the local Node.js, so ``backupper`` behaves exactly as the npm version. Agent
hooks point at files inside this package, which stay in place across upgrades.
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

__version__ = "0.1.0"

MIN_NODE = 18
CLI = Path(__file__).resolve().parent / "_node" / "node_modules" / "agents-backupper" / "dist" / "cli.js"


def _node_major(node):
    try:
        out = subprocess.run([node, "--version"], capture_output=True, text=True, check=True).stdout
        return int(out.strip().lstrip("v").split(".")[0])
    except (OSError, ValueError, subprocess.CalledProcessError):
        return None


def main():
    node = shutil.which("node")
    if node is None:
        sys.stderr.write(f"backupper: Node.js >= {MIN_NODE} is required but `node` was not found on PATH.\n"
                         "Install it from https://nodejs.org and try again.\n")
        return 1
    major = _node_major(node)
    if major is not None and major < MIN_NODE:
        sys.stderr.write(f"backupper: Node.js >= {MIN_NODE} is required (found v{major}).\n")
        return 1
    if not CLI.is_file():
        sys.stderr.write(f"backupper: bundled CLI missing at {CLI}; reinstall agents-backupper.\n")
        return 1
    args = [node, str(CLI), *sys.argv[1:]]
    if os.name == "posix":
        os.execv(node, args)
    return subprocess.call(args)
