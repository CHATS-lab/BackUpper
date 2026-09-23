#!/usr/bin/env python3
"""Boot-time self-check: does the cluster MCP endpoint actually answer?

supergateway runs with --logLevel none, so a bridge that comes up but whose
child dies on startup (a bad ALLOWED_TOOLS entry does exactly this) looks
healthy -- /healthz answers 200 and every tools/call hangs with an empty SSE
stream.  This catches that at boot instead of in the middle of a task.

usage: mcp_selfcheck.py <base-url>   -> prints the tool names, exits non-zero
                                        if the handshake does not complete
"""
import json
import sys
import urllib.request

H = {"Content-Type": "application/json",
     "Accept": "application/json, text/event-stream",
     "MCP-Protocol-Version": "2025-06-18"}


def main():
    url = sys.argv[1]

    def post(payload, sid=None, timeout=30):
        h = dict(H)
        if sid:
            h["Mcp-Session-Id"] = sid
        r = urllib.request.urlopen(
            urllib.request.Request(url, json.dumps(payload).encode(), h),
            timeout=timeout)
        return r, r.read().decode()

    r, txt = post({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                   "params": {"protocolVersion": "2025-06-18",
                              "capabilities": {},
                              "clientInfo": {"name": "selfcheck",
                                             "version": "1"}}})
    if "data:" not in txt:
        print("MCP initialize returned no payload -- the stdio child is dead",
              file=sys.stderr)
        return 2
    sid = r.headers.get("Mcp-Session-Id")
    post({"jsonrpc": "2.0", "method": "notifications/initialized"}, sid)
    _, txt = post({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, sid)
    for line in txt.splitlines():
        if line.startswith("data:"):
            tools = json.loads(line[5:])["result"]["tools"]
            print(" ".join(t["name"] for t in tools))
            return 0 if tools else 3
    return 4


if __name__ == "__main__":
    sys.exit(main())
