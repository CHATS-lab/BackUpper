# backupper_install.sh -- install the BackUpper inside a task container.
# Sourced by run_task_claude.sh and run_task_codex.sh (the agents that run in the
# container); run_task.sh installs it on the host for hermes.
#
# bu_install_in_container AGENT RUNNER MODEL [KEY=VALUE ...]
#   AGENT   claude-code | codex       (the argument of `backupper install`)
#   RUNNER  claude | codex            (the key of subagentModels for MODEL)
#   MODEL   the tier-4 subagent's model
#   KEY=VALUE  further `backupper config set` pairs
#
# Reads CID, CWD, RUN, AGENT_UID, BU_STORE_IN and BU_STORE_ENV from the caller,
# and RB_BU_PKG (from pack_backupper.sh), RB_BU_NODE_DIR, RB_BU_MODE,
# RB_BU_RUNNER, RB_BU_SUBAGENT_TIMEOUT and RB_BU_EXPERIENCES from the environment;
# BU_EXTRA_PATH, if set, is placed on the agent's PATH after the BackUpper's own.
# Sets BU_PATH_ENV (docker exec -e flags for the agent) and BU_SUMMARY.
# Everything is placed under /opt/rbbu except the hook registration that
# `backupper install` writes into the workspace and the store itself.

BUDIR=/opt/rbbu
BU_NODE_IN="$BUDIR/nodejs/bin/node"
BU_CLI_IN="$BUDIR/package/dist/cli.js"

# _bu_cli ARGS...: the installed CLI, run as root in the workspace on the same store as the hooks.
_bu_cli() {
  docker exec -u 0 -w "$CWD" "${BU_STORE_ENV[@]+"${BU_STORE_ENV[@]}"}" "$CID" \
    "$BU_NODE_IN" "$BU_CLI_IN" "$@"
}

bu_install_in_container() {
  local agent="$1" runner="$2" model="$3"; shift 3
  local pkg="${RB_BU_PKG:-}" node_src="${RB_BU_NODE_DIR:-}" node_real hookfile kv
  [ -s "$pkg" ] || { echo "[fail] RB_BU_PKG is not a packed BackUpper (see pack_backupper.sh): '$pkg'"; return 1; }
  [ -x "$node_src/bin/node" ] || { echo "[fail] RB_BU_NODE_DIR has no bin/node: '$node_src'"; return 1; }

  # A private node runtime: task images are not expected to ship one. Only bin/
  # and lib/ are needed; --no-same-owner because a rootless userns cannot chown.
  node_real="$(basename "$(readlink -f "$node_src")")"
  docker exec -u 0 "$CID" mkdir -p "$BUDIR/bin" || { echo "[fail] mkdir $BUDIR"; return 1; }
  tar -C "$(dirname "$(readlink -f "$node_src")")" -czf "$RUN/.node.tgz" "$node_real/bin" "$node_real/lib" 2>/dev/null
  docker cp "$RUN/.node.tgz" "$CID:$BUDIR/node.tgz" >/dev/null && rm -f "$RUN/.node.tgz"
  docker exec -u 0 "$CID" sh -c "cd $BUDIR && tar --no-same-owner -xzf node.tgz && rm -f node.tgz && ln -sfn $node_real nodejs" \
    || { echo "[fail] staging node"; return 1; }

  # The package as published, with its production dependencies.
  docker cp "$pkg" "$CID:$BUDIR/pkg.tgz" >/dev/null \
    && docker exec -u 0 "$CID" sh -c "cd $BUDIR && tar --no-same-owner -xzf pkg.tgz && rm -f pkg.tgz" \
    || { echo "[fail] staging the BackUpper package"; return 1; }
  # A `backupper` command on the agent's PATH, as after `npm install -g`.
  docker exec -u 0 "$CID" sh -c "printf '%s\n' '#!/bin/sh' 'exec $BU_NODE_IN $BU_CLI_IN \"\$@\"' > $BUDIR/bin/backupper && chmod 755 $BUDIR/bin/backupper" \
    || { echo "[fail] backupper shim"; return 1; }

  # The package's own installer writes the hooks (and seeds the bundled experiences).
  _bu_cli install "$agent" > "$RUN/backupper_install.log" 2>&1 \
    || { echo "[fail] backupper install $agent (see backupper_install.log)"; return 1; }

  # The installed hooks invoke a bare `node`; point them at the staged runtime.
  case "$agent" in
    claude-code) hookfile="$CWD/.claude/settings.local.json" ;;
    codex)       hookfile="$CWD/.codex/hooks.json" ;;
    *) echo "[fail] bu_install_in_container: unsupported agent $agent"; return 1 ;;
  esac
  docker exec -u 0 "$CID" "$BU_NODE_IN" -e '
    const fs = require("fs"), [file, node] = process.argv.slice(1);
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const groups of Object.values(doc.hooks || {}))
      for (const g of groups) for (const h of g.hooks || [])
        if (typeof h.command === "string") h.command = h.command.replace(/^node /, node + " ");
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  ' "$hookfile" "$BU_NODE_IN" || { echo "[fail] rewriting the node path in $hookfile"; return 1; }

  # subagentRunner=auto follows the agent whose hook fired; the model is set per runner.
  for kv in "mode=${RB_BU_MODE:-checker}" \
            "subagentEnabled=true" \
            "subagentRunner=${RB_BU_RUNNER:-auto}" \
            "subagentModels={\"$runner\":\"$model\"}" \
            "subagentTimeoutSeconds=${RB_BU_SUBAGENT_TIMEOUT:-240}" \
            "$@"; do
    [ -n "$kv" ] || continue
    _bu_cli config set "${kv%%=*}" "${kv#*=}" >> "$RUN/backupper_install.log" 2>&1 \
      || { echo "[fail] backupper config set ${kv%%=*}"; return 1; }
  done
  docker exec -u 0 "$CID" test -s "$BU_STORE_IN/config.json" \
    || { echo "[fail] backupper config.json not at $BU_STORE_IN/config.json"; return 1; }

  # RB_BU_EXPERIENCES replaces the bundled capture playbooks.
  if [ -n "${RB_BU_EXPERIENCES:-}" ]; then
    local ef
    for ef in "$RB_BU_EXPERIENCES"/*.json; do
      [ -s "$ef" ] || continue
      docker cp "$ef" "$CID:$BU_STORE_IN/experiences/$(basename "$ef")" >/dev/null \
        && echo "[arm] experience: $(basename "$ef") (from RB_BU_EXPERIENCES)"
    done
  fi
  echo "[arm] experiences: $(docker exec "$CID" sh -c "ls $BU_STORE_IN/experiences 2>/dev/null | tr '\n' ' '")"

  # The agent, and so the hook, runs as the image's user: hand it the store.
  docker exec -u 0 "$CID" chown -R "${AGENT_UID:-0}:0" "$BUDIR" "$BU_STORE_IN" "$(dirname "$hookfile")" >/dev/null 2>&1 || true
  if docker exec "$CID" sh -c "mkdir -p '$BU_STORE_IN/.wtest' && rmdir '$BU_STORE_IN/.wtest'" >/dev/null 2>&1; then
    BU_SUMMARY="store $BU_STORE_IN writable by the agent"
  else
    BU_SUMMARY="[ERROR] store $BU_STORE_IN NOT writable by the agent -- every hook call fails and nothing is captured"
  fi

  local img_path
  img_path="$(docker exec "$CID" sh -c 'printf %s "$PATH"' 2>/dev/null)"
  BU_PATH_ENV=(-e "PATH=$BUDIR/bin:$BUDIR/nodejs/bin:${BU_EXTRA_PATH:+$BU_EXTRA_PATH:}${img_path:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"
               "${BU_STORE_ENV[@]+"${BU_STORE_ENV[@]}"}"
               -e BACKUPPER_PERSIST_SUBAGENT_SESSIONS=1)
  echo "[arm] backupper $(_bu_cli --version 2>/dev/null | tail -1) installed for $agent:" \
       "mode=${RB_BU_MODE:-checker} runner=${RB_BU_RUNNER:-auto} subagent=$model"
}
