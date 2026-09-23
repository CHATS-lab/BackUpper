#!/usr/bin/env python3
"""Load a prompt from a markdown source file.

One file per prompt, in regretbench/prompts/ (harness judges and classifiers) or
backupper/prompts/ (the plugin; the same format, compiled into the plugin by
backupper/scripts/gen_prompts.mjs). Format:

    ---
    name: <file basename>
    loaded_from: <the code that sends it>
    used_in: <where it matters>
    ends_with_newline: true        # optional: the text ends with "\\n" (the file then
                                   # needs no trailing blank line, which editors strip)
    placeholders: [TOKEN, ...]     # every {{TOKEN}} in the body and its sections
    sections: [name, ...]          # optional named sections, in file order
    ---

    # <title>

    <body>

    <!-- section: <name> -->
    <optional fragment the code glues in>
    <!-- /section -->

The body runs from the blank line after the title to the first section marker (or
end of file); only the file's final newline is dropped. Bodies and sections never
start or end with a newline -- the code adds structural newlines -- so the files
survive editors that trim blank lines.

    from prompt_md import load_prompt, load_prompt_section
    RUBRIC = load_prompt("judge-main")                     # regretbench/prompts/judge-main.md
    BRIEFING = load_prompt("briefing-checker", plugin=True)  # backupper/prompts/briefing-checker.md
"""
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
PROMPTS_DIR = os.path.join(os.path.dirname(HERE), "prompts")                       # regretbench/prompts
PLUGIN_PROMPTS_DIR = os.path.join(os.path.dirname(os.path.dirname(HERE)), "backupper", "prompts")

_SECTION_OPEN = re.compile(r"^<!-- section: ([a-z0-9-]+) -->$")
_SECTION_CLOSE = "<!-- /section -->"


def prompt_path(name, plugin=False):
    return os.path.join(PLUGIN_PROMPTS_DIR if plugin else PROMPTS_DIR, name + ".md")


def _check(where, text):
    if text.startswith("\n") or text.endswith("\n"):
        raise ValueError("%s: text must not start or end with a newline" % where)
    return text


def parse_prompt_md(path):
    """-> {"name", "title", "meta", "body", "sections": {name: text}, "order": [...]}"""
    base = os.path.basename(path)[:-3]
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    if not text.startswith("---\n"):
        raise ValueError("%s: missing front-matter" % base)
    end = text.find("\n---\n", 4)
    if end < 0:
        raise ValueError("%s: unterminated front-matter" % base)
    meta = {}
    for line in text[4:end].split("\n"):
        m = re.match(r"^([a-z_]+):\s*(.*)$", line)
        if m:
            meta[m.group(1)] = m.group(2)
    if meta.get("name") != base:
        raise ValueError("%s: front-matter name %r != file name" % (base, meta.get("name")))
    rest = text[end + 5:]
    if not rest.startswith("\n# "):
        raise ValueError('%s: expected a blank line and a "# Title" line after the front-matter' % base)
    t_end = rest.index("\n", 1)
    title = rest[3:t_end]
    rest = rest[t_end + 1:]
    if not rest.startswith("\n"):
        raise ValueError("%s: expected a blank line after the title" % base)
    rest = rest[1:]
    if rest.endswith("\n"):
        rest = rest[:-1]                      # the file's final newline only
    lines = rest.split("\n")
    i = 0
    body_lines = []
    while i < len(lines) and not _SECTION_OPEN.match(lines[i]):
        body_lines.append(lines[i]); i += 1
    body = "\n".join(body_lines)
    if i < len(lines):
        body = body.rstrip("\n")              # blank line(s) before the first section
    _check("%s body" % base, body)
    if meta.get("ends_with_newline", "").strip().lower() == "true":
        body += "\n"
    sections, order = {}, []
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            i += 1; continue
        m = _SECTION_OPEN.match(line)
        if not m:
            raise ValueError("%s line %d: text outside a section after the main body" % (base, i + 1))
        name = m.group(1)
        if name in sections:
            raise ValueError("%s: duplicate section %s" % (base, name))
        start = i + 1
        i = start
        while i < len(lines) and lines[i] != _SECTION_CLOSE:
            i += 1
        if i >= len(lines):
            raise ValueError("%s: section %s is not closed" % (base, name))
        sections[name] = _check("%s section %s" % (base, name), "\n".join(lines[start:i]))
        order.append(name)
        i += 1
    declared = [s.strip() for s in meta.get("sections", "[]").strip("[]").split(",") if s.strip()]
    if declared != order:
        raise ValueError("%s: front-matter sections %s do not match the file's %s" % (base, declared, order))
    return {"name": base, "title": title, "meta": meta, "body": body, "sections": sections, "order": order}


def load_prompt(name, plugin=False):
    """The main body of regretbench/prompts/<name>.md (or backupper/prompts/ with plugin=True)."""
    return parse_prompt_md(prompt_path(name, plugin))["body"]


def load_prompt_section(name, section, plugin=False):
    return parse_prompt_md(prompt_path(name, plugin))["sections"][section]


def render(text, **vars):
    """Replace {{KEY}} tokens (single pass; unknown tokens are left alone)."""
    return re.sub(r"\{\{([A-Z0-9_]+)\}\}", lambda m: str(vars[m.group(1)]) if m.group(1) in vars else m.group(0), text)


if __name__ == "__main__":
    import sys
    for arg in sys.argv[1:]:
        d = parse_prompt_md(arg)
        print("%s: %d chars, sections: %s" % (d["name"], len(d["body"]), ", ".join(d["order"]) or "-"))
