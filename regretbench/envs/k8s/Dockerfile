# regretbench/env-k8s:base -- a single-node Kubernetes cluster in one container:
# k3s, the Kubernetes MCP server bridged to streamable HTTP, and the first-boot
# seeder. It carries no cluster data; each k8s task's cluster/Dockerfile builds
# FROM it and mints that task's state under /opt/seed.
#
# k3s cannot be seeded at build time (the API server has to be running), so the
# cluster objects are created on first boot by seed_task.py.
#
# The image requires --privileged (cgroup v2 delegation and a tmpfs for
# containerd); see start_cluster.sh.
#
#   docker build -t regretbench/env-k8s:base regretbench/envs/k8s

# --------------------------------------------------------------------------
# fetch: pull the k3s airgap bundle and throw away the images we disable.
# Upstream ships 8 images / 265 MB; this environment runs 4 of them.
# --------------------------------------------------------------------------
FROM debian:bookworm-slim AS fetch
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 ca-certificates curl && rm -rf /var/lib/apt/lists/*
# curl + sha256sum -c rather than `ADD --checksum=`, so the legacy builder works too.
RUN mkdir -p /src && curl -fsSL -o /src/airgap.tar \
      https://github.com/k3s-io/k3s/releases/download/v1.36.3+k3s1/k3s-airgap-images-amd64.tar \
    && echo "ad67d696c5c96755c20196f07fee3390db3eca499a1dc3cdd443b56057ab00ff  /src/airgap.tar" \
       | sha256sum -c -
COPY files/prune_airgap.py /src/prune_airgap.py
RUN mkdir -p /out && python3 /src/prune_airgap.py /src/airgap.tar \
      /out/k3s-airgap-core.tar \
      mirrored-pause coredns local-path-provisioner mirrored-library-busybox

# --------------------------------------------------------------------------
# cc: the setuid launcher that lets an image whose USER is unprivileged still
# boot a cluster.  See files/rb-boot.c.
# --------------------------------------------------------------------------
FROM debian:bookworm-slim AS cc
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*
COPY files/rb-boot.c /src/rb-boot.c
RUN gcc -O2 -static -o /rb-boot /src/rb-boot.c && strip /rb-boot

# --------------------------------------------------------------------------
# base: the reusable environment. No cluster data.
# --------------------------------------------------------------------------
FROM node:22-bookworm-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq less file procps python3 iproute2 \
      tar gzip vim-tiny mount util-linux \
    && rm -rf /var/lib/apt/lists/*

# k3s ships every runtime component it needs (containerd, runc, iptables,
# conntrack, cni) inside this one binary, and dispatches on argv[0].
RUN curl -fsSL -o /usr/local/bin/k3s \
      https://github.com/k3s-io/k3s/releases/download/v1.36.3+k3s1/k3s \
    && echo "2f98a9f8fe5782479ee2d54e70a1b10a7f6fd4cae8d38ed3098452dc6eed76b5  /usr/local/bin/k3s" \
       | sha256sum -c - \
    && chmod 755 /usr/local/bin/k3s
RUN for t in kubectl crictl ctr; do ln -s /usr/local/bin/k3s /usr/local/bin/$t; done

# containerd imports every archive it finds here at agent startup; this is
# what makes the cluster work with no egress at all.
COPY --from=fetch /out/k3s-airgap-core.tar /var/lib/rancher/k3s/agent/images/

# the cluster API service (MCP over the cluster) and the stdio->HTTP bridge.
# The sed makes the bridge log, rather than crash on, a failed send to a client
# that has gone away (an unhandled rejection in supergateway 3.4.3).
RUN npm install -g --no-fund --no-audit \
      supergateway@3.4.3 mcp-server-kubernetes@4.1.4 \
    && npm cache clean --force \
    && f="$(npm root -g)/supergateway/dist/gateways/stdioToStatefulStreamableHttp.js" \
    && sed -i 's|^\( *\)transport.send(jsonMsg);|\1Promise.resolve(transport.send(jsonMsg)).catch((e) => { logger.error(`Failed to send to StreamableHttp`, e); });|' "$f" \
    && grep -q 'Promise.resolve(transport.send(jsonMsg))' "$f"

COPY files/mcp_selfcheck.py /usr/local/lib/k8senv/mcp_selfcheck.py
COPY files/seed_task.py     /usr/local/lib/k8senv/seed_task.py
COPY files/start.sh         /usr/local/bin/start.sh
COPY --from=cc /rb-boot /usr/local/sbin/rb-boot
RUN chmod 0755 /usr/local/bin/start.sh \
    && chown root:root /usr/local/sbin/rb-boot \
    && chmod 4755 /usr/local/sbin/rb-boot

# The account the agent arrives as.  `docker exec` with no -u takes the
# image's user, so this is what a shell on the box is.  It owns nothing under
# /var/lib/rancher, cannot read the admin kubeconfig, and reaches the cluster
# only through the MCP endpoint; start.sh locks those paths down as its last
# act before dropping to this uid.
RUN groupadd -g 1900 agent \
    && useradd -u 1900 -g 1900 -m -d /home/agent -s /bin/bash agent

ENV KUBECONFIG=/etc/rancher/k3s/k3s.yaml
EXPOSE 8815
WORKDIR /home/agent
USER agent
ENTRYPOINT ["/usr/local/sbin/rb-boot"]
CMD ["sleep", "infinity"]
