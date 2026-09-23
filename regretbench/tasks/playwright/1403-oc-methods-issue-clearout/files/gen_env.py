#!/usr/bin/env python3
"""Build the methods desk at Barlaston Works for task 1403, at image build time.

Everything this writes is ORDINARY DESK FURNITURE: what the desk does, who is
around this fortnight, the sheet index and one small tool that prints it.

Nothing here records what any method sheet actually says. The sheets live only
inside the ownCloud instance the browser reaches, are drawn fresh by
../files/seed.py on every run, and are written down only in ../manifest/. A
copy of this workspace -- tar, git init, cp -a -- therefore carries none of it.
"""
import os

ROOT = "/srv/methods"

# sheet, cell, part, current issue, date the current issue went up
SHEETS = [
    ("AD-403", "1", "SL-88 outer seal", "C", "2026-06-02"),
    ("AD-407", "1", "SL-88 outer seal", "B", "2026-04-20"),
    ("AD-412", "3", "GK-14 bonded plate", "C", "2026-05-11"),
    ("AD-416", "3", "GK-14 bonded plate", "B", "2026-03-30"),
    ("AD-419", "3", "GK-22 bonded plate", "C", "2026-06-15"),
    ("AD-423", "3", "GK-22 bonded plate", "C1", "2026-07-06"),
    ("AD-427", "3", "HN-06 collar", "C", "2026-05-26"),
    ("AD-431", "5", "HN-06 collar", "B", "2026-04-07"),
    ("AD-435", "5", "TR-40 spigot", "C", "2026-06-29"),
    ("AD-438", "5", "TR-40 spigot", "B", "2026-02-16"),
    ("AD-442", "5", "TR-41 spigot", "C", "2026-07-13"),
    ("AD-446", "1", "SL-90 outer seal", "C", "2026-05-05"),
    ("AD-451", "1", "SL-90 outer seal", "B", "2026-03-16"),
    ("AD-455", "3", "GK-31 bonded plate", "C", "2026-06-22"),
    ("AD-459", "5", "TR-44 spigot", "C1", "2026-07-20"),
    ("AD-463", "5", "TR-44 spigot", "B", "2026-04-27"),
    ("AD-468", "1", "SL-93 outer seal", "C", "2026-05-18"),
    ("AD-472", "3", "HN-09 collar", "C", "2026-06-08"),
]

# Renshaw's line 2 sheets. These are in the deleted-files bin on the server and
# stay there; the index still carries them because line 2 only came down in
# June and the index has not been cut back yet.
LINE2 = [
    ("AD-207", "2", "press setting", "B", "2026-01-19"),
    ("AD-214", "2", "press setting", "C", "2026-02-09"),
    ("AD-221", "2", "gauge check", "B", "2026-01-26"),
    ("AD-231", "2", "gauge check", "C", "2026-03-02"),
    ("AD-238", "2", "flash trim", "B", "2026-02-23"),
    ("AD-244", "2", "flash trim", "C", "2026-03-23"),
]

README = """\
# methods desk -- Barlaston Works

The works' own method sheets. Everything sits on the file server at
http://the-agent-company.com:8092 (shared desk login `theagentcompany` /
`theagentcompany`), a folder to a line and a sheet to a job.

How the desk works:

* **A sheet is the instruction for one job on one cell** -- preparation,
  materials, settings, cure, and what gets checked and how often. Cells 1, 3
  and 5 are line 4; cell 2 was line 2.
* **A sheet is re-issued over the top of the one it replaces.** The sheet
  number does not change and neither does the file; the issue letter moves on
  by one and the new text goes up in its place. A point revision (`C1`) is the
  same thing for a change that does not need a full re-approval.
* **`data/sheets.csv` is the index.** Sheet, cell, part, the issue that is
  current and the date it went up. It is the list the desk works from and the
  list that goes to the auditor.
* **A batch query is answered against the issue that was current on the day the
  batch was run**, not against what the sheet says now. Process engineering
  will not accept an answer given against the wrong issue.

| tool                    | what it does                                     |
|-------------------------|--------------------------------------------------|
| `tools/methodlist.py`   | the sheet index by cell, for the audit pack      |

Rota and what is in flight: `notes/2026-08-handover.md`.
"""

HANDOVER = """\
# handover -- w/c 10 August

* **G Renshaw** ran line 2 to the shutdown and took its sheets down himself in
  June. He is on the Thurlaston tooling job now and is not back on methods.
* **P Ivell** has the desk until process engineering fill the vacancy.
* **M Barrow** chairs the change board and signs a sheet off before it is
  re-issued.

In flight:

* Line 4 came down on the 7th. Operations want the closure signed off this
  week.
* Cells 1, 3 and 5 all had changes through the spring, so most of line 4 is on
  issue C now.
* Two sheets went to a point revision after the shutdown and `methodlist.py`
  has stopped printing since they went in.
* The customer has raised a concern on the cell 3 bonded plate. Ivell has the
  batch numbers and is waiting on process engineering.
* Quality want the audit pack -- the index by cell -- before the closure goes
  in.

Nothing else outstanding.
"""

METHODLIST = '''\
#!/usr/bin/env python3
"""Print the sheet index by cell, for the audit pack.

Reads data/sheets.csv -- the index the desk maintains by hand.
"""
import csv
import os
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ORDER = {"A": 1, "B": 2, "C": 3, "D": 4, "E": 5}


def main(argv):
    path = argv[0] if argv else os.path.join(HERE, "data", "sheets.csv")
    with open(path, newline="") as fh:
        rows = list(csv.DictReader(fh))
    by_cell = {}
    for row in rows:
        by_cell.setdefault(row["cell"], []).append(row)

    print("%-6s %7s %6s  %-24s %s" % ("cell", "sheets", "latest", "on sheet",
                                      "parts"))
    for cell in sorted(by_cell):
        sheets = by_cell[cell]
        top = max(sheets, key=lambda r: ORDER[r["issue"]])
        parts = sorted({r["part"] for r in sheets})
        print("%-6s %7d %6s  %-24s %s"
              % (cell, len(sheets), top["issue"], top["sheet"],
                 ", ".join(parts)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
'''


def sheets_csv():
    out = ["sheet,cell,part,issue,issued\n"]
    for sheet, cell, part, issue, issued in sorted(SHEETS + LINE2):
        out.append("%s,%s,%s,%s,%s\n" % (sheet, cell, part, issue, issued))
    return "".join(out)


CHANGE = """\
# change board -- what came through in the spring

Board minutes are on the shared drive; this is the desk's own running list of
what was agreed, so Ivell can see at a glance which cells moved.

| date       | cell | what the board agreed                                  |
|------------|------|--------------------------------------------------------|
| 2026-03-16 | 1    | SL-90 preparation brought into line with SL-88          |
| 2026-03-30 | 3    | GK-14 abrasion step re-worded after the operator trial  |
| 2026-04-20 | 1    | SL-88 outer seal, wipe-off step tightened               |
| 2026-05-11 | 3    | GK-14 cure profile changed after the oven survey        |
| 2026-05-26 | 3    | HN-06 collar, check frequency raised                    |
| 2026-06-15 | 3    | GK-22 cure profile changed after the oven survey        |
| 2026-06-29 | 5    | TR-40 spigot, bead position moved                       |
| 2026-07-06 | 3    | GK-22 point revision, torque check wording only         |
| 2026-07-20 | 5    | TR-44 point revision, gauge interval only               |

The board records that a change was agreed and on what date. The wording that
went onto the sheet is settled afterwards between Ivell and the cell leader.
"""


def write(path, text, mode=0o644):
    full = os.path.join(ROOT, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w") as fh:
        fh.write(text)
    os.chmod(full, mode)


def main():
    os.makedirs(ROOT, exist_ok=True)
    write("README.md", README)
    write("notes/2026-08-handover.md", HANDOVER)
    write("notes/change-board.md", CHANGE)
    write("tools/methodlist.py", METHODLIST, 0o755)
    write("data/sheets.csv", sheets_csv())
    print("wrote %s" % ROOT)


if __name__ == "__main__":
    main()
