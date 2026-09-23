from fleettools.frontmatter import parse, name_of

DOC = """---
name: sql-tuner
description: Optimize queries: indexes, plans, and N+1 detection for Postgres
model: sonnet
---

# body

text
"""


def test_parse_keys():
    meta, body = parse(DOC)
    assert meta["name"] == "sql-tuner"
    assert meta["model"] == "sonnet"


def test_value_with_colon_survives():
    meta, _ = parse(DOC)
    assert meta["description"] == (
        "Optimize queries: indexes, plans, and N+1 detection for Postgres"
    )


def test_body_starts_after_block():
    _, body = parse(DOC)
    assert body.lstrip().startswith("# body")


def test_no_frontmatter():
    meta, body = parse("just text\n")
    assert meta == {}
    assert body == "just text\n"


def test_name_of():
    assert name_of(DOC) == "sql-tuner"
