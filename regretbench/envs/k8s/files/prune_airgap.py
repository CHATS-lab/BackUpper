#!/usr/bin/env python3
"""BUILD-TIME ONLY. Shrinks the k3s airgap image bundle to the images this
environment actually runs.

The upstream k3s-airgap-images-amd64.tar is ~265 MB because it carries
traefik, metrics-server, klipper-helm and klipper-lb.  This environment
disables all four, so those blobs would be dead weight in the final image and
dead time at first boot (containerd imports every tar it finds under
/var/lib/rancher/k3s/agent/images).

The bundle is an OCI layout (oci-layout + index.json + blobs/sha256/...) that
also carries a legacy docker manifest.json.  Both indices are rewritten and
only the transitively-referenced blobs are copied over.

usage: prune_airgap.py <in.tar> <out.tar> <repo-substring> [<repo-substring>...]
"""
import json
import sys
import tarfile

INDEX_TYPES = {
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
}
MANIFEST_TYPES = {
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
}


def main():
    src_path, dst_path = sys.argv[1], sys.argv[2]
    wanted = sys.argv[3:]
    src = tarfile.open(src_path)

    def blob(digest):
        return "blobs/" + digest.replace(":", "/")

    def read_json(digest):
        return json.loads(src.extractfile(blob(digest)).read())

    present = set(src.getnames())
    keep_blobs = set()

    def walk(desc):
        """Collect a descriptor and everything it points at.

        The bundle is amd64-only, so a multi-arch index still lists per-arch
        manifests whose blobs upstream already stripped.  Anything not present
        in the tar is simply skipped -- the upstream bundle has the same holes
        and containerd imports it happily."""
        digest = desc["digest"]
        name = blob(digest)
        if name not in present:
            return
        keep_blobs.add(name)
        mt = desc.get("mediaType", "")
        if mt in INDEX_TYPES:
            for child in read_json(digest).get("manifests", []):
                walk(child)
        elif mt in MANIFEST_TYPES:
            doc = read_json(digest)
            for d in [doc["config"]["digest"]] + [
                    layer["digest"] for layer in doc.get("layers", [])]:
                if blob(d) in present:
                    keep_blobs.add(blob(d))

    def match(name):
        return any(w in name for w in wanted)

    index = json.loads(src.extractfile("index.json").read())
    kept_index = []
    for desc in index.get("manifests", []):
        ann = desc.get("annotations", {}) or {}
        name = ann.get("io.containerd.image.name", "") or ann.get(
            "org.opencontainers.image.ref.name", "")
        if not match(name):
            continue
        kept_index.append(desc)
        walk(desc)
    index["manifests"] = kept_index

    legacy = json.loads(src.extractfile("manifest.json").read())
    kept_legacy = []
    for entry in legacy:
        tags = entry.get("RepoTags") or []
        if not any(match(t) for t in tags):
            continue
        kept_legacy.append(entry)
        keep_blobs.add(entry["Config"])
        keep_blobs.update(entry.get("Layers", []))

    if not kept_index:
        sys.exit("prune_airgap: nothing matched %r" % (wanted,))

    def add_bytes(tar, name, payload):
        info = tarfile.TarInfo(name)
        info.size = len(payload)
        info.mtime = 0
        tar.addfile(info, __import__("io").BytesIO(payload))

    written = 0
    with tarfile.open(dst_path, "w") as dst:
        add_bytes(dst, "oci-layout",
                  src.extractfile("oci-layout").read())
        add_bytes(dst, "index.json", json.dumps(index).encode())
        add_bytes(dst, "manifest.json", json.dumps(kept_legacy).encode())
        for member in src.getmembers():
            if member.name in keep_blobs and member.isfile():
                member.mtime = 0
                dst.addfile(member, src.extractfile(member))
                written += member.size

    print("prune_airgap: kept %d image(s), %d blobs, %.1f MB"
          % (len(kept_index), len(keep_blobs), written / 1e6))
    for desc in kept_index:
        ann = desc.get("annotations", {}) or {}
        print("  " + ann.get("io.containerd.image.name", "?"))


if __name__ == "__main__":
    main()
