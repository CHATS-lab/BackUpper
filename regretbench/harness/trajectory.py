#!/usr/bin/env python3
"""Agent transcripts -> the shapes the rest of the harness reads.

One file, four subcommands:

  trajectory.py build ...             session/stream JSONL -> trajectory.json
  trajectory.py codex                 codex `exec --json` events on stdin ->
                                      Claude stream-json on stdout
  trajectory.py hermes-normalize ...  hermes session JSON -> Claude stream-json
  trajectory.py hermes-sessions ...   resolve / merge hermes session chains
"""
import argparse
import hashlib
import json
import os
import sqlite3
import sys


# =============================================================================
# build
# =============================================================================
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
  trajectory.py build --out trajectory.json --log agent.log --instruction-file F \
      [--session S.jsonl] [--stream stream.jsonl] [--model M]"""

def cc_text(s):
    return s if isinstance(s, str) else json.dumps(s, default=str)


def cc_records(path):
    """Yield (type, message, envelope) for the transcript lines that carry a message.

    Subagent side-thread lines (isSidechain) are kept; cc_convert() marks them.
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


def cc_convert(paths, instruction):
    msgs = [{"role": "user", "content": instruction}]
    seen_first_user = False
    for path in paths:
        if not path or not os.path.exists(path):
            continue
        for kind, message, envelope in cc_records(path):
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
                            side, error_tag, cc_text(result or "")))
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


def cc_render(msgs):
    out = []
    for m in msgs:
        line = "[%s] %s" % (m["role"], m.get("content") or "")
        for tc in m.get("tool_calls") or []:
            line += "\n  -> %s(%s)" % (tc.get("name"),
                                       json.dumps(tc.get("arguments"), default=str))
        out.append(line)
    return "\n\n".join(out) + "\n"


def main_build(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--log")
    ap.add_argument("--instruction-file", required=True)
    ap.add_argument("--session")
    ap.add_argument("--stream")
    ap.add_argument("--model", default="")
    # Provenance: which harness produced the transcript, recorded in the artifact.
    ap.add_argument("--agent", default="claude-code")
    a = ap.parse_args(argv)

    instruction = open(a.instruction_file, encoding="utf-8").read().strip()
    # Prefer Claude Code's own session record; fall back to the stream-json dump.
    src = [a.session] if a.session and os.path.exists(a.session) else []
    if not src:
        src = [a.stream]
    msgs = cc_convert(src, instruction)
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
            fh.write(cc_render(msgs))
    n_tools = sum(len(m.get("tool_calls") or []) for m in msgs)
    print("messages=%d tool_calls=%d tools=%d mcp_tools=%d mcp_called=%d"
          % (len(msgs), n_tools, len(tools), len(mcp_tools), len(traj["mcp_tools_called"])))


# =============================================================================
# codex
# =============================================================================
"""Convert codex-cli's `codex exec --json` event stream into the JSONL envelope
that Claude Code's `--output-format stream-json` emits, which is the format
read by asks_confirmation.py and `trajectory.py build`.

Usage: codex exec ... --json | trajectory.py codex >> claude_stream.jsonl

stdin carries one codex event per line; stdout receives zero or more
Claude-shaped lines per event. Unrecognised or malformed lines are skipped
rather than raised; the caller keeps the raw stream in codex_stream.raw.jsonl.

The wire format is a bare object per line:

  {"type":"thread.started","thread_id":"019fd5f4-..."}
  {"type":"turn.started"}
  {"type":"item.completed","item":{"id":"item_0","type":"agent_message",
                                   "text":"Running it now."}}
  {"type":"item.started","item":{"id":"item_1","type":"command_execution",
       "command":"/bin/bash -lc 'echo hi'","aggregated_output":"",
       "exit_code":null,"status":"in_progress"}}
  {"type":"item.completed","item":{"id":"item_1","type":"command_execution",
       "command":"/bin/bash -lc 'echo hi'","aggregated_output":"hi\\n",
       "exit_code":0,"status":"completed"}}
  {"type":"turn.completed","usage":{"input_tokens":18448,...}}

The `--json` surface uses item.* / turn.* / thread.* events with a nested
`item` carrying its own `type`; the internal enum names of the binary never
appear on the wire."""

# command_execution items seen as item.started but not yet item.completed,
# keyed by item id, so a run killed mid-command still shows the command issued.
_OPEN_CALLS = {}


def _cmd_to_str(cmd):
    if isinstance(cmd, list):
        return " ".join(str(c) for c in cmd)
    return str(cmd) if cmd is not None else ""


def _assistant(blocks):
    return {"type": "assistant", "message": {"role": "assistant", "content": blocks}}


def _codex_text_block(text):
    return {"type": "text", "text": text or ""}


def _tool_use(call_id, name, arguments):
    return {"type": "tool_use", "id": str(call_id), "name": name,
            "input": arguments if isinstance(arguments, dict) else {"value": arguments}}


def _tool_result(call_id, content, is_error=False):
    return {"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": str(call_id),
         "content": content if isinstance(content, str) else json.dumps(content, default=str),
         "is_error": bool(is_error)}]}}


def _item_to_tool(item):
    """(name, arguments) for a codex item that represents a tool call."""
    it = item.get("type")
    if it == "command_execution":
        # Claude's Bash shape: downstream readers expect the command under
        # input.command.
        return "Bash", {"command": _cmd_to_str(item.get("command"))}
    if it in ("file_change", "patch_apply"):
        return "Edit", {k: v for k, v in item.items() if k not in ("id", "type")}
    if it == "mcp_tool_call":
        server = item.get("server") or item.get("server_name") or "mcp"
        tool = item.get("tool") or item.get("tool_name") or "call"
        return "mcp__%s__%s" % (server, tool), item.get("arguments") or {
            k: v for k, v in item.items() if k not in ("id", "type")}
    if it == "web_search":
        return "WebSearch", {"query": item.get("query") or ""}
    if it == "todo_list":
        return "TodoWrite", {k: v for k, v in item.items() if k not in ("id", "type")}
    # Unknown item type: still emit it as a tool call rather than dropping it,
    # so tool-call counts stay honest when codex-cli adds new item types.
    return str(it or "unknown"), {k: v for k, v in item.items() if k not in ("id", "type")}


def _result_of(item):
    """(content, is_error) for a completed tool item."""
    it = item.get("type")
    if it == "command_execution":
        code = item.get("exit_code")
        return item.get("aggregated_output") or "", (code not in (0, None))
    if it == "mcp_tool_call":
        return json.dumps(item.get("result") or item.get("output") or {}, default=str), \
               bool(item.get("error"))
    body = {k: v for k, v in item.items() if k not in ("id", "type", "command")}
    return json.dumps(body, default=str), bool(item.get("error"))


def codex_convert(obj):
    """Yield zero or more Claude-shaped records for one codex event."""
    if not isinstance(obj, dict):
        return
    # Tolerate a wrapped envelope ({"id":..,"msg":{...}}) as well as the bare
    # object the current wire format uses.
    if "msg" in obj and isinstance(obj.get("msg"), dict) and "type" not in obj:
        obj = obj["msg"]

    et = obj.get("type")

    if et == "item.started":
        item = obj.get("item") or {}
        if item.get("type") == "command_execution":
            _OPEN_CALLS[str(item.get("id"))] = item
        return

    if et == "item.completed":
        item = obj.get("item") or {}
        it = item.get("type")
        iid = str(item.get("id") or len(_OPEN_CALLS))
        _OPEN_CALLS.pop(iid, None)

        if it == "agent_message":
            yield _assistant([_codex_text_block(item.get("text"))])
            return
        if it == "reasoning":
            txt = item.get("text") or item.get("summary") or ""
            if txt:
                yield _assistant([{"type": "thinking", "thinking": txt}])
            return
        if it == "error":
            yield _assistant([_codex_text_block("[error] " + str(item.get("message") or item))])
            return

        name, args = _item_to_tool(item)
        yield _assistant([_tool_use(iid, name, args)])
        content, is_error = _result_of(item)
        yield _tool_result(iid, content, is_error)
        return

    if et in ("turn.completed", "turn.failed", "turn.aborted"):
        # Flush any command that was issued but never reported completion, so a
        # hung/killed destructive command is still visible in the trajectory.
        for iid, item in list(_OPEN_CALLS.items()):
            name, args = _item_to_tool(item)
            yield _assistant([_tool_use(iid, name, args)])
            yield _tool_result(iid, "[no completion event -- turn ended while running]", True)
            _OPEN_CALLS.pop(iid, None)
        usage = obj.get("usage") or {}
        yield {"type": "result", "subtype": et.split(".")[-1],
               "is_error": et != "turn.completed", "num_turns": 1,
               "total_cost_usd": obj.get("total_cost_usd"), "usage": usage}
        return

    if et == "error":
        yield _assistant([_codex_text_block("[error] " + str(obj.get("message") or obj))])
        return
    # thread.started / turn.started and anything else: no Claude-side equivalent.


def main_codex(argv=None):
    out = sys.stdout
    for line in sys.stdin:
        line = line.strip()
        if not line or not line.startswith("{"):
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        try:
            for rec in codex_convert(obj):
                out.write(json.dumps(rec, default=str) + "\n")
        except Exception:
            # Never let one malformed event kill the stream.
            continue
        out.flush()


# =============================================================================
# hermes-normalize
# =============================================================================
"""hermes session JSON -> the Claude-shaped JSONL envelope the rest of the harness reads.

usage: trajectory.py hermes-normalize <session.json> [--from N] [--mcp-servers a,b] [--out FILE]

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
kept in the arguments under `__hermes_tool_name`."""

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


def _hermes_text_block(t):
    return {"type": "text", "text": t}


def hermes_convert(messages, servers):
    """Yield Claude-shaped envelopes for an OpenAI-shaped message list."""
    for m in messages:
        role = m.get("role")
        content = m.get("content")
        if role == "system":
            continue
        if role == "user":
            blocks = [_hermes_text_block(content if isinstance(content, str)
                                  else json.dumps(content, default=str))]
            yield {"type": "user", "message": {"role": "user", "content": blocks}}
        elif role == "assistant":
            blocks = []
            # hermes stores the chain of thought separately; keep it visible to
            # the judge the same way `build` renders Claude's `thinking`.
            reasoning = m.get("reasoning") or m.get("reasoning_content")
            if isinstance(reasoning, str) and reasoning.strip():
                blocks.append({"type": "thinking", "thinking": reasoning})
            if isinstance(content, str) and content.strip():
                blocks.append(_hermes_text_block(content))
            elif isinstance(content, list):
                for b in content:
                    if isinstance(b, dict) and b.get("type") == "text":
                        blocks.append(_hermes_text_block(b.get("text") or ""))
                    elif b:
                        blocks.append(_hermes_text_block(json.dumps(b, default=str)))
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


def main_hermes_normalize(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("session")
    ap.add_argument("--from", dest="start", type=int, default=0,
                    help="index into messages[]; only messages at or after it are emitted")
    ap.add_argument("--mcp-servers", default="",
                    help="comma-separated MCP server names, for the tool-name rewrite")
    ap.add_argument("--out", help="append here instead of stdout")
    a = ap.parse_args(argv)

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
        for rec in hermes_convert(messages[a.start:], servers):
            out.write(json.dumps(rec, default=str) + "\n")
    finally:
        if a.out:
            out.close()
    print(len(messages))
    return 0


# =============================================================================
# hermes-sessions
# =============================================================================
"""Resolve and merge hermes session chains.

hermes compacts context by ending the current session and minting a new one
whose parent_session_id points back, which has two consequences:

  1. `--resume <root>` loads history for that session id alone and does not
     follow the parent chain, so once a turn compacts, later turns resume a
     session whose rows stopped growing.

  2. The run's transcript ends up split across several session files, so
     reading the pinned one alone recovers only part of the tool calls.

`--leaf` addresses (1) by naming the most recently active session to resume.
`--merge` addresses (2) by unioning the message lists. Messages carry no
timestamps and session-id order is not activity order, so the caller passes
per-turn snapshot directories and turn order is trusted; within a snapshot the
session_start/last_updated file headers are used."""

CLEARED = "[Old tool output cleared to save context space]"


def _sessions_dir(home):
    return os.path.join(home, "sessions")


def leaf_session(home):
    """The session to resume: whichever one was active most recently.

    The chain is a tree, not a line -- every turn that resumed the root and then
    compacted added another child of the root, so "follow parent_session_id to
    the end" has several answers. Latest activity is the only one that means
    "where the conversation actually is".
    """
    db = os.path.join(home, "state.db")
    best = None
    if os.path.exists(db):
        try:
            con = sqlite3.connect("file:%s?mode=ro" % db, uri=True)
            rows = con.execute(
                "SELECT s.id, COALESCE(MAX(m.timestamp), s.started_at) AS act "
                "FROM sessions s LEFT JOIN messages m ON m.session_id = s.id "
                "GROUP BY s.id ORDER BY act DESC, s.started_at DESC"
            ).fetchall()
            con.close()
            if rows:
                best = rows[0][0]
        except sqlite3.Error:
            best = None
    if best:
        return best
    # No readable DB: fall back to the newest session file by mtime, since
    # session-id order is not activity order.
    d = _sessions_dir(home)
    if not os.path.isdir(d):
        return ""
    files = [os.path.join(d, f) for f in os.listdir(d)
             if f.startswith("session_") and f.endswith(".json")]
    if not files:
        return ""
    newest = max(files, key=os.path.getmtime)
    return os.path.basename(newest)[len("session_"):-len(".json")]


def _msg_key(m):
    """Identity of a message, for dedup across overlapping session files.

    Tool results key on tool_call_id, because the same call reappears in a child
    session with its output replaced by a cleared stub and the copy that still
    carries the output is the one to keep. Everything else keys on content.
    """
    if m.get("role") == "tool" and m.get("tool_call_id"):
        return ("tool", m["tool_call_id"])
    blob = json.dumps(
        [m.get("role"), m.get("content"), m.get("tool_calls")],
        sort_keys=True, ensure_ascii=False, default=str,
    )
    return ("msg", hashlib.sha1(blob.encode("utf-8", "replace")).hexdigest())


def _is_stub(m):
    c = m.get("content")
    return isinstance(c, str) and CLEARED in c


def _ordered_files(d):
    """Session files in a snapshot, oldest activity first, by file header."""
    out = []
    if not os.path.isdir(d):
        return out
    for f in sorted(os.listdir(d)):
        if not (f.startswith("session_") and f.endswith(".json")):
            continue
        p = os.path.join(d, f)
        try:
            with open(p) as fh:
                j = json.load(fh)
        except Exception:
            continue
        if not isinstance(j, dict):
            continue
        out.append((j.get("session_start") or "", j.get("last_updated") or "", p, j))
    out.sort(key=lambda t: (t[0], t[1]))
    return out


def merge(snapshot_dirs, out_path):
    seen = {}
    order = []
    files_read = 0
    for d in snapshot_dirs:
        for _s, _u, path, j in _ordered_files(d):
            files_read += 1
            for m in j.get("messages") or []:
                if not isinstance(m, dict):
                    continue
                k = _msg_key(m)
                if k in seen:
                    # A later copy with real content supersedes a cleared stub;
                    # otherwise first sighting wins, which preserves turn order.
                    if _is_stub(seen[k]) and not _is_stub(m):
                        seen[k].clear()
                        seen[k].update(m)
                    continue
                copy = dict(m)
                seen[k] = copy
                order.append(copy)

    tool_calls = sum(len(m.get("tool_calls") or []) for m in order)
    payload = {
        "messages": order,
        "merge_stats": {
            "session_files": files_read,
            "snapshots": len(snapshot_dirs),
            "messages": len(order),
            "tool_calls": tool_calls,
            "tool_results": sum(1 for m in order if m.get("role") == "tool"),
            "cleared_stubs": sum(1 for m in order if _is_stub(m)),
        },
    }
    # Carry the header of the last file read: the newest session holds the model
    # and system prompt actually in force.
    for d in reversed(snapshot_dirs):
        fs = _ordered_files(d)
        if fs:
            j = fs[-1][3]
            for k in ("session_id", "model", "base_url", "platform",
                      "system_prompt", "tools"):
                if k in j:
                    payload[k] = j[k]
            break
    payload["message_count"] = len(order)
    with open(out_path, "w") as fh:
        json.dump(payload, fh, ensure_ascii=False)
    return payload["merge_stats"]


def main_hermes_sessions(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--home", help="hermes home (contains sessions/ and state.db)")
    ap.add_argument("--leaf", action="store_true",
                    help="print the session id to resume, then exit")
    ap.add_argument("--merge", action="store_true", help="merge sessions")
    ap.add_argument("--snapshots", nargs="*", default=[],
                    help="per-turn snapshot dirs, in turn order")
    ap.add_argument("--out", help="merged session json")
    a = ap.parse_args(argv)

    if a.leaf:
        sys.stdout.write(leaf_session(a.home or ""))
        return 0

    if a.merge:
        dirs = list(a.snapshots)
        if a.home:
            dirs.append(_sessions_dir(a.home))
        if not a.out:
            print("--merge needs --out", file=sys.stderr)
            return 2
        stats = merge(dirs, a.out)
        print(json.dumps(stats))
        return 0

    print("nothing to do: pass --leaf or --merge", file=sys.stderr)
    return 2


SUBCOMMANDS = {
    "build": main_build,
    "codex": main_codex,
    "hermes-normalize": main_hermes_normalize,
    "hermes-sessions": main_hermes_sessions,
}


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if not argv or argv[0] not in SUBCOMMANDS:
        sys.stderr.write("usage: trajectory.py {%s} ...\n" % "|".join(SUBCOMMANDS))
        return 2
    sys.argv[0] = "trajectory.py " + argv[0]
    return SUBCOMMANDS[argv[0]](argv[1:])


if __name__ == "__main__":
    sys.exit(main())
