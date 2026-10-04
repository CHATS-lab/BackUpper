#!/usr/bin/env python3
"""Anthropic-Messages relay for the Claude Code runner (harness/run_task_claude.sh,
RB_CLAUDE_AUTH=gateway).

Forwards `POST /v1/messages` (streaming or not) to an upstream and injects the
upstream credential from its own environment. It runs in a sidecar container
that holds the key, so the task container only learns the gateway's bridge URL
and a per-run nonce; the credential never enters the task image or a run artifact.

One JSON line per request/response is logged to --log: model, message count,
the tool names the client advertised (evidence that the MCP tools registered),
and token usage when the upstream reports it. Credentials are never logged.

`POST /v1/messages/count_tokens` is answered locally with an estimate, because
OpenRouter's Anthropic-compatible surface does not implement it.

Usage:
  claude_gateway.py --mode relay --listen 0.0.0.0:8900 --token NONCE \
      --upstream https://openrouter.ai/api/v1 --key-env RB_UPSTREAM_KEY \
      [--prefix-anthropic] [--log /gw/gateway.jsonl]
"""
import argparse
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ARGS = None
LOCK = threading.Lock()
STATE = {"requests": 0}


def logline(rec):
    rec["t"] = round(time.time(), 3)
    line = json.dumps(rec, default=str)
    with LOCK:
        if ARGS.log:
            with open(ARGS.log, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        else:
            sys.stderr.write(line + "\n")
            sys.stderr.flush()


def est_tokens(body):
    """Rough chars/4 estimate over every string field, for the count_tokens shim."""
    n = 0
    stack = [body.get("system"), body.get("messages"), body.get("tools")]
    while stack:
        o = stack.pop()
        if isinstance(o, str):
            n += len(o)
        elif isinstance(o, dict):
            stack.extend(o.values())
        elif isinstance(o, list):
            stack.extend(o)
    return max(1, n // 4)


def tool_names(body):
    out = []
    for t in body.get("tools") or []:
        if not isinstance(t, dict):
            continue
        if t.get("name"):
            out.append(t["name"])                       # anthropic shape
        elif isinstance(t.get("function"), dict) and t["function"].get("name"):
            out.append(t["function"]["name"])           # openai chat shape
    return out


# --------------------------------------------------------------------------- #
# relay
# --------------------------------------------------------------------------- #
def upstream_model(m):
    if ARGS.prefix_anthropic and m and "/" not in m:
        return "anthropic/" + m
    return m


# Some upstreams reject unknown top-level fields with a 400 "<field>: Extra inputs
# are not permitted". The field is read from the error, stripped, and remembered
# so later requests omit it.
STRIP = set()
EXTRA_RE = re.compile(r'([A-Za-z_][A-Za-z0-9_]*)[A-Za-z0-9_.]*: Extra inputs are not permitted')


def relay(body, path, stream):
    key = os.environ.get(ARGS.key_env, "")
    if not key:
        raise RuntimeError("gateway: upstream key env %s is empty" % ARGS.key_env)
    body = dict(body)
    body["model"] = upstream_model(body.get("model", ""))
    for f in STRIP:
        body.pop(f, None)
    url = ARGS.upstream.rstrip("/") + path
    # The client's raw path already starts with /v1 and an upstream base URL may
    # also end in /v1, so collapse the resulting duplicate segment.
    if url.count("/v1/v1/"):
        url = url.replace("/v1/v1/", "/v1/", 1)
    hdrs = {"content-type": "application/json",
            "authorization": "Bearer " + key,
            "x-api-key": key,
            # Some CDNs reject urllib's default user agent with a 403.
            "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                          "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "anthropic-version": "2023-06-01"}
    # Each 400 names one field, so allow several rounds.
    for _ in range(8):
        req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=hdrs)
        try:
            return urllib.request.urlopen(req, timeout=ARGS.upstream_timeout)
        except urllib.error.HTTPError as e:
            if e.code != 400:
                raise
            txt = e.read().decode("utf-8", "replace")
            m = EXTRA_RE.search(txt)
            if not m or m.group(1) not in body:
                # Re-raise with the already-consumed error body restored.
                e2 = urllib.error.HTTPError(url, e.code, e.reason, e.headers, None)
                e2.read = lambda t=txt: t.encode()
                raise e2
            field = m.group(1)
            STRIP.add(field)
            body.pop(field, None)
            logline({"ev": "strip_field", "field": field})
    raise RuntimeError("gateway: stripped 8 fields and upstream still refuses")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "rb-claude-gateway"

    def log_message(self, *a):  # silence stderr access log
        pass

    def _send(self, code, payload, ctype="application/json"):
        blob = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(blob)))
        self.end_headers()
        self.wfile.write(blob)

    def do_GET(self):
        if self.path.rstrip("/") in ("/healthz", ""):
            self._send(200, {"ok": True, "mode": ARGS.mode})
        else:
            self._send(404, {"error": "not found"})

    def _authorized(self):
        if not ARGS.token:
            return True
        got = (self.headers.get("authorization", "").removeprefix("Bearer ").strip()
               or self.headers.get("x-api-key", "").strip())
        return got == ARGS.token

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            self._send(400, {"error": "bad json"})
            return
        if not self._authorized():
            logline({"ev": "unauthorized", "path": self.path})
            self._send(401, {"type": "error",
                             "error": {"type": "authentication_error",
                                       "message": "bad gateway token"}})
            return
        with LOCK:
            STATE["requests"] += 1
            seq = STATE["requests"]
        path = self.path.split("?")[0]

        if path.endswith("/count_tokens"):
            self._send(200, {"input_tokens": est_tokens(body)})
            return
        if not path.endswith("/messages"):
            self._send(404, {"error": "not found"})
            return

        logline({"ev": "request", "seq": seq, "mode": ARGS.mode,
                 "model": body.get("model"), "stream": bool(body.get("stream")),
                 "n_messages": len(body.get("messages") or []),
                 "system_chars": len(json.dumps(body.get("system") or "")),
                 "n_tools": len(body.get("tools") or []),
                 "tools": tool_names(body)})

        stream = bool(body.get("stream"))
        try:
            resp = relay(body, "/messages", stream)
        except urllib.error.HTTPError as e:
            err = e.read()
            logline({"ev": "upstream_error", "seq": seq, "code": e.code,
                     "body": err[:800].decode("utf-8", "replace")})
            self._send(e.code, err)
            return
        except Exception as e:  # noqa: BLE001
            logline({"ev": "upstream_exception", "seq": seq, "err": repr(e)[:400]})
            self._send(502, {"type": "error", "error": {"type": "api_error",
                                                        "message": "gateway upstream failure"}})
            return

        if not stream:
            blob = resp.read()
            try:
                j = json.loads(blob)
                logline({"ev": "response", "seq": seq, "usage": j.get("usage"),
                         "stop_reason": j.get("stop_reason")})
            except json.JSONDecodeError:
                pass
            self._send(resp.status, blob)
            return

        self.send_response(resp.status)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.send_header("transfer-encoding", "chunked")
        self.end_headers()
        tail = b""
        while True:
            chunk = resp.read(4096)
            if not chunk:
                break
            tail = (tail + chunk)[-4096:]
            self.wfile.write(b"%x\r\n" % len(chunk) + chunk + b"\r\n")
        self.wfile.write(b"0\r\n\r\n")
        # usage/cost ride on the final message_delta / message_stop events
        for ln in tail.split(b"\n"):
            if ln.startswith(b"data: ") and b"usage" in ln:
                try:
                    j = json.loads(ln[6:])
                except json.JSONDecodeError:
                    continue
                if j.get("type") in ("message_delta", "message_stop"):
                    logline({"ev": "response", "seq": seq, "usage": j.get("usage"),
                             "stop_reason": (j.get("delta") or {}).get("stop_reason")})


def main():
    global ARGS
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=("relay",), default="relay")
    ap.add_argument("--listen", default="0.0.0.0:8900")
    ap.add_argument("--token", default="")
    ap.add_argument("--log", default="")
    ap.add_argument("--upstream", default="https://openrouter.ai/api/v1")
    ap.add_argument("--key-env", default="RB_UPSTREAM_KEY")
    ap.add_argument("--prefix-anthropic", action="store_true",
                    help="rewrite bare model ids to anthropic/<id> (OpenRouter)")
    ap.add_argument("--upstream-timeout", type=int, default=900)
    ARGS = ap.parse_args()
    host, _, port = ARGS.listen.rpartition(":")
    srv = ThreadingHTTPServer((host or "0.0.0.0", int(port)), Handler)
    logline({"ev": "start", "mode": ARGS.mode, "listen": ARGS.listen,
             "upstream": ARGS.upstream if ARGS.mode == "relay" else None})
    srv.serve_forever()


if __name__ == "__main__":
    main()
