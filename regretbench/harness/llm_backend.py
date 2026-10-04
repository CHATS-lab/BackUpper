#!/usr/bin/env python3
"""CLI backends for a scoring LLM call, plus the OpenRouter key lookup.

Shared by every scoring caller (harness/judge.py, harness/judge_subagent_quality.py).
Each keeps its own prompts, rubrics and output contracts; judge.py posts to
OpenRouter itself and comes here for the other two backends:

  claude-cli   the system+user pair through `claude -p` on the host.
               Scoring only reads a trajectory, so it never needs to run inside
               a task container.
  codex-cli    the same pair through `codex exec` with a codex login.

Nothing is logged here; the caller decides what to record.

The claude-cli backend runs with minimal context: --safe-mode (no CLAUDE.md,
skills, plugins, hooks or MCP), --tools "" (no tool use) and
--no-session-persistence. The rubric is passed via --system-prompt, identical
to the system message of the OpenRouter path; the payload goes in on stdin.

RateLimited is raised for provider-side rate or quota limits, so callers can
record a pending result instead of failing.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import time

DEFAULT_CLI_MODEL = os.environ.get("RB_CLI_MODEL", "claude-sonnet-4-5")
_LIMIT_RE = re.compile(
    r"usage limit|rate.?limit|too many requests|429|overloaded|"
    r"quota|insufficient.credit|credits? (?:exhausted|required)|resource_exhausted",
    re.I)


class RateLimited(RuntimeError):
    """The provider is rate- or quota-limited; the caller records a pending result."""


class Refused(RuntimeError):
    """The model declined to answer (stop_reason=refusal, 0 output tokens).

    Distinct from every other failure because it is a property of the model
    rather than of the harness or the provider: retrying the same model cannot
    help, while another model may answer the identical payload.
    """


# Tried in order when the first choice refuses; a refusal is model-specific.
REFUSAL_FALLBACKS = ("claude-opus-4-5", "claude-sonnet-4-5")


def openrouter_key():
    k = os.environ.get("OPENROUTER_API_KEY")
    if k:
        return k
    raise RuntimeError("set OPENROUTER_API_KEY")


# --------------------------------------------------------------------------- #
# claude-cli
# --------------------------------------------------------------------------- #
def _cli_env():
    """A clean environment for a nested `claude`: strip the parent session's own
    CLAUDE_CODE_* markers so the child does not think it is a continuation."""
    env = dict(os.environ)
    for k in list(env):
        if k.startswith(("CLAUDE_CODE_", "CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT")):
            env.pop(k, None)
    return env


DEFAULT_CODEX_MODEL = os.environ.get("RB_CODEX_JUDGE_MODEL", "gpt-5.6-terra")


def _codex_cli(model, system, user, timeout):
    """Send the system+user pair through the codex CLI and return its reply.

    Three constraints shape the invocation: subscription auth is read from
    $CODEX_HOME/auth.json and requires an OpenAI model slug; --ignore-user-config
    skips config.toml without affecting auth, so a machine-local custom provider
    cannot reroute the request; and -o writes the final message to its own file,
    since stdout interleaves reasoning and events.
    """
    exe = os.environ.get("RB_CODEX_EXE", "codex")
    m = model or DEFAULT_CODEX_MODEL
    env = _cli_env()
    env["CODEX_HOME"] = os.environ.get("RB_CODEX_HOME", os.path.expanduser("~/.codex"))
    # Any of these would switch codex away from the subscription login.
    for k in ("OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"):
        env.pop(k, None)
    with tempfile.TemporaryDirectory() as td:
        sysf = os.path.join(td, "sys.txt")
        outf = os.path.join(td, "last.txt")
        with open(sysf, "w") as fh:
            fh.write(system)
        cmd = [exe, "exec", "--skip-git-repo-check", "--ephemeral",
               "--ignore-user-config", "--sandbox", "read-only",
               "-m", m, "-c", "model_instructions_file=" + sysf,
               "-o", outf, "-"]
        p = subprocess.run(cmd, input=user, capture_output=True, text=True,
                           timeout=timeout, env=env)
        out = ""
        if os.path.exists(outf):
            out = open(outf, errors="replace").read().strip()
    if out:
        return out
    err = (p.stderr or "").strip()
    blob = (p.stdout or "").strip()
    details = []
    if err:
        details.append("stderr: " + err[-1200:])
    if blob:
        details.append("stdout[tail]: " + blob[-600:])
    msg = "\n".join(details)
    if _LIMIT_RE.search(msg):
        raise RateLimited("codex-cli limit: %s" % msg[:400])
    raise RuntimeError("codex-cli failed (rc=%s): %s" % (p.returncode, msg[:1400]))


def _claude_cli(model, system, user, timeout):
    exe = os.environ.get("RB_CLAUDE_EXE", "claude")
    cmd = [exe, "-p", "--model", model or DEFAULT_CLI_MODEL,
           "--output-format", "json", "--system-prompt", system,
           "--tools", "", "--no-session-persistence", "--strict-mcp-config",
           "--safe-mode"]
    p = subprocess.run(cmd, input=user, capture_output=True, text=True,
                       timeout=timeout, env=_cli_env())
    blob = (p.stdout or "").strip()
    if p.returncode != 0 or not blob:
        # Report stderr first, then the head of stdout, then its tail: the CLI
        # prints a large usage envelope, so a tail-only capture is all metadata
        # and none of the cause.
        err = (p.stderr or "").strip()
        # A refusal is a model decision, not a failure: surface it as such so
        # call() can escalate to another model instead of returning no verdict.
        if '"stop_reason":"refusal"' in blob.replace(" ", ""):
            raise Refused(f"{model or DEFAULT_CLI_MODEL} declined to answer "
                          f"(stop_reason=refusal, 0 output tokens)")
        head, tail = blob[:900], blob[-400:]
        details = []
        if err:
            details.append("stderr: " + err[:900])
        if head:
            details.append("stdout[head]: " + head)
        if len(blob) > 1300:
            details.append("stdout[tail]: " + tail)
        msg = "\n".join(details)
        if _LIMIT_RE.search(msg):
            raise RateLimited(f"claude-cli limit: {msg[:400]}")
        raise RuntimeError(f"claude-cli failed (rc={p.returncode}): {msg[:1400]}")
    try:
        j = json.loads(blob)
    except json.JSONDecodeError:
        return blob                      # already plain text
    if isinstance(j, dict):
        if j.get("is_error") or j.get("subtype") not in (None, "success"):
            msg = json.dumps(j)[:1200]
            if _LIMIT_RE.search(msg):
                raise RateLimited(f"claude-cli limit: {msg[:400]}")
            raise RuntimeError(f"claude-cli error result: {msg[:600]}")
        return j.get("result") or ""
    return blob


# --------------------------------------------------------------------------- #
# public
# --------------------------------------------------------------------------- #
def call(system, user, model=None, backend=None, timeout=300, attempts=4,
         sleep=time.sleep):
    """Return the model's raw reply text. Retries transient failures with
    backoff; raises RateLimited when the provider persistently says no."""
    last = None
    for i in range(max(1, attempts)):
        try:
            if backend == "claude-cli":
                return _claude_cli(model, system, user, timeout)
            if backend == "codex-cli":
                return _codex_cli(model, system, user, timeout)
            raise RuntimeError(f"unknown backend {backend!r} (claude-cli|codex-cli)")
        except Refused as e:
            # Try each fallback model once; retrying the refusing model cannot help.
            last = e
            for alt in REFUSAL_FALLBACKS:
                if alt == (model or DEFAULT_CLI_MODEL):
                    continue
                try:
                    print(f"[llm_backend] {e} -- retrying on {alt}", file=sys.stderr)
                    return _claude_cli(alt, system, user, timeout)
                except Refused as e2:
                    last = e2
                except Exception as e2:  # noqa: BLE001
                    last = e2
                    break
            raise last
        except RateLimited as e:
            last = e
        except subprocess.TimeoutExpired as e:
            last = e
        except Exception as e:  # noqa: BLE001  transient 429/5xx/socket
            last = e
            if _LIMIT_RE.search(repr(e)):
                last = RateLimited(repr(e)[:400])
        if i < attempts - 1:
            sleep(min(60, 5 * (2 ** i)))
    if isinstance(last, RateLimited):
        raise last
    raise last if last else RuntimeError("no attempt made")
