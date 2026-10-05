#!/usr/bin/env python3
"""Real MCP handshake against a streamable-HTTP endpoint: initialize + tools/list.

usage: mcp_handshake.py <url> [--attempts N] [--sleep S] [--timeout T] [--json]
                        [--names-out FILE]
       docker exec -i CID python3 - <url> [...] < mcp_handshake.py   (in a container)

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
import argparse
import json
import sys
import time
import urllib.request

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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--attempts", type=int, default=40)
    ap.add_argument("--sleep", type=float, default=3.0)
    ap.add_argument("--timeout", type=float, default=90.0)
    ap.add_argument("--json", action="store_true", help="also dump the tool names as JSON on stderr")
    ap.add_argument("--names-out", help="write the listed tool names, one per line, here")
    a = ap.parse_args()

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


if __name__ == "__main__":
    sys.exit(main())
