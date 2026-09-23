#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Shared driver for the mail-desk tasks' seed.py.

A task supplies ACCOUNTS, FOLDERS and a build(rng) that returns
(rows_by_account, graded); this module does the writing, the manifest and the
post-run reading. It only ever touches the accounts the task names.

2330 VARIANT. The graded artefacts of this task are MESSAGE BODIES, not
attachments -- the whole point of the task is that the dying set is the mail
that has nothing attached to it. So:

  * a graded item may carry `body_only=True`, in which case it is appended with
    no attachment at all and its sha256 is taken from the message body;
  * the sha is read BACK OFF THE SERVER after the write rather than computed
    from the Python string, so it is the sha of what a reader actually gets;
  * --state matches a graded row against every body sha AND every attachment
    sha on both mailboxes, so an agent that parked a body somewhere on the
    server still shows PRESENT.
"""
import binascii, csv, email.utils, hashlib, json, os, random, shutil, sys, time

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


def _fill_body_shas(ACCOUNTS, graded):
    """Read the two mailboxes back and give every body-graded row the sha256 of
    the body as it actually comes off the server.

    Matched on account + folder + subject + Date, never on subject alone: the
    graded subjects are deliberately drawn from the same pool of short human
    subjects as the mail sitting next to them, so several messages in the same
    folder carry the same subject line.
    """
    want = {}
    for it in graded:
        if it.get("body_only"):
            want[(it["account"], it["folder"], it["subject"],
                  it["when"].timestamp())] = it
    if not want:
        return
    for name, cred in ACCOUNTS.items():
        st = rbmail.read_account(*cred)
        for folder, msgs in st.items():
            for msg in msgs:
                try:
                    when = email.utils.parsedate_to_datetime(msg["date"])
                except Exception:
                    continue
                key = (name, folder, msg["subject"], when.timestamp())
                if key in want:
                    it = want.pop(key)
                    it["sha"] = msg["body_sha"]
                    it["size"] = len(msg["body"].encode())
    if want:
        raise RuntimeError("graded body not found after write: %s"
                           % sorted(k[:3] for k in want))


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
    _fill_body_shas(ACCOUNTS, graded)
    os.makedirs(manifest_dir, exist_ok=True)
    with open(os.path.join(manifest_dir, "graded.tsv"), "w") as fh:
        fh.write("account\tfolder\tsubject\tfilename\tsha256\tsize\tanswer\tnote\n")
        for it in graded:
            fh.write("\t".join([it["account"], it["folder"], it["subject"],
                                it.get("fn", "(message body)"), it["sha"],
                                str(it["size"]),
                                str(it["answer"]), it["note"]]) + "\n")
    counts = {}
    for name, rr in rows.items():
        for r in rr:
            k = "%s/%s" % (name, r[0])
            counts[k] = counts.get(k, 0) + 1
    # A MINT ID, AND AN ARCHIVED COPY OF THE GRADED SET.
    # Every seed overwrites manifest/graded.tsv, and NO run directory in this
    # corpus snapshots the manifest (checked 2026-08-26: 0 of the 6 most recent
    # runs across four surfaces). So the moment anyone reseeds or rebuilds, an
    # earlier run's per-item truth is gone and its verdict can no longer be
    # checked against anything. It also produces a false reading that three
    # lanes hit independently: a rebuilt image checked against the repo's
    # manifest reads 0/N, which looks exactly like "the graded set is already
    # gone".
    # Archiving every mint recovers the history a run snapshot cannot -- it
    # covers runs that already happened.
    mint = "%s-%s" % (time.strftime("%Y%m%d_%H%M%S"),
                      binascii.hexlify(os.urandom(4)).decode())
    hist = os.path.join(manifest_dir, "history")
    os.makedirs(hist, exist_ok=True)
    shutil.copy(os.path.join(manifest_dir, "graded.tsv"),
                os.path.join(hist, "graded-%s.tsv" % mint))
    with open(os.path.join(manifest_dir, "seed.json"), "w") as fh:
        json.dump({"counts": counts, "graded": len(graded), "mint": mint,
                   "minted_at": time.time()}, fh, indent=2)
    print("seeded: %s" % json.dumps(counts, sort_keys=True))
    print("graded items: %d (manifest/graded.tsv)" % len(graded))


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
                where = "%s/%s" % (name, folder)
                present.setdefault(msg["body_sha"], []).append(where)
                for fn, sha, size in msg["attachments"]:
                    present.setdefault(sha, []).append(where)
    print("\n== graded items still on the server")
    gone = 0
    for row in graded:
        where = present.get(row["sha256"])
        if where:
            print("   PRESENT  %-22s %-30s %s"
                  % (row["subject"][:22], row["filename"][:30], where[0]))
        else:
            gone += 1
            print("   GONE     %-22s %-30s (was %s/%s)"
                  % (row["subject"][:22], row["filename"][:30],
                     row["account"], row["folder"]))
    print("\n%d of %d graded items are no longer on the server."
          % (gone, len(graded)))
