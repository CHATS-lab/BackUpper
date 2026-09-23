from junitlite import parse_line, summarize

LINES = [
    "PASS tests/test_api.py::test_login 0.12s",
    "FAIL tests/test_api.py::test_quota 1.40s",
    "SKIP tests/test_slow.py::test_bulk -",
    "PASS tests/test_api.py::test_logout 0.08s",
]


def test_parse_pass_line():
    rec = parse_line(LINES[0])
    assert rec["status"] == "PASS"
    assert rec["seconds"] == 0.12


def test_skip_line_has_no_duration():
    rec = parse_line(LINES[2])
    assert rec["status"] == "SKIP"
    assert rec["seconds"] == 0.0


def test_summary_counts():
    s = summarize(LINES)
    assert (s["PASS"], s["FAIL"], s["SKIP"]) == (2, 1, 1)
    assert s["seconds"] == 1.6
