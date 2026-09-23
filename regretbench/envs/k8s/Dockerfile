# syntax=docker/dockerfile:1.7
#
# A real single-node Kubernetes cluster in one container: k3s, an MCP server
# over the cluster API, and a seeder.
#
# Two stages, deliberately:
#
#   base    k3s + its airgap images + the cluster API service + the seeder
#           SCRIPT.  No cluster data of any kind.  This is the expensive layer
#           (~600 MB, one 265 MB download) and it is what many tasks share.
#   seeded  runs mint_seed.py, which mints THIS task's graded values with a
#           CSPRNG and lays down the bytes that will go into the volume.
#           A new task rebuilds only this stage.
#
# k3s cannot be seeded at build time -- the API server has to be running, and
# that needs cgroups this build does not have -- so the cluster objects are
# created on FIRST BOOT by /usr/local/lib/k8senv/seed.sh.  What mint_seed.py
# writes at build time is the payload and the graded values; seed.sh copies
# the payload into the PersistentVolume and then deletes it from the
# filesystem, so the archive ends up existing in exactly one place.
#
# The image REQUIRES --privileged (see README.md).

# --------------------------------------------------------------------------
# fetch: pull the k3s airgap bundle and throw away the images we disable.
# Upstream ships 8 images / 265 MB; this environment runs 4 of them.
# --------------------------------------------------------------------------
FROM debian:bookworm-slim AS fetch
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 ca-certificates curl && rm -rf /var/lib/apt/lists/*
# Legacy-builder compatible: this host's dockerd has no buildx, and
# `ADD --checksum=` / `--chmod=` are BuildKit-only.  curl + sha256sum -c gives
# the identical guarantee (the digests are the ones the BuildKit form carried).
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

# the cluster API service (MCP over the cluster) and the stdio->HTTP bridge
RUN npm install -g --no-fund --no-audit \
      supergateway@3.4.3 mcp-server-kubernetes@4.1.4 \
    && npm cache clean --force

COPY files/mint_seed.py     /usr/local/lib/k8senv/mint_seed.py
COPY files/mcp_selfcheck.py /usr/local/lib/k8senv/mcp_selfcheck.py
COPY files/seed_task.py /usr/local/lib/k8senv/seed_task.py
COPY files/seed.sh      /usr/local/lib/k8senv/seed.sh
COPY files/start.sh     /usr/local/bin/start.sh
COPY --from=cc /rb-boot /usr/local/sbin/rb-boot
RUN chmod 0755 /usr/local/lib/k8senv/seed.sh /usr/local/bin/start.sh \
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

# --------------------------------------------------------------------------
# seeded: this task's data. Rebuilt per task; `base` stays cached.
# --------------------------------------------------------------------------
FROM base AS seeded
USER root
RUN mkdir -p /opt/seed && chmod 0700 /opt/seed \
    && python3 /usr/local/lib/k8senv/mint_seed.py \
    && chown -R root:root /opt/seed
USER agent
