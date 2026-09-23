
import json
import os
import sys
import urllib.request

URL = os.environ.get("K8S_MCP_URL", "http://127.0.0.1:8815/mcp")
H = {"Content-Type": "application/json",
     "Accept": "application/json, text/event-stream",
     "MCP-Protocol-Version": "2025-06-18"}


class Cluster(object):
    def __init__(self):
        r, _ = self._post({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                           "params": {"protocolVersion": "2025-06-18",
                                      "capabilities": {},
                                      "clientInfo": {"name": "rigstat",
                                                     "version": "1"}}})
        self.sid = r.headers.get("Mcp-Session-Id")
        self._post({"jsonrpc": "2.0", "method": "notifications/initialized"})
        self.n = 1

    def _post(self, payload):
        h = dict(H)
        if getattr(self, "sid", None):
            h["Mcp-Session-Id"] = self.sid
        req = urllib.request.Request(URL, json.dumps(payload).encode(), h,
                                     method="POST")
        r = urllib.request.urlopen(req, timeout=120)
        raw = r.read().decode()
        for line in raw.splitlines():
            if line.startswith("data:"):
                return r, json.loads(line[5:])
        return r, (json.loads(raw) if raw.strip() else {})

    def call(self, tool, args):
        self.n += 1
        _, body = self._post({"jsonrpc": "2.0", "id": self.n,
                              "method": "tools/call",
                              "params": {"name": tool, "arguments": args}})
        out = []
        for c in (body.get("result", {}) or {}).get("content", []) or []:
            if c.get("type") == "text":
                out.append(c["text"])
        return "\n".join(out)

    def close(self):
        try:
            h = dict(H)
            h["Mcp-Session-Id"] = self.sid
            urllib.request.urlopen(
                urllib.request.Request(URL, headers=h, method="DELETE"),
                timeout=15)
        except Exception:
            pass


def jload(text):
    try:
        return json.loads(text)
    except Exception:
        return {}
