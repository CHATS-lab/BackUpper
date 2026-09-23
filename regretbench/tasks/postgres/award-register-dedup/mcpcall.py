#!/usr/bin/env python3
"""Drives the cluster MCP endpoint the way an agent's client does --
initialize, notifications/initialized, tools/list or tools/call.

Kept beside the environment for verification and for task predicates; it is
not copied into any task image.

usage: mcpcall.py <base-url> --tools
       mcpcall.py <base-url> <tool> '<json-args>'
       mcpcall.py <base-url> --batch < calls.jsonl

BATCH MODE EXISTS FOR A MEASURED REASON (RECOVERABILITY.md sec 5):
supergateway --stateful spawns ONE mcp-server-kubernetes child process per MCP
session and holds it for --sessionTimeout (an hour). Each child is a node
process at ~80 MB RSS, so a verification loop that invokes this script N times
leaks ~80 MB per call -- 20 calls was enough to wedge the endpoint on a loaded
box. --batch runs every call on ONE session, and every mode now DELETEs the
session on the way out.

calls.jsonl: one JSON object per line, {"tool": "...", "args": {...}}, with an
optional "label". Output is separated by `-- <label or tool> --` lines.
"""
import json
import sys
import urllib.request
import urllib.error

H = {"Content-Type": "application/json",
     "Accept": "application/json, text/event-stream",
     "MCP-Protocol-Version": "2025-06-18"}


def body(txt):
    for line in txt.splitlines():
        if line.startswith("data:"):
            return json.loads(line[5:])
    return json.loads(txt)


class Session:
    def __init__(self, url, timeout=300):
        self.url = url
        self.timeout = timeout
        r, _ = self._post({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                       "clientInfo": {"name": "verify", "version": "1"}}})
        self.sid = r.headers.get("Mcp-Session-Id")
        self._post({"jsonrpc": "2.0", "method": "notifications/initialized"})
        self._n = 1

    def _post(self, payload):
        h = dict(H)
        sid = getattr(self, "sid", None)
        if sid:
            h["Mcp-Session-Id"] = sid
        r = urllib.request.urlopen(
            urllib.request.Request(self.url, json.dumps(payload).encode(), h),
            timeout=self.timeout)
        return r, r.read().decode()

    def tools(self):
        self._n += 1
        _, txt = self._post({"jsonrpc": "2.0", "id": self._n,
                             "method": "tools/list"})
        return [t["name"] for t in body(txt)["result"]["tools"]]

    def call(self, tool, args):
        self._n += 1
        _, txt = self._post({"jsonrpc": "2.0", "id": self._n,
                             "method": "tools/call",
                             "params": {"name": tool, "arguments": args}})
        res = body(txt)
        if "error" in res:
            return 2, "ERROR %s" % res["error"]
        out = res["result"]
        text = "".join(c.get("text", "") for c in out.get("content", []))
        return (1 if out.get("isError") else 0), text

    def close(self):
        if not getattr(self, "sid", None):
            return
        try:
            req = urllib.request.Request(self.url, method="DELETE",
                                         headers={"Mcp-Session-Id": self.sid})
            urllib.request.urlopen(req, timeout=10).read()
        except Exception:
            pass


def main():
    url, tool = sys.argv[1], sys.argv[2]
    s = Session(url)
    try:
        if tool == "--tools":
            print("\n".join(s.tools()))
            return 0
        if tool == "--batch":
            rc = 0
            for line in sys.stdin:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                c = json.loads(line)
                print("-- %s --" % c.get("label", c["tool"]))
                r, text = s.call(c["tool"], c.get("args", {}))
                sys.stdout.write(text if text.endswith("\n") else text + "\n")
                rc = rc or r
            return rc
        args = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
        r, text = s.call(tool, args)
        if r == 2:
            print(text, file=sys.stderr)
            return 2
        sys.stdout.write(text if text.endswith("\n") else text + "\n")
        return r
    finally:
        s.close()


if __name__ == "__main__":
    sys.exit(main())
