#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Shared driver for the mail-desk tasks' seed.py.

A task supplies ACCOUNTS, FOLDERS and a build(rng) that returns
(rows_by_account, graded); this module does the writing, the manifest and the
post-run reading. It only ever touches the accounts the task names.
"""
import csv, hashlib, json, os, random, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import rbmail, rbdoc


def attach(item, rng):
    """Turn a graded spec dict into (filename, bytes, maintype, subtype)."""
    if item.get("jpeg"):
        data = rbdoc.jpeg(item.get("w", 320), item.get("h", 240),
                          item["jpeg"].encode())
        mt, st = "image", "jpeg"
    elif item.get("text"):
        data = ("\n".join(item["text"]) + "\n").encode()
        mt, st = "text", "csv" if item["fn"].endswith(".csv") else "plain"
    else:
        data = rbdoc.pdf(item["doc"], item["fn"])
        mt, st = "application", "pdf"
    item["sha"] = hashlib.sha256(data).hexdigest()
    item["size"] = len(data)
    return (item["fn"], data, mt, st)


def write(account, folders, rows):
    addr, pw = account
    m = rbmail.conn(addr, pw)
    try:
        for f in folders:
            m.create('"%s"' % f)
        for folder, subject, frm, when, body, atts in sorted(rows, key=lambda r: r[3]):
            msg = rbmail.mkmsg(subject, frm, addr, when, body, atts)
            rbmail.append(m, folder, msg, when, seen=(when.month < 6))
    finally:
        m.logout()


def run(build, ACCOUNTS, FOLDERS, manifest_dir):
    if "--state" in sys.argv:
        return _state(ACCOUNTS, manifest_dir)
    if "--clean" in sys.argv:
        for cred in ACCOUNTS.values():
            rbmail.wipe_account(*cred)
        print("cleaned")
        return
    rng = random.Random(int.from_bytes(os.urandom(8), "big"))
    rows, graded = build(rng)
    for cred in ACCOUNTS.values():
        rbmail.wipe_account(*cred)
    for name, cred in ACCOUNTS.items():
        write(cred, FOLDERS[name], rows.get(name, []))
    os.makedirs(manifest_dir, exist_ok=True)
    with open(os.path.join(manifest_dir, "graded.tsv"), "w") as fh:
        fh.write("account\tfolder\tsubject\tfilename\tsha256\tsize\tanswer\tnote\n")
        for it in graded:
            fh.write("\t".join([it["account"], it["folder"], it["subject"],
                                it["fn"], it["sha"], str(it["size"]),
                                str(it["answer"]), it["note"]]) + "\n")
    counts = {}
    for name, rr in rows.items():
        for r in rr:
            k = "%s/%s" % (name, r[0])
            counts[k] = counts.get(k, 0) + 1
    with open(os.path.join(manifest_dir, "seed.json"), "w") as fh:
        json.dump({"counts": counts, "graded": len(graded)}, fh, indent=2)
    print("seeded: %s" % json.dumps(counts, sort_keys=True))
    print("graded attachments: %d (manifest/graded.tsv)" % len(graded))


def _state(ACCOUNTS, manifest_dir):
    graded = []
    p = os.path.join(manifest_dir, "graded.tsv")
    if os.path.exists(p):
        with open(p) as fh:
            graded = list(csv.DictReader(fh, delimiter="\t"))
    present = {}
    for name, cred in ACCOUNTS.items():
        st = rbmail.read_account(*cred)
        print("\n== %s (%s)" % (name, cred[0]))
        for folder in sorted(st):
            print("   %-20s %d" % (folder, len(st[folder])))
        for folder, msgs in st.items():
            for msg in msgs:
                for fn, sha, size in msg["attachments"]:
                    present.setdefault(sha, []).append("%s/%s" % (name, folder))
    print("\n== graded attachments still on the server")
    gone = 0
    for row in graded:
        where = present.get(row["sha256"])
        if where:
            print("   PRESENT  %-34s %s" % (row["filename"], where[0]))
        else:
            gone += 1
            print("   GONE     %-34s (was %s/%s)" % (row["filename"],
                                                     row["account"], row["folder"]))
    print("\n%d of %d graded attachments are no longer on the server."
          % (gone, len(graded)))
