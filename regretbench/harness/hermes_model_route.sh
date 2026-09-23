# The single definition, on the hermes route, of "model name -> upstream name + upstream
# URL". Both run_task.sh (v1, single-turn) and adapters/hermes.sh (v2, multi-turn) source
# it -- don't copy a second one.
#
# Why this layer is needed (measured 2026-08-19 by curling the upstream directly, not guessed)
# ---------------------------------------------------------------
# REDACTED-ENDPOINT's two OpenAI-shaped routes **307 each other depending on model family**:
#
#   /experimental/passthrough/openai/v1 + claude-*                  -> 307 -> /compat/
#   /experimental/compat/openai/v1      + terra|sol|gemini|deepseek -> 307 -> /passthrough/
#
# And once you land on /compat, the whitelisted name claude-code uses isn't recognized there:
#
#   /compat + claude-opus-5        -> 400 {"detail":"Invalid model name 'claude-opus-5'"}
#   /compat + claude-opus-5  -> 200, tool_calls work fine (streaming too)
#
# Stacked together, these two facts are the entire reason opus/sonnet get tool_calls=0 on
# hermes: hermes uses the openai SDK (httpx), which **does** follow the 307 on a POST, so the
# request really does reach /compat -- and then every turn gets bounced by a 400 "Invalid
# model name 'claude-opus-5'", which hermes classifies as non-retryable and aborts on the
# spot. The Endpoint line printed in the log is the configured base_url (passthrough), not
# the one that actually returned the 400, which makes this easy to misread when
# investigating. See results/_ablation_smoke/opus__hermes/*/hermes_stdout.log.
#
# The name table reuses env-llama.sh's RB_MODEL_MAP directly -- the claude-gateway route does
# the same thing (whitelisted name -> gateway name), and two tables would inevitably drift
# apart, so we keep only one.
#
# The mapping only affects **the name sent to the upstream**. run.sh's summary.csv,
# trajectory, and run directory names still carry the caller's original claude-opus-5, so the
# model labels stay comparable across ablation arms.

# rb_hermes_route <model>
#   Sets three variables (all exported):
#     HERMES_UPSTREAM_MODEL      the name passed to `hermes chat -m`
#     OPENROUTER_BASE_URL        the route this model should hit
#     HERMES_FORCE_NON_STREAMING claude=1, everything else=0 (see the reasoning in the case
#                                 block below)
#   Non-claude models: name unchanged, URL reverts to whatever the caller originally set,
#   streaming unchanged.
rb_hermes_route() {
  local want="$1" pair k v map="${RB_MODEL_MAP:-}"
  HERMES_UPSTREAM_MODEL="$want"
  # RB_MODEL_MAP may not be set (when env-llama.sh hasn't been sourced): in that case only
  # do the endpoint check, don't rename anything.
  for pair in ${map//,/ }; do
    k="${pair%%=*}"; v="${pair#*=}"
    [ "$k" = "$want" ] && [ -n "$v" ] && { HERMES_UPSTREAM_MODEL="$v"; break; }
  done
  # The non-claude route needs to revert to "whatever URL the caller originally set," so
  # stash it away on the first call. This function gets re-sourced and called by
  # adapters/hermes.sh on every turn; without stashing it, the second call would treat the
  # compat URL it wrote last time as "the original" and never be able to get back to
  # passthrough.
  : "${RB_HERMES_BASE_URL_ORIG:=${OPENROUTER_BASE_URL:-}}"
  export RB_HERMES_BASE_URL_ORIG
  # Determine the family from the **mapped** name: both the client's whitelisted name and the
  # name actually served by the upstream (both already normalized here to claude-opus-5)
  # need to land on compat, and a claude name not present in RB_MODEL_MAP (e.g. one added
  # later) must not silently take the wrong route either.
  case "$HERMES_UPSTREAM_MODEL" in
    *claude*)
      # Explicitly target compat rather than relying on the SDK to follow the 307: one fewer
      # round trip, and it won't silently degrade to 0 tool calls the day the upstream swaps
      # the 307 for a different status code (or a client that doesn't follow redirects).
      OPENROUTER_BASE_URL="${RB_COMPAT_BASE_URL:-https://REDACTED-ENDPOINT/compat/openai/v1}"
      # /compat's **streaming** OpenAI-compat layer is broken for Claude: the tool_call
      # deltas never carry an id, and the raw chunk of a second, parallel tool_use gets
      # spliced into the first call's arguments string. hermes then mints its own
      # call_<hex> id, and the next turn's request gets killed by an upstream 500 'Out of
      # bounds dict access: invalid index "tool_call_id"', stalling the whole run on its
      # first tool call (measured 2026-08-19, scripts/_probe/rb-probe5.py; the proxy on the
      # codex route hits the same pothole, see responses_to_chat_proxy.wants_non_stream).
      # The non-streaming response for the same conversation returns correct ids for both
      # the call and the parallel calls, so streaming is turned off here. Only for claude:
      # other models keep streaming as before, with the same request body as the other arms.
      HERMES_FORCE_NON_STREAMING=1
      ;;
    *)
      OPENROUTER_BASE_URL="$RB_HERMES_BASE_URL_ORIG"
      HERMES_FORCE_NON_STREAMING=0
      ;;
  esac
  # --- context_length ---------------------------------------------------------
  # hermes cannot discover this on its own here. get_model_context_length()
  # (agent/model_metadata.py) treats REDACTED-ENDPOINT as a custom endpoint, asks it
  # for /models, gets a 404, and returns DEFAULT_FALLBACK_CONTEXT = 128,000 at
  # :912 -- an early return, so models.dev and its own DEFAULT_CONTEXT_LENGTHS
  # table are never consulted. Editing that table therefore does nothing; the
  # value has to come from config.yaml, which run_task.sh writes from here.
  #
  # 128,000 with the default 0.50 threshold means compaction at 64k. Across 1281
  # hermes runs on disk, 495 (39%) compacted, 1202 times in total -- and the
  # largest single request in any of them had an over-estimated ceiling of 361k.
  # Every one of those compactions was an artefact of this number. They are not
  # free: compaction ends the session and mints a child, and `--resume` does not
  # follow the chain, so the agent loses its own memory of earlier turns.
  #
  # Real limits, curl'd 2026-08-23 -- the upstream states them in the 400 body:
  #   deepseek-v4-pro   "model maximum context length: 1048575"
  #   gemini-3-7-flash      "maximum number of tokens allowed 1048576"
  #   claude-opus-5 /compat "prompt is too long: ... > 1000000 maximum"
  # An unknown model keeps 128,000 rather than inheriting someone else's limit.
  case "$HERMES_UPSTREAM_MODEL" in
    *claude*)   HERMES_CONTEXT_LENGTH=1000000 ;;
    *gemini*)   HERMES_CONTEXT_LENGTH=1048576 ;;
    *deepseek*) HERMES_CONTEXT_LENGTH=1048575 ;;
    *)          HERMES_CONTEXT_LENGTH=128000  ;;
  esac

  # --- per-model credential ----------------------------------------------------
  # The default key does not carry deepseek: chat/completions answers
  # REDACTED-SYM-ModelAccessDeniedException for deepseek-v4-pro while gemini,
  # claude (/compat) and the two gpt-5-6 -responses models all succeed on it
  # (curl'd 2026-08-23, both keys, both endpoint shapes). So deepseek keeps the
  # older key and everything else moves to the new one. Overriding here rather
  # than in env-hermes.sh because the model is not known until this function runs.
  case "$HERMES_UPSTREAM_MODEL" in
    *deepseek*)
      if [ -s "${RB_DEEPSEEK_KEY_FILE:-}" ]; then
        OPENROUTER_API_KEY="$(tr -d '\n' < "${RB_DEEPSEEK_KEY_FILE:-}")"
        RB_UPSTREAM_KEY="$OPENROUTER_API_KEY"
        export OPENROUTER_API_KEY RB_UPSTREAM_KEY
      else
        echo "[warn] deepseek key file missing; falling back to the default key" >&2
      fi
      ;;
  esac

  export OPENROUTER_BASE_URL HERMES_UPSTREAM_MODEL HERMES_FORCE_NON_STREAMING \
         HERMES_CONTEXT_LENGTH
}
