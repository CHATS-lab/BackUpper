#!/usr/bin/env bash
# Boot: bring the cluster up as root, seed it on first boot, publish the
# cluster API service, then drop to the agent account and run the given
# command.  Reached only through /usr/local/sbin/rb-boot (setuid root); see
# rb-boot.c for why.
set -e

AGENT_USER=${K8SENV_AGENT_USER:-agent}
AGENT_UID=$(id -u "$AGENT_USER")
AGENT_GID=$(id -g "$AGENT_USER")

if [ "$(id -u)" != "0" ]; then
  echo "start.sh must run as root (invoke /usr/local/sbin/rb-boot)" >&2
  exit 1
fi

# One boot per container. Without this the agent could re-enter the boot path
# through rb-boot; with it, a second call dies here.
mkdir -p /run/rbenv
if ! ( set -o noclobber; : > /run/rbenv/booted ) 2>/dev/null; then
  echo "already booted" >&2
  exit 1
fi
chmod 0700 /run/rbenv

mkdir -p /var/log/services /run /var/lib/rbenv
chmod 0700 /var/log/services /var/lib/rbenv
: > /var/log/services/k3s.log

# --- cgroup v2 delegation --------------------------------------------------
# The kubelet needs to create /sys/fs/cgroup/kubepods with the memory and io
# controllers delegated, and cgroup v2 will not delegate a domain controller
# out of a cgroup that still holds processes.  k3s does this evacuation itself
# only when it is PID 1; here PID 1 is this script, so we do it -- move every
# process in the root cgroup into a child, then enable every controller the
# kernel offers for children.  Requires --privileged (the cgroup mount is
# read-only otherwise, and this fails with "read-only file system").
if [ -e /sys/fs/cgroup/cgroup.controllers ]; then
  if ! mkdir -p /sys/fs/cgroup/init 2>/dev/null; then
    echo "cannot write /sys/fs/cgroup -- this image needs --privileged" >&2
    exit 1
  fi
  while read -r pid; do
    echo "$pid" > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || true
  done < /sys/fs/cgroup/cgroup.procs
  for c in $(cat /sys/fs/cgroup/cgroup.controllers); do
    echo "+$c" > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || true
  done
fi

# --- a non-overlayfs filesystem for containerd -----------------------------
# The container root is itself an overlayfs, and overlayfs refuses to stack on
# an overlayfs with multiple lowerdirs, so containerd's snapshotter has
# nowhere to work.  The `native` snapshotter is the documented fallback and it
# does not survive here either -- CreateContainer times out after two minutes.
# So give containerd a filesystem of its own and let it use the ordinary
# overlayfs snapshotter on top.  tmpfs, not a loop-mounted disk image: loop
# devices are a host-global resource shared with everything else on the
# machine, and a container that takes one can starve its neighbours.
# Measured cost: ~530 MB of the allowance is actually used at rest.
# Needs --privileged (mount).
CONTAINERD_DIR=/var/lib/rancher/k3s/agent/containerd
mkdir -p "$CONTAINERD_DIR"
if [ "$(stat -f -c %T "$CONTAINERD_DIR")" = "overlayfs" ]; then
  if ! mount -t tmpfs -o "size=${K8SENV_CONTAINERD_FS_SIZE:-3g},mode=0700" \
       k3s-containerd "$CONTAINERD_DIR"; then
    echo "could not mount tmpfs on $CONTAINERD_DIR -- this image needs --privileged" >&2
    exit 1
  fi
fi

NODE_NAME=${K8SENV_NODE_NAME:-k3s-ops-01}

K3S_ARGS=(
  server
  --node-name "$NODE_NAME"
  --disable=traefik,metrics-server,servicelb
  --disable-network-policy
  --disable-helm-controller
  --write-kubeconfig-mode 600
)

k3s "${K3S_ARGS[@]}" >>/var/log/services/k3s.log 2>&1 &

export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

# --- wait for the control plane -------------------------------------------
ready=
for _ in $(seq 1 300); do
  if kubectl get node "$NODE_NAME" \
       -o 'jsonpath={.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null \
       | grep -qx True; then ready=1; break; fi
  sleep 1
done
if [ -z "$ready" ]; then
  echo "CLUSTER DID NOT COME UP -- last lines of /var/log/services/k3s.log:" >&2
  tail -20 /var/log/services/k3s.log >&2
  exit 1
fi

mkdir -p /root/.kube
cp /etc/rancher/k3s/k3s.yaml /root/.kube/config
chmod 600 /root/.kube/config

# --- first-boot seeding ----------------------------------------------------
# k3s cannot be seeded at image build time (the API server has to be running),
# so the seed runs once, here.  Everything it writes was minted at BUILD time
# and lives under /opt/seed; the seeder removes that directory when it is done
# so the payload exists in exactly one place afterwards: the volume.
if [ "${K8SENV_SEED:-1}" = "1" ] && [ ! -e /var/lib/rbenv/.seeded ]; then
  if /usr/local/lib/k8senv/seed.sh >>/var/log/services/seed.log 2>&1; then
    date -u +%FT%TZ > /var/lib/rbenv/.seeded
  else
    echo "SEED FAILED -- see /var/log/services/seed.log" >&2
    tail -40 /var/log/services/seed.log >&2
    exit 1
  fi
fi

# --- cluster API service ---------------------------------------------------
# An MCP server over the cluster, bridged from stdio to streamable HTTP.
# The default surface is everything mcp-server-kubernetes offers except the
# three helm tools, because no helm binary is installed.  A name that is not
# one of the server's own kills the child process on startup, so change this
# only against `mcp_selfcheck.py`'s output.
ALLOWED_TOOLS="${K8SENV_ALLOWED_TOOLS:-kubectl_get,kubectl_describe,kubectl_logs,kubectl_apply,kubectl_create,kubectl_delete,kubectl_patch,kubectl_scale,kubectl_rollout,kubectl_generic,kubectl_context,kubectl_reconnect,exec_in_pod,port_forward,stop_port_forward,list_api_resources,explain_resource,node_management,cleanup,ping}"
export ALLOWED_TOOLS
export KUBECONFIG

( while :; do
    supergateway --stdio "mcp-server-kubernetes" \
      --outputTransport streamableHttp --stateful --streamableHttpPath /mcp \
      --port "${K8SENV_MCP_PORT:-8815}" --healthEndpoint /healthz \
      --sessionTimeout 3600000 --logLevel none
    sleep 2
  done ) >>/var/log/services/cluster-mcp.log 2>&1 &

MCP_URL="http://127.0.0.1:${K8SENV_MCP_PORT:-8815}"
for _ in $(seq 1 120); do
  curl -sf -m 2 "$MCP_URL/healthz" >/dev/null 2>&1 && break
  sleep 1
done
if ! python3 /usr/local/lib/k8senv/mcp_selfcheck.py "$MCP_URL/mcp" \
       >>/var/log/services/selfcheck.log 2>&1; then
  echo "CLUSTER MCP ENDPOINT IS NOT ANSWERING -- see /var/log/services/selfcheck.log" >&2
  tail -5 /var/log/services/selfcheck.log >&2
  exit 1
fi

# --- shut the back doors ---------------------------------------------------
# From here on the agent's only route to cluster state is the MCP endpoint on
# 127.0.0.1:${K8SENV_MCP_PORT}.  Everything that would be a second route --
# the admin kubeconfig, the local-path storage root where PVC data actually
# lives, the kubelet's mounted-volume tree, the containerd socket, the service
# logs -- is root-only.  k3s creates several of these itself while booting, so
# this runs last, not first.
for p in /etc/rancher /var/lib/rancher /var/lib/kubelet /var/lib/cni \
         /var/lib/rbenv /run/k3s /run/rbenv /root /var/log/services \
         /var/log/pods /var/log/containers; do
  [ -e "$p" ] && chmod 0700 "$p"
done
chmod 0600 /etc/rancher/k3s/k3s.yaml /root/.kube/config 2>/dev/null || true

# --- drop privileges -------------------------------------------------------
exec setpriv --reuid "$AGENT_UID" --regid "$AGENT_GID" --init-groups \
     env HOME="/home/$AGENT_USER" USER="$AGENT_USER" \
         PATH=/usr/local/bin:/usr/bin:/bin \
         K8S_MCP_URL="http://127.0.0.1:${K8SENV_MCP_PORT:-8815}/mcp" \
     "$@"
