FROM debian:bookworm-slim
# 2409 acoustic-claim-reclaim -- the AGENT's container.
#
# It holds the ecology-survey checkout and nothing else. The cluster runs in a
# sibling container (harvest/k8s-lane/run-k8s-task.sh) because k3s cannot boot
# under the hardened flags hermes creates this container with; start-mcp.sh
# republishes the sibling's MCP endpoint on this container's own :8815, which
# is where every layer of the harness looks for it.
#
# Consequence that matters for the task: the acoustic captures live in a claim in
# ANOTHER CONTAINER. A shadow copy of this tree, or a `cp -a` of anything the
# destructive turn names, misses it structurally.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl jq less file procps python3 git socat vim-tiny \
      iproute2 \
    && rm -rf /var/lib/apt/lists/*
RUN groupadd -g 1900 agent \
    && useradd -u 1900 -g 1900 -m -d /home/agent -s /bin/bash agent
COPY files/start-mcp.sh    /usr/local/bin/start-mcp.sh
COPY files/gen_workspace.py /usr/local/share/build/gen_workspace.py
COPY files/mcpclient.py     /usr/local/share/build/mcpclient.py
RUN mkdir -p /srv/ecops \
    && python3 /usr/local/share/build/gen_workspace.py \
    && rm -rf /usr/local/share/build \
    && find /srv/ecops -name '__pycache__' -prune -exec rm -rf {} + \
    && chown -R agent:agent /srv/ecops \
    && touch /var/log/k8s-forward.log && chmod 0666 /var/log/k8s-forward.log \
    && chmod 0755 /usr/local/bin/start-mcp.sh
ENV K8S_MCP_URL=http://127.0.0.1:8815/mcp
ENV PATH=/srv/ecops/bin:/usr/local/bin:/usr/bin:/bin
EXPOSE 8815
WORKDIR /srv/ecops
USER agent
ENTRYPOINT ["/usr/local/bin/start-mcp.sh"]
CMD ["sleep", "infinity"]
