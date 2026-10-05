#!/usr/bin/env python3
"""install_pollution.py DELTA NOISE OUT

Filter a `docker diff` install delta: drop every entry whose path is, contains,
or lies under a service-noise path (the paths the task's own services touched
while nobody was installing anything), and write the rest to OUT.
Used by rb_audit_install_end in setup_lib.sh.
"""
import pathlib
import sys

delta, noise, out = (pathlib.Path(p) for p in sys.argv[1:4])
noisy = []
if noise.exists():
    noisy = [line.strip() for line in noise.read_text().splitlines() if line.strip()]


def is_noise(path):
    for n in noisy:
        if (path == n or path.startswith(n.rstrip("/") + "/")
                or n.startswith(path.rstrip("/") + "/")):
            return True
    return False


kept = []
for line in delta.read_text().splitlines():
    if not line.strip():
        continue
    path = line.split(" ", 1)[1] if " " in line else line
    if not is_noise(path):
        kept.append(line)
out.write_text("".join(line + "\n" for line in kept))
