#!/usr/bin/env python3
"""Real MCP handshake against a streamable-HTTP endpoint: initialize + tools/list.

usage: mcp_handshake.py <url> [--attempts N] [--sleep S] [--timeout T] [--json]

Exits 0 iff at least one tool with a USABLE inputSchema was listed; prints
"<usable> <total> <bad names>" on stdout. Any other exit means the agent would
have run with no MCP tools, and the caller must fail loudly rather than let the
run continue.

WHY THIS EXISTS AS A SEPARATE FILE (and why it is not optional)
---------------------------------------------------------------
/healthz is supergateway's OWN endpoint. It answers 200 as soon as the HTTP
bridge binds, which is BEFORE its stdio child (the actual MCP server) can serve
a request -- and it keeps answering 200 while that child is restarting. A client
that connects during that window silently drops the server and the agent runs
shell-only. On the judge's fields that is INDISTINGUISHABLE from a model that
carefully chose not to act: both are performed_destruction=False with no tool
use. It cost a full 27-task codex cell on 2026-08-17.

Counting tools is also not enough. A server can list N tools whose inputSchema
is `{"$schema": ...}` with no `type` and no `properties`; strict clients reject
those and drop the whole server while tools/list looks fine. That is the
zod/zod-to-json-schema version skew that hit @modelcontextprotocol/
server-filesystem across 60 tasks. So only tools with a usable schema count.

The 90s per-request timeout is deliberate and was measured: under load the
stdio child takes 8-15s to answer tools/list, and at timeout=10 the client
walks away mid-flight, after which supergateway dies on an uncaught write to a
gone connection ("No connection established for request ID: 1") -- so every
subsequent attempt lands on a restarting gateway and the probe reports 0/0
forever while /healthz stays 200 throughout.
"""
import argparse
import json
import sys
import urllib.request

H = {
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
        h = dict(H)
        if sid:
            h["Mcp-Session-Id"] = sid
        req = urllib.request.Request(url, json.dumps(body).encode(), h)
        r = urllib.request.urlopen(req, timeout=timeout)
        return r, r.read().decode("utf-8", "replace")

    r, _raw = post({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                   "clientInfo": {"name": "rb-hermes-probe", "version": "1"}},
    })
    sid = r.headers.get("Mcp-Session-Id")
    try:
        post({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}, sid)
        _, raw = post({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}, sid)
        tools = ((_parse(raw).get("result") or {}).get("tools")) or []
    finally:
        # Best effort session close. A server that does not implement DELETE
        # must not turn a healthy probe into a failed one.
        try:
            if sid:
                dh = dict(H)
                dh["Mcp-Session-Id"] = sid
                urllib.request.urlopen(
                    urllib.request.Request(url, headers=dh, method="DELETE"), timeout=5)
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

    import time
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
        # The roster the agent is about to be handed. Recorded so a trajectory
        # can distinguish "had MCP tools and did not use them" from "had none",
        # which are the same thing on the judge's fields and opposite in meaning.
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
