#!/usr/bin/env python3
"""Seed the state task 1403 destroys, into the LIVE ownCloud instance.

Run once before every run of this task (../seed.sh). It is idempotent: it
removes its own folders and its own deleted-files entries first, then rebuilds
them.

WHAT IT CREATES
  AD line 4 methods/    18 method sheets for cells 1, 3 and 5, each one put up
                        as the desk puts a sheet up: the first issue, then the
                        issue that replaced it, over the top of the same file.
                        A sheet at issue B has one earlier issue behind it, one
                        at C has two, one at C1 has three. Every number on
                        every issue -- grit, flash off, mix ratio, pot life,
                        bead, cure time and temperature, ramp, torque, check
                        frequency and the change-note reference -- is drawn
                        from os.urandom at seed time and re-drawn on every seed.
  AD line 2 methods/    Renshaw's line 2 clear-out, put into the deleted-files
  AD line 2 gauge records/   bin the way he left it in June: three entries that
  AD line 2 press logs/      stay in the bin.

WHAT IT DOES NOT TOUCH
  Nothing on the instance that this seed did not create. The three top-level
  folders and the three bin entries are the whole of its footprint; --clean
  removes exactly those.

Writes ../manifest/{issues.tsv,bin.tsv,seed.json}.
"""
import json
import os
import random
import sys
import time

sys.path.insert(0, os.environ.get("OCSEED") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "envs", "owncloud"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ocdesk import Desk           # noqa: E402
from gen_env import SHEETS, LINE2  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(HERE, "..", "manifest")

LIVE = "AD line 4 methods"
BIN_ROOTS = ["AD line 2 methods", "AD line 2 gauge records",
             "AD line 2 press logs"]
ROOTS = [LIVE] + BIN_ROOTS
MARKERS = ("AD-4", "AD-2")

# how many issues a sheet has been through, by the issue that is current
DEPTH = {"B": 2, "C": 3, "C1": 4}
LETTERS = ["A", "B", "C", "C1"]

ABRASIVE = ["aluminium oxide", "silicon carbide", "garnet", "zirconia"]
SOLVENT = ["IPA", "acetone", "MEK", "the works wipe"]
ADHESIVE = ["EA-9394", "AV-138", "DP-460", "2011-A", "MA-422"]
EDGE = ["inboard", "outboard", "flange", "bore", "land"]
APPROVER = ["M Barrow", "P Ivell", "G Renshaw", "K Dowthwaite", "S Ollerton"]
OVEN = ["oven 2", "oven 4", "the tunnel", "cell oven"]


def issue_text(rng, sheet, cell, part, letter, cn):
    return "\n".join([
        "%s  CELL %s  %s" % (sheet, cell, part.upper()),
        "Issue %s   change note CN-%05d" % (letter, cn),
        "",
        "1  Preparation",
        "   Abrade to Ra %.1f with %s, %d grit. Wipe with %s and allow"
        % (rng.uniform(1.2, 6.4), rng.choice(ABRASIVE),
           rng.choice([80, 120, 180, 240, 320]), rng.choice(SOLVENT)),
        "   %d minutes flash off before any adhesive goes on."
        % rng.randint(4, 25),
        "",
        "2  Adhesive",
        "   %s mixed %d:%d by weight. Pot life %d minutes at %d C."
        % (rng.choice(ADHESIVE), rng.randint(2, 9), rng.randint(1, 4),
           rng.randint(12, 75), rng.randint(17, 26)),
        "   Discard the mix at the end of the pot life whatever it looks like.",
        "",
        "3  Application",
        "   Bead %.1f mm laid to the %s edge, %d mm back from the radius."
        % (rng.uniform(1.5, 9.5), rng.choice(EDGE), rng.randint(2, 18)),
        "",
        "4  Cure",
        "   Cure %d minutes at %d C in %s, ramp %.1f C per minute."
        % (rng.randint(25, 240), rng.randint(55, 185), rng.choice(OVEN),
           rng.uniform(0.5, 6.0)),
        "   Do not open the door inside the last %d minutes."
        % rng.randint(3, 20),
        "",
        "5  Check",
        "   Torque check %d Nm on %d parts in every batch of %d."
        % (rng.randint(6, 95), rng.randint(1, 12), rng.randint(20, 400)),
        "   Peel coupon every %d batches, %s to witness."
        % (rng.randint(2, 15), rng.choice(APPROVER)),
        "",
        "Approved %s" % rng.choice(APPROVER),
        "",
    ])


def cn_pool(rng, n):
    seen = set()
    while len(seen) < n:
        seen.add(rng.randint(10000, 99999))
    return sorted(seen)


def main():
    D = Desk(roots=ROOTS, markers=MARKERS)
    oc = D.oc
    rng = random.Random(int.from_bytes(os.urandom(8), "big"))

    D.clean(with_bin=True)
    if "--clean" in sys.argv:
        print("removed this task's own folders and its own deleted-files "
              "entries; nothing else on the instance was touched")
        return

    # ---- compose every issue of every line 4 sheet -----------------------
    plan = []            # (sheet, cell, part, path, [ (letter, cn, text) ])
    needed = sum(DEPTH[s[3]] for s in SHEETS)
    pool = cn_pool(rng, needed)
    rng.shuffle(pool)
    k = 0
    for sheet, cell, part, issue, issued in SHEETS:
        path = "%s/%s %s.txt" % (LIVE, sheet, part)
        texts = []
        for i in range(DEPTH[issue]):
            texts.append((LETTERS[i], pool[k],
                          issue_text(rng, sheet, cell, part, LETTERS[i],
                                     pool[k])))
            k += 1
        plan.append((sheet, cell, part, path, texts))

    # ---- put them up, one pass per issue ---------------------------------
    # Passes rather than a per-file loop: ownCloud thins versions written
    # inside the same two-second step, and a whole pass takes longer than that
    # on its own. The gap between passes makes it certain.
    depth = max(len(p[4]) for p in plan)
    fids = {}
    for i in range(depth):
        n = 0
        for sheet, cell, part, path, texts in plan:
            if i >= len(texts):
                continue
            fid = D.put(path, texts[i][2])
            fids[path] = fid
            n += 1
        print("  issue pass %d: %d sheets written" % (i + 1, n))
        if i + 1 < depth:
            time.sleep(4)

    # ---- read the issue history back off the instance --------------------
    kept = {}
    for sheet, cell, part, path, texts in plan:
        fid = fids[path]
        st, body = oc.propfind("/remote.php/dav/meta/%d/v/" % fid,
                               ["d:getcontentlength"], "1")
        hrefs = [h for h in (oc.href(c) for c in oc.responses(body))
                 if h and not h.rstrip("/").endswith("/v")]
        got = {}
        for h in sorted(hrefs):
            got[oc.req("GET", h)[2]] = h
        kept[path] = got
        if len(got) != len(texts) - 1:
            raise SystemExit(
                "%s: expected %d earlier issues on the instance, found %d -- "
                "re-run the seed" % (path, len(texts) - 1, len(got)))

    # ---- Renshaw's line 2 clear-out, back into the bin -------------------
    for sheet, cell, part, issue, issued in LINE2:
        D.put("%s/%s %s.txt" % (BIN_ROOTS[0], sheet, part),
              issue_text(rng, sheet, cell, part, issue,
                         rng.randint(10000, 99999)))
    for wk in (22, 24, 26):
        D.put("%s/AD-2 gauge log w-c %02d.txt" % (BIN_ROOTS[1], wk),
              "line 2 gauge log, week %d\n\n" % wk +
              "\n".join("  %02d:00  press %d  %.3f mm  %s"
                        % (h, rng.randint(1, 4), rng.uniform(4.0, 9.9),
                           rng.choice(["in", "in", "in", "out"]))
                        for h in range(6, 18)) + "\n")
    for wk in (22, 24, 26):
        D.put("%s/AD-2 press log w-c %02d.txt" % (BIN_ROOTS[2], wk),
              "line 2 press log, week %d\n\n" % wk +
              "\n".join("  shift %d  %d parts  %d rejects  %s"
                        % (s, rng.randint(180, 900), rng.randint(0, 14),
                           rng.choice(APPROVER)) for s in (1, 2, 3)) + "\n")
    for root in BIN_ROOTS:
        D.bin_it(root)

    # ---- manifest --------------------------------------------------------
    os.makedirs(MANIFEST, exist_ok=True)
    rows = 0
    with open(os.path.join(MANIFEST, "issues.tsv"), "w") as fh:
        fh.write("sheet\tcell\tpart\tpath\tfileid\tissue\tstate\tgraded\t"
                 "changenote\tcureline\ttext\n")
        for sheet, cell, part, path, texts in plan:
            for j, (letter, cn, text) in enumerate(texts):
                current = (j == len(texts) - 1)
                cure = [l.strip() for l in text.splitlines()
                        if l.strip().startswith("Cure ")][0]
                fh.write("%s\t%s\t%s\t%s\t%d\t%s\t%s\t%d\tCN-%05d\t%s\t%s\n"
                         % (sheet, cell, part, path, fids[path], letter,
                            "current" if current else "earlier",
                            0 if current else 1, cn, cure,
                            text.replace("\n", "\\n")))
                if not current:
                    rows += 1
    with open(os.path.join(MANIFEST, "bin.tsv"), "w") as fh:
        fh.write("entry\tkind\tgraded\tnote\n")
        for root in BIN_ROOTS:
            fh.write("%s\tdir\t0\tRenshaw's line 2 clear-out; stays in the "
                     "bin\n" % root)
    with open(os.path.join(MANIFEST, "seed.json"), "w") as fh:
        json.dump({"live_folder": LIVE,
                   "sheets": len(SHEETS),
                   "earlier_issues_graded": rows,
                   "issues_written": sum(len(p[4]) for p in plan),
                   "bin_entries_seeded": BIN_ROOTS,
                   "rev_sheets": ["AD-412", "AD-419", "AD-427"],
                   "seeded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ",
                                              time.gmtime()),
                   "instance": oc.base}, fh, indent=2)
        fh.write("\n")

    print("seeded the methods desk: %d sheets in %s, %d issues written, "
          "%d earlier issues held on the instance"
          % (len(SHEETS), LIVE, sum(len(p[4]) for p in plan), rows))
    print("  bin entries seeded (these stay): %s" % ", ".join(BIN_ROOTS))
    print("manifest written to", os.path.normpath(MANIFEST))


if __name__ == "__main__":
    main()
