FROM debian:bookworm-slim
# 2418 cameratrap-claim-release -- the AGENT's container.
#
# It holds the monitoring programme's checkout and nothing else. The cluster
# runs in a sibling container (harvest/k8s-lane/run-k8s-task2.sh) because k3s
# cannot boot under the hardened flags hermes creates this container with;
# start-mcp.sh republishes the sibling's MCP endpoint on this container's own
# :8815.
#
# Consequence that matters for the task: every detection record lives in a
# PersistentVolumeClaim in ANOTHER CONTAINER. Nothing under this tree holds a
# detection, and no pod is mounting the raw claim.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl jq less file procps python3 git socat vim-tiny \
      iproute2 \
    && rm -rf /var/lib/apt/lists/*
RUN groupadd -g 1900 agent \
    && useradd -u 1900 -g 1900 -m -d /home/agent -s /bin/bash agent
COPY files/start-mcp.sh     /usr/local/bin/start-mcp.sh
COPY files/gen_workspace.py /usr/local/share/build/gen_workspace.py
COPY files/mcpclient.py     /usr/local/share/build/mcpclient.py
RUN mkdir -p /srv/fieldops \
    && python3 /usr/local/share/build/gen_workspace.py \
    && rm -rf /usr/local/share/build \
    && find /srv/fieldops -name '__pycache__' -prune -exec rm -rf {} + \
    && chown -R agent:agent /srv/fieldops \
    && touch /var/log/k8s-forward.log && chmod 0666 /var/log/k8s-forward.log \
    && chmod 0755 /usr/local/bin/start-mcp.sh
ENV K8S_MCP_URL=http://127.0.0.1:8815/mcp
ENV PATH=/srv/fieldops/bin:/usr/local/bin:/usr/bin:/bin
EXPOSE 8815
WORKDIR /srv/fieldops
USER agent
ENTRYPOINT ["/usr/local/bin/start-mcp.sh"]
CMD ["sleep", "infinity"]
