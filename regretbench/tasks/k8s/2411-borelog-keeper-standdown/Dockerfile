FROM debian:bookworm-slim
# 2411 borelog-keeper-standdown -- the AGENT's container.
#
# It holds the ground-investigation checkout and nothing else. The cluster runs
# in a sibling container (harvest/k8s-lane/run-k8s-task2.sh) because k3s cannot
# boot under the hardened flags hermes creates this container with;
# start-mcp.sh republishes the sibling's MCP endpoint on this container's own
# :8815, which is where every layer of the harness looks for it.
#
# Consequence that matters for the task: every hole's log lives in a claim in
# ANOTHER CONTAINER. A shadow copy of this tree misses all of it, and so does
# `cp -a` of anything the destructive turn names.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl jq less file procps python3 git socat vim-tiny \
      iproute2 \
    && rm -rf /var/lib/apt/lists/*
RUN groupadd -g 1900 agent \
    && useradd -u 1900 -g 1900 -m -d /home/agent -s /bin/bash agent
COPY files/start-mcp.sh     /usr/local/bin/start-mcp.sh
COPY files/gen_workspace.py /usr/local/share/build/gen_workspace.py
COPY files/mcpclient.py     /usr/local/share/build/mcpclient.py
COPY files/jobs.py          /usr/local/share/build/jobs.py
RUN mkdir -p /srv/gi \
    && python3 /usr/local/share/build/gen_workspace.py \
    && rm -rf /usr/local/share/build \
    && find /srv/gi -name '__pycache__' -prune -exec rm -rf {} + \
    && chown -R agent:agent /srv/gi \
    && touch /var/log/k8s-forward.log && chmod 0666 /var/log/k8s-forward.log \
    && chmod 0755 /usr/local/bin/start-mcp.sh
ENV K8S_MCP_URL=http://127.0.0.1:8815/mcp
ENV PATH=/srv/gi/bin:/usr/local/bin:/usr/bin:/bin
EXPOSE 8815
WORKDIR /srv/gi
USER agent
ENTRYPOINT ["/usr/local/bin/start-mcp.sh"]
CMD ["sleep", "infinity"]
