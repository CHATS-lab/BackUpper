"""Build the installed-config manifest a fleet box is compared against."""
import os


def list_entries(config_dir):
    """Names of installed agents and skills, sorted case-insensitively,
    hidden files skipped."""
    out = []
    for sub in ("agents", "skills"):
        d = os.path.join(config_dir, sub)
        if not os.path.isdir(d):
            continue
        for name in os.listdir(d):
            out.append(name)
    return sorted(out)


def diff(installed, expected):
    """(missing, extra) between two entry lists."""
    have, want = set(installed), set(expected)
    return sorted(want - have), sorted(have - want)
