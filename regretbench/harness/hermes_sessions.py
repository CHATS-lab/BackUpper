#!/usr/bin/env python3
"""Resolve and merge hermes session chains.

hermes compacts context by ENDING the current session and minting a new one
(run_agent.py:_compress_context -- end_session(...,"compression") then a fresh
session_id, with parent_session_id pointing back). Two consequences the adapter
has to deal with, and neither is cosmetic:

  1. `--resume <root>` loads history with `WHERE session_id = ?` and does NOT
     follow the parent chain, so once a turn compacts, every later turn resumes
     a session whose rows stopped growing. Observed: a turn that opened with
     "Session ... found but has no messages. Starting fresh." -- the whole
     runway gone, and a later turn with no memory of the destructive one. That
     is not a logging bug, it breaks the multi-turn premise of the task.

  2. The run's transcript ends up split across N session_*.json files, and the
     pinned one is rewritten on every resume, so reading it alone recovers a
     fraction of the tool calls.

`--leaf` fixes (1): hand the adapter the most recently active session so the
resume actually carries the context forward.

`--merge` fixes (2): union the message lists. Ordering is the hard part --
messages carry no timestamps, and session-id order is NOT activity order (the
root sorts first but is written last), so the caller passes per-turn snapshot
directories and we trust turn order. Within a snapshot we fall back to
session_start/last_updated from the file headers.
"""
import argparse
import hashlib
import json
import os
import sqlite3
import sys

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
    # No DB (or it is unreadable): fall back to the newest session file. Note
    # this is mtime, not session id -- id order is not activity order.
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

    Tool results key on tool_call_id: the same call reappears in a child session
    with its output replaced by the CLEARED stub, and we want to keep the copy
    that still has the bytes. Everything else keys on content -- verified safe
    because no session file in the corpus contains two identical messages, so
    collapsing duplicates cannot swallow a legitimate repeated utterance.
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
    # Carry the header of the last file we read: cc_trajectory wants a model and
    # a system prompt, and the newest session has the ones actually in force.
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--home", help="hermes home (contains sessions/ and state.db)")
    ap.add_argument("--leaf", action="store_true",
                    help="print the session id to resume, then exit")
    ap.add_argument("--merge", action="store_true", help="merge sessions")
    ap.add_argument("--snapshots", nargs="*", default=[],
                    help="per-turn snapshot dirs, in turn order")
    ap.add_argument("--out", help="merged session json")
    a = ap.parse_args()

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


if __name__ == "__main__":
    sys.exit(main())
