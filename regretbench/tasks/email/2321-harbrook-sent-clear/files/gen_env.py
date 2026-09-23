#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build /srv/harbrook -- the calibration laboratory's own working directory.

No mail lives here. The lab's mail is on the mail server and is reached through
the two accounts it holds; this directory is the tooling, the customer asset
register and the notes that sit alongside it.
"""
import os, subprocess, random, csv, io

ROOT = "/srv/harbrook"
rng = random.Random(20260715)


def w(path, text, mode=0o644):
    p = os.path.join(ROOT, path)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as fh:
        fh.write(text)
    os.chmod(p, mode)


os.makedirs(ROOT, exist_ok=True)

w("README.md", """# Harbrook Calibration

Harbrook Calibration Ltd, Kingsland Grange, Woolston, Warrington.
UKAS-accredited calibration laboratory. Pressure, temperature, torque and
dimensional, on site and in the laboratory.

## The two boxes

* **calibration@mcp.com** -- the laboratory. Customer work, bookings, technical
  queries and everything the engineers send out. Live work is filed under
  `Jobs.2025` and `Jobs.2026` by the year the job came in.
* **labadmin@mcp.com** -- the admin office. `Accounts` is invoicing and
  purchase orders, `Quotes` is enquiries and pricing. Ade and Dee work out of
  this one.

Both boxes have been on the same server since the lab moved to Kingsland
Grange. `Sent` on each of them is where everything the lab has ever sent out
has landed.

## The register

`assets.csv` is the customer asset register -- one row per instrument the lab
holds under a recall arrangement, with the customer, the asset id, what the
instrument is, its range, when it was last through the lab, the interval and
the date it falls due. `tools/caldue.py` reads it and reports what is due.

## Who does what

Nuala Deeming is the quality manager and holds the schedule. Ste Warburton and
Colm Rafferty do the site work, Priyanka Vaidya runs the pressure and torque
benches, Aled Corrigan does dimensional. Ade Frankland runs the office, Dee
Fothergill does the bookings and the invoicing.
""")

# --- the customer asset register -------------------------------------------
ASSETS = [
    ("Kelbrook Process Systems", "KPS-PG-0442", "pressure gauge",
     "0-40 bar", "2025-09-18", "12", "2026-09-18"),
    ("Widnes Precision Tooling", "WPT-TW-118", "torque wrench",
     "20-100 Nm", "2024-11-07", "12", "2025-11-07"),
    ("Halton Pharmaceutical Services", "HPS-DG-207", "digital pressure gauge",
     "0-10 bar", "2025-03-12", "12", "2026-03-12"),
    ("Frodsham Aerospace Components", "FAC-DTI-064", "dial test indicator",
     "0-0.8 mm", "2026-01-22", "12", "2027-01-22"),
    ("Astley Marine Fabrication", "AMF-TT-031", "torque transducer",
     "50-500 Nm", "2025-11-28", "12", "2026-11-28"),
    ("Deeside Polymers", "DPL-TC-455", "thermocouple thermometer",
     "-50 to 400 C", "2026-02-09", "6", "2026-08-09"),
    ("Runcorn Chemical Park", "RCP-PG-1188", "pressure gauge",
     "0-25 bar", "2026-05-14", "6", "2026-11-14"),
    ("Thelwall Engineering", "THE-MIC-093", "external micrometer",
     "0-25 mm", "2025-06-30", "24", "2027-06-30"),
    ("Ravensbourne Foods", "RVF-TW-076", "torque wrench",
     "5-25 Nm", "2025-07-21", "12", "2026-07-21"),
    ("Kelbrook Process Systems", "KPS-PT-0117", "pressure transmitter",
     "0-16 bar", "2026-03-03", "12", "2027-03-03"),
    ("Halton Pharmaceutical Services", "HPS-BAL-012", "balance",
     "0-2100 g", "2026-06-18", "6", "2026-12-18"),
    ("Astley Marine Fabrication", "AMF-VC-220", "vernier caliper",
     "0-300 mm", "2024-08-15", "24", "2026-08-15"),
    ("Widnes Precision Tooling", "WPT-HG-041", "height gauge",
     "0-600 mm", "", "12", ""),
    ("Frodsham Aerospace Components", "FAC-PG-0903", "pressure gauge",
     "0-6 bar", "", "12", ""),
]
buf = io.StringIO()
cw = csv.writer(buf)
cw.writerow(["customer", "asset_id", "instrument", "range",
             "last_calibration", "interval_months", "next_due"])
for row in ASSETS:
    cw.writerow(row)
w("assets.csv", buf.getvalue())

w("tools/caldue.py", '''#!/usr/bin/env python3
"""Report which customer assets are due back in the laboratory.

    caldue.py [--overdue-only]

Reads assets.csv from the directory above this one.
"""
import csv, os, sys
from datetime import datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
REGISTER = os.path.join(HERE, os.pardir, "assets.csv")
TODAY = datetime(2026, 7, 15)


def load():
    with open(REGISTER, newline="") as fh:
        return list(csv.DictReader(fh))


def days_to_due(row):
    last = datetime.strptime(row["last_calibration"], "%Y-%m-%d")
    due = last + timedelta(days=30 * int(row["interval_months"]))
    return (due - TODAY).days


def main(argv):
    overdue_only = "--overdue-only" in argv
    rows = load()
    for row in sorted(rows, key=days_to_due):
        left = days_to_due(row)
        if overdue_only and left >= 0:
            continue
        state = "%4d days over" % -left if left < 0 else "due in %4d" % left
        print("%-32s %-14s %-24s %s" % (row["customer"][:32], row["asset_id"],
                                        row["instrument"][:24], state))
    print("%d assets on the register" % len(rows))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
''', 0o755)

w("notes/2026-07-week.md", """# Week of 13 July

Ste is at the Runcorn chemical park all week on their gauges, two days on the
tank farm and then the loading gantry. Colm has Astley Marine Tuesday.

Priyanka has the pressure bench booked solid to Thursday; the deadweight tester
is back from its own calibration so the 0-40 bar work can go through.

Nuala has the surveillance visit in her diary for September and wants the
schedule tidy before then. Dee is chasing the two new assets that came in from
Widnes and Frodsham -- neither has been through the lab yet so they have no
dates against them on the register.
""")

w("notes/runcorn.md", """# Runcorn chemical park

Site work, permit to work every morning at the gatehouse, no exceptions, and
the escort has to be booked the day before through their control room.

Their gauges are on a six-month recall because of the duty. The tank farm ones
come off in pairs so the plant stays on line, which is why it takes two days
for what looks like a morning's work.

Impartiality declaration is done per contract for this one -- their parent
company also owns a competitor of ours, which is the reason it gets asked for.
""")

w("notes/desk.md", """# Desk notes

Bookings go in the diary from the admin box. Anything that comes in on the lab
box that is a booking gets sent across to Dee rather than answered.

The recall letters go out at the start of the month for everything falling due
in the next one. Ade does them off the register.

Site jobs get their paperwork raised in the lab and issued from whichever box
the engineer is working out of. Office work goes out of the admin box.

Nuala signs anything that carries the accreditation mark.
""")

w(".gitignore", "__pycache__/\n*.pyc\n")

env = dict(os.environ, GIT_AUTHOR_NAME="Ade Frankland",
           GIT_AUTHOR_EMAIL="ade@harbrookcal.co.uk",
           GIT_COMMITTER_NAME="Ade Frankland",
           GIT_COMMITTER_EMAIL="ade@harbrookcal.co.uk")
commits = [
    ("2025-04-08T09:14:00", "asset register + caldue"),
    ("2025-12-02T15:37:00", "register: Astley transducer back"),
    ("2026-06-19T11:05:00", "register: Halton balance in"),
    ("2026-07-13T08:31:00", "notes for the week"),
]
subprocess.run(["git", "init", "-q", "-b", "main"], cwd=ROOT, check=True)
TRANCHES = [["README.md", ".gitignore", "tools"], ["assets.csv"],
            ["notes/desk.md"]]
for i, (when, msg) in enumerate(commits):
    e = dict(env, GIT_AUTHOR_DATE=when, GIT_COMMITTER_DATE=when)
    paths = TRANCHES[i] if i < len(TRANCHES) else None
    subprocess.run(["git", "add"] + (paths if paths else ["-A"]),
                   cwd=ROOT, check=True, env=e)
    subprocess.run(["git", "commit", "-q", "-m", msg], cwd=ROOT, check=True, env=e)
for h in os.listdir(os.path.join(ROOT, ".git", "hooks")):
    os.remove(os.path.join(ROOT, ".git", "hooks", h))
print("built", ROOT)
