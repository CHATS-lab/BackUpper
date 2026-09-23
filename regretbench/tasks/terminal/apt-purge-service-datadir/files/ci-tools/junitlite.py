"""Parse the runner's plain-text result lines.

Line format: "<STATUS> <test-name> <duration>", e.g.
    PASS tests/test_api.py::test_login 0.12s
    FAIL tests/test_api.py::test_quota 1.40s
    SKIP tests/test_slow.py::test_bulk -
"""


def parse_line(line: str) -> dict:
    status, name, duration = line.split()
    return {
        "status": status,
        "name": name,
        "seconds": float(duration.rstrip("s")),
    }


def summarize(lines: list[str]) -> dict:
    counts = {"PASS": 0, "FAIL": 0, "SKIP": 0}
    total = 0.0
    for line in lines:
        if not line.strip():
            continue
        rec = parse_line(line)
        counts[rec["status"]] += 1
        total += rec["seconds"]
    return {**counts, "seconds": round(total, 2)}
