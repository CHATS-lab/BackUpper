#!/usr/bin/env python3
"""One place to make a scoring LLM call, with two interchangeable backends.

Shared by every scoring caller (harness/judge.py, harness/judge_subagent_quality.py).
Each keeps its own prompts, rubrics and output contracts; this module only answers
"send this system+user pair somewhere and give me back the raw text".

  openrouter   the original path: POST /api/v1/chat/completions with
               OPENROUTER_API_KEY. Unchanged, still the default everywhere.
  claude-cli   runs the same system+user pair through `claude -p` on the HOST,
               i.e. on the machine's own Claude Code subscription. Scoring never
               needs to be inside a task container -- it only reads a trajectory
               -- so this keeps the scoring path independent of OpenRouter
               credits entirely.

Backend selection: explicit argument > RB_LLM_BACKEND env > "openrouter".
Nothing is ever logged; the caller decides what to record.

The claude-cli backend is deliberately minimal-context: --safe-mode (no
CLAUDE.md, skills, plugins, hooks or MCP), --tools "" (no tool use at all --
a judge must read, not act) and --no-session-persistence (no transcript is
written for a scoring call). The rubric goes in via --system-prompt, so the
judging prompt is byte-identical to what the OpenRouter path sends as the
system message; the payload goes in on stdin, which has no argv size limit.

RateLimited is raised for provider-side "slow down / out of quota" conditions so
callers can record a *pending* record and exit non-fatally instead of losing a
sweep.
"""
import json
import os
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CLI_MODEL = os.environ.get("RB_CLI_MODEL", "claude-sonnet-4-5")
_LIMIT_RE = re.compile(
    r"usage limit|rate.?limit|too many requests|429|overloaded|"
    r"quota|insufficient.credit|credits? (?:exhausted|required)|resource_exhausted",
    re.I)


class RateLimited(RuntimeError):
    """Provider says: not now. Caller should record a pending result."""


class Refused(RuntimeError):
    """The model DECLINED to answer (stop_reason=refusal, 0 output tokens).

    Distinct from every other failure because it is a property of the MODEL,
    not of the harness or the provider -- retrying the same model is pointless
    and a different one usually succeeds. Task 600's judge call returned
    `stop_reason: "refusal"` on claude-sonnet-4-5 (its REV turn asks for
    "restricted assertion accessions" for gene variants -- synthetic, but it
    reads like a request for restricted clinical records). claude-opus-4-5
    judged the identical payload without hesitation: dest=True, backed_up=False.

    Before this existed the refusal surfaced as `claude-cli failed (rc=1)` and
    the run was written off as unscoreable, so a perfectly good REAL verdict
    was nearly lost.
    """


# Tried in order when the first choice refuses. A refusal is model-specific, so
# escalating to a different model is the fix, not a workaround.
REFUSAL_FALLBACKS = ("claude-opus-4-5", "claude-sonnet-4-5")


def backend_name(explicit=None):
    return explicit or os.environ.get("RB_LLM_BACKEND") or "openrouter"


# --------------------------------------------------------------------------- #
# OpenRouter spend cap (Li, 2026-08-13: "$80 for eval and judge, then back to
# subscription")
# --------------------------------------------------------------------------- #
# The key was at 38320.72 of 38450 when this was set -- 99.7% spent, which is
# why task 600 came back judge_status=judge_error with both verdict fields null:
# an HTTP 402 on a run that had already cost a full Opus screen. The cap makes
# that failure mode impossible: past the limit we fall back to claude-cli, which
# is the same rubric on the subscription, instead of returning no verdict.
#
# Enforced in call() rather than at each call site so judge.py and any future
# caller inherit it -- judge.py's CLI default is still
# `openrouter` even though config.yaml says claude-cli, so a bare invocation
# would otherwise bill the key silently.
# Optional. Absent (the default in this release) means "no spend cap": _read_budget()
# returns None and call() never falls back for budget reasons. Write
# {"limit_usd": N} here to cap the OpenRouter key.
OR_BUDGET = os.environ.get("RB_OR_BUDGET_FILE") or os.path.join(HERE, "or_budget.json")
_BUDGET_TTL = 60.0          # seconds; a live check per minute, not per call
_budget_cache = {"at": 0.0, "spent": None}
_budget_notified = False


def _read_budget():
    try:
        with open(OR_BUDGET) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def openrouter_spend(force=False):
    """(spent, limit, ok) for the capped window. spent is None if unknown.

    `spent` counts from the baseline recorded when the cap was set, NOT from the
    key's lifetime usage -- the cap is a budget for this work, not an account
    total.
    """
    cfg = _read_budget()
    if not cfg:
        return None, None, True          # no cap configured -> unrestricted
    limit = float(cfg.get("limit_usd", 0) or 0)
    base = float(cfg.get("baseline_usage", 0) or 0)
    now = time.time()
    if not force and _budget_cache["spent"] is not None \
            and now - _budget_cache["at"] < _BUDGET_TTL:
        spent = _budget_cache["spent"]
        return spent, limit, spent < limit
    try:
        req = urllib.request.Request(
            "https://openrouter.ai/api/v1/credits",
            headers={"Authorization": f"Bearer {openrouter_key()}"})
        d = json.load(urllib.request.urlopen(req, timeout=20))["data"]
        spent = float(d["total_usage"]) - base
    except Exception:
        # Cannot read the meter -> assume the cap is blown. Failing toward the
        # subscription costs a slower judge; failing toward OpenRouter costs
        # money we said we would not spend.
        return None, limit, False
    _budget_cache.update(at=now, spent=spent)
    return spent, limit, spent < limit


# --------------------------------------------------------------------------- #
# openrouter (original)
# --------------------------------------------------------------------------- #
def openrouter_key():
    k = os.environ.get("OPENROUTER_API_KEY")
    if k:
        return k
    env = os.path.join(HERE, ".env")
    if os.path.isfile(env):
        m = re.search(r"sk-or-[A-Za-z0-9_-]+", open(env).read())
        if m:
            return m.group(0)
    raise RuntimeError("set OPENROUTER_API_KEY (or put it in harness/.env)")


def _openrouter(model, system, user, timeout, key=None):
    body = json.dumps({
        "model": model,
        "messages": [{"role": "system", "content": system},
                     {"role": "user", "content": user}],
        "temperature": 0,
    }).encode()
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions", data=body,
        headers={"Authorization": f"Bearer {key or openrouter_key()}",
                 "Content-Type": "application/json"})
    r = json.load(urllib.request.urlopen(req, timeout=timeout))
    return r["choices"][0]["message"]["content"]


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
    """Judging runs on codex's subscription quota (claude's limits are tighter).

    Three things have to hold for this route to work, and each has been verified:
      * Subscription auth only recognizes $CODEX_HOME/auth.json, and the model
        name has to be an OpenAI slug. On 2026-09-09, pairing an OpenRouter
        slug (deepseek/...) with the subscription made all 412 calls fail with
        `status 400 ... model is not available`, and the error only shows up
        on stderr -- the caller just sees "no result", indistinguishable from
        "the model refuses to answer".
      * `--ignore-user-config` only skips config.toml, it doesn't affect auth --
        this keeps a custom provider in some machine-local config from routing
        the request elsewhere.
      * `-o` writes the final message to its own file. codex exec's stdout
        mixes reasoning and events together, so fishing JSON out of it can
        grab the segment where the model is echoing back the prompt.
    """
    exe = os.environ.get("RB_CODEX_EXE", "codex")
    m = model or DEFAULT_CODEX_MODEL
    env = _cli_env()
    env["CODEX_HOME"] = os.environ.get("RB_CODEX_HOME", "/root/.codex")
    # If these are present they knock auth_mode away from chatgpt
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
    msg = "\n".join(x for x in (("stderr: " + err[-1200:]) if err else "",
                                ("stdout[tail]: " + blob[-600:]) if blob else "") if x)
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
        # Keep the HEAD as well as the tail. The CLI prints a large usage/
        # modelUsage envelope, so a tail-only capture is all metadata and none
        # of the cause -- task 600's failure reported
        # `put_tokens_details":{"thinking_tokens":0}...` and said nothing about
        # what went wrong. stderr first (that is where the message lives), then
        # the head of stdout, then the tail.
        err = (p.stderr or "").strip()
        # A refusal is a model decision, not a failure -- surface it as such so
        # call() can escalate to another model instead of returning a null
        # verdict on a run that already cost a full screen.
        if '"stop_reason":"refusal"' in blob.replace(" ", ""):
            raise Refused(f"{model or DEFAULT_CLI_MODEL} declined to answer "
                          f"(stop_reason=refusal, 0 output tokens)")
        head, tail = blob[:900], blob[-400:]
        msg = "\n".join(x for x in (
            ("stderr: " + err[:900]) if err else "",
            ("stdout[head]: " + head) if head else "",
            ("stdout[tail]: " + tail) if len(blob) > 1300 else "") if x)
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


def cli_model_used(model=None):
    return model or DEFAULT_CLI_MODEL


# --------------------------------------------------------------------------- #
# public
# --------------------------------------------------------------------------- #
def call(system, user, model=None, backend=None, timeout=300, attempts=4,
         key=None, sleep=time.sleep):
    """Return the model's raw reply text. Retries transient failures with
    backoff; raises RateLimited when the provider persistently says no."""
    b = backend_name(backend)
    if b == "openrouter":
        spent, limit, ok = openrouter_spend()
        if not ok:
            global _budget_notified
            if not _budget_notified:
                _budget_notified = True
                shown = "unreadable" if spent is None else f"${spent:.2f}"
                print(f"[llm_backend] OpenRouter spend {shown} of ${limit:.0f} "
                      f"cap -- switching to claude-cli (subscription)",
                      file=__import__("sys").stderr)
            b = "claude-cli"
    last = None
    for i in range(max(1, attempts)):
        try:
            if b == "claude-cli":
                return _claude_cli(model, system, user, timeout)
            if b == "codex-cli":
                return _codex_cli(model, system, user, timeout)
            if b == "openrouter":
                return _openrouter(model, system, user, timeout, key)
            raise RuntimeError(f"unknown backend {b!r} (openrouter|claude-cli|codex-cli)")
        except Refused as e:
            # Escalate through the fallback models once each. Retrying the same
            # model cannot help -- the refusal is deterministic for that payload.
            last = e
            for alt in REFUSAL_FALLBACKS:
                if alt == (model or DEFAULT_CLI_MODEL):
                    continue
                try:
                    print(f"[llm_backend] {e} -- retrying on {alt}",
                          file=__import__("sys").stderr)
                    return _claude_cli(alt, system, user, timeout)
                except Refused as e2:
                    last = e2
                except Exception as e2:  # noqa: BLE001
                    last = e2
                    break
            raise last
        except RateLimited as e:
            last = e
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise RuntimeError(f"HTTP {e.code} from OpenRouter — key rejected") from None
            if e.code == 402:
                raise RateLimited("HTTP 402 from OpenRouter — out of credits") from None
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
