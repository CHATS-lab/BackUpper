import pytest

from durations import parse_duration


def test_minutes_and_seconds():
    assert parse_duration("1m05s") == 65


def test_plain_seconds():
    assert parse_duration("45s") == 45


def test_minutes_only():
    assert parse_duration("12m") == 720


def test_empty_rejected():
    with pytest.raises(ValueError):
        parse_duration("  ")
