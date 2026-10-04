#!/usr/bin/env python3
"""Generic FIRST-BOOT seeder for k8s tasks.

Each task's cluster image mints its state at BUILD time under /opt/seed; this
engine reads that declarative spec on first boot and executes it:

  /opt/seed/seed.json     the spec (below)
  /opt/seed/cluster.yaml  a multi-document manifest, applied as-is
  /opt/seed/payload/<d>/  trees streamed into mounted volumes through a pod
  /opt/seed/graded.env    KEY=VALUE, the values the task grades on

seed.json:

  objects        [{kind, name, ns?}]       everything cluster.yaml applies,
                 so the annotation strip below needs no YAML parser
  wait_rollouts  [{ns, kind, name}]        wait before anything is loaded
  payloads       [{ns, dir, dest, selector | pod}]
                 tar the tree at payload/<dir> into <dest> inside the first pod
                 matching <selector>, or inside <pod> when a name is given
                 (StatefulSet ordinals need the name -- a selector matches
                 every replica and jsonpath [0] is always ordinal 0)
  steps          ordered, each exactly one of
                   {"exec": {ns, selector, cmd:[...], container?}}
                   {"kubectl": [argv...]}
                   {"wait_job": {ns, name, timeout?}}
                   {"wait_rollout": {ns, kind, name}}
                   {"sleep": seconds}
  verify         {ns, selector, cmd:[...], expect: "<GRADED_KEY>"}
                 run cmd in the pod, require its stdout (stripped) to equal
                 graded.env[expect]. This is how we prove the bytes landed in
                 the VOLUME rather than in a directory of the seeder's own.

Two things are done unconditionally, and both are recoverability fixes rather
than conveniences (see RECOVERABILITY.md sec 1.1 and sec 5):

  * every object applied from cluster.yaml has
    `kubectl.kubernetes.io/last-applied-configuration` STRIPPED afterwards.
    kubectl apply writes the whole previous manifest into that annotation and a
    later patch does not update it, so leaving it in place hands the agent a
    one-call undo of any patch.
  * /opt/seed is removed when the spec has been executed and verified, so the
    payload exists in exactly one place afterwards: inside the volume.
"""
import json
import os
import shutil
import subprocess
import sys
import time

SEED_DIR = os.environ.get("K8SENV_SEED_DIR", "/opt/seed")
KUBECONFIG = os.environ.get("KUBECONFIG", "/etc/rancher/k3s/k3s.yaml")


def say(msg):
    print("[seed %s] %s" % (time.strftime("%T"), msg), flush=True)


def kubectl(*args, **kw):
    env = dict(os.environ, KUBECONFIG=KUBECONFIG)
    return subprocess.run(("kubectl",) + args, env=env,
                          capture_output=True, text=True, **kw)


def kubectl_ok(*args):
    r = kubectl(*args)
    if r.returncode != 0:
        raise SystemExit("kubectl %s failed:\n%s%s"
                         % (" ".join(args), r.stdout, r.stderr))
    return r.stdout


def wait_rollout(ns, kind, name, timeout=300):
    for _ in range(timeout):
        if kubectl("-n", ns, "get", "%s/%s" % (kind, name)).returncode == 0:
            break
        time.sleep(1)
    kubectl_ok("-n", ns, "rollout", "status", "%s/%s" % (kind, name),
               "--timeout=%ds" % timeout)


def first_pod(ns, selector, timeout=300):
    for _ in range(timeout):
        r = kubectl("-n", ns, "get", "pod", "-l", selector,
                    "--field-selector=status.phase=Running",
                    "-o", "jsonpath={.items[0].metadata.name}")
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip()
        time.sleep(1)
    raise SystemExit("no running pod for %s in %s" % (selector, ns))


def strip_last_applied(objects):
    """Remove the annotation kubectl apply plants on every object.

    `objects` is the list the minting script wrote to seed.json's "objects"
    key: [{kind, name, ns?}]. No YAML parser is needed in the image.
    """
    n = 0
    for d in objects:
        args = ["-n", d["ns"]] if d.get("ns") else []
        args += ["annotate", "%s/%s" % (d["kind"].lower(), d["name"]),
                 "kubectl.kubernetes.io/last-applied-configuration-"]
        if kubectl(*args).returncode == 0:
            n += 1
    say("stripped last-applied-configuration from %d/%d objects"
        % (n, len(objects)))


def load_payload(ns, selector, src, dest, pod=None):
    # A tar stream through `kubectl exec`, never `kubectl cp`: cp of a
    # directory into an existing directory nests it (dest/<basename>) rather
    # than merging, which silently put a StatefulSet's per-ordinal payload at
    # /var/lib/shard/shard3/… and failed the seed's own verify step.
    pod = pod or first_pod(ns, selector)
    say("loading %s into %s:%s (pod %s)" % (src, ns, dest, pod))
    env = dict(os.environ, KUBECONFIG=KUBECONFIG)
    tar = subprocess.Popen(["tar", "cf", "-", "-C", src, "."],
                           stdout=subprocess.PIPE)
    ex = subprocess.Popen(["kubectl", "-n", ns, "exec", "-i", pod, "--",
                           "tar", "xf", "-", "-C", dest],
                          stdin=tar.stdout, env=env)
    tar.stdout.close()
    if ex.wait() != 0 or tar.wait() not in (0, None):
        raise SystemExit("payload load failed for %s" % src)


def main():
    spec = json.load(open(os.path.join(SEED_DIR, "seed.json")))
    graded = {}
    gpath = os.path.join(SEED_DIR, "graded.env")
    if os.path.exists(gpath):
        for line in open(gpath):
            if "=" in line:
                k, v = line.rstrip("\n").split("=", 1)
                graded[k] = v

    say("waiting for kube-system to settle")
    wait_rollout("kube-system", "deploy", "local-path-provisioner")
    wait_rollout("kube-system", "deploy", "coredns")

    manifest = os.path.join(SEED_DIR, "cluster.yaml")
    say("applying cluster.yaml")
    kubectl_ok("apply", "-f", manifest)
    strip_last_applied(spec.get("objects", []))

    for w in spec.get("wait_rollouts", []):
        wait_rollout(w["ns"], w.get("kind", "deploy"), w["name"])

    for p in spec.get("payloads", []):
        load_payload(p["ns"], p.get("selector"),
                     os.path.join(SEED_DIR, "payload", p["dir"]), p["dest"],
                     pod=p.get("pod"))

    for step in spec.get("steps", []):
        if "exec" in step:
            s = step["exec"]
            pod = first_pod(s["ns"], s["selector"])
            args = ["-n", s["ns"], "exec", pod]
            if s.get("container"):
                args += ["-c", s["container"]]
            args += ["--"] + s["cmd"]
            out = kubectl_ok(*args)
            say("exec %s: %s" % (s["selector"], out.strip()[:120]))
        elif "kubectl" in step:
            kubectl_ok(*step["kubectl"])
        elif "wait_job" in step:
            s = step["wait_job"]
            kubectl_ok("-n", s["ns"], "wait", "--for=condition=complete",
                       "job/" + s["name"],
                       "--timeout=%ds" % s.get("timeout", 300))
        elif "wait_rollout" in step:
            s = step["wait_rollout"]
            wait_rollout(s["ns"], s.get("kind", "deploy"), s["name"])
        elif "sleep" in step:
            time.sleep(step["sleep"])
        else:
            raise SystemExit("unknown step: %r" % step)

    v = spec.get("verify")
    if v:
        pod = first_pod(v["ns"], v["selector"])
        got = kubectl_ok("-n", v["ns"], "exec", pod, "--", *v["cmd"]).strip()
        want = graded[v["expect"]]
        if got != want:
            raise SystemExit("VERIFY FAILED: pod says %r, expected %r"
                             % (got, want))
        say("verified through the pod: %s" % v["expect"])

    shutil.rmtree(SEED_DIR)
    say("removed %s -- the payload now exists only inside the cluster"
        % SEED_DIR)


if __name__ == "__main__":
    sys.exit(main())
