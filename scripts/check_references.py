#!/usr/bin/env python3
"""Every file the release's harness scripts source / bash / python3 / import must exist.

SCOPE: the launcher and the harness -- run_regretbench.sh, regretbench/harness/**,
regretbench/gen_mcp_config.sh, scripts/**, and the env service scripts the launcher
calls. Task fixtures under regretbench/tasks/** are inputs to a docker build, not
harness code, and are not scanned.

It resolves the shell variables that name release directories ($HERE = the script's
own directory, $RB, $ROOT, $H) and skips anything that expands to a path inside a
container ($RUN, $TASKDIR, /opt, /tmp, /gw, ...), because those are created at run
time and cannot be checked from the tree.

Usage: python3 scripts/check_references.py   (exit 1 on any missing target)
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RB = os.path.join(ROOT, "regretbench")
H = os.path.join(RB, "harness")

TARGETS = [
    os.path.join(ROOT, "run_regretbench.sh"),
    os.path.join(RB, "gen_mcp_config.sh"),
    os.path.join(RB, "envs", "k8s", "reset.sh"),
    os.path.join(RB, "envs", "gitlab", "rb-gitlab.sh"),
    os.path.join(RB, "envs", "rb-mail", "setup-mail.sh"),
    os.path.join(RB, "envs", "rb-mail", "reset-mail.sh"),
]
TARGET_DIRS = [H, os.path.join(ROOT, "scripts")]

# Fixed release directories. $HERE is per-file (the script's own dir) and is bound
# in resolve(). Everything else ($RUN, $TASKDIR, $CSDIR, $STAGE, ...) is run-time.
VARS = {"RB": RB, "ROOT": ROOT, "H": H}
# Absolute prefixes that only exist inside a task container / a temp dir.
CONTAINER_PREFIXES = ("/opt", "/tmp", "/gw", "/usr", "/var", "/etc", "/srv", "/root",
                      "/work", "/rbhome", "/data", "/home", "/mnt")

SHELL_EXEC = re.compile(
    r'(?:^|[;&|(`]\s*|\s)(?:\.|source|bash|sh)\s+"?(\$\{?\w+\}?/)?([\w./-]+\.sh)"?')
PY_EXEC = re.compile(
    r'(?:"\$PY"|\$PY|"\$\{PY\}"|python3?)\s+(?:- )?"?(\$\{?\w+\}?/)?([\w./-]+\.py)"?')
PY_IMPORT = re.compile(r'^\s*(?:from|import)\s+(\w+)', re.M)

STDLIB = set(getattr(sys, "stdlib_module_names", ()))
EXTERNAL = STDLIB | {
    "yaml", "docker", "mcp", "httpx", "requests", "numpy", "pytest", "pydantic",
    # hermes-agent, supplied via HERMES_SRC and deliberately not shipped.
    "tools",
    # scripts/check_prompts.py sys.path.insert()s regretbench/harness before
    # importing it; it is checked by that script's own first assertion.
    "prompt_md",
}


def files():
    seen = []
    for t in TARGETS:
        if os.path.exists(t):
            seen.append(t)
    for d in TARGET_DIRS:
        for dirpath, dirnames, filenames in os.walk(d):
            dirnames[:] = [x for x in dirnames if x != "__pycache__"]
            for fn in sorted(filenames):
                if fn.endswith((".sh", ".py")):
                    seen.append(os.path.join(dirpath, fn))
    return sorted(set(seen))


def strip_docstring(text):
    """Drop the module docstring: a Usage: line in it is documentation, not a call."""
    m = re.search(r'^(?:#![^\n]*\n)?(?:"""|\'\'\')', text)
    if not m:
        return text
    q = text[m.end() - 3:m.end()]
    end = text.find(q, m.end())
    return text[:m.start()] + text[end + 3:] if end > 0 else text


def resolve(prefix, target, origin):
    """-> absolute path to check, or None if the reference is not a release path."""
    if target.startswith("/"):
        return None if target.startswith(CONTAINER_PREFIXES) else target
    if prefix:
        var = prefix.strip("$/{}")
        if var == "HERE":
            # adapters/*.sh are SOURCED by run.sh, so their $HERE is run.sh's:
            # the harness directory, not adapters/.
            base = os.path.dirname(origin)
            if os.path.basename(base) == "adapters":
                base = os.path.dirname(base)
            return os.path.join(base, target)
        if var not in VARS:
            return None
        return os.path.join(VARS[var], target)
    return os.path.join(os.path.dirname(origin), target)


def main():
    missing, checked = [], 0
    for path in files():
        rel = os.path.relpath(path, ROOT)
        text = open(path, encoding="utf-8", errors="replace").read()
        if path.endswith(".py"):
            text = strip_docstring(text)
        # Whole-line comments are prose: a comment naming a file is not a call.
        code = "\n".join(l for l in text.split("\n") if not l.lstrip().startswith("#"))
        for rx in (SHELL_EXEC, PY_EXEC):
            for prefix, target in rx.findall(code):
                t = resolve(prefix or "", target, path)
                if t is None:
                    continue
                checked += 1
                if not os.path.exists(t):
                    missing.append("%s -> %s" % (rel, os.path.relpath(t, ROOT)))
        if path.endswith(".py"):
            # Module-level imports only; docstrings are stripped by the comment
            # filter above only for '#' lines, so require the import to be at
            # column 0 or inside a function (both start the line with 'import').
            for mod in PY_IMPORT.findall(code):
                if mod in EXTERNAL:
                    continue
                checked += 1
                if not os.path.exists(os.path.join(os.path.dirname(path), mod + ".py")):
                    missing.append("%s -> import %s" % (rel, mod))

    print("checked %d executed/imported references across %d harness files"
          % (checked, len(files())))
    for m in sorted(set(missing)):
        print("MISSING  " + m)
    print("ALL PRESENT" if not missing else "%d MISSING" % len(set(missing)))
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
