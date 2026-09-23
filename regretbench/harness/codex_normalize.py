#!/usr/bin/env python3
"""Normalize codex-cli's `codex exec --json` event stream into the SAME
JSONL envelope Claude Code's `--output-format stream-json` emits, so every
downstream consumer that already understands that shape needs zero changes:

  harness/asks_confirmation.py   reads {"message":{"role":"assistant",
                                  "content":[{"type":"text","text":...}]}}
  harness/predicate.py           commands_in() reads {"message":{"content":
                                  [{"type":"tool_use","input":{"command":...}}]}}
  harness/cc_trajectory.py       records() reads {"type":"user"|"assistant",
                                  "message":{...}}
  any tool-call counter          counts messages[].tool_calls in trajectory.json
                                  (produced by cc_trajectory.py from the above)

Usage: codex exec ... --json | codex_normalize.py >> claude_stream.jsonl
(stdin: one codex event object per line. stdout: zero or more Claude-shaped
lines per input line. Never raises on a line it doesn't recognize -- it is
far cheaper to lose one event's fidelity than to break the whole pipeline,
and a caller that tees stdin to codex_stream.raw.jsonl keeps the original for
post-hoc repair.)

VERIFIED against real `codex exec --json` output from codex-cli 0.146.0 via
openrouter (2026-08-06). The captured wire format is a BARE object per line:

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

An earlier version of this file was written from `strings` on the stripped
binary and keyed off the INTERNAL Rust enum names (ExecCommandBegin/End,
TaskStarted, AgentMessageDelta, ...). Those names never appear on the wire:
the `--json` surface uses item.* / turn.* / thread.* with a nested `item`
carrying its own `type`. That version matched nothing, so every run would
have normalized to zero tool calls and zero assistant text -- the nudge would
never fire and the judge would grade an empty trajectory as "never acted".
Re-validate against codex_stream.raw.jsonl if codex-cli is upgraded.
"""
import json
import sys

# command_execution items seen as item.started but not yet item.completed,
# keyed by item id. A run killed mid-command (agent_timeout, container stop)
# still has to show that the command was ISSUED -- dropping it would score a
# destruction that hung as though the agent never tried.
_OPEN_CALLS = {}


def _cmd_to_str(cmd):
    if isinstance(cmd, list):
        return " ".join(str(c) for c in cmd)
    return str(cmd) if cmd is not None else ""


def _assistant(blocks):
    return {"type": "assistant", "message": {"role": "assistant", "content": blocks}}


def _text_block(text):
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
        # Claude's Bash shape: predicate.py's commands_in() reads input.command,
        # so the destructive command must land in exactly that key.
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


def convert(obj):
    """Yield zero or more Claude-shaped records for one codex event."""
    if not isinstance(obj, dict):
        return
    # Tolerate a wrapped envelope ({"id":..,"msg":{...}}) in case a future
    # codex-cli reverts to it; the 0.146.0 wire format is the bare object.
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
            yield _assistant([_text_block(item.get("text"))])
            return
        if it == "reasoning":
            txt = item.get("text") or item.get("summary") or ""
            if txt:
                yield _assistant([{"type": "thinking", "thinking": txt}])
            return
        if it == "error":
            yield _assistant([_text_block("[error] " + str(item.get("message") or item))])
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
        yield _assistant([_text_block("[error] " + str(obj.get("message") or obj))])
        return
    # thread.started / turn.started and anything else: no Claude-side equivalent.


def main():
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
            for rec in convert(obj):
                out.write(json.dumps(rec, default=str) + "\n")
        except Exception:
            # Never let one malformed event kill the stream.
            continue
        out.flush()


if __name__ == "__main__":
    main()
