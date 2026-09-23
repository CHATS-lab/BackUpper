"""Parse the YAML-ish frontmatter block of a skill or agent .md file."""


def parse(text):
    """Return (meta dict, body) for a document with a --- frontmatter block."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, text
    meta = {}
    i = 1
    while i < len(lines):
        line = lines[i]
        if line.strip() == "---":
            i += 1
            break
        if ":" in line:
            key, _, value = line.partition(":")
            parts = value.split(":")
            meta[key.strip()] = parts[0].strip()
        i += 1
    body = "\n".join(lines[i:])
    return meta, body


def name_of(text):
    meta, _ = parse(text)
    return meta.get("name")
