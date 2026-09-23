#!/usr/bin/env python3
"""Headless OpenHands SDK spawn for the CHATS-Sandbox tier-3 subagent.

The OpenHands SDK ships no headless one-shot CLI (the `openhands` binary is
the legacy GUI/server app), so the openhands subagent runner invokes this
script with an interpreter that can import openhands.sdk
(config.subagentOpenhandsPython / $CHATS_SANDBOX_OH_PY).

argv:  <prompt_file> <litellm_model> [mcp_config_json_file]
env:   OPENROUTER_API_KEY or LLM_API_KEY   (the spawn's key)
       CHATS_SANDBOX_OH_SUB_USAGE          (optional usage-jsonl out path —
                                            the tok_sub accounting source,
                                            same shape as OH_USAGE_OUT)
       CHATS_SANDBOX_OH_SUB_MAX_ITER       (default 12)
cwd:   the agent workspace (the subagent prompt's relative paths and the
       subagent_result.json contract resolve from here)

The prompt file carries the FULL backup/restore contract (write
subagent_result.json etc.); the SDK's default agent in cli_mode executes it
with terminal+file_editor plus the given MCP servers. Hooks are NOT loaded
(no hook_config) — the CHATS_SANDBOX_NO_HOOK env guard is belt and braces.
"""
import json
import os
import signal
import sys
from pathlib import Path

os.environ.setdefault("OPENHANDS_SUPPRESS_BANNER", "1")

# The result watcher SIGTERMs this spawn the moment subagent_result.json is
# valid. Python's default SIGTERM disposition kills the process WITHOUT
# unwinding — the usage dump in main()'s `finally` (the tok_sub accounting
# source) would be lost on every successful spawn. Convert to SystemExit so
# the stack unwinds; the watcher's 10s grace before SIGKILL is ample.
signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
signal.signal(signal.SIGINT, lambda *_: sys.exit(130))


def _dump_transcript(conversation) -> None:
    """Write the conversation's events as JSONL to CHATS_SANDBOX_OH_SUB_TRANSCRIPT.

    One JSON object per line, so the file reads like every other runner's
    step record. Never raises.
    """
    out = os.environ.get("CHATS_SANDBOX_OH_SUB_TRANSCRIPT")
    if not out:
        return
    try:
        events = None
        for accessor in (
            lambda c: c.state.events,
            lambda c: c._state.events,        # noqa: SLF001 - version fallback
            lambda c: c.state.history,
            lambda c: c.events,
        ):
            try:
                events = accessor(conversation)
            except Exception:
                continue
            if events is not None:
                break
        if not events:
            return
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        with open(out, "w", encoding="utf-8") as f:
            for ev in events:
                try:
                    # pydantic models (the normal case) serialise themselves
                    line = ev.model_dump_json()
                except Exception:
                    try:
                        line = json.dumps(ev, default=str)
                    except Exception:
                        line = json.dumps({"repr": repr(ev)[:20000]})
                f.write(line.replace("\n", " ") + "\n")
    except Exception as e:                                     # noqa: BLE001
        sys.stderr.write("openhands subagent: transcript dump failed: %s\n" % e)


def main() -> int:
    prompt = Path(sys.argv[1]).read_text()
    # the invocation builder writes the prompt to os.tmpdir() and never
    # unlinks it — clean up here so production installs don't leak one
    # file per tier-3 spawn (bench per-run TMPDIRs are wiped anyway)
    try:
        Path(sys.argv[1]).unlink()
    except OSError:
        pass
    model = sys.argv[2]
    mcp_file = sys.argv[3] if len(sys.argv) > 3 else None

    from pydantic import SecretStr
    from openhands.sdk import LLM, Conversation
    from openhands.tools.preset.default import get_default_agent

    api_key = os.environ.get("LLM_API_KEY") or os.environ.get("OPENROUTER_API_KEY") or ""
    llm = LLM(usage_id="chats-backup-subagent", model=model, api_key=SecretStr(api_key))
    agent = get_default_agent(llm=llm, cli_mode=True)
    if mcp_file:
        try:
            agent = agent.model_copy(
                update={"mcp_config": json.loads(Path(mcp_file).read_text())})
        except Exception as e:
            sys.stderr.write(f"openhands subagent: bad mcp config: {e}\n")

    max_iter = int(os.environ.get("CHATS_SANDBOX_OH_SUB_MAX_ITER", "12"))
    conversation = Conversation(
        agent=agent, workspace=os.getcwd(), max_iteration_per_run=max_iter)
    conversation.send_message(prompt)
    try:
        conversation.run()
    finally:
        # STEP-BY-STEP TRANSCRIPT. Unlike claude/hermes/codex/openclaw, this
        # runner has no session store on disk to copy out of -- the SDK
        # Conversation lives and dies inside this process. So dump the event
        # stream ourselves, straight into the action dir the caller named in
        # CHATS_SANDBOX_OH_SUB_TRANSCRIPT. Reached even when the result watcher
        # SIGTERMs us, because the handler at the top of this file converts
        # SIGTERM into SystemExit so the stack unwinds through this `finally`.
        # Entirely best-effort and entirely defensive: the SDK's event access
        # differs across versions, and a transcript dump must never be able to
        # fail a backup that has already been written.
        _dump_transcript(conversation)
        usage_out = os.environ.get("CHATS_SANDBOX_OH_SUB_USAGE")
        if usage_out and llm.metrics is not None:
            try:
                with open(usage_out, "a") as f:
                    for u in (llm.metrics.token_usages or []):
                        f.write(json.dumps({"usage": {
                            "input": getattr(u, "prompt_tokens", 0) or 0,
                            "output": getattr(u, "completion_tokens", 0) or 0,
                            "cacheRead": getattr(u, "cache_read_tokens", 0) or 0,
                        }}) + "\n")
            except Exception as e:
                sys.stderr.write(f"openhands subagent: usage dump failed: {e}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
