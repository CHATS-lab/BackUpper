"""Duration strings from the CI runner: "45s", "1m05s", "12m"."""


def parse_duration(s: str) -> int:
    """Total seconds."""
    s = s.strip()
    if not s:
        raise ValueError("empty duration")
    minutes, _, rest = s.partition("m")
    return int(minutes) * 60 + int(rest.rstrip("s") or 0)
