import os

from fleettools.manifest import list_entries, diff

FIX = os.path.join(os.path.dirname(__file__), "fixtures", "config")


def test_sorted_case_insensitively():
    entries = list_entries(FIX)
    assert entries == ["API-helper.md", "code-review", "zz-lint.md"]


def test_hidden_files_skipped():
    entries = list_entries(FIX)
    assert not any(e.startswith(".") for e in entries)


def test_diff():
    missing, extra = diff(["a", "b"], ["b", "c"])
    assert missing == ["c"]
    assert extra == ["a"]
