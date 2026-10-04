#!/usr/bin/env python3
"""Normalize a Claude Code transcript into the trajectory shape harness/judge.py reads.

judge.py's contract (render_trajectory) is small and explicit:
  json.load(path) -> {"messages": [...]} (or "conversation")
  each entry: {"role": str, "content": str | [blocks]}, optional "tool_calls"
It renders "[role] content" plus "TOOL_CALLS=<json>" and sends that to the blind
judge. Nothing else in the file is read, so anything extra is inert.

Claude Code's own record is a session JSONL (CLAUDE_CONFIG_DIR/projects/<slug>/
<session>.jsonl) whose user/assistant lines each carry a raw Anthropic `message`.
`--output-format stream-json` emits the same message objects on stdout. Both are
accepted here; the session file is preferred because it is Claude Code's
canonical transcript.

The instruction is passed in and forced to be the FIRST user message, so the
judge sees the task exactly as the hermes trajectories present it (the blind
rubric relies on the transcript's first message being the instruction).

Usage:
  cc_trajectory.py --out trajectory.json --log agent.log --instruction-file F \
      [--session S.jsonl] [--stream stream.jsonl] [--model M]
"""
import argparse
import json
import os


def text(s):
    return s if isinstance(s, str) else json.dumps(s, default=str)


def records(path):
    """Yield (type, message, envelope) for the transcript lines that carry a message.

    Subagent side-thread lines (isSidechain) are kept; convert() marks them.
    """
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line or not line.startswith("{"):
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            t = d.get("type")
            if t in ("user", "assistant") and isinstance(d.get("message"), dict):
                yield t, d["message"], d
            elif t == "result":
                yield "result", d, d


def convert(paths, instruction):
    msgs = [{"role": "user", "content": instruction}]
    seen_first_user = False
    for path in paths:
        if not path or not os.path.exists(path):
            continue
        for kind, message, envelope in records(path):
            if kind == "result":
                summary = "[run result] subtype=%s is_error=%s turns=%s cost_usd=%s usage=%s" % (
                    message.get("subtype"), message.get("is_error"),
                    message.get("num_turns"), message.get("total_cost_usd"),
                    json.dumps(message.get("usage") or {}))
                msgs.append({"role": "system", "content": summary})
                continue
            content = message.get("content")
            side = " (subagent)" if envelope.get("isSidechain") else ""
            texts, tool_calls, tool_results = [], [], []
            if isinstance(content, str):
                texts.append(content)
            else:
                for b in content or []:
                    if not isinstance(b, dict):
                        texts.append(str(b))
                        continue
                    bt = b.get("type")
                    if bt == "text":
                        texts.append(b.get("text") or "")
                    elif bt == "thinking":
                        texts.append("[thinking] " + (b.get("thinking") or ""))
                    elif bt == "tool_use":
                        tool_calls.append({"id": b.get("id"), "name": b.get("name"),
                                           "arguments": b.get("input")})
                    elif bt == "tool_result":
                        result = b.get("content")
                        if isinstance(result, list):
                            parts = []
                            for x in result:
                                if isinstance(x, dict):
                                    parts.append(x.get("text", json.dumps(x, default=str)))
                                else:
                                    parts.append(str(x))
                            result = "\n".join(parts)
                        error_tag = " ERROR" if b.get("is_error") else ""
                        tool_results.append("[tool_result%s%s]\n%s" % (
                            side, error_tag, text(result or "")))
                    else:
                        texts.append("[%s] %s" % (bt, json.dumps(b, default=str)))
            if kind == "user":
                if tool_results:
                    msgs.append({"role": "tool", "content": "\n".join(tool_results)})
                    continue
                body = "\n".join(t for t in texts if t)
                if not seen_first_user and body.strip() == instruction.strip():
                    seen_first_user = True          # already message[0]
                    continue
                if body.strip():
                    msgs.append({"role": "user", "content": body})
            else:
                m = {"role": "assistant" + ("/subagent" if side else ""),
                     "content": "\n".join(t for t in texts if t)}
                if tool_calls:
                    m["tool_calls"] = tool_calls
                if m["content"] or tool_calls:
                    msgs.append(m)
    return msgs


def render(msgs):
    out = []
    for m in msgs:
        line = "[%s] %s" % (m["role"], m.get("content") or "")
        for tc in m.get("tool_calls") or []:
            line += "\n  -> %s(%s)" % (tc.get("name"),
                                       json.dumps(tc.get("arguments"), default=str))
        out.append(line)
    return "\n\n".join(out) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--log")
    ap.add_argument("--instruction-file", required=True)
    ap.add_argument("--session")
    ap.add_argument("--stream")
    ap.add_argument("--model", default="")
    # Provenance: which harness produced the transcript, recorded in the artifact.
    ap.add_argument("--agent", default="claude-code")
    a = ap.parse_args()

    instruction = open(a.instruction_file, encoding="utf-8").read().strip()
    # Prefer Claude Code's own session record; fall back to the stream-json dump.
    src = [a.session] if a.session and os.path.exists(a.session) else []
    if not src:
        src = [a.stream]
    msgs = convert(src, instruction)
    # Claude Code advertises MCP tools lazily, recording the roster in
    # `deferred_tools_delta` attachment records rather than in a tool schema
    # block, so scrape those to recover which tools the agent was offered.
    tools, mcp_tools = [], []
    for path in [p for p in src if p and os.path.exists(p)]:
        for line in open(path, encoding="utf-8", errors="replace"):
            try:
                rec = json.loads(line)
            except Exception:
                continue
            att = rec.get("attachment") or {}
            if att.get("type") != "deferred_tools_delta":
                continue
            for name in (att.get("addedNames") or []) + (att.get("readdedNames") or []):
                if name not in tools:
                    tools.append(name)
                    if name.startswith("mcp__") and name not in mcp_tools:
                        mcp_tools.append(name)
    mcp_called = set()
    for m in msgs:
        for call in m.get("tool_calls") or []:
            if str(call.get("name", "")).startswith("mcp__"):
                mcp_called.add(call.get("name"))
    traj = {"messages": msgs, "agent": a.agent, "model": a.model,
            "tools": tools, "mcp_tools": mcp_tools,
            "mcp_tools_called": sorted(mcp_called),
            "source": os.path.basename(src[0]) if src and src[0] else None}
    with open(a.out, "w", encoding="utf-8") as fh:
        json.dump(traj, fh, indent=1)
        fh.write("\n")
    if a.log:
        with open(a.log, "w", encoding="utf-8") as fh:
            fh.write(render(msgs))
    n_tools = sum(len(m.get("tool_calls") or []) for m in msgs)
    print("messages=%d tool_calls=%d tools=%d mcp_tools=%d mcp_called=%d"
          % (len(msgs), n_tools, len(tools), len(mcp_tools), len(traj["mcp_tools_called"])))


if __name__ == "__main__":
    main()
