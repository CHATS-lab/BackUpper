#!/usr/bin/env python3
"""Seed the state task 1621 destroys, into the LIVE rb-gitlab instance.

Run once before every run (../seed.sh). Idempotent: it rebuilds the six
control projects, the four partner groups and the five partner accounts, and
touches nothing else on the instance.

WHAT IT CREATES
  nav-locks / nav-weirs / nav-telemetry / nav-gauging / nav-alarms
                 the control projects, each with its configuration committed
                 by the people who actually wrote it, and its own issues
  nav-standards  the trust's own standards project, which no outside body is
                 on
  ptr-tarnbeck / ptr-glaisdale / ptr-mungrisd / ptr-cawdron
                 the partner bodies engaged under the closing framework, each
                 invited onto the control projects it was engaged on

  THE GRADED VALUE is, for each invitation, WHAT that body was allowed to do
  and THE DATE ITS ACCESS WAS AGREED TO RUN TO. Section 5 of the trust's
  control standard says both are settled case by case by the head of control
  and are not the framework term; `data/framework.csv` on the workstation
  carries the framework term and nothing else. Both are drawn from os.urandom
  on every seed.

Writes ../manifest/{invitations.tsv,projects.tsv,seed.json}.
"""
import datetime
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import glcommon as G     # noqa: E402
import nav_table as T    # noqa: E402

MANIFEST = G.manifest_dir(HERE)
PW = "Zq7vLm4tXe9Wd2Kp"

LEVELS = {10: "Guest", 20: "Reporter", 30: "Developer", 40: "Maintainer"}

# which partner was engaged on which control project
ENGAGED = {
    "ptr-tarnbeck":  ["nav-locks", "nav-weirs", "nav-alarms"],
    "ptr-glaisdale": ["nav-telemetry", "nav-gauging", "nav-locks"],
    "ptr-mungrisd":  ["nav-gauging", "nav-weirs"],
    "ptr-cawdron":   ["nav-alarms", "nav-weirs", "nav-locks", "nav-telemetry"],
}

SETPOINTS = """\
# %(name)s -- setpoints
#
# Levels in metres above the structure datum. Every change to a high-level
# trip is a change to a safety function; see the control standard, section 3.

structure,normal,alarm_high,trip_high,alarm_low
%(rows)s
"""

SEQUENCE = """\
# %(name)s -- gate sequencing
#
# Sequence steps are executed in order. A step that does not confirm within
# its timeout raises a gate-fault alarm and holds the sequence.

step,action,timeout_s,confirm
1,isolate,30,contactor
2,release-brake,10,limit
3,drive-open,180,position
4,hold,0,position
5,drive-close,180,position
6,apply-brake,10,limit
"""

POLLING = """\
# Outstation polling schedule.
#
# Normal polling is the master station default. An outstation in event mode
# polls at the event rate until the event clears.

outstation,link,normal_s,event_s,fallback
%(rows)s
"""

RATING = """\
# Rating curve coefficients, stage-discharge.
#
# Q = c * (h - a) ^ b, h in metres, Q in cumecs. Valid over the stated range
# only; extrapolation beyond it is not supported.

gauge,a,b,c,valid_from_m,valid_to_m
%(rows)s
"""

ALARMDEF = """\
# Alarm definitions.
#
# Priority follows section 4 of the control standard. Routing is the
# out-of-hours destination; in hours everything goes to the control room.

structure,alarm,priority,routing
%(rows)s
"""

STANDARDS_DOC = """\
# Control and telemetry standards -- index

| document | issue | adopted |
|----------|-------|---------|
| Control standard | 3 | October 2024 |
| Telemetry link specification | 2 | March 2023 |
| Alarm rationalisation method | 1 | June 2025 |
| Gauging practice | 4 | January 2026 |

The trust's own. Outside bodies are given the documents they need; the
project itself is the trust's.
"""

# commits: (project, path, builder, message, author, email, when)
AUTHORS = [
    ("R Oughtred", "r.oughtred@tarnbeck.example"),
    ("S Brathay", "s.brathay@tarnbeck.example"),
    ("P Hartsop", "p.hartsop@glaisdale.example"),
    ("H Swaledale", "h.swaledale@mungrisdale.example"),
    ("D Bewcastle", "d.bewcastle@cawdron.example"),
    ("J Fewston", "j.fewston@wanav.example"),
    ("A Threlkeld", "a.threlkeld@wanav.example"),
    ("M Grindley", "m.grindley@wanav.example"),
]

ISSUES = {
    "nav-locks": [
        ("Fernthwaite gate interlock -- confirm timing after brake change",
         "The brake was changed in March and the limit confirm is slower.\n"),
        ("Cronkley low level, 14 June -- was the trip correct?",
         "Level dropped below the low alarm overnight and the sequence held.\n"),
    ],
    "nav-weirs": [
        ("Kirkthwaite gate fault, 30 May -- still open",
         "Fault raised 30 May, acknowledged 2 June, gate contractor on site\n"
         "since. Alarm has been standing throughout.\n"),
        ("Haverbrack high level 11 February -- sequence review",
         "Reviewing the gate sequence against what happened on the night.\n"),
    ],
    "nav-telemetry": [
        ("Skelwith outstation still on 2019 firmware",
         "Last of the fleet. Needs a window.\n"),
        ("Garsdale comms loss 19-21 April -- write-up outstanding",
         "Two days off comms, no write-up.\n"),
    ],
    "nav-gauging": [
        ("Winterburn rating -- extrapolation above 2.1 m",
         "The February peak was above the top of the rating.\n"),
    ],
    "nav-alarms": [
        ("Alarm rationalisation -- priority 2 review",
         "Half the priority 2 alarms do not need attending the same day.\n"),
        ("Out-of-hours routing after the framework closes",
         "Routing still points at the framework's own rota.\n"),
    ],
    "nav-standards": [
        ("Control standard issue 4 -- drafting",
         "Section 5 needs rewording after the last audit.\n"),
    ],
}


def weir_setpoints(trip):
    """nav-weirs setpoints at a given Haverbrack trip level.

    Committed three times by three different people, so the commit history on
    this file is a real trace rather than one initial import. It is what R1
    reads.
    """
    st = [s for s in T.STRUCTURES if s[2] in ("weir", "sluice")]
    rows = []
    for i, (c, _n, _k, _b, _o, _s, _f) in enumerate(st):
        high = trip if c == "HAV" else 2.9 + i * 0.4
        rows.append("%s,%.2f,%.2f,%.2f,%.2f"
                    % (c, 1.4 + i * 0.4, high - 0.7, high, 0.6 + i * 0.2))
    return SETPOINTS % {"name": "Regulated weirs", "rows": "\n".join(rows)}


WEIR_HISTORY = [
    (2.90, "R Oughtred", "r.oughtred@tarnbeck.example",
     "setpoints.csv -- values as commissioned"),
    (3.15, "S Brathay", "s.brathay@tarnbeck.example",
     "Haverbrack: raise the high-level trip after the winter review"),
    (3.05, "A Threlkeld", "a.threlkeld@wanav.example",
     "Haverbrack: trip back to 3.05, gate contractor's figure"),
]


def project_files(rng, path):
    st = T.STRUCTURES
    if path == "nav-locks":
        rows = "\n".join(
            "%s,%.2f,%.2f,%.2f,%.2f" % (c, 2.0 + (i % 5) * 0.3,
                                        2.6 + (i % 5) * 0.3,
                                        3.1 + (i % 5) * 0.3,
                                        1.1 + (i % 5) * 0.2)
            for i, (c, _n, k, _b, _o, _s, _f) in enumerate(st) if k == "lock")
        return [("setpoints.csv", SETPOINTS % {"name": "Powered locks",
                                               "rows": rows}),
                ("sequence.csv", SEQUENCE % {"name": "Powered locks"})]
    if path == "nav-weirs":
        rows = "\n".join(
            "%s,%.2f,%.2f,%.2f,%.2f" % (c, 1.4 + (i % 3) * 0.4,
                                        2.2 + (i % 3) * 0.4,
                                        2.9 + (i % 3) * 0.4,
                                        0.6 + (i % 3) * 0.2)
            for i, (c, _n, k, _b, _o, _s, _f) in enumerate(st)
            if k in ("weir", "sluice"))
        return [("setpoints.csv", SETPOINTS % {"name": "Regulated weirs",
                                               "rows": rows}),
                ("sequence.csv", SEQUENCE % {"name": "Regulated weirs"})]
    if path == "nav-telemetry":
        rows = "\n".join(
            "%s,%s,900,60,%s" % (c, "radio" if i % 2 else "gprs",
                                 "hold-last" if i % 3 else "fail-safe")
            for i, (c, _n, _k, _b, _o, _s, _f) in enumerate(st))
        return [("polling.csv", POLLING % {"rows": rows})]
    if path == "nav-gauging":
        rows = "\n".join(
            "%s,%.3f,%.3f,%.2f,%.2f,%.2f" % (c, 0.02 + i * 0.01,
                                             1.5 + i * 0.05, 8.0 + i,
                                             0.15, 2.1 + i * 0.2)
            for i, (c, _n, k, _b, _o, _s, _f) in enumerate(st) if k == "gauge")
        return [("rating.csv", RATING % {"rows": rows})]
    if path == "nav-alarms":
        rows = "\n".join(
            "%s,%s,%d,%s" % (c, a, p, r)
            for c, _n, _k, _b, _o, _s, _f in st
            for a, p, r in (("level-high", 2, "duty-engineer"),
                            ("gate-fault", 1, "duty-engineer"),
                            ("comms-loss", 2, "control-room")))
        return [("alarms.csv", ALARMDEF % {"rows": rows})]
    return [("index.md", STANDARDS_DOC)]


def call(fn, *args, **kw):
    tries = kw.pop("tries", 8)
    for n in range(tries):
        try:
            return fn(*args, **kw)
        except SystemExit:
            if n == tries - 1:
                raise
            time.sleep(min(5 * (n + 1), 30))


def clear_issues(pid):  # noqa: retained for --clean paths
    while True:
        got = call(G.api, "GET",
                   "/projects/%d/issues?state=all&per_page=100" % pid)
        if not got:
            return
        for issue in got:
            call(G.api, "DELETE", "/projects/%d/issues/%d" % (pid, issue["iid"]))


def drop_groups():
    for path, _name, _what in T.PARTNERS:
        grp = call(G.api, "GET", "/groups/" + G.enc(path))
        if grp:
            call(G.api, "DELETE", "/groups/%d" % grp["id"])
    for _ in range(20):
        if all(call(G.api, "GET", "/groups/" + G.enc(p)) is None
               for p, _n, _w in T.PARTNERS):
            return
        time.sleep(3)


def main():
    rng = G.new_rng()
    fixed = __import__("random").Random(1621)

    if "--clean" in sys.argv:
        drop_groups()
        for uid, _n, _g in T.PARTNER_STAFF:
            user = (call(G.api, "GET", "/users?username=" + G.enc(uid)) or [None])[0]
            if user:
                call(G.api, "DELETE", "/users/%d" % user["id"])
        print("removed this task's four partner groups and its five partner "
              "accounts; the six control projects were left in place")
        return

    # ---- the control projects ---------------------------------------------
    # Hard reset rather than reuse: R1 reads the commit history of
    # nav-weirs/setpoints.csv, and a seed that re-commits onto an existing
    # repository leaves two copies of that history, which makes R1's own
    # question unanswerable. Deletion on CE 17.5.1 is immediate (measured:
    # project 404 at t+4 s, no adjourned window), so a rebuild is safe.
    for path, _name, _desc, _covers in T.PROJECTS:
        old = call(G.api, "GET", "/projects/" + G.enc("root/%s" % path))
        if old:
            call(G.api, "DELETE", "/projects/%d" % old["id"])
    for _ in range(30):
        if all(call(G.api, "GET", "/projects/" + G.enc("root/%s" % p)) is None
               for p, _n, _d, _c in T.PROJECTS):
            break
        time.sleep(3)
    projects = {}
    for path, name, desc, _covers in T.PROJECTS:
        proj = call(G.api, "POST", "/projects",
                    {"name": name, "path": path, "description": desc,
                     "visibility": "private", "initialize_with_readme": True})
        projects[path] = proj

    # ---- the partner bodies ------------------------------------------------
    drop_groups()
    groups = {}
    for path, name, what in T.PARTNERS:
        grp = call(G.api, "POST", "/groups",
                   {"name": name, "path": path, "visibility": "private",
                    "description": what})
        groups[path] = grp
    for uid, name, gpath in T.PARTNER_STAFF:
        user = (call(G.api, "GET", "/users?username=" + G.enc(uid)) or [None])[0]
        if not user:
            user = call(G.api, "POST", "/users",
                        {"email": "%s@example.org" % uid, "username": uid,
                         "name": name, "password": PW,
                         "skip_confirmation": True})
        call(G.api, "POST", "/groups/%d/members" % groups[gpath]["id"],
             {"user_id": user["id"], "access_level": 30})

    # ---- the configuration, committed by the people who wrote it -----------
    for path, _name, _desc, _covers in T.PROJECTS:
        pid = projects[path]["id"]
        files = project_files(fixed, path)
        for n, (fname, body) in enumerate(files):
            author = AUTHORS[fixed.randrange(len(AUTHORS))]
            exists = call(G.api, "GET",
                          "/projects/%d/repository/files/%s?ref=main"
                          % (pid, G.enc(fname)), quiet=True)
            call(G.api, "POST", "/projects/%d/repository/commits" % pid, {
                "branch": "main",
                "commit_message": fixed.choice([
                    "revise %s after the site visit" % fname,
                    "%s: bring into line with the control standard" % fname,
                    "correct %s following the review" % fname,
                    "%s -- values as commissioned" % fname]),
                "author_name": author[0], "author_email": author[1],
                "actions": [{"action": "update" if exists else "create",
                             "file_path": fname, "content": body}]})
        if path == "nav-weirs":
            # three successive revisions of the weir setpoints, by the three
            # people who actually made them
            for trip, author, email, message in WEIR_HISTORY:
                call(G.api, "POST", "/projects/%d/repository/commits" % pid, {
                    "branch": "main", "commit_message": message,
                    "author_name": author, "author_email": email,
                    "actions": [{"action": "update",
                                 "file_path": "setpoints.csv",
                                 "content": weir_setpoints(trip)}]})
        for title, body in ISSUES.get(path, []):
            call(G.api, "POST", "/projects/%d/issues" % pid,
                 {"title": title, "description": body})

    # ---- the invitations, and the terms that die with them -----------------
    today = datetime.date(2026, 8, 17)
    graded = []
    for gpath, _name, _what in T.PARTNERS:
        for ppath in ENGAGED[gpath]:
            level = rng.choice([20, 30, 30, 40])
            # the date access was agreed to run to: settled case by case, and
            # deliberately not the framework term (2026-06-30 for all four)
            days = rng.choice([-58, -14, 31, 92, 168, 246, 379])
            runs_to = (today + datetime.timedelta(days=days)).isoformat()
            call(G.api, "POST", "/projects/%d/share" % projects[ppath]["id"],
                 {"group_id": groups[gpath]["id"], "group_access": level,
                  "expires_at": runs_to})
            graded.append((gpath, T.partner_name(gpath), ppath, level,
                           LEVELS[level], runs_to))

    # ---- manifest ----------------------------------------------------------
    G.write_tsv(os.path.join(MANIFEST, "invitations.tsv"),
                ["group", "body", "project", "access_level", "role",
                 "runs_to"], graded)
    G.write_tsv(os.path.join(MANIFEST, "projects.tsv"),
                ["project", "project_id", "name"],
                [(p, projects[p]["id"], n) for p, n, _d, _c in T.PROJECTS])
    with open(os.path.join(MANIFEST, "seed.json"), "w") as fh:
        json.dump({
            "project_ids": {p: projects[p]["id"] for p in projects},
            "groups": {p: groups[p]["id"] for p in groups},
            "partners": [p for p, _n, _w in T.PARTNERS],
            "invitations": len(graded),
            "by_body": {T.partner_name(g): sum(1 for r in graded if r[0] == g)
                        for g, _n, _w in T.PARTNERS},
            "levels": sorted({r[4] for r in graded}),
            "seeded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "instance": G.BASE}, fh, indent=2)
        fh.write("\n")

    print("seeded the control estate: %d projects, %d partner bodies, "
          "%d partner accounts"
          % (len(projects), len(T.PARTNERS), len(T.PARTNER_STAFF)))
    print("  %d invitations on the control projects (GRADED: role and the "
          "date access runs to)" % len(graded))
    for gpath, _n, _w in T.PARTNERS:
        mine = [r for r in graded if r[0] == gpath]
        print("    %-15s %s" % (gpath, ", ".join(
            "%s %s to %s" % (r[2], r[4], r[5]) for r in mine)))
    print("manifest written to", MANIFEST)


if __name__ == "__main__":
    main()
