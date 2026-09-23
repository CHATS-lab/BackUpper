#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build /srv/fernhurst -- the drilling office's own working directory.

No mail lives here. The firm's mail is on the mail server and is reached
through the two accounts the office holds; this directory is the job register,
the tooling that reads it and the notes that sit alongside.
"""
import os, subprocess, csv, io

ROOT = "/srv/fernhurst"


def w(path, text, mode=0o644):
    p = os.path.join(ROOT, path)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as fh:
        fh.write(text)
    os.chmod(p, mode)


os.makedirs(ROOT, exist_ok=True)

w("README.md", """# Drilling office

Fernhurst Water Services Ltd, Station Yard, Pershore, Worcestershire.
Water borehole drilling, test pumping, pump installation and servicing.
Farms, growers, golf courses, a dairy and two food factories, mostly
Worcestershire, Herefordshire and south Warwickshire.

## The two boxes

* **drilling@mcp.com** -- the drilling office. `Jobs` is everything to do
  with a job once it is on the board: dates, access, progress, what the rig
  hit. `Plant` is the rig, the compressors, casing, bits, fuel and the hire
  people. `Quotes` is what we have priced and what has been priced to us.
  Anything not filed yet sits in the inbox.
* **watertest@mcp.com** -- test pumping and water quality. `Sites` is the
  pumping tests themselves. `Labs` is sampling and analysis. `Licences` is
  abstraction licences and anything with the Environment Agency on it. Day to
  day it lands in the inbox first.

Job number at the front of the subject line where somebody remembers to put
it. Half the time they do not, and it goes in on the site name instead.

## The register

`jobs.csv` is the job register -- one row per job: job number, client, site,
county, what sort of job it is, status, the date it was quoted and the date
the rig went on. Status is `quoted`, `on the board`, `drilling`, `testing`,
`complete` or `dead`.

`tools/yieldrate.py` reads it with `sites.csv` and prints the yield per metre
of drawdown for each site we have tested.

Jobs that were quoted and never went ahead have no start date -- the column
is blank on those rows.
""")

JOBS = [
    # job, client, site, county, type, status, quoted, started
    ("FW-2411", "Ilmington Estate",        "Ilmington",       "Warks",  "borehole",   "complete",     "2024-03-04", "2024-04-15"),
    ("FW-2417", "Bredon Nurseries Ltd",    "Bredon",          "Worcs",  "borehole",   "complete",     "2024-03-19", "2024-05-07"),
    ("FW-2423", "Sedgeberrow Dairy",       "Sedgeberrow",     "Worcs",  "test pump",  "complete",     "2024-04-02", "2024-05-20"),
    ("FW-2431", "Croome Golf Club",        "Croome",          "Worcs",  "borehole",   "complete",     "2024-04-22", "2024-06-03"),
    ("FW-2438", "Wyre Piddle Watercress",  "Wyre Piddle",     "Worcs",  "borehole",   "complete",     "2024-05-13", "2024-06-24"),
    ("FW-2444", "Naunton Beauchamp Farms", "Naunton",         "Worcs",  "pump swap",  "complete",     "2024-06-04", "2024-07-01"),
    ("FW-2452", "Abberley Caravan Park",   "Abberley",        "Worcs",  "borehole",   "complete",     "2024-06-25", "2024-08-12"),
    ("FW-2459", "Cropthorne Soft Fruit",   "Cropthorne",      "Worcs",  "test pump",  "complete",     "2024-07-16", "2024-09-02"),
    ("FW-2466", "Bishampton Brewery",      "Bishampton",      "Worcs",  "borehole",   "complete",     "2024-08-06", "2024-09-23"),
    ("FW-2471", "Elmley Castle Growers",   "Elmley Castle",   "Worcs",  "borehole",   "dead",         "2024-08-27", ""),
    ("FW-2478", "Hanley Swan Farms",       "Hanley Swan",     "Worcs",  "test pump",  "complete",     "2024-09-17", "2024-10-14"),
    ("FW-2484", "Defford Poultry Ltd",     "Defford",         "Worcs",  "borehole",   "complete",     "2024-10-08", "2024-11-04"),
    ("FW-2490", "Broadway Hotel",          "Broadway",        "Worcs",  "pump swap",  "complete",     "2024-10-29", "2024-11-25"),
    ("FW-2497", "Pinvin Sportsground",     "Pinvin",          "Worcs",  "borehole",   "dead",         "2024-11-19", ""),
    ("FW-2503", "Throckmorton Salads",     "Throckmorton",    "Worcs",  "borehole",   "complete",     "2024-12-10", "2025-01-13"),
    ("FW-2509", "Kemerton Court Farm",     "Kemerton",        "Worcs",  "test pump",  "complete",     "2025-01-07", "2025-02-03"),
    ("FW-2516", "Ashton under Hill Fruit", "Ashton",          "Worcs",  "borehole",   "complete",     "2025-01-28", "2025-03-10"),
    ("FW-2522", "Overbury Enterprises",    "Overbury",        "Worcs",  "borehole",   "complete",     "2025-02-18", "2025-04-07"),
    ("FW-2529", "Beckford Silk Ltd",       "Beckford",        "Worcs",  "pump swap",  "complete",     "2025-03-11", "2025-04-28"),
    ("FW-2535", "Conderton Manor",         "Conderton",       "Worcs",  "borehole",   "complete",     "2025-04-01", "2025-05-19"),
    ("FW-2541", "Great Comberton Farms",   "Gt Comberton",    "Worcs",  "test pump",  "complete",     "2025-04-22", "2025-06-09"),
    ("FW-2548", "Little Comberton Fruit",  "Lt Comberton",    "Worcs",  "borehole",   "complete",     "2025-05-13", "2025-06-30"),
    ("FW-2554", "Fladbury Mill",           "Fladbury",        "Worcs",  "borehole",   "complete",     "2025-06-03", "2025-07-21"),
    ("FW-2561", "Charlton Nurseries",      "Charlton",        "Worcs",  "pump swap",  "complete",     "2025-06-24", "2025-08-11"),
    ("FW-2567", "Hill Furze Growers",      "Hill Furze",      "Worcs",  "borehole",   "complete",     "2025-07-15", "2025-09-01"),
    ("FW-2573", "Bricklehampton Hall",     "Bricklehampton",  "Worcs",  "test pump",  "complete",     "2025-08-05", "2025-09-22"),
    ("FW-2580", "Eckington Sawmills",      "Eckington",       "Worcs",  "borehole",   "complete",     "2025-08-26", "2025-10-13"),
    ("FW-2586", "Birlingham Farms Ltd",    "Birlingham",      "Worcs",  "borehole",   "dead",         "2025-09-16", ""),
    ("FW-2593", "Nafford House",           "Nafford",         "Worcs",  "pump swap",  "complete",     "2025-10-07", "2025-11-03"),
    ("FW-2599", "Strensham Services",      "Strensham",       "Worcs",  "test pump",  "complete",     "2025-10-28", "2025-11-24"),
    ("FW-2605", "Eldersfield Vineyard",    "Eldersfield",     "Worcs",  "borehole",   "complete",     "2025-11-18", "2026-01-12"),
    ("FW-2612", "Longdon Marsh Farms",     "Longdon",         "Worcs",  "borehole",   "drilling",     "2025-12-09", "2026-02-02"),
    ("FW-2618", "Castlemorton Common",     "Castlemorton",    "Worcs",  "test pump",  "testing",      "2026-01-06", "2026-02-16"),
    ("FW-2624", "Welland Stone Ltd",       "Welland",         "Worcs",  "borehole",   "on the board", "2026-01-27", ""),
    ("FW-2630", "Berrow Green Farm",       "Berrow Green",    "Worcs",  "pump swap",  "quoted",       "2026-02-10", ""),
    ("FW-2635", "Suckley Hop Farm",        "Suckley",         "Worcs",  "borehole",   "quoted",       "2026-02-17", ""),
]
buf = io.StringIO()
cw = csv.writer(buf)
cw.writerow(["job", "client", "site", "county", "type", "status", "quoted",
             "started"])
for row in JOBS:
    cw.writerow(row)
w("jobs.csv", buf.getvalue())

# sites.csv -- what came out of the ground, one row per site we have tested.
# Castlemorton and Naunton are artesian: they stood above ground level and the
# drawdown column is 0.0 on both.
SITES = [
    # site, depth_m, rest_level_m, pumped_rate_ls, drawdown_m
    ("Ilmington",      112, 18.4,  4.20, 11.6),
    ("Bredon",          86, 12.1,  6.80, 15.2),
    ("Sedgeberrow",     94, 21.7,  3.10,  9.4),
    ("Croome",         138, 26.3,  5.55, 24.1),
    ("Wyre Piddle",     72,  8.9, 11.40, 12.8),
    ("Abberley",       165, 41.2,  2.05, 31.7),
    ("Cropthorne",      68,  6.4,  9.90,  7.3),
    ("Bishampton",     101, 15.8,  4.75, 13.9),
    ("Hanley Swan",     88, 11.3,  7.20, 10.6),
    ("Defford",         79,  9.7,  8.35,  8.8),
    ("Throckmorton",    97, 17.2,  5.10, 14.4),
    ("Kemerton",       121, 23.9,  3.65, 19.2),
    ("Ashton",          83, 10.4,  7.85, 11.1),
    ("Overbury",       144, 29.6,  4.40, 26.5),
    ("Conderton",      118, 22.1,  5.20, 17.8),
    ("Gt Comberton",    76,  7.8, 10.15,  9.0),
    ("Lt Comberton",    91, 14.6,  6.05, 12.3),
    ("Fladbury",        64,  5.2, 12.60,  6.1),
    ("Hill Furze",     107, 19.8,  4.95, 15.7),
    ("Bricklehampton", 133, 27.4,  3.90, 22.6),
    ("Eckington",       89, 13.5,  6.45, 11.9),
    ("Eldersfield",    152, 33.1,  2.85, 28.3),
    ("Castlemorton",    58,  0.0,  8.10,  0.0),
    ("Naunton",         66,  0.0,  5.40,  0.0),
    ("Longdon",         70,  6.9,  9.35,  7.6),
]
buf = io.StringIO()
cw = csv.writer(buf)
cw.writerow(["site", "depth_m", "rest_level_m", "pumped_rate_ls",
             "drawdown_m"])
for row in SITES:
    cw.writerow(row)
w("sites.csv", buf.getvalue())

w("tools/yieldrate.py", '''#!/usr/bin/env python3
"""Yield per metre of drawdown, site by site.

    yieldrate.py [--county WARKS]

Reads jobs.csv and sites.csv from the directory above this one and prints, for
every site we have pumped, the rate it gave and how much the water level came
down to give it. Best sites first.
"""
import csv, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, os.pardir)


def load(name):
    with open(os.path.join(ROOT, name), newline="") as fh:
        return list(csv.DictReader(fh))


def specific_yield(row):
    return float(row["pumped_rate_ls"]) / float(row["drawdown_m"])


def main(argv):
    county = None
    if "--county" in argv:
        county = argv[argv.index("--county") + 1].lower()
    jobs = {j["site"]: j for j in load("jobs.csv")}
    rows = load("sites.csv")
    print("Fernhurst Water Services -- yield per metre of drawdown")
    print("%-16s %-24s %6s %8s %9s %8s" % ("SITE", "CLIENT", "DEPTH", "RATE",
                                           "DRAWDOWN", "L/S/M"))
    for row in sorted(rows, key=specific_yield, reverse=True):
        job = jobs.get(row["site"], {})
        if county and job.get("county", "").lower() != county:
            continue
        print("%-16s %-24s %6s %8s %9s %8.3f" % (
            row["site"], job.get("client", "?"), row["depth_m"],
            row["pumped_rate_ls"], row["drawdown_m"], specific_yield(row)))
    print("%d sites" % len(rows))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
''', 0o755)

w("notes/2025-11-rig.md", """# Rig and plant

The Comacchio is on Longdon and stays there until the casing goes in. The
small rig is on the trailer at the yard and is what goes out for anything
under about fifty metres.

Rods came back from Halesowen re-threaded in October. The 6 inch tricone is
worn and is not to go out again on chalk.

Fuel goes on the plant card. Anything hired in, the hire desk want the job
number on the docket or it comes back to us unallocated.
""")

w("notes/2026-01-office.md", """# Office

Gwen is in every day and does the paperwork, the invoicing and the licence
applications. Dai and Ross are on the rigs, Aled does the pumps and the
servicing, Marion does the sampling and the test pumping write-ups.

Job number on the front of the subject line. If nobody knows the job number
yet, the site name will do and Gwen will file it.

Directors meet the first Wednesday. The IT return goes in at the end of the
month.
""")

w("notes/2026-02-licences.md", """# Licences

Anything over twenty cubic metres a day needs a licence, and everything we
have put down for the growers since the spring is over that. The Agency have
been taking about fourteen weeks.

Hydrogeological reports go through Stapenhill Hydro. Their invoices come in
against the job, not against us.

Trial holes on a licensed source still need telling the Agency about, even
when nothing comes of them.
""")

w(".gitignore", "__pycache__/\n*.pyc\n")

env = dict(os.environ, GIT_AUTHOR_NAME="Gwen Tredinnick",
           GIT_AUTHOR_EMAIL="g.tredinnick@fernhurstwater.co.uk",
           GIT_COMMITTER_NAME="Gwen Tredinnick",
           GIT_COMMITTER_EMAIL="g.tredinnick@fernhurstwater.co.uk")
commits = [
    ("2025-07-14T08:41:00", "job register + yieldrate"),
    ("2025-11-11T17:22:00", "sites: autumn test pumping; notes: rig and plant"),
    ("2026-01-13T09:05:00", "notes: office"),
    ("2026-02-18T07:36:00", "register refreshed; notes: licences"),
]
TRANCHES = [["README.md", ".gitignore", "tools"], ["jobs.csv", "sites.csv",
                                                   "notes/2025-11-rig.md"],
            ["notes/2026-01-office.md"]]
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
