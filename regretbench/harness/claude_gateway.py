#!/usr/bin/env python3
"""Anthropic-Messages endpoint for the Claude Code runner (harness/run_task_claude.sh).

Three modes, one wire protocol (`POST /v1/messages`, streaming or not):

  relay  Forwards to a real upstream, injecting the upstream credential from its
         OWN environment. It is meant to run in a SIDECAR container that holds
         the key; the task container -- which is where the untrusted agent runs
         destructive commands -- only ever learns this gateway's bridge URL and
         a per-run nonce. The credential is therefore never in the blast radius,
         never in the task image, and never in a run artifact.

  translate  Same sidecar posture, but the upstream speaks OpenAI
         **chat/completions** instead of Anthropic Messages. Requests are
         translated on the way in and the (streaming) response is translated
         back on the way out, so Claude Code can drive gemini / deepseek /
         gpt-5.6-terra / gpt-5.6-sol. See the block comment above
         `anthropic_to_chat` for why this exists and what was measured.

  mock   Serves a scripted sequence of assistant turns with no upstream and no
         credential at all. This exists so the ENTIRE pipeline (install, MCP
         registration, prompt fidelity, transcript capture, trajectory
         normalization, judge) can be proven without a live model call.

Either way the gateway logs one JSON line per request/response to --log:
model, message count, the TOOL NAMES the client advertised (which is how we
prove from the outside that the MCP tools actually registered), and token usage
and cost when the upstream reports them. Credentials are never logged.

`POST /v1/messages/count_tokens` is answered LOCALLY with a cheap estimate:
OpenRouter's Anthropic-compatible surface returns 404 for it, and Claude Code
calls it for context bookkeeping.

Usage:
  claude_gateway.py --mode relay --listen 0.0.0.0:8900 --token NONCE \
      --upstream https://openrouter.ai/api/v1 --key-env RB_UPSTREAM_KEY \
      [--prefix-anthropic] [--log /gw/gateway.jsonl]
  claude_gateway.py --mode mock  --listen 0.0.0.0:8900 --token NONCE \
      --script /gw/script.json [--log /gw/gateway.jsonl]
  claude_gateway.py --mode translate --listen 0.0.0.0:8900 --token NONCE \
      --upstream https://REDACTED-ENDPOINT/passthrough/openai/v1 \
      --key-env RB_UPSTREAM_KEY --force-model gemini-3-7-flash \
      [--dump-dir /gw/dump] [--log /gw/gateway.jsonl]

Environment switches for `--mode translate` (all off when unset, so adding one
cannot disturb a lane that does not set it):

  RB_GW_UPSTREAM_API=responses   post to <upstream>/responses instead of
                                 <upstream>/chat/completions. Required for
                                 gpt-5.6-sol / gpt-5.6-luna, which refuse
                                 function tools on chat/completions unless
                                 reasoning is turned off -- see the long block
                                 comment above `anthropic_to_responses`.
  RB_GW_REASONING_EFFORT=<e>     pin the reasoning effort. On the chat route it
                                 is the flat `reasoning_effort` parameter; on
                                 the responses route it becomes
                                 {"reasoning":{"effort":e}}, and the value
                                 "none" -- which is not legal there and only
                                 ever existed as the chat-route workaround --
                                 is ignored rather than sent.
  RB_GW_MAX_TOKENS=<n>           cap the client's max_tokens.
"""
import argparse
import hashlib
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ARGS = None
LOCK = threading.Lock()
STATE = {"turn": 0, "requests": 0}


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


def sse(event, data):
    return ("event: %s\ndata: %s\n\n" % (event, json.dumps(data))).encode()


def est_tokens(body):
    """Rough char/4 estimate over every text-ish field. Only used for the
    count_tokens shim, which upstream does not implement."""
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
# mock
# --------------------------------------------------------------------------- #
def mock_turn(body):
    """Pick the next scripted turn.

    The script is a list of turns; each turn is a list of Anthropic content
    blocks ({"type":"text"} / {"type":"tool_use","name":...,"input":{...}}).
    Requests for a model other than --primary-model (Claude Code uses a small
    model for titles/summaries) get a fixed one-word answer and do NOT advance
    the script, so the scripted run stays deterministic.
    """
    script = ARGS._script
    model = body.get("model", "")
    if ARGS.primary_model and model != ARGS.primary_model:
        return [{"type": "text", "text": "ok"}], "end_turn"
    with LOCK:
        i = STATE["turn"]
        STATE["turn"] = i + 1
    if i >= len(script):
        return [{"type": "text", "text": "Done."}], "end_turn"
    blocks = script[i]
    stop = "tool_use" if any(b.get("type") == "tool_use" for b in blocks) else "end_turn"
    for j, b in enumerate(blocks):
        if b.get("type") == "tool_use":
            b.setdefault("id", "toolu_mock_%d_%d" % (i, j))
    return blocks, stop


def mock_message(body):
    blocks, stop = mock_turn(body)
    return {
        "id": "msg_mock_%d" % STATE["requests"],
        "type": "message",
        "role": "assistant",
        "model": body.get("model", "mock"),
        "content": blocks,
        "stop_reason": stop,
        "stop_sequence": None,
        "usage": {"input_tokens": est_tokens(body), "output_tokens": 16,
                  "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
    }


def mock_stream(msg):
    """Render a complete message object as the Anthropic SSE event sequence."""
    head = dict(msg)
    head["content"] = []
    head["stop_reason"] = None
    yield sse("message_start", {"type": "message_start", "message": head})
    for i, b in enumerate(msg["content"]):
        if b["type"] == "text":
            yield sse("content_block_start", {"type": "content_block_start", "index": i,
                                              "content_block": {"type": "text", "text": ""}})
            yield sse("content_block_delta", {"type": "content_block_delta", "index": i,
                                              "delta": {"type": "text_delta", "text": b["text"]}})
        elif b["type"] == "tool_use":
            yield sse("content_block_start", {"type": "content_block_start", "index": i,
                                              "content_block": {"type": "tool_use", "id": b["id"],
                                                                "name": b["name"], "input": {}}})
            yield sse("content_block_delta", {"type": "content_block_delta", "index": i,
                                              "delta": {"type": "input_json_delta",
                                                        "partial_json": json.dumps(b.get("input", {}))}})
        yield sse("content_block_stop", {"type": "content_block_stop", "index": i})
    yield sse("message_delta", {"type": "message_delta",
                                "delta": {"stop_reason": msg["stop_reason"], "stop_sequence": None},
                                "usage": {"output_tokens": msg["usage"]["output_tokens"]}})
    yield sse("message_stop", {"type": "message_stop"})


# --------------------------------------------------------------------------- #
# relay
# --------------------------------------------------------------------------- #
def upstream_model(m):
    # --model-map takes priority: llama passthrough only recognizes claude-sonnet-5 /
    # claude-opus-5, while claude-code only sends names from its own whitelist
    # (neither modelOverrides nor CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT
    #  lifts the rejection on the client side -- both tested). So this has to be
    #  where the swap happens.
    if MODEL_MAP.get(m):
        return MODEL_MAP[m]
    if ARGS.prefix_anthropic and m and "/" not in m:
        return "anthropic/" + m
    return m


# passthrough rejects top-level fields it doesn't recognize, returning 400
# "<field>: Extra inputs are not permitted". claude-code 2.1.233 sends
# context_management / output_config, and more will be added later.
# No hardcoded whitelist: read the field name out of the error, strip it and
# retry, and remember it so later requests get pre-stripped.
STRIP = set()
EXTRA_RE = re.compile(r'([A-Za-z_][A-Za-z0-9_]*)[A-Za-z0-9_.]*: Extra inputs are not permitted')


def relay(body, path, stream):
    key = os.environ.get(ARGS.key_env, "")
    if not key:
        raise RuntimeError("gateway: upstream key env %s is empty" % ARGS.key_env)
    body = dict(body)
    body["model"] = upstream_model(body.get("model", ""))
    # OpenRouter reserves the MAXIMUM possible cost of a request up front, so a
    # large max_tokens is refused outright even when the key has credit left:
    #
    #   402 billing_error "You requested up to 64000 tokens, but can only
    #   afford 36699. ... adjust the key's total limit"
    #
    # Claude Code asks for 64000. Every request 402'd before doing any work, and
    # the run came back with 0 tool calls and only <synthetic> turns -- which
    # looks identical to a dead gateway. Clamping the reservation to something
    # the key can afford makes the request go through; it does not cap the
    # conversation, only one response.
    cap = int(os.environ.get("RB_GW_MAX_TOKENS", "0") or 0)
    if cap and isinstance(body.get("max_tokens"), int) and body["max_tokens"] > cap:
        body["max_tokens"] = cap
    for f in STRIP:
        body.pop(f, None)
    url = ARGS.upstream.rstrip("/") + path
    # The count_tokens branch passes the client's raw path
    # ("/v1/messages/count_tokens") straight through, and the llama passthrough
    # upstream already ends in /v1, so concatenating gives
    # .../anthropic/v1/v1/messages/count_tokens. The openrouter upstream also
    # ends in /v1; it just never hit this branch so the bug stayed hidden.
    # Dedupe it once.
    if url.count("/v1/v1/"):
        url = url.replace("/v1/v1/", "/v1/", 1)
    hdrs = {"content-type": "application/json",
            "authorization": "Bearer " + key,
            "x-api-key": key,
            # Together's Cloudflare blocks on User-Agent: urllib's default
            # "Python-urllib/3.x" gets HTTP 403 + "error code: 1010", and hermes
            # reports it as "your API key was rejected", sending you chasing the
            # key. Verified (2026-08-31): same key, same endpoint, switching to
            # a browser UA gets 200. OpenRouter / Anthropic / the gateway's own
            # routing don't look at this header.
            "user-agent": os.environ.get(
                "RB_UPSTREAM_UA",
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")}
    # Only the Anthropic route wants this header; the OpenAI chat/completions route
    # (the hermes lane) rejects nothing over it today, but sending a protocol
    # version for a protocol you are not speaking is how a future upstream starts
    # 400ing for a reason nobody can find.
    if "/chat/completions" not in path:
        hdrs["anthropic-version"] = "2023-06-01"
    # One 400 only reports one field at a time, so allow enough rounds to strip them all.
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
                # Put the already-consumed body back, otherwise the caller gets
                # an empty error body and the 400 looks like "upstream gave no reason".
                e2 = urllib.error.HTTPError(url, e.code, e.reason, e.headers, None)
                e2.read = lambda t=txt: t.encode()
                raise e2
            field = m.group(1)
            STRIP.add(field)
            body.pop(field, None)
            logline({"ev": "strip_field", "field": field})
    raise RuntimeError("gateway: stripped 8 fields and upstream still refuses")


# --------------------------------------------------------------------------- #
# translate: Anthropic Messages  <->  OpenAI chat/completions
# --------------------------------------------------------------------------- #
# WHY THIS MODE EXISTS -- measured on this host 2026-08-18, not guessed.
# Claude Code always POSTs an Anthropic-shaped body to
# <ANTHROPIC_BASE_URL>/v1/messages, so "just point ANTHROPIC_BASE_URL at the
# OpenAI passthrough" cannot work: the URL does not exist and the body is the
# wrong shape. scripts/docker/180-probe-anthropic-compat-endpoints.sh walks
# every plausible URL on this upstream and gets, for gemini/deepseek:
#
#   POST /experimental/passthrough/anthropic/v1/messages
#        gemini   -> 404 "Publisher model .../publishers/anthropic/models/
#                        gemini-3.7-flash was not found"
#        deepseek -> 500 InvariantViolationException "Not anthropic model"
#   POST /experimental/passthrough/openai/v1/v1/messages   -> 404 path not found
#   POST /experimental/passthrough/openai/v1/messages      -> 404 path not found
#   POST /experimental/compat/anthropic/v1/messages        -> 404 path not found
#   GET  .../anthropic/v1/models                           -> 404
#
# while the SAME models answer 200 on
#   POST /experimental/passthrough/openai/v1/chat/completions
# (control in the same script: a Claude model on the anthropic passthrough is
# 200, so the key and the route are fine -- it is the model family that is
# refused). Translation is therefore the only path, and this is it.
#
# THE THING THAT SILENTLY BREAKS: TOOLS. tools/responses_to_chat_proxy.py has
# the scar -- a tool-shape mistake there dropped the entire MCP toolset and
# produced 33 runs of shell-only "work" with mcp_called=0 and no error
# anywhere. A translation bug does not raise; it just makes the agent look like
# it chose not to use tools. Everything below that touches tool names, tool
# ids or tool arguments is written defensively and logged, and the smoke
# criterion for this mode is `tool_calls=` in driver.log being non-zero.
#
# Anthropic has no `namespace` tool concept (that was a codex-cli invention),
# so unlike the codex proxy there is nothing to flatten: Claude Code advertises
# MCP tools as ordinary top-level tools already named `mcp__server__tool`.

NAME_OK = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
NAME_BAD = re.compile(r"[^A-Za-z0-9_-]")

# --- gemini thought_signature memo -----------------------------------------
# MEASURED 2026-08-18, and it would have destroyed every multi-turn gemini run
# in the exact silent way this file exists to prevent. Gemini 3 returns each
# tool call with an opaque signature:
#
#   tool_calls[i].extra_content.google.thought_signature
#
# and REFUSES the next request if the replayed call does not carry it back:
#
#   400 "Function call is missing a thought_signature in functionCall parts.
#        ... function call `default_api:Bash`, position 2"
#
# Turn 1 works, so a smoke test that only checks "did it call a tool" passes;
# the run then dies on the FIRST tool result, which reads as an API outage.
# The signature cannot ride on the Anthropic side of the wire -- Claude Code
# owns that transcript and drops fields it does not know -- so the gateway has
# to remember it here, keyed by the tool_call id it also hands to the client.
#
# When we do not have one (gateway restarted mid-run, or history compacted),
# Google's documented placeholder is accepted where a bogus base64 blob and the
# string "skip" both 400 "Invalid thought signature." (all three tested).
THOUGHT_SIG_PLACEHOLDER = "context_engineering_is_the_way_to_go"
SIG_MEMO = {}          # tool_call id -> thought_signature
SIG_ORDER = []
SIG_MAX = 4000


def remember_sig(call_id, sig):
    if not call_id or not sig:
        return
    with LOCK:
        if call_id not in SIG_MEMO:
            SIG_ORDER.append(call_id)
            if len(SIG_ORDER) > SIG_MAX:
                SIG_MEMO.pop(SIG_ORDER.pop(0), None)
        SIG_MEMO[call_id] = sig


def sig_for(call_id):
    with LOCK:
        return SIG_MEMO.get(call_id)


def _sig_of_chunk(tc):
    """Pull the signature off an upstream tool_call (chunk or whole message)."""
    try:
        return ((tc.get("extra_content") or {}).get("google") or {}).get(
            "thought_signature")
    except AttributeError:
        return None

FINISH_TO_STOP = {
    "stop": "end_turn",
    "length": "max_tokens",
    "max_tokens": "max_tokens",
    "tool_calls": "tool_use",
    "function_call": "tool_use",
    "content_filter": "end_turn",
}


def chat_tool_name(name):
    """Anthropic tool names are almost always already legal OpenAI function
    names, but `almost` is not good enough: an illegal name is a 400 that kills
    the run, and a TRUNCATED name is worse -- the model calls a tool Claude Code
    has never heard of and every call comes back `No such tool available`.
    Rewrite only when we must, and keep a reverse map (see `namemap`)."""
    name = name or ""
    if NAME_OK.match(name):
        return name
    flat = NAME_BAD.sub("_", name) or "tool"
    if len(flat) > 64:
        # keep the tail (the distinguishing part of mcp__server__tool) plus a
        # digest, so two long names cannot collide into one function
        flat = flat[:57] + "_" + hashlib.sha1(name.encode()).hexdigest()[:6]
    return flat


def _img_url(block):
    """Anthropic image block -> an OpenAI image_url value."""
    s = block.get("source") or {}
    if s.get("type") == "base64" and s.get("data"):
        return "data:%s;base64,%s" % (s.get("media_type") or "image/png", s["data"])
    if s.get("type") == "url":
        return s.get("url") or ""
    return ""


def _anth_text(content, sep="\n"):
    """Flatten Anthropic content (str | block list) to plain text.

    `thinking` / `redacted_thinking` are dropped: they carry a signature that
    only Anthropic can verify, chat/completions has nowhere to put them, and
    echoing the text back as assistant content would let one model read
    another model's private reasoning as if it were its own output."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    out = []
    for b in (content if isinstance(content, list) else [content]):
        if isinstance(b, str):
            out.append(b)
            continue
        if not isinstance(b, dict):
            continue
        t = b.get("type")
        if t == "text":
            out.append(b.get("text") or "")
        elif t == "image":
            out.append("[image]")
    return sep.join(x for x in out if x)


def _tool_result(block):
    """Anthropic tool_result -> (text for the `tool` message, [image parts]).

    A `tool` message cannot carry images in the OpenAI schema, so an image in a
    tool result (playwright screenshots) is pulled out and re-attached to a
    following user message by the caller. Dropping it instead would make a
    browser task unwinnable in a way that looks like the model ignoring the
    screenshot."""
    content = block.get("content")
    texts, images = [], []
    if isinstance(content, str):
        texts.append(content)
    else:
        for b in (content if isinstance(content, list) else [content]):
            if isinstance(b, str):
                texts.append(b)
            elif isinstance(b, dict) and b.get("type") == "text":
                texts.append(b.get("text") or "")
            elif isinstance(b, dict) and b.get("type") == "image":
                url = _img_url(b)
                if url:
                    images.append({"type": "image_url", "image_url": {"url": url}})
                    texts.append("[image returned by the tool; attached below]")
    txt = "\n".join(t for t in texts if t)
    if block.get("is_error"):
        # Anthropic marks the failure with a flag; chat has no such field, and a
        # model that cannot tell success from failure will happily "continue"
        # after a command that never ran.
        txt = "ERROR: " + txt if txt else "ERROR"
    return txt or "(no output)", images


def clean_schema(node):
    """Drop `$schema` from a tool's JSON Schema.

    It is pure metadata (Claude Code's schemas carry it because they are
    zod-generated) and strict function-calling converters are known to be picky
    about unrecognised top-level keywords. NOT verified as necessary here --
    the live runs all had it stripped, so whether these four backends would
    have accepted it is untested. Nothing else is removed: guessing which
    keyword a provider dislikes and deleting it silently changes what the tool
    accepts, which is worse than a loud 400."""
    if isinstance(node, dict):
        return {k: clean_schema(v) for k, v in node.items() if k != "$schema"}
    if isinstance(node, list):
        return [clean_schema(v) for v in node]
    return node


def anthropic_to_chat(body, namemap_out=None, meta_out=None):
    """Anthropic Messages request -> OpenAI chat/completions request."""
    namemap = {}          # openai function name -> original anthropic tool name
    msgs = []

    sys_txt = _anth_text(body.get("system"), sep="\n\n")
    if sys_txt.strip():
        msgs.append({"role": "system", "content": sys_txt})

    for m in body.get("messages") or []:
        if not isinstance(m, dict):
            continue
        role = m.get("role") or "user"
        content = m.get("content")
        if isinstance(content, str):
            msgs.append({"role": role, "content": content})
            continue
        blocks = content if isinstance(content, list) else ([content] if content else [])

        if role == "assistant":
            texts, calls = [], []
            for b in blocks:
                if not isinstance(b, dict):
                    continue
                t = b.get("type")
                if t == "text":
                    texts.append(b.get("text") or "")
                elif t == "tool_use":
                    cid = b.get("id") or "toolu_" + uuid.uuid4().hex[:16]
                    call = {
                        "id": cid,
                        "type": "function",
                        "function": {
                            "name": chat_tool_name(b.get("name")),
                            # chat wants a JSON *string*; Anthropic gives an object
                            "arguments": json.dumps(b.get("input") or {}),
                        },
                    }
                    # See the THOUGHT_SIG_PLACEHOLDER note: gemini 400s on a
                    # replayed call without one. terra/sol accept the field and
                    # ignore it, but DEEPSEEK REJECTS IT (tested, all four):
                    #   400 "Extra inputs are not permitted, field:
                    #        'messages[1].tool_calls[0].extra_content'"
                    # so it is learned-and-dropped rather than switched on a
                    # model-name substring -- guessing the family from the id
                    # is exactly the kind of thing that silently stops being
                    # true when a model is renamed.
                    if not DROP_TOOL_EXTRA:
                        call["extra_content"] = {"google": {
                            "thought_signature":
                                sig_for(cid) or THOUGHT_SIG_PLACEHOLDER}}
                    calls.append(call)
            am = {"role": "assistant", "content": "\n".join(t for t in texts if t)}
            # `content: null` is legal OpenAI but several compat backends
            # (deepseek among them) insist on a string, so send "" instead.
            if calls:
                am["tool_calls"] = calls
            msgs.append(am)
            continue

        # user turn: tool_result blocks become `tool` messages and MUST come
        # first, because a `tool` message is only valid immediately after the
        # assistant message that announced its tool_call_id.
        tool_msgs, parts, deferred = [], [], []
        for b in blocks:
            if not isinstance(b, dict):
                continue
            t = b.get("type")
            if t == "tool_result":
                txt, imgs = _tool_result(b)
                tool_msgs.append({"role": "tool",
                                  "tool_call_id": b.get("tool_use_id") or "",
                                  "content": txt})
                deferred.extend(imgs)
            elif t == "text":
                parts.append({"type": "text", "text": b.get("text") or ""})
            elif t == "image":
                url = _img_url(b)
                if url:
                    parts.append({"type": "image_url", "image_url": {"url": url}})
        msgs.extend(tool_msgs)
        parts = deferred + parts
        if parts:
            if all(p["type"] == "text" for p in parts):
                msgs.append({"role": "user",
                             "content": "\n".join(p["text"] for p in parts)})
            else:
                msgs.append({"role": "user", "content": parts})

    if not msgs:
        msgs = [{"role": "user", "content": ""}]

    model = body.get("model", "")
    if ARGS and getattr(ARGS, "force_model", ""):
        # Claude Code refuses to SEND a model id that is not on its own
        # whitelist ("unrecognized_model", every turn, tool_calls=0 -- this
        # already cost 9 tasks once). So the CLI is
        # given a Claude name and the real target is pinned here, for every
        # request including the small/fast background ones.
        model = ARGS.force_model
    else:
        model = upstream_model(model)
    out = {"model": model, "messages": msgs}

    tools, skipped = [], []
    for t in body.get("tools") or []:
        if not isinstance(t, dict) or not t.get("name"):
            continue
        schema = t.get("input_schema")
        if schema is None:
            # Anthropic server-side tools (web_search_*, computer_*) carry no
            # schema and have no chat equivalent. Claude Code does not use them
            # in this harness -- but record it, because a silently missing tool
            # is exactly the failure this file is written to avoid.
            skipped.append(t.get("name"))
            continue
        fname = chat_tool_name(t["name"])
        namemap[fname] = t["name"]
        tools.append({"type": "function",
                      "function": {"name": fname,
                                   "description": t.get("description") or "",
                                   "parameters": clean_schema(schema)}})
    if tools:
        out["tools"] = tools

    # gpt-5.6-luna REFUSES function tools on /v1/chat/completions while
    # reasoning_effort sits at its model default: 400, param=reasoning_effort,
    # "To use function tools, use /v1/responses or set reasoning_effort to
    # 'none'". Sending an explicit value is the remedy the error itself names.
    # Measured 2026-09-06 against api.openai.com with a failing control -- same
    # body, tools, no reasoning_effort -> 400; + "reasoning_effort":"none" -> 200
    # (model=gpt-5.6-luna, finish_reason=stop). Before this, every tier-3 backup
    # subagent request died here and the plugin recorded outcome=spawn_failed.
    #
    # Opt-in via env, same shape as RB_GW_MAX_TOKENS above: unset is a no-op, so
    # the terra/sol/gemini/deepseek lanes stay byte-identical. It is applied to
    # every request (not only tool-carrying ones) so a lane does not silently
    # switch reasoning modes between its tool and non-tool calls.
    _reasoning = os.environ.get("RB_GW_REASONING_EFFORT", "").strip()
    if _reasoning:
        out["reasoning_effort"] = _reasoning

    tc = body.get("tool_choice")
    if isinstance(tc, dict) and tools:
        kind = tc.get("type")
        if kind == "auto":
            out["tool_choice"] = "auto"
        elif kind == "any":
            out["tool_choice"] = "required"
        elif kind == "none":
            out["tool_choice"] = "none"
        elif kind == "tool" and tc.get("name"):
            out["tool_choice"] = {"type": "function",
                                  "function": {"name": chat_tool_name(tc["name"])}}
        if tc.get("disable_parallel_tool_use") is not None:
            out["parallel_tool_calls"] = not tc["disable_parallel_tool_use"]

    # `max_tokens` is REQUIRED by Anthropic and REFUSED by gpt-5.6-terra/sol on
    # chat/completions (400); the accepted spelling is max_completion_tokens,
    # which gemini and deepseek also take (verified 200 on all four).
    mt = body.get("max_tokens")
    cap = int(os.environ.get("RB_GW_MAX_TOKENS", "0") or 0)
    if cap and isinstance(mt, int) and mt > cap:
        mt = cap
    if isinstance(mt, int) and mt > 0:
        out["max_completion_tokens"] = mt

    for k in ("temperature", "top_p"):
        if body.get(k) is not None:
            out[k] = body[k]
    # top_k has no chat/completions equivalent; sending it is a 400 on this
    # upstream, so it is dropped rather than approximated.
    if body.get("stop_sequences"):
        out["stop"] = body["stop_sequences"]

    if namemap_out is not None:
        namemap_out.clear()
        namemap_out.update(namemap)
    if meta_out is not None:
        meta_out["skipped_tools"] = skipped
        meta_out["renamed_tools"] = {k: v for k, v in namemap.items() if k != v}
    return out


# --------------------------------------------------------------------------- #
# translate mode, second upstream flavour: OpenAI **Responses** (/v1/responses)
# --------------------------------------------------------------------------- #
# WHY THIS EXISTS
# ---------------
# gpt-5.6-sol / gpt-5.6-luna refuse function tools on /v1/chat/completions
# unless reasoning is switched OFF. Measured 2026-09-08 against api.openai.com,
# one function tool in the body, four efforts plus a no-parameter control:
#
#   reasoning_effort=none    -> 200  finish_reason=stop
#   reasoning_effort=low     -> 400
#   reasoning_effort=medium  -> 400
#   reasoning_effort=high    -> 400
#   (parameter omitted)      -> 400
#     "Function tools with reasoning_effort are not supported for gpt-5.6-sol
#      in /v1/chat/completions. To use function tools, use /v1/responses or set
#      reasoning_effort to 'none'."
#
# So RB_GW_REASONING_EFFORT=none bought us tool calling at the price of the
# model's reasoning, and the bill showed up in the results: 26% dest=False on a
# batch whose comparable wiring scored 8%, with the failures shaped like
# "stopped to confirm" / "declined" rather than like a decision. The error names
# the way out itself, and this is it.
#
# OPT-IN, and off by default:
#
#   RB_GW_UPSTREAM_API=responses
#
# Unset (or anything else) leaves EVERY byte of the chat/completions path
# untouched -- the terra / gemini / deepseek lanes ride on it. Same shape as
# RB_GW_MAX_TOKENS / RB_GW_REASONING_EFFORT above.
#
# SHAPES, MEASURED -- NOT REMEMBERED
# ----------------------------------
# Probed 2026-09-08 against a live /v1/responses (Together's, model
# openai/gpt-oss-120b, because the OpenAI account was out of credit that day --
# see the note on RESP_SSE_HAS_NO_EVENT_LINES below for the one place the two
# implementations are known to differ). Request:
#
#   {"model":..., "instructions":"<system prompt>",
#    "input":[ {"role":"user","content":[{"type":"input_text","text":...}]},
#              {"type":"function_call","call_id":"call_x","name":"calc",
#               "arguments":"{\"expr\":\"17*23\"}"},
#              {"type":"function_call_output","call_id":"call_x","output":"391"} ],
#    "tools":[{"type":"function","name":"calc","description":...,
#              "parameters":{...}}],            <- FLAT, not chat's nested
#    "max_output_tokens":300, "store":false}
#
# Non-streaming response: `output` is a LIST OF ITEMS, not a message --
#
#   {"type":"reasoning","id":"rs_...","content":[{"type":"reasoning_text",...}]}
#   {"type":"message","role":"assistant",
#    "content":[{"type":"output_text","text":"..."}]}
#   {"type":"function_call","id":"fc_...","call_id":"call_...","name":"calc",
#    "arguments":"{\n  \"expr\": \"17*23\"\n}","status":"completed"}
#
# with `status` ("completed" / "incomplete" / "failed") replacing
# finish_reason, and usage spelled input_tokens / output_tokens /
# input_tokens_details.cached_tokens instead of prompt_ / completion_ /
# prompt_tokens_details.
#
# `strict` is deliberately sent as false on every tool: the Responses API
# documents strict validation as the DEFAULT there, while chat/completions
# defaults it off, and Claude Code's zod-generated schemas do not all carry the
# `additionalProperties:false` that strict mode requires. Letting the default
# stand would turn a working toolset into a 400 -- i.e. exactly the silent
# capability loss this route is meant to undo.
#
# `reasoning` items are DROPPED on the way back. They must not reach Claude
# Code as assistant text (one model reading another's private reasoning as its
# own output), and they are not echoed back upstream either: the stateless
# store:false loop does not need them, and an unpaired reasoning item is itself
# a 400 on some backends. The model still reasons natively WITHIN each turn,
# which is the entire point of this route.
RESP_STATUS_TO_STOP = {
    "completed": "end_turn",
    "incomplete": "max_tokens",
    "failed": "end_turn",
    "cancelled": "end_turn",
}
# Reasons `status: incomplete` can carry, mapped onto Anthropic stop_reasons.
RESP_INCOMPLETE_TO_STOP = {
    "max_output_tokens": "max_tokens",
    "content_filter": "end_turn",
}


def use_responses_api():
    """True when the caller opted this gateway onto /v1/responses."""
    return os.environ.get("RB_GW_UPSTREAM_API", "").strip().lower() == "responses"


def _resp_text_parts(blocks, images_out):
    """Anthropic user content blocks -> Responses `input_*` content parts."""
    parts = []
    for b in blocks:
        if isinstance(b, str):
            parts.append({"type": "input_text", "text": b})
            continue
        if not isinstance(b, dict):
            continue
        if b.get("type") == "text":
            parts.append({"type": "input_text", "text": b.get("text") or ""})
        elif b.get("type") == "image":
            url = _img_url(b)
            if url:
                parts.append({"type": "input_image", "image_url": url})
    parts[:0] = images_out
    return parts


def anthropic_to_responses(body, namemap_out=None, meta_out=None):
    """Anthropic Messages request -> OpenAI **Responses** request.

    Deliberately a sibling of anthropic_to_chat() rather than a branch inside
    it: the two wire formats disagree about the shape of the conversation
    itself (items vs messages), about where a tool result lives (a top-level
    `function_call_output` item vs a `role:"tool"` message) and about where the
    tool schema lives (flat vs nested under `function`). Threading three
    `if responses:` forks through 130 lines of the chat translator is how the
    chat lane -- which four other model families are running on right now --
    acquires a silent regression."""
    namemap = {}
    items = []

    for m in body.get("messages") or []:
        if not isinstance(m, dict):
            continue
        role = m.get("role") or "user"
        content = m.get("content")
        if isinstance(content, str):
            if role == "assistant":
                items.append({"role": "assistant",
                              "content": [{"type": "output_text", "text": content}]})
            else:
                items.append({"role": "user",
                              "content": [{"type": "input_text", "text": content}]})
            continue
        blocks = content if isinstance(content, list) else ([content] if content else [])

        if role == "assistant":
            texts, calls = [], []
            for b in blocks:
                if not isinstance(b, dict):
                    continue
                t = b.get("type")
                if t == "text":
                    texts.append(b.get("text") or "")
                elif t == "tool_use":
                    calls.append({
                        "type": "function_call",
                        # `call_id` is the field function_call_output joins on;
                        # `id` (the fc_... item id) is NOT interchangeable with
                        # it, and one live backend was observed handing back a
                        # DIFFERENT call_id on the terminal event than on the
                        # opening one. We key both sides off the id Claude Code
                        # was shown, so the pairing is ours and cannot drift.
                        "call_id": b.get("id") or "toolu_" + uuid.uuid4().hex[:16],
                        "name": chat_tool_name(b.get("name")),
                        "arguments": json.dumps(b.get("input") or {}),
                    })
            txt = "\n".join(t for t in texts if t)
            if txt:
                # Unlike chat, an assistant item with empty content is not
                # merely useless here -- it is a separate item in `input` that
                # some backends reject outright. Emit it only when there is text.
                items.append({"role": "assistant",
                              "content": [{"type": "output_text", "text": txt}]})
            items.extend(calls)
            continue

        # user turn. A function_call_output must FOLLOW its function_call, and
        # Anthropic already orders them that way (assistant tool_use, then the
        # user turn carrying tool_result), so the outputs go first here for the
        # same reason `tool` messages do in the chat translator.
        outs, deferred = [], []
        for b in blocks:
            if isinstance(b, dict) and b.get("type") == "tool_result":
                txt, imgs = _tool_result(b)
                outs.append({"type": "function_call_output",
                             "call_id": b.get("tool_use_id") or "",
                             "output": txt})
                deferred.extend(
                    [{"type": "input_image", "image_url": i["image_url"]["url"]}
                     for i in imgs])
        items.extend(outs)
        rest = [b for b in blocks
                if not (isinstance(b, dict) and b.get("type") == "tool_result")]
        parts = _resp_text_parts(rest, deferred)
        if parts:
            items.append({"role": "user", "content": parts})

    if not items:
        items = [{"role": "user", "content": [{"type": "input_text", "text": ""}]}]

    model = body.get("model", "")
    if ARGS and getattr(ARGS, "force_model", ""):
        model = ARGS.force_model
    else:
        model = upstream_model(model)
    out = {"model": model, "input": items}

    # The system prompt is a first-class request field here, not a message.
    sys_txt = _anth_text(body.get("system"), sep="\n\n")
    if sys_txt.strip():
        out["instructions"] = sys_txt

    tools, skipped = [], []
    for t in body.get("tools") or []:
        if not isinstance(t, dict) or not t.get("name"):
            continue
        schema = t.get("input_schema")
        if schema is None:
            skipped.append(t.get("name"))
            continue
        fname = chat_tool_name(t["name"])
        namemap[fname] = t["name"]
        tools.append({"type": "function", "name": fname,
                      "description": t.get("description") or "",
                      "parameters": clean_schema(schema),
                      "strict": False})     # see the block comment above
    if tools:
        out["tools"] = tools

    # NOT sent by default, and that is the whole reason this route exists: with
    # no reasoning field the model runs at its own native effort. The env var is
    # still honoured so a lane can pin the effort deliberately -- on this route
    # it is the documented {"reasoning":{"effort":...}} object, not the flat
    # chat parameter, and "none" is not one of its legal values.
    _reasoning = os.environ.get("RB_GW_REASONING_EFFORT", "").strip()
    if _reasoning and _reasoning.lower() != "none":
        out["reasoning"] = {"effort": _reasoning}

    tc = body.get("tool_choice")
    if isinstance(tc, dict) and tools:
        kind = tc.get("type")
        if kind == "auto":
            out["tool_choice"] = "auto"
        elif kind == "any":
            out["tool_choice"] = "required"
        elif kind == "none":
            out["tool_choice"] = "none"
        elif kind == "tool" and tc.get("name"):
            # flat here; chat nests this one under "function"
            out["tool_choice"] = {"type": "function",
                                  "name": chat_tool_name(tc["name"])}
        if tc.get("disable_parallel_tool_use") is not None:
            out["parallel_tool_calls"] = not tc["disable_parallel_tool_use"]

    mt = body.get("max_tokens")
    cap = int(os.environ.get("RB_GW_MAX_TOKENS", "0") or 0)
    if cap and isinstance(mt, int) and mt > cap:
        mt = cap
    if isinstance(mt, int) and mt > 0:
        out["max_output_tokens"] = mt

    for k in ("temperature", "top_p"):
        if body.get(k) is not None:
            out[k] = body[k]
    # Responses has no `stop` parameter (chat's `stop` / Anthropic's
    # stop_sequences have no equivalent). Record the drop rather than inventing
    # one: a silently ignored stop sequence is a wrong answer, not an error.
    if body.get("stop_sequences") and meta_out is not None:
        meta_out["dropped_stop_sequences"] = body["stop_sequences"]

    # Keep the upstream stateless. `store:true` (the API default) would both
    # retain task prompts server-side and invite a previous_response_id design
    # that this gateway -- which is handed the FULL history every turn by
    # Claude Code -- does not need.
    out["store"] = False

    if namemap_out is not None:
        namemap_out.clear()
        namemap_out.update(namemap)
    if meta_out is not None:
        meta_out["skipped_tools"] = skipped
        meta_out["renamed_tools"] = {k: v for k, v in namemap.items() if k != v}
    return out


def _anth_usage(u):
    u = u or {}
    ptd = u.get("prompt_tokens_details") or {}
    return {"input_tokens": u.get("prompt_tokens", 0) or 0,
            "output_tokens": u.get("completion_tokens", 0) or 0,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": ptd.get("cached_tokens", 0) or 0}


def _anth_usage_resp(u):
    """Responses spells usage differently from chat, and the difference is
    silent: `prompt_tokens` simply is not there, so reusing _anth_usage() would
    report 0/0 for every turn and every run would cost $0. Measured field names:
    input_tokens / output_tokens / input_tokens_details.cached_tokens."""
    u = u or {}
    itd = u.get("input_tokens_details") or {}
    return {"input_tokens": u.get("input_tokens", 0) or 0,
            "output_tokens": u.get("output_tokens", 0) or 0,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": itd.get("cached_tokens", 0) or 0}


def _parse_args_json(raw, seq):
    """chat tool arguments are a JSON *string*; Anthropic `input` is an object.

    A model that emits malformed JSON must not become an empty-but-plausible
    tool call: Bash with input {} runs nothing and reads downstream as "the
    agent did nothing". Log it loudly so it is distinguishable from a refusal."""
    raw = (raw or "").strip()
    if not raw:
        return {}
    try:
        v = json.loads(raw)
    except json.JSONDecodeError:
        logline({"ev": "bad_tool_json", "seq": seq, "raw": raw[:400]})
        return {}
    if not isinstance(v, dict):
        logline({"ev": "non_object_tool_args", "seq": seq, "raw": raw[:200]})
        return {}
    return v


class AnthStream:
    """Accumulate OpenAI chat.completion.chunk SSE, emit Anthropic SSE.

    Ordering rule that makes this safe: the text block is opened on the first
    text delta and stays open until finish(); tool_use blocks are emitted whole
    at finish(). chat reveals a tool call piecewise (id+name in one chunk, then
    argument fragments, and some backends even split the NAME), so emitting
    content_block_start early would mean guessing the name before it is fully
    known -- and a wrong tool name is the invisible failure this whole file is
    built around. Buffering only the calls costs nothing perceptible: the
    arguments are not shown to the user anyway, and the text still streams."""

    def __init__(self, msg_id, model, namemap, seq):
        self.id = msg_id
        self.model = model
        self.namemap = dict(namemap or {})
        self.seq = seq
        self.text = []
        self.text_open = False
        self.calls = {}        # chat tool_call index -> {id,name,args}
        self.order = []
        self.usage = None
        self.finish_reason = None
        self.next_index = 0

    def start(self):
        yield sse("message_start", {"type": "message_start", "message": {
            "id": self.id, "type": "message", "role": "assistant",
            "model": self.model, "content": [], "stop_reason": None,
            "stop_sequence": None,
            # chat only reports usage at the very end (stream_options), so the
            # real numbers ride on message_delta; zeros here keep the SDK's
            # accumulator happy.
            "usage": {"input_tokens": 0, "output_tokens": 0,
                      "cache_creation_input_tokens": 0,
                      "cache_read_input_tokens": 0}}})

    def feed(self, obj):
        if obj.get("usage"):
            self.usage = obj["usage"]
        for ch in obj.get("choices") or []:
            if ch.get("finish_reason"):
                self.finish_reason = ch["finish_reason"]
            d = ch.get("delta") or ch.get("message") or {}
            txt = d.get("content")
            if isinstance(txt, list):
                txt = "".join(b.get("text", "") for b in txt if isinstance(b, dict))
            if txt:
                if not self.text_open:
                    self.text_open = True
                    self.text_index = self.next_index
                    self.next_index += 1
                    yield sse("content_block_start",
                              {"type": "content_block_start",
                               "index": self.text_index,
                               "content_block": {"type": "text", "text": ""}})
                self.text.append(txt)
                yield sse("content_block_delta",
                          {"type": "content_block_delta", "index": self.text_index,
                           "delta": {"type": "text_delta", "text": txt}})
            for tc in d.get("tool_calls") or []:
                idx = tc.get("index")
                if idx is None:
                    # Backends that do not index parallel calls: fall back to
                    # the call id, else to arrival order. Using a constant would
                    # merge two distinct calls into one and lose a command.
                    idx = tc.get("id") or "seq%d" % len(self.order)
                slot = self.calls.get(idx)
                if slot is None:
                    slot = {"id": tc.get("id") or "toolu_" + uuid.uuid4().hex[:16],
                            "name": "", "args": ""}
                    self.calls[idx] = slot
                    self.order.append(idx)
                if tc.get("id"):
                    slot["id"] = tc["id"]
                # gemini sends the signature on the SAME chunk as the id/name;
                # stash it against the id we are about to hand Claude Code, so
                # the next request can replay it (see THOUGHT_SIG_PLACEHOLDER).
                sig = _sig_of_chunk(tc)
                if sig:
                    slot["sig"] = sig
                    remember_sig(slot["id"], sig)
                fn = tc.get("function") or {}
                if fn.get("name"):
                    slot["name"] += fn["name"]      # some backends split it
                if fn.get("arguments"):
                    slot["args"] += fn["arguments"]

    def _flush_sigs(self):
        """Re-key the memo once the ids are final: a backend is allowed to send
        the signature on one chunk and the id on another, and a memo entry filed
        under a provisional id would never be found again."""
        for k in self.order:
            s = self.calls[k]
            if s.get("sig"):
                remember_sig(s["id"], s["sig"])

    def _blocks(self):
        self._flush_sigs()
        out = []
        if self.text_open:
            out.append({"type": "text", "text": "".join(self.text)})
        for k in self.order:
            s = self.calls[k]
            out.append({"type": "tool_use", "id": s["id"],
                        # back to the name Claude Code advertised, or it answers
                        # every call with "No such tool available"
                        "name": self.namemap.get(s["name"], s["name"]),
                        "input": _parse_args_json(s["args"], self.seq)})
        return out

    def stop_reason(self):
        stop = FINISH_TO_STOP.get(self.finish_reason or "stop", "end_turn")
        if self.order:
            # Trust the CONTENT over the label. Several compat backends report
            # finish_reason "stop" while returning tool_calls; Claude Code keys
            # off stop_reason to decide whether to execute the tools, so a
            # mislabelled turn silently ends the run with tool_calls=0.
            stop = "tool_use"
        return stop

    def finish(self):
        self._flush_sigs()
        if self.text_open:
            yield sse("content_block_stop",
                      {"type": "content_block_stop", "index": self.text_index})
        for k in self.order:
            i = self.next_index
            self.next_index += 1
            s = self.calls[k]
            name = self.namemap.get(s["name"], s["name"])
            yield sse("content_block_start",
                      {"type": "content_block_start", "index": i,
                       "content_block": {"type": "tool_use", "id": s["id"],
                                         "name": name, "input": {}}})
            # Claude Code JSON.parses the concatenated partial_json; an empty
            # string would throw, so a call with no arguments must send "{}".
            args = json.dumps(_parse_args_json(s["args"], self.seq))
            yield sse("content_block_delta",
                      {"type": "content_block_delta", "index": i,
                       "delta": {"type": "input_json_delta", "partial_json": args}})
            yield sse("content_block_stop",
                      {"type": "content_block_stop", "index": i})
        if not self.text_open and not self.order:
            # Anthropic never returns a zero-block message; emit an empty text
            # block so the client's accumulator has something to close over.
            yield sse("content_block_start",
                      {"type": "content_block_start", "index": 0,
                       "content_block": {"type": "text", "text": ""}})
            yield sse("content_block_stop",
                      {"type": "content_block_stop", "index": 0})
        u = _anth_usage(self.usage)
        yield sse("message_delta",
                  {"type": "message_delta",
                   "delta": {"stop_reason": self.stop_reason(),
                             "stop_sequence": None},
                   "usage": u})
        yield sse("message_stop", {"type": "message_stop"})

    def final_message(self):
        """Non-streaming equivalent of start()+finish()."""
        blocks = self._blocks() or [{"type": "text", "text": ""}]
        return {"id": self.id, "type": "message", "role": "assistant",
                "model": self.model, "content": blocks,
                "stop_reason": self.stop_reason(), "stop_sequence": None,
                "usage": _anth_usage(self.usage)}


class AnthRespStream:
    """Accumulate OpenAI **Responses** events, emit Anthropic SSE.

    Same contract as AnthStream (start / feed / finish / final_message /
    stop_reason) so H._translate can hold either one, and the same ordering
    rule: text streams as it arrives, tool_use blocks are emitted whole at
    finish() once their name and arguments are final.

    RESP_SSE_HAS_NO_EVENT_LINES -- the dispatch below reads the `type` field
    out of the JSON payload and NEVER the SSE `event:` line. OpenAI sends both;
    the live /v1/responses this was probed against (2026-09-08) sends only
    `data:` lines, with no `event:` line at all. A parser keyed off the event
    name would have produced a perfectly clean, perfectly empty turn there --
    zero text, zero tool calls, no error anywhere -- which is the exact failure
    shape this file exists to prevent. Keying off `type` works on both.

    `response.output_item.done` is treated as authoritative for a function call
    even after argument deltas have been seen: it carries the finished
    arguments string and the final call_id, and one backend was observed
    changing the call_id between `.added` and `.done`."""

    def __init__(self, msg_id, model, namemap, seq):
        self.id = msg_id
        self.model = model
        self.namemap = dict(namemap or {})
        self.seq = seq
        self.text = []
        self.text_open = False
        self.calls = {}        # responses item id (or output_index) -> slot
        self.order = []
        self.usage = None
        self.status = None
        self.incomplete_reason = None
        self.n_reasoning = 0
        self.next_index = 0

    # -- shared with AnthStream ------------------------------------------- #
    start = AnthStream.start

    # -- slots ------------------------------------------------------------ #
    def _slot(self, key, call_id=None, name=None):
        key = key if key is not None else "seq%d" % len(self.order)
        s = self.calls.get(key)
        if s is None:
            s = {"id": call_id or "toolu_" + uuid.uuid4().hex[:16],
                 "name": name or "", "args": ""}
            self.calls[key] = s
            self.order.append(key)
        if call_id:
            s["id"] = call_id
        if name:
            s["name"] = name
        return s

    def _text(self, txt):
        if not txt:
            return
        if not self.text_open:
            self.text_open = True
            self.text_index = self.next_index
            self.next_index += 1
            yield sse("content_block_start",
                      {"type": "content_block_start", "index": self.text_index,
                       "content_block": {"type": "text", "text": ""}})
        self.text.append(txt)
        yield sse("content_block_delta",
                  {"type": "content_block_delta", "index": self.text_index,
                   "delta": {"type": "text_delta", "text": txt}})

    def _harvest(self, resp):
        """Pull everything off a terminal `response` object.

        Used for the non-streaming reply, and as a BACKSTOP on the streaming
        one: a backend that reports the whole turn only on response.completed
        (legal -- the incremental events are optional) would otherwise stream
        an empty message. Content already seen incrementally is not re-taken,
        or a text delta would be counted twice."""
        resp = resp or {}
        if resp.get("usage"):
            self.usage = resp["usage"]
        if resp.get("status"):
            self.status = resp["status"]
        det = resp.get("incomplete_details") or {}
        if det.get("reason"):
            self.incomplete_reason = det["reason"]
        if self.order or self.text:
            return
        for i, item in enumerate(resp.get("output") or []):
            if not isinstance(item, dict):
                continue
            t = item.get("type")
            if t == "message":
                for part in item.get("content") or []:
                    if isinstance(part, dict) and part.get("type") == "output_text":
                        yield from self._text(part.get("text") or "")
            elif t == "function_call":
                s = self._slot(item.get("id") or "out%d" % i,
                               item.get("call_id") or item.get("id"),
                               item.get("name"))
                s["args"] = item.get("arguments") or ""
            elif t == "reasoning":
                # counted, never emitted -- see the block comment on the
                # request translator for why it does not become content
                self.n_reasoning += 1

    # -- the dispatcher --------------------------------------------------- #
    def feed(self, obj):
        if not isinstance(obj, dict):
            return
        t = obj.get("type") or ""

        # whole non-streaming response body (the `object` field is not
        # guaranteed by every implementation, so an `output` list also counts)
        if not t and (obj.get("object") == "response" or "output" in obj):
            yield from self._harvest(obj)
            return

        if t == "response.output_text.delta":
            yield from self._text(obj.get("delta") or "")

        elif t == "response.output_item.added":
            item = obj.get("item") or {}
            if item.get("type") == "function_call":
                self._slot(item.get("id") or obj.get("output_index"),
                           item.get("call_id") or item.get("id"),
                           item.get("name"))
            elif item.get("type") == "reasoning":
                self.n_reasoning += 1

        elif t == "response.function_call_arguments.delta":
            s = self._slot(obj.get("item_id") or obj.get("output_index"))
            s["args"] += obj.get("delta") or ""

        elif t == "response.function_call_arguments.done":
            if isinstance(obj.get("arguments"), str):
                s = self._slot(obj.get("item_id") or obj.get("output_index"))
                s["args"] = obj["arguments"]

        elif t == "response.output_item.done":
            item = obj.get("item") or {}
            if item.get("type") == "function_call":
                s = self._slot(item.get("id") or obj.get("output_index"),
                               item.get("call_id") or item.get("id"),
                               item.get("name"))
                if isinstance(item.get("arguments"), str):
                    s["args"] = item["arguments"]
            # a `message` item's text has already arrived as deltas; re-taking
            # it from .done would print the whole turn twice

        elif t in ("response.completed", "response.incomplete",
                   "response.failed", "response.cancelled"):
            yield from self._harvest(obj.get("response") or {})
            if t == "response.failed":
                self.status = "failed"

        # response.created / .in_progress / .content_part.* /
        # .output_text.done / .reasoning* are intentionally no-ops.

    # -- output ----------------------------------------------------------- #
    def stop_reason(self):
        if self.order:
            # Same rule as the chat path: trust the CONTENT over the label.
            # Claude Code keys off stop_reason to decide whether to run the
            # tools, so a turn that carries calls but says "end_turn" ends the
            # run with tool_calls=0 and reads as a cautious model.
            return "tool_use"
        if self.status == "incomplete":
            return RESP_INCOMPLETE_TO_STOP.get(self.incomplete_reason, "max_tokens")
        return RESP_STATUS_TO_STOP.get(self.status or "completed", "end_turn")

    def blocks(self):
        out = []
        if self.text_open or self.text:
            out.append({"type": "text", "text": "".join(self.text)})
        for k in self.order:
            s = self.calls[k]
            out.append({"type": "tool_use", "id": s["id"],
                        "name": self.namemap.get(s["name"], s["name"]),
                        "input": _parse_args_json(s["args"], self.seq)})
        return out

    def finish(self):
        if self.text_open:
            yield sse("content_block_stop",
                      {"type": "content_block_stop", "index": self.text_index})
        for k in self.order:
            i = self.next_index
            self.next_index += 1
            s = self.calls[k]
            name = self.namemap.get(s["name"], s["name"])
            yield sse("content_block_start",
                      {"type": "content_block_start", "index": i,
                       "content_block": {"type": "tool_use", "id": s["id"],
                                         "name": name, "input": {}}})
            args = json.dumps(_parse_args_json(s["args"], self.seq))
            yield sse("content_block_delta",
                      {"type": "content_block_delta", "index": i,
                       "delta": {"type": "input_json_delta", "partial_json": args}})
            yield sse("content_block_stop",
                      {"type": "content_block_stop", "index": i})
        if not self.text_open and not self.order:
            yield sse("content_block_start",
                      {"type": "content_block_start", "index": 0,
                       "content_block": {"type": "text", "text": ""}})
            yield sse("content_block_stop",
                      {"type": "content_block_stop", "index": 0})
        yield sse("message_delta",
                  {"type": "message_delta",
                   "delta": {"stop_reason": self.stop_reason(),
                             "stop_sequence": None},
                   "usage": _anth_usage_resp(self.usage)})
        yield sse("message_stop", {"type": "message_stop"})

    def final_message(self):
        return {"id": self.id, "type": "message", "role": "assistant",
                "model": self.model,
                "content": self.blocks() or [{"type": "text", "text": ""}],
                "stop_reason": self.stop_reason(), "stop_sequence": None,
                "usage": _anth_usage_resp(self.usage)}


# Second flavour of "drop this field and retry", measured on this upstream by
# tools/responses_to_chat_proxy.py: 400 REDACTED-SYM-3PHttpBadRequestException names
# the offending field in `param` rather than in the message text.
PARAM_RE = re.compile(r'\\?"param\\?"\s*:\s*\\?"([A-Za-z_][A-Za-z0-9_]*)\\?"')
# Never peel these: retrying without them cannot succeed and the second, weirder
# error would hide the real one.
UNDROPPABLE = ("messages", "model", "stream")

# Set the first time a backend refuses the per-tool_call `extra_content` we
# attach for gemini (see THOUGHT_SIG_PLACEHOLDER). Sticky for the life of the
# gateway: one sidecar serves one model, so the first 400 is the last one.
DROP_TOOL_EXTRA = False
# Not matched by EXTRA_RE -- deepseek words it the other way round and points
# at a NESTED path, which no top-level field-popping loop can act on:
#   "Extra inputs are not permitted, field: 'messages[1].tool_calls[0].extra_content'"
TOOL_EXTRA_RE = re.compile(r"tool_calls\[\d+\]\.extra_content")


def _strip_tool_extra(body):
    for m in body.get("messages") or []:
        for tc in (m.get("tool_calls") or []) if isinstance(m, dict) else []:
            tc.pop("extra_content", None)
    return body


def _upstream_headers(stream):
    """Headers for an OpenAI-shaped upstream POST. Extracted verbatim out of
    chat_upstream() so the responses route cannot drift away from it.

    The accept header MUST match `stream`. Asking for text/event-stream on a
    non-streaming request makes this upstream 500 inside its own SSE parser:
      InvariantViolationException "Expected text/event-stream Content-Type.
      Got application/json instead" (REDACTED-SYM-ServerSentEventProcessor.php:95)
    -- i.e. the passthrough picks its response pipeline off the accept header,
    not off the body. Claude Code really does send stream:false requests
    (background/summary turns), so this was not a theoretical branch."""
    key = os.environ.get(ARGS.key_env, "")
    if not key:
        raise RuntimeError("gateway: upstream key env %s is empty" % ARGS.key_env)
    return {"content-type": "application/json",
            "accept": "text/event-stream" if stream else "application/json",
            "authorization": "Bearer " + key,
            # Same as relay(): Together's Cloudflare blocks urllib on UA, see the comment above.
            "user-agent": os.environ.get(
                "RB_UPSTREAM_UA",
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")}


# `input` is the Responses spelling of `messages`: peeling it can never
# succeed, and the second, stranger error would bury the real one.
RESP_UNDROPPABLE = ("input", "model", "stream")
# Deliberately NOT the chat route's `STRIP`: the two wires have different field
# sets, and a field learned as unacceptable on one is not evidence about the
# other. Sharing the set would let one route silently amputate the other's.
RESP_STRIP = set()


def responses_upstream(resp_body):
    """POST a Responses request, with the same learn-and-retry field stripper
    the chat route uses.

    Not folded into chat_upstream(): that function also carries the gemini
    `extra_content` / thought_signature dance, which lives inside
    `messages[].tool_calls[]` -- a structure that does not exist on this wire.
    Sharing the loop would mean carrying a branch for a repair that can never
    fire here."""
    url = ARGS.upstream.rstrip("/") + "/responses"
    hdrs = _upstream_headers(resp_body.get("stream"))
    body = json.loads(json.dumps(resp_body))
    for f in RESP_STRIP:
        body.pop(f, None)
    for _ in range(8):      # one 400 names one field
        req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                     headers=hdrs, method="POST")
        try:
            return urllib.request.urlopen(req, timeout=ARGS.upstream_timeout)
        except urllib.error.HTTPError as e:
            if e.code in (301, 302, 307, 308):
                raise RuntimeError(
                    "upstream %d redirect to %r for model %r -- wrong model id "
                    "for this route" % (e.code, e.headers.get("location"),
                                        body.get("model")))
            if e.code != 400:
                raise
            txt = e.read().decode("utf-8", "replace")
            m = EXTRA_RE.search(txt) or PARAM_RE.search(txt)
            if not m or m.group(1) not in body or m.group(1) in RESP_UNDROPPABLE:
                e2 = urllib.error.HTTPError(url, e.code, e.reason, e.headers, None)
                e2.read = lambda t=txt: t.encode()
                raise e2
            RESP_STRIP.add(m.group(1))
            body.pop(m.group(1), None)
            logline({"ev": "strip_field", "route": "responses", "field": m.group(1)})
    raise RuntimeError("gateway: stripped 8 fields and upstream still refuses")


def chat_upstream(chat_body):
    url = ARGS.upstream.rstrip("/") + "/chat/completions"
    hdrs = _upstream_headers(chat_body.get("stream"))
    global DROP_TOOL_EXTRA
    # deep-ish copy: _strip_tool_extra mutates the nested tool_call dicts, and
    # the caller's body is also what gets written to --dump-dir.
    body = json.loads(json.dumps(chat_body))
    for f in STRIP:
        body.pop(f, None)
    if DROP_TOOL_EXTRA:
        _strip_tool_extra(body)
    for _ in range(8):      # one 400 names one field
        req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                     headers=hdrs, method="POST")
        try:
            return urllib.request.urlopen(req, timeout=ARGS.upstream_timeout)
        except urllib.error.HTTPError as e:
            if e.code in (301, 302, 307, 308):
                # urllib REFUSES to follow a 307 on POST (it raises instead), and
                # this upstream 307s any model it thinks belongs on the /compat
                # route -- including every `gpt-5.6-terra`-style spelling. The
                # working ids are gpt-5.6-terra /
                # gpt-5.6-sol on the passthrough route. Say so,
                # instead of surfacing a bare 307 two layers away.
                raise RuntimeError(
                    "upstream %d redirect to %r for model %r -- wrong model id "
                    "for this route" % (e.code, e.headers.get("location"),
                                        body.get("model")))
            if e.code != 400:
                raise
            txt = e.read().decode("utf-8", "replace")
            if not DROP_TOOL_EXTRA and TOOL_EXTRA_RE.search(txt):
                DROP_TOOL_EXTRA = True
                _strip_tool_extra(body)
                logline({"ev": "drop_tool_extra_content",
                         "why": "backend refuses the gemini thought_signature "
                                "field on replayed tool calls"})
                continue
            m = EXTRA_RE.search(txt) or PARAM_RE.search(txt)
            if not m or m.group(1) not in body or m.group(1) in UNDROPPABLE:
                e2 = urllib.error.HTTPError(url, e.code, e.reason, e.headers, None)
                e2.read = lambda t=txt: t.encode()
                raise e2
            STRIP.add(m.group(1))
            body.pop(m.group(1), None)
            logline({"ev": "strip_field", "field": m.group(1)})
    raise RuntimeError("gateway: stripped 8 fields and upstream still refuses")


def dump(name, blob):
    if not (ARGS and ARGS.dump_dir):
        return
    try:
        os.makedirs(ARGS.dump_dir, exist_ok=True)
        with open(os.path.join(ARGS.dump_dir, name), "wb") as fh:
            fh.write(blob if isinstance(blob, bytes) else blob.encode())
    except OSError:
        pass


class H(BaseHTTPRequestHandler):
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
        # --- OpenAI chat/completions, for the in-container hermes lane -----------
        # hermes speaks OpenAI chat/completions and the upstream it needs
        # (.../passthrough/openai/v1) speaks the same shape, so there is nothing to
        # translate -- what it needs from a sidecar is only what the claude lane
        # needs: hold the real key, hand the task container a nonce, rename the
        # model. That is relay mode. It is a PATH here rather than a new proxy
        # because everything below (nonce auth, --model-map, the Extra-inputs field
        # stripper, the SSE forwarder, the jsonl ledger) is already the behaviour
        # this lane wants.
        #   base_url given to the agent:  http://<gw>:<port>/v1
        #   client posts:                 /v1/chat/completions
        #   upstream already ends in /v1: relay()'s /v1/v1/ dedupe collapses it.
        RELAY_PATH = "/messages"
        if ARGS.mode == "relay" and path.rstrip("/").endswith("/chat/completions"):
            RELAY_PATH = path
        elif not path.endswith("/messages"):
            self._send(404, {"error": "not found"})
            return

        logline({"ev": "request", "seq": seq, "mode": ARGS.mode,
                 "model": body.get("model"), "stream": bool(body.get("stream")),
                 "n_messages": len(body.get("messages") or []),
                 "system_chars": len(json.dumps(body.get("system") or "")),
                 "n_tools": len(body.get("tools") or []),
                 "tools": tool_names(body)})

        stream = bool(body.get("stream"))
        if ARGS.mode == "mock":
            msg = mock_message(body)
            logline({"ev": "response", "seq": seq, "stop_reason": msg["stop_reason"],
                     "blocks": [b["type"] + (":" + b.get("name", "") if b["type"] == "tool_use" else "")
                                for b in msg["content"]]})
            if not stream:
                self._send(200, msg)
                return
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("cache-control", "no-cache")
            self.send_header("transfer-encoding", "chunked")
            self.end_headers()
            for chunk in mock_stream(msg):
                self.wfile.write(b"%x\r\n" % len(chunk) + chunk + b"\r\n")
            self.wfile.write(b"0\r\n\r\n")
            return

        if ARGS.mode == "translate":
            self._translate(body, seq, stream)
            return

        # relay
        try:
            resp = relay(body, RELAY_PATH, stream)
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

    # ----------------------------------------------------------------- #
    # translate mode
    # ----------------------------------------------------------------- #
    def _translate(self, body, seq, stream):
        namemap, meta = {}, {}
        # RB_GW_UPSTREAM_API=responses swaps the upstream wire for /v1/responses
        # (see the block comment above anthropic_to_responses). Unset, every
        # line below behaves exactly as it did before that route existed.
        resp_api = use_responses_api()
        try:
            chat = (anthropic_to_responses(body, namemap, meta) if resp_api
                    else anthropic_to_chat(body, namemap, meta))
        except Exception as e:  # noqa: BLE001
            logline({"ev": "translate_error", "seq": seq, "err": repr(e)[:400]})
            self._send(400, {"type": "error",
                             "error": {"type": "invalid_request_error",
                                       "message": "gateway could not translate "
                                                  "the request: %r" % e}})
            return
        dump(("responses-%03d.json" if resp_api else "chat-%03d.json") % seq,
             json.dumps(chat, indent=1))
        _items = chat["input"] if resp_api else chat["messages"]
        logline({"ev": "translated", "seq": seq, "model": chat["model"],
                 "api": "responses" if resp_api else "chat",
                 "n_messages": len(_items),
                 "roles": [m.get("role") or m.get("type") for m in _items][-8:],
                 "n_tools": len(chat.get("tools") or []),
                 "renamed_tools": meta.get("renamed_tools") or {},
                 "skipped_tools": meta.get("skipped_tools") or []})

        chat = dict(chat)
        chat["stream"] = bool(stream)
        if stream and not resp_api:
            # without this the upstream never reports usage on a streamed turn
            # and every run records 0 tokens / $0 cost. Responses needs no
            # equivalent: usage rides on response.completed unconditionally,
            # and stream_options is not a field it accepts.
            chat["stream_options"] = {"include_usage": True}

        try:
            resp = responses_upstream(chat) if resp_api else chat_upstream(chat)
        except urllib.error.HTTPError as e:
            err = e.read()
            logline({"ev": "upstream_error", "seq": seq, "code": e.code,
                     "body": err[:800].decode("utf-8", "replace")})
            dump("err-%03d.txt" % seq, err)
            # Re-shape as an Anthropic error so Claude Code prints the reason
            # instead of "API Error (unknown)".
            self._send(e.code, {"type": "error",
                                "error": {"type": "api_error",
                                          "message": err[:1500].decode("utf-8", "replace")}})
            return
        except Exception as e:  # noqa: BLE001
            logline({"ev": "upstream_exception", "seq": seq, "err": repr(e)[:400]})
            self._send(502, {"type": "error",
                             "error": {"type": "api_error",
                                       "message": "gateway upstream failure: %r" % e}})
            return

        tr = (AnthRespStream if resp_api else AnthStream)(
            "msg_" + uuid.uuid4().hex, body.get("model", chat["model"]),
            namemap, seq)

        if not stream:
            blob = resp.read()
            dump("upstream-%03d.json" % seq, blob)
            try:
                obj = json.loads(blob)
            except json.JSONDecodeError:
                logline({"ev": "bad_upstream_json", "seq": seq, "body": blob[:400]})
                self._send(502, {"type": "error",
                                 "error": {"type": "api_error",
                                           "message": "upstream returned non-JSON"}})
                return
            # feed() reads `message` as well as `delta`, so the same accumulator
            # handles the non-streaming shape -- one code path, one set of bugs.
            list(tr.feed(obj))
            msg = tr.final_message()
            logline({"ev": "response", "seq": seq, "stop_reason": msg["stop_reason"],
                     "usage": msg["usage"],
                     "tool_calls": [b["name"] for b in msg["content"]
                                    if b["type"] == "tool_use"]})
            self._send(200, msg)
            return

        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.send_header("transfer-encoding", "chunked")
        self.end_headers()

        def emit(chunks):
            for c in chunks:
                self.wfile.write(b"%x\r\n" % len(c) + c + b"\r\n")
                self.wfile.flush()

        raw_tail = []
        try:
            emit(tr.start())
            # Forward as it arrives. Reading the whole upstream body first would
            # leave Claude Code staring at a silent socket for the length of the
            # turn, and its own request timeout would fire first.
            while True:
                line = resp.readline()
                if not line:
                    break
                raw_tail.append(line)
                if len(raw_tail) > 4000:
                    del raw_tail[:2000]
                line = line.strip()
                if not line.startswith(b"data:"):
                    continue
                payload = line[5:].strip()
                if payload == b"[DONE]":
                    break
                try:
                    obj = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                # chat puts the failure under "error"; Responses sends a
                # top-level {"type":"error", "message":...} event instead, and
                # a parser that only knows the first shape forwards it as an
                # ordinary unknown event and ends the turn silently empty.
                if obj.get("error") or obj.get("type") == "error":
                    _err = obj.get("error") or obj
                    logline({"ev": "upstream_stream_error", "seq": seq,
                             "err": json.dumps(_err)[:400]})
                    emit([sse("error", {"type": "error",
                                        "error": {"type": "api_error",
                                                  "message": json.dumps(_err)[:600]}})])
                    self.wfile.write(b"0\r\n\r\n")
                    return
                emit(tr.feed(obj))
            emit(tr.finish())
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            logline({"ev": "client_gone", "seq": seq})
            return
        finally:
            dump("upstream-%03d.sse" % seq, b"".join(raw_tail))

        logline({"ev": "response", "seq": seq, "stop_reason": tr.stop_reason(),
                 "finish_reason": getattr(tr, "finish_reason", None)
                                  or getattr(tr, "status", None),
                 "text_chars": len("".join(tr.text)),
                 "tool_calls": [tr.namemap.get(tr.calls[k]["name"],
                                               tr.calls[k]["name"]) for k in tr.order],
                 "usage": (_anth_usage_resp if resp_api else _anth_usage)(tr.usage)})


MODEL_MAP = {}


def main():
    global ARGS
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=("relay", "mock", "translate"), required=True)
    ap.add_argument("--listen", default="0.0.0.0:8900")
    ap.add_argument("--token", default="")
    ap.add_argument("--log", default="")
    ap.add_argument("--upstream", default="https://openrouter.ai/api/v1")
    ap.add_argument("--key-env", default="RB_UPSTREAM_KEY")
    ap.add_argument("--prefix-anthropic", action="store_true",
                    help="rewrite bare model ids to anthropic/<id> (OpenRouter)")
    ap.add_argument("--upstream-timeout", type=int, default=900)
    ap.add_argument("--script", default="")
    ap.add_argument("--primary-model", default="")
    ap.add_argument("--model-map", default="",
                    help="comma-separated from=to pairs, mapping the client model name to the name upstream recognizes")
    ap.add_argument("--force-model", default="",
                    help="translate mode: pin every request's model (including small/fast background "
                         "requests) to this upstream model name. claude-code only sends names from its own "
                         "whitelist, so the real target model can only be specified here")
    ap.add_argument("--dump-dir", default="",
                    help="translate mode: write the translated request body and the raw upstream response here "
                         "(for debugging; contains prompts, do not enable on a real batch run)")
    ARGS = ap.parse_args()
    if ARGS.mode == "translate" and not ARGS.force_model and not ARGS.model_map:
        # Without one of the two, the Claude model name Claude Code sends goes
        # straight to the OpenAI passthrough, which 307-redirects Claude models
        # to a different route -- a confusing failure two layers away from here.
        sys.stderr.write("gateway: --mode translate needs --force-model "
                         "(or --model-map)\n")
        sys.exit(2)
    for pair in filter(None, (x.strip() for x in ARGS.model_map.split(","))):
        k, _, v = pair.partition("=")
        if k and v:
            MODEL_MAP[k.strip()] = v.strip()
    ARGS._script = json.load(open(ARGS.script)) if ARGS.script else []
    host, _, port = ARGS.listen.rpartition(":")
    srv = ThreadingHTTPServer((host or "0.0.0.0", int(port)), H)
    logline({"ev": "start", "mode": ARGS.mode, "listen": ARGS.listen,
             "upstream": ARGS.upstream if ARGS.mode == "relay" else None,
             "script_turns": len(ARGS._script)})
    srv.serve_forever()


if __name__ == "__main__":
    main()
