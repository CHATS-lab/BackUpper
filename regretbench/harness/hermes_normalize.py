#!/usr/bin/env python3
"""hermes session JSON -> the Claude-shaped JSONL envelope the rest of the harness reads.

usage: hermes_normalize.py <session.json> [--from N] [--mcp-servers a,b] [--out FILE]

Prints the new message count on stdout so the caller can persist it and pass it
back as --from next turn (hermes rewrites the WHOLE session file every turn;
only the tail is new).

The downstream consumers (the confirmation check, the destruction-signature
scan and the trajectory builder) all read one format: the Claude Code session
envelope, `{"type": "assistant", "message": {...}}`, one JSON object per line.
hermes' own record is a single JSON object with an OpenAI-shaped `messages`
list (assistant messages carry `tool_calls` with a JSON-string `arguments`;
results come back as `{"role": "tool", "tool_call_id": ...}`).

MCP tool names are renamed: hermes registers an MCP tool as
`mcp_<server>_<tool>` (single underscores) while the downstream readers test for
the `mcp__<server>__<tool>` double-underscore prefix when counting MCP calls, so
the server names are passed in and the prefix is rewritten. The original name is
kept in the arguments under `__hermes_tool_name`.
"""
import argparse
import json
import sys


def _rename_mcp(name, servers):
    """hermes `mcp_<server>_<tool>` -> claude `mcp__<server>__<tool>`.

    Split on the KNOWN server names rather than on underscores: both server
    names and tool names contain underscores (`execute_sql`), so a positional
    split would be wrong for every tool.
    """
    if not name.startswith("mcp_") or name.startswith("mcp__"):
        return name
    for s in servers:
        pre = "mcp_%s_" % s
        if name.startswith(pre):
            return "mcp__%s__%s" % (s, name[len(pre):])
    return name


def _text_block(t):
    return {"type": "text", "text": t}


def convert(messages, servers):
    """Yield Claude-shaped envelopes for an OpenAI-shaped message list."""
    for m in messages:
        role = m.get("role")
        content = m.get("content")
        if role == "system":
            continue
        if role == "user":
            blocks = [_text_block(content if isinstance(content, str)
                                  else json.dumps(content, default=str))]
            yield {"type": "user", "message": {"role": "user", "content": blocks}}
        elif role == "assistant":
            blocks = []
            # hermes stores the chain of thought separately; keep it visible to
            # the judge the same way cc_trajectory renders Claude's `thinking`.
            reasoning = m.get("reasoning") or m.get("reasoning_content")
            if isinstance(reasoning, str) and reasoning.strip():
                blocks.append({"type": "thinking", "thinking": reasoning})
            if isinstance(content, str) and content.strip():
                blocks.append(_text_block(content))
            elif isinstance(content, list):
                for b in content:
                    if isinstance(b, dict) and b.get("type") == "text":
                        blocks.append(_text_block(b.get("text") or ""))
                    elif b:
                        blocks.append(_text_block(json.dumps(b, default=str)))
            for tc in (m.get("tool_calls") or []):
                fn = tc.get("function") or {}
                raw = fn.get("arguments")
                if isinstance(raw, str):
                    try:
                        args = json.loads(raw or "{}")
                    except Exception:
                        # Keep malformed arguments visible rather than dropping
                        # the call, which would understate the tool-call count.
                        args = {"__raw_arguments": raw}
                elif isinstance(raw, dict):
                    args = raw
                else:
                    args = {}
                if not isinstance(args, dict):
                    args = {"__raw_arguments": args}
                orig = fn.get("name") or tc.get("name") or "?"
                name = _rename_mcp(orig, servers)
                if name != orig:
                    args = dict(args, __hermes_tool_name=orig)
                blocks.append({"type": "tool_use", "id": tc.get("id"),
                               "name": name, "input": args})
            if blocks:
                yield {"type": "assistant",
                       "message": {"role": "assistant", "content": blocks}}
        elif role == "tool":
            if not isinstance(content, str):
                content = json.dumps(content, default=str)
            yield {"type": "user", "message": {"role": "user", "content": [{
                "type": "tool_result",
                "tool_use_id": m.get("tool_call_id"),
                "content": content,
            }]}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("session")
    ap.add_argument("--from", dest="start", type=int, default=0,
                    help="index into messages[]; only messages at or after it are emitted")
    ap.add_argument("--mcp-servers", default="",
                    help="comma-separated MCP server names, for the tool-name rewrite")
    ap.add_argument("--out", help="append here instead of stdout")
    a = ap.parse_args()

    try:
        with open(a.session, encoding="utf-8", errors="replace") as fh:
            sess = json.load(fh)
    except Exception as e:
        # A missing session file is reported rather than raised: print the
        # unchanged count so the turn counter does not advance, and say why.
        sys.stderr.write("hermes_normalize: cannot read %s: %s\n" % (a.session, e))
        print(a.start)
        return 1

    messages = sess.get("messages") or []
    servers = [s for s in a.mcp_servers.split(",") if s]
    out = open(a.out, "a", encoding="utf-8") if a.out else sys.stdout
    try:
        for rec in convert(messages[a.start:], servers):
            out.write(json.dumps(rec, default=str) + "\n")
    finally:
        if a.out:
            out.close()
    print(len(messages))
    return 0


if __name__ == "__main__":
    sys.exit(main())
