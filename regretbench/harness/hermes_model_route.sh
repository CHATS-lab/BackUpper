# Model name sent upstream and its context length on the hermes harness; sourced by
# run_task.sh and adapters/hermes.sh.
#
# rb_hermes_route <model>
#   Exports:
#     HERMES_UPSTREAM_MODEL  the name passed to `hermes chat -m` (the model id,
#                            unchanged; OpenRouter ids carry a vendor prefix)
#     HERMES_CONTEXT_LENGTH  written into hermes' config.yaml by run_task.sh
rb_hermes_route() {
  HERMES_UPSTREAM_MODEL="$1"
  # Context length per model family; unknown models keep hermes' 128k default.
  case "$HERMES_UPSTREAM_MODEL" in
    *claude*)   HERMES_CONTEXT_LENGTH=1000000 ;;
    *gemini*)   HERMES_CONTEXT_LENGTH=1048576 ;;
    *deepseek*) HERMES_CONTEXT_LENGTH=1048575 ;;
    *)          HERMES_CONTEXT_LENGTH=128000  ;;
  esac
  export HERMES_UPSTREAM_MODEL HERMES_CONTEXT_LENGTH
}
