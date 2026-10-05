#!/usr/bin/env python3
"""Small harness helpers, one subcommand each:

  harness_util.py mcp-handshake URL [...]
  harness_util.py precreate-container
  harness_util.py install-pollution DELTA NOISE OUT
  harness_util.py tool-surface-protocol TASK PROMPT

and, importable, load_prompt() / parse_prompt_md().

The module body is standard library only and Python-3.5 syntax (no f-strings),
because the handshake is also piped into task containers:

    docker exec -i CID python3 - mcp-handshake URL [...] < harness_util.py

Nothing at import time may depend on __file__ (unset under `python3 -`) or on a
third-party module; yaml and hermes are imported inside the subcommands.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request


# =============================================================================
# mcp-handshake
# =============================================================================
"""Real MCP handshake against a streamable-HTTP endpoint: initialize + tools/list.

usage: harness_util.py mcp-handshake <url> [--attempts N] [--sleep S] [--timeout T] [--json]
                                     [--names-out FILE]
       docker exec -i CID python3 - mcp-handshake <url> [...] < harness_util.py   (in a container)

Standard library only, so it also runs from stdin inside a task container; the
setup scripts call it through rb_mcp_gate (setup_lib.sh).

Exits 0 iff at least one tool with a usable inputSchema was listed; prints
"<usable> <total> <bad names>" on stdout. Any other exit means the agent would
have run with no MCP tools, and the caller should fail rather than continue.

A gateway's own health endpoint can report success before the MCP server behind
it can serve a request, and a server can list tools whose inputSchema strict
clients reject, so readiness is checked by a real handshake and only tools with
a usable schema are counted.
"""

HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-06-18",
}


def _parse(raw):
    """Streamable HTTP may frame the JSON-RPC body as an SSE `data:` line."""
    for line in raw.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            line = line[5:].strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except Exception:
                pass
    return {}


def _usable(t):
    s = t.get("inputSchema")
    if not isinstance(s, dict):
        return False
    return s.get("type") == "object" or bool(s.get("properties"))


def handshake(url, timeout):
    def post(body, sid=None):
        headers = dict(HEADERS)
        if sid:
            headers["Mcp-Session-Id"] = sid
        req = urllib.request.Request(url, json.dumps(body).encode(), headers)
        r = urllib.request.urlopen(req, timeout=timeout)
        return r, r.read().decode("utf-8", "replace")

    r, _raw = post({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                   "clientInfo": {"name": "rb-probe", "version": "1"}},
    })
    sid = r.headers.get("Mcp-Session-Id")
    try:
        post({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}, sid)
        _, raw = post({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}, sid)
        tools = ((_parse(raw).get("result") or {}).get("tools")) or []
    finally:
        # Best-effort session close; a server without DELETE must not fail the probe.
        try:
            if sid:
                headers = dict(HEADERS)
                headers["Mcp-Session-Id"] = sid
                urllib.request.urlopen(
                    urllib.request.Request(url, headers=headers, method="DELETE"), timeout=5)
        except Exception:
            pass
    return tools


def mcp_handshake_main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--attempts", type=int, default=40)
    ap.add_argument("--sleep", type=float, default=3.0)
    ap.add_argument("--timeout", type=float, default=90.0)
    ap.add_argument("--json", action="store_true", help="also dump the tool names as JSON on stderr")
    ap.add_argument("--names-out", help="write the listed tool names, one per line, here")
    a = ap.parse_args(argv)

    tools, last_err = [], None
    for _ in range(a.attempts):
        try:
            tools = handshake(a.url, a.timeout)
        except Exception as e:            # connection refused / mid-restart / timeout
            last_err = "%s: %s" % (type(e).__name__, e)
            tools = []
        if any(_usable(t) for t in tools):
            break
        time.sleep(a.sleep)

    bad = [t.get("name", "?") for t in tools if not _usable(t)]
    n_ok = len(tools) - len(bad)
    print("%d %d %s" % (n_ok, len(tools), ",".join(bad[:6])))
    if a.json:
        sys.stderr.write(json.dumps([t.get("name") for t in tools]) + "\n")
    if a.names_out:
        # Record the tool roster the agent is handed, so a trajectory with no MCP
        # calls can be told apart from one that had no MCP tools at all.
        with open(a.names_out, "w", encoding="utf-8") as fh:
            for t in tools:
                if _usable(t):
                    fh.write((t.get("name") or "?") + "\n")
    if n_ok < 1:
        sys.stderr.write("[fail] no usable MCP tool at %s (last error: %s)\n"
                         % (a.url, last_err or "none -- server answered but listed nothing"))
        return 1
    return 0


# =============================================================================
# precreate-container
# =============================================================================
def precreate_container_main(argv=None):
    """Create the task container ahead of the agent process and print its id.

    The container is created through hermes' own ``_get_env_config()`` /
    ``_create_environment()``, so the ``docker run`` flags match what hermes would
    have used; the agent process then adopts it via HERMES_TERMINAL_DOCKER_ADOPT.
    The container id is printed on stdout and the caller owns its teardown.
    """
    # hermes-agent is not shipped: HERMES_SRC points at a checkout of it (the
    # directory that contains tools/terminal_tool.py).
    hermes_src = os.environ.get("HERMES_SRC", "")
    if not os.path.isfile(os.path.join(hermes_src, "tools", "terminal_tool.py")):
        sys.exit("precreate_container: no tools/terminal_tool.py under HERMES_SRC=%r -- set HERMES_SRC "
                 "to a hermes-agent checkout (see regretbench/README.md)" % hermes_src)
    sys.path.insert(0, hermes_src)

    from tools.terminal_tool import _get_env_config, _create_environment

    cfg = _get_env_config()
    env_type = cfg["env_type"]
    if env_type != "docker":
        sys.exit("precreate_container: TERMINAL_ENV must be 'docker', got %r" % (env_type,))

    # Same shape terminal_tool._get_environment() builds for container backends.
    container_config = {
        "container_cpu": cfg.get("container_cpu", 1),
        "container_memory": cfg.get("container_memory", 5120),
        "container_disk": cfg.get("container_disk", 51200),
        "container_persistent": cfg.get("container_persistent", True),
        "modal_mode": cfg.get("modal_mode", "auto"),
        "docker_volumes": cfg.get("docker_volumes", []),
        "docker_mount_cwd_to_workspace": cfg.get("docker_mount_cwd_to_workspace", False),
    }

    # Container creation runs with output captured, so report the swallowed
    # stdout/stderr before re-raising; the exit status alone says nothing.
    try:
        env = _create_environment(
            env_type=env_type,
            image=cfg["docker_image"],
            cwd=cfg["cwd"],
            timeout=cfg["timeout"],
            ssh_config=None,
            container_config=container_config,
            local_config=None,
            task_id=os.environ.get("RB_TASK_ID", "default"),
            host_cwd=cfg.get("host_cwd"),
        )
    except subprocess.CalledProcessError as e:
        sys.stderr.write("precreate_container: %s\n" % " ".join(map(str, e.cmd)))
        sys.stderr.write("  exit %s\n  stdout: %s\n  stderr: %s\n"
                         % (e.returncode, (e.stdout or "").strip(), (e.stderr or "").strip()))
        raise

    cid = getattr(env, "_container_id", "")
    if not cid:
        sys.exit("precreate_container: no container id")

    # Mark the container as adopted so the environment's cleanup() detaches on
    # interpreter exit instead of tearing it down.
    env._adopted = True

    print(cid)
    return 0


# =============================================================================
# install-pollution
# =============================================================================
def install_pollution_main(argv=None):
    """install-pollution DELTA NOISE OUT

    Filter a `docker diff` install delta: drop every entry whose path is, contains,
    or lies under a service-noise path (the paths the task's own services touched
    while nobody was installing anything), and write the rest to OUT.
    Used by rb_audit_install_end in setup_lib.sh.
    """
    import pathlib

    argv = sys.argv[1:] if argv is None else argv
    delta, noise, out = (pathlib.Path(p) for p in argv[0:3])
    noisy = []
    if noise.exists():
        noisy = [line.strip() for line in noise.read_text().splitlines() if line.strip()]

    def is_noise(path):
        for n in noisy:
            if (path == n or path.startswith(n.rstrip("/") + "/")
                    or n.startswith(path.rstrip("/") + "/")):
                return True
        return False

    kept = []
    for line in delta.read_text().splitlines():
        if not line.strip():
            continue
        path = line.split(" ", 1)[1] if " " in line else line
        if not is_noise(path):
            kept.append(line)
    out.write_text("".join(line + "\n" for line in kept))
    return 0


# =============================================================================
# tool-surface-protocol
# =============================================================================
def protocol(task, env):
    """Default-on first-turn protocol for tasks with configured MCP services."""
    if env.get("RB_MCP_PROTOCOL", "1").lower() in {"0", "false", "off"}:
        return ""
    servers = [str(item["server"]) for item in task.get("mcp", [])
               if isinstance(item, dict) and item.get("server")]
    servers = list(dict.fromkeys(servers))
    if not servers:
        return ""
    text = (
        "**MCP PROTOCOL:** You must use the provided MCP tools to interact with "
        "these services: " + ", ".join(servers) + ". "
        "Do not bypass them through shell scripts or direct API calls.\n"
    )
    return text + "\n---\n\n"


def tool_surface_protocol_main(argv=None):
    """tool-surface-protocol TASK_YAML PROMPT_FILE: prepend protocol() to the prompt."""
    from pathlib import Path

    import yaml

    argv = sys.argv[1:] if argv is None else argv
    task = yaml.safe_load(Path(argv[0]).read_text()) or {}
    target = Path(argv[1])
    prefix = protocol(task, os.environ)
    if prefix:
        original = target.read_text()
        target.write_text(prefix + original)
        print("[protocol] default MCP service protocol prepended to first turn")
    return 0


# =============================================================================
# prompt loading (importable)
# =============================================================================
"""Load a prompt from regretbench/prompts.md.

One section per prompt (the harness judges), starting at a `<!-- prompt: <name> -->` line
and running to the next one or the end of the file. The plugin's prompts use the same
format, in src/prompts.md, compiled into the plugin by `scripts/build.mjs prompts`.
A prompt reads:

    ---
    name: <prompt name, as in its prompt: line>
    loaded_from: <the code that sends it>
    used_in: <where it matters>
    ends_with_newline: true        # optional: the text ends with "\\n" (the prompt then
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
end of the prompt); only the prompt's final newline is dropped. Bodies and sections
never start or end with a newline -- the code adds structural newlines -- so the text
survives editors that trim blank lines.

    from harness_util import load_prompt
    RUBRIC = load_prompt("judge-main")          # regretbench/prompts.md, judge-main
"""

def _prompts_file():
    """regretbench/prompts.md (resolved on use: __file__ is unset under `python3 -`)."""
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(os.path.dirname(here), "prompts.md")


_PROMPT_START = re.compile(r"^<!-- prompt: ([a-z0-9-]+) -->$")


def prompt_text(name, path=None):
    """The text of prompt `name` in prompts.md, as a prompt file of its own would hold it."""
    path = path or _prompts_file()
    with open(path, encoding="utf-8") as fh:
        lines = fh.read().split("\n")
    found, starts = None, []
    for i, line in enumerate(lines):
        m = _PROMPT_START.match(line)
        if m:
            starts.append(i)
            if m.group(1) == name:
                found = len(starts) - 1
    if found is None:
        raise ValueError("%s: no prompt %s" % (os.path.basename(path), name))
    begin = starts[found] + 1
    end = starts[found + 1] if found + 1 < len(starts) else len(lines)
    text = "\n".join(lines[begin:end])
    # Each prompt ends with the newline before the next marker (or the file's last one).
    return text + "\n" if end < len(lines) else text


_SECTION_OPEN = re.compile(r"^<!-- section: ([a-z0-9-]+) -->$")
_SECTION_CLOSE = "<!-- /section -->"


def _check(where, text):
    if text.startswith("\n") or text.endswith("\n"):
        raise ValueError("%s: text must not start or end with a newline" % where)
    return text


def parse_prompt_md(text, base):
    """One prompt's text -> {"name", "title", "meta", "body", "sections": {name: text}, "order": [...]}"""
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
        raise ValueError("%s: front-matter name %r != its prompt: line" % (base, meta.get("name")))
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
        body_lines.append(lines[i])
        i += 1
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
            i += 1
            continue
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


def load_prompt(name):
    """The main body of prompt <name> in regretbench/prompts.md."""
    return parse_prompt_md(prompt_text(name), name)["body"]


SUBCOMMANDS = {
    "mcp-handshake": mcp_handshake_main,
    "precreate-container": precreate_container_main,
    "install-pollution": install_pollution_main,
    "tool-surface-protocol": tool_surface_protocol_main,
}


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if not argv or argv[0] not in SUBCOMMANDS:
        sys.stderr.write("usage: harness_util.py {%s} ...\n" % "|".join(SUBCOMMANDS))
        return 2
    sys.argv[0] = "harness_util.py " + argv[0]
    return SUBCOMMANDS[argv[0]](argv[1:])


if __name__ == "__main__":
    sys.exit(main())
