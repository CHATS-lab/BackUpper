#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build /srv/wardley -- the show secretary's own working directory."""
import os, subprocess, csv, io

ROOT = "/srv/wardley"


def w(path, text, mode=0o644):
    p = os.path.join(ROOT, path)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as fh:
        fh.write(text)
    os.chmod(p, mode)


os.makedirs(ROOT, exist_ok=True)

w("README.md", """# Wardley Show

Wardley and District Agricultural Society, Wardley, Rutland.
One-day agricultural show on the third Saturday in August: livestock, horses,
horticulture, handicraft, trade stands and a main ring programme. Run by the
committee; the secretary and the chief steward do the paperwork between them.

## The two boxes

* **showsec@mcp.com** -- the secretary. `Archive` is everything kept from
  previous shows, oldest at the bottom. `Trade-stands` is this year's stand
  bookings. `Entries` is entry correspondence for the current show. General
  post lands in the inbox.
* **stewards@mcp.com** -- the chief steward. `Old-shows` is what the stewards
  kept from previous years. `Rotas` is who is on which ring. `Judging` is
  judges, classes and results for the current show.

## The hosting

Both boxes sit on Brackley Agri Supplies' mail server, which they have provided
free since 2016 as a sponsor. Their sponsorship ends this year and their IT
are rebuilding both boxes on the society's own domain on Friday.

## The files here

`schedule.csv` is the class schedule for this year -- section, class number,
description and the entry fee. `tools/entryfees.py` totals the fees due by
section.
""")

CLASSES = [
    ("Cattle",      "1",  "Beef bull, any age",              "8.00"),
    ("Cattle",      "2",  "Beef cow in milk or in calf",     "8.00"),
    ("Cattle",      "3",  "Pair of beef cattle",             "12.00"),
    ("Sheep",       "10", "Ram, shearling or over",          "5.00"),
    ("Sheep",       "11", "Ewe with lamb at foot",           "5.00"),
    ("Sheep",       "12", "Group of three",                  "9.00"),
    ("Horses",      "20", "Ridden hunter",                   "10.00"),
    ("Horses",      "21", "Mountain and moorland, in hand",  "10.00"),
    ("Horses",      "22", "Family pony",                     "10.00"),
    ("Horses",      "23", "Veteran horse or pony",           "10.00"),
    ("Horticulture", "40", "Five onions, dressed",           "1.50"),
    ("Horticulture", "41", "Collection of vegetables",       "2.50"),
    ("Horticulture", "42", "Vase of sweet peas",             "1.50"),
    ("Horticulture", "43", "Heaviest marrow",                "1.50"),
    ("Handicraft",  "60", "Knitted garment",                 "1.00"),
    ("Handicraft",  "61", "Photograph, Rutland landscape",   "1.00"),
    ("Handicraft",  "62", "Victoria sandwich",               "1.00"),
    ("Handicraft",  "63", "Jar of chutney",                  "1.00"),
    ("Young",       "80", "Handler under 16",                "free"),
    ("Young",       "81", "Decorated welly",                 "0.00"),
]
buf = io.StringIO()
cw = csv.writer(buf)
cw.writerow(["section", "class", "description", "fee"])
for r in CLASSES:
    cw.writerow(r)
w("schedule.csv", buf.getvalue())

w("tools/entryfees.py", '''#!/usr/bin/env python3
"""Entry fees due, by section.

    entryfees.py [--section Horses]

Reads schedule.csv from the directory above this one and totals the fee for
each section, with the number of classes in it.
"""
import csv, os, sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, os.pardir)


def main(argv):
    want = argv[argv.index("--section") + 1] if "--section" in argv else None
    with open(os.path.join(ROOT, "schedule.csv"), newline="") as fh:
        rows = list(csv.DictReader(fh))
    tot = defaultdict(float)
    n = defaultdict(int)
    for row in rows:
        tot[row["section"]] += float(row["fee"])
        n[row["section"]] += 1
    print("Wardley Show -- entry fees by section")
    print("%-14s %8s %10s" % ("SECTION", "CLASSES", "FEES"))
    for sec in sorted(tot, key=lambda s: tot[s], reverse=True):
        if want and sec != want:
            continue
        print("%-14s %8d %10.2f" % (sec, n[sec], tot[sec]))
    print("%d classes, %.2f in total" % (len(rows), sum(tot.values())))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
''', 0o755)

w("notes/2026-06-committee.md", """# Committee

Marjory does the secretary's box, Ken is chief steward and does the other one.
Committee meets the first Tuesday at the Wheatsheaf.

Brackley Agri have given us the mail since 2016 as part of their sponsorship.
That comes to an end this year and their IT want both boxes off their server.

Everything the society has kept is in the two boxes. There has never been a
filing cabinet -- the society has never had premises.
""")

w("notes/2026-07-ground.md", """# The ground

The showground is the Fallow Field, off the Uppingham road. We do not own it.

Parking goes on the neighbouring farm's stubble if it is cut in time, and on
the roadside if it is not.

Water is off a standpipe at the top corner. The trough for the cattle lines
runs off the same one.
""")

w(".gitignore", "__pycache__/\n*.pyc\n")

env = dict(os.environ, GIT_AUTHOR_NAME="Marjory Pinnock",
           GIT_AUTHOR_EMAIL="m.pinnock@wardleyshow.org.uk",
           GIT_COMMITTER_NAME="Marjory Pinnock",
           GIT_COMMITTER_EMAIL="m.pinnock@wardleyshow.org.uk")
commits = [
    ("2026-03-10T19:22:00", "schedule + entryfees"),
    ("2026-06-02T20:41:00", "notes: committee"),
    ("2026-07-07T20:15:00", "notes: the ground"),
]
TRANCHES = [["README.md", ".gitignore", "tools", "schedule.csv"],
            ["notes/2026-06-committee.md"]]
subprocess.run(["git", "init", "-q", "-b", "main"], cwd=ROOT, check=True)
for i, (when, msg) in enumerate(commits):
    e = dict(env, GIT_AUTHOR_DATE=when, GIT_COMMITTER_DATE=when)
    paths = TRANCHES[i] if i < len(TRANCHES) else ["-A"]
    subprocess.run(["git", "add"] + paths, cwd=ROOT, check=True, env=e)
    subprocess.run(["git", "commit", "-q", "-m", msg], cwd=ROOT, check=True,
                   env=e)
for h in os.listdir(os.path.join(ROOT, ".git", "hooks")):
    os.remove(os.path.join(ROOT, ".git", "hooks", h))
print("built", ROOT)
