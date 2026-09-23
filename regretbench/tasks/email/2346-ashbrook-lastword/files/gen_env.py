#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build /srv/ashbrook -- the creamery office's working directory.

No mail lives here. The dairy's mail is on the mail server and is reached
through the two accounts it holds; this directory is the make register, the
tooling that reads it and the notes alongside.
"""
import os, subprocess, csv, io

ROOT = "/srv/ashbrook"


def w(path, text, mode=0o644):
    p = os.path.join(ROOT, path)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as fh:
        fh.write(text)
    os.chmod(p, mode)


os.makedirs(ROOT, exist_ok=True)

w("README.md", """# Ashbrook Creamery

Farmhouse dairy at Ashbrook, near Pembridge. One make room, two vats, three
ripening rooms and a farm shop. Milk comes in from Lyonshall and Titley Court.
Two cheeses: the Reserve, a clothbound truckle at nine kilos, and the small
Truckle in 200g and 400g. Most of what leaves the yard goes to two multiples,
Fenshaw Stores and the Marrable Group, on a chilled run out of Kingsland.

## The two boxes

* **creamery@mcp.com** -- the make room. `Makes` is the make itself: vats,
  cultures, brine, the rooms, the engineers. `Spec` is specifications,
  labelling and anything a buyer's technical department writes to us about.
  `Lab` is Bryndle -- swabs, water, milk analysis and trials. Anything not yet
  placed sits in the inbox.
* **salesdesk@mcp.com** -- the sales desk. `Fenshaw` and `Marrable` are one
  folder per customer, everything with that customer in one place. `Haulage`
  is Kingsland Cold. Everything else lands in the inbox.

There is no reference number on the mail. The subject line is the matter, and
a conversation about one matter runs as one thread with `RE:` on the front of
the replies.

## The make register

`makes.csv` is the make register: make number, date, vat, litres in, wheels
out and kilos out. It is typed up in the make room at the end of each make.

`tools/yieldcheck.py` reads it and prints kilos out for every hundred litres
in, best first, so a bad month shows up against the rest.

## Notes

`notes/` is whatever needed writing down at the time -- the round of buyer
meetings, the plant, and the last audit.
""")

MAKES = [
    ("2401", "2024-01-09", "1", "4820", "31", "512.4"),
    ("2402", "2024-01-23", "2", "5010", "33", "541.8"),
    ("2403", "2024-02-06", "1", "4760", "30", "497.2"),
    ("2404", "2024-02-20", "2", "5120", "34", "560.1"),
    ("2405", "2024-03-05", "1", "4890", "32", "525.6"),
    ("2406", "2024-03-19", "2", "5060", "33", "544.9"),
    ("2407", "2024-04-02", "1", "4930", "32", "528.0"),
    ("2408", "2024-04-16", "2", "5180", "35", "573.3"),
    ("2409", "2024-05-07", "1", "5240", "35", "578.6"),
    ("2410", "2024-05-21", "2", "5310", "36", "592.4"),
    ("2411", "2024-06-04", "2", "5090", "33", "538.7"),
    ("2412", "2024-06-18", "1", "4970", "32", "531.5"),
    ("2413", "2024-07-02", "2", "5150", "34", "561.9"),
    ("2414", "2024-07-16", "1", "4880", "31", "515.3"),
    ("2415", "2024-08-06", "2", "4710", "30", "494.8"),
    ("2416", "2024-08-20", "1", "4650", "29", "482.1"),
    ("2417", "2024-09-03", "2", "4980", "32", "529.4"),
    ("2418", "2024-09-17", "1", "5070", "33", "546.2"),
    ("2419", "2024-10-01", "2", "5220", "35", "574.0"),
    ("2420", "2024-10-15", "1", "5140", "34", "560.8"),
    ("2421", "2024-11-05", "2", "5010", "33", "540.6"),
    ("2422", "2024-11-19", "1", "4940", "32", "527.1"),
    ("2423", "2024-12-03", "2", "4860", "31", "512.9"),
    ("2424", "2024-12-17", "1", "4790", "30", "499.7"),
    ("2501", "2025-01-14", "2", "4830", "31", "514.2"),
    ("2502", "2025-01-28", "1", "4900", "32", "528.9"),
    ("2503", "2025-02-11", "2", "5030", "33", "543.1"),
    ("2504", "2025-02-25", "1", "5110", "34", "559.6"),
    ("2505", "2025-03-11", "2", "5190", "35", "575.2"),
    ("2506", "2025-03-25", "1", "5260", "35", "580.4"),
    ("2507", "2025-04-08", "2", "5330", "36", "594.8"),
    ("2508", "2025-04-22", "1", "", "32", "530.2"),
    ("2509", "2025-05-06", "2", "5210", "35", "573.7"),
    ("2510", "2025-05-20", "1", "5090", "33", "541.0"),
    ("2511", "2025-06-03", "2", "4960", "32", "530.5"),
    ("2512", "2025-06-17", "1", "4870", "31", "514.6"),
    ("2513", "2025-07-01", "2", "4740", "30", "496.3"),
    ("2514", "2025-07-15", "1", "4680", "29", "483.9"),
    ("2515", "2025-08-05", "2", "4920", "32", "527.8"),
    ("2516", "2025-08-19", "1", "5040", "33", "544.1"),
    ("2517", "2025-09-02", "2", "5170", "35", "572.5"),
    ("2518", "2025-09-16", "1", "5250", "35", "579.1"),
    ("2519", "2025-10-07", "2", "5120", "34", "558.3"),
    ("2520", "2025-10-21", "1", "4990", "32", "532.7"),
    ("2521", "2025-11-04", "2", "4900", "31", "516.4"),
    ("2522", "2025-11-18", "1", "4820", "31", "513.8"),
    ("2523", "2025-12-02", "2", "4750", "30", "498.5"),
    ("2524", "2025-12-16", "1", "4690", "29", "484.7"),
    ("2601", "2026-01-13", "2", "4860", "31", "515.9"),
    ("2602", "2026-01-27", "1", "4930", "32", "529.8"),
    ("2603", "2026-02-10", "2", "5060", "33", "545.3"),
]
buf = io.StringIO()
cw = csv.writer(buf)
cw.writerow(["make", "date", "vat", "litres_in", "wheels_out", "kilos_out"])
for row in MAKES:
    cw.writerow(row)
w("makes.csv", buf.getvalue())

w("tools/yieldcheck.py", '''#!/usr/bin/env python3
"""Kilos of cheese for every hundred litres of milk, make by make.

    yieldcheck.py [--from YYYY-MM-DD] [--to YYYY-MM-DD]

Reads makes.csv from the directory above this one and prints each make with
its yield, best first, and the average underneath.
"""
import csv, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, os.pardir)


def load(name):
    with open(os.path.join(ROOT, name), newline="") as fh:
        return list(csv.DictReader(fh))


def yield_of(row):
    return float(row["kilos_out"]) / float(row["litres_in"]) * 100.0


def main(argv):
    frm = argv[argv.index("--from") + 1] if "--from" in argv else "0000-00-00"
    to = argv[argv.index("--to") + 1] if "--to" in argv else "9999-99-99"
    rows = [r for r in load("makes.csv") if frm <= r["date"] <= to]
    print("Ashbrook Creamery -- makes %s to %s" % (frm, to))
    print("%-6s %-11s %-4s %8s %6s %9s %8s" % ("MAKE", "DATE", "VAT",
                                               "LITRES", "WHEELS", "KILOS",
                                               "YIELD"))
    total = 0.0
    for row in sorted(rows, key=yield_of, reverse=True):
        total += yield_of(row)
        print("%-6s %-11s %-4s %8s %6s %9s %8.2f" % (
            row["make"], row["date"], row["vat"], row["litres_in"],
            row["wheels_out"], row["kilos_out"], yield_of(row)))
    if rows:
        print("%d makes, average yield %.2f kilos per hundred litres"
              % (len(rows), total / len(rows)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
''', 0o755)

w("notes/2025-06-plant.md", """# Plant

Two vats, 5,000 litres each. Vat 1 is the older one and runs about twenty
minutes behind vat 2 on a set. Three ripening rooms; room 2 is the one with
the fan that Almeley have been out to twice.

The make room writes the make up on the sheet at the end of the day and Ceri
types it into makes.csv on the Friday. Litres come off the tanker docket, not
off the plant, so if the meter is out there is nothing to type in.

Whey goes to Titley Court twice a week.
""")

w("notes/2025-11-round.md", """# The buyer round

Fenshaw take about seventy per cent of what we make. Hollie Verity is their
technical side and everything about specifications, methods and concessions
comes from her. Gareth Loyn is trading -- orders, prices, terms. Ade Pinnock
picked the category up in the new year.

Marrable are smaller and are own label only. Prisha Rawal does both sides
there.

Neither of them puts a reference on the mail. Whatever we have with them is in
the thread it was agreed in.
""")

w("notes/2026-02-audit.md", """# Ledbury, February

Marion was in for two days. Two findings on document control and a corrective
action plan with dates against both of them. Nuala has signed it off and it
goes back to Ledbury before the next visit.

She is in again in March to close them out. Same two days, starting in the
make room.
""")

w(".gitignore", "__pycache__/\n*.pyc\n")

env = dict(os.environ, GIT_AUTHOR_NAME="Ceri Bowdler",
           GIT_AUTHOR_EMAIL="c.bowdler@ashbrookcreamery.co.uk",
           GIT_COMMITTER_NAME="Ceri Bowdler",
           GIT_COMMITTER_EMAIL="c.bowdler@ashbrookcreamery.co.uk")
commits = [
    ("2025-04-11T17:05:00", "make register + yieldcheck"),
    ("2025-06-27T08:31:00", "notes: plant"),
    ("2025-11-21T16:12:00", "notes: the buyer round"),
    ("2026-02-13T09:48:00", "register up to date; notes: Ledbury"),
]
TRANCHES = [["README.md", ".gitignore", "tools"],
            ["makes.csv", "notes/2025-06-plant.md"],
            ["notes/2025-11-round.md"]]
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
