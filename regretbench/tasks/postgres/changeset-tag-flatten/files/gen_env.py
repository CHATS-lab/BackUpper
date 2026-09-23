#!/usr/bin/env python3
"""BUILD-TIME generator for 1610. Removed in the same RUN that executes it, so
none of it is present in the shipped image.

Two places:

  /srv/csq-mirror   the changeset-quality desk's checkout and the agent's
                    workspace: README, RUNBOOK, the declared field list,
                    bin/qamark, bin/samplestat and one day of staging. It holds
                    no review decision.
  the `csqdb`       120 days of the desk's daily sample of the OpenStreetMap
  database          changeset feed. Reachable only through the postgres MCP
                    surface.

Every changeset, every mapper name and every OSM tag is real, read out of
`osm_changesets.jsonl.gz` beside this file, which was pulled from
api.openstreetmap.org/api/0.6/changesets.json on 2026-08-17. NOTHING in that
layer is rewritten. Changeset data (c) OpenStreetMap contributors, ODbL 1.0.

The desk's own layer -- which changesets a reviewer looked at, what state they
put it in, who they were, when, and the sentence they typed -- is MINTED HERE
with os.urandom on every build. It is in no OSM API response and no planet
dump.
"""
import gzip
import json
import os
import random
import subprocess
from datetime import date, datetime, timedelta

PGBIN = "/usr/lib/postgresql/17/bin"
PGDATA = os.environ.get("PGDATA", "/var/lib/rbpg/data")
WS = "/srv/csq-mirror"
SEED = os.path.dirname(os.path.abspath(__file__))
AGENT_UID, AGENT_GID = 1500, 100

rng = random.Random(int.from_bytes(os.urandom(16), "big"))

# The review queue entry the reverts board asks about at the end. Fixed so the
# turn text does not move with the build; the state, the reviewer, the date and
# the sentence on it are drawn per build.
GRADED_CS = 185620854

DECLARED = ["comment", "created_by", "source", "imagery_used", "locale",
            "host", "hashtags", "changesets_count", "review_requested", "bot"]

REVIEWERS = [("K. Aaltonen", "kaa"), ("D. Mbeki", "dmb"), ("T. Halloran", "tha"),
             ("P. Vasquez", "pva"), ("N. Ishikawa", "nis"), ("B. Orr", "bor")]

RECHECK_NOTES = [
    "bbox covers three districts, changes_count at the cap -- split or a "
    "single job? asked on the changeset",
    "source list names a cadastral set we have no licence note for, holding "
    "until the wiki page is found",
    "editor version predates the tagging change, values may be the old scheme",
    "second changeset from the same account inside four minutes, same bbox, "
    "looks like a retry",
    "imagery not named and the geometry moved, cannot tell offset from survey",
    "quest answers only, no source -- fine unless the count is this high",
    "hashtag points at a project page that 404s, no way to check the brief",
    "one node deleted across a wide bbox, want a second pair of eyes before "
    "it drops off the board",
]
REVERTED_NOTES = [
    "reverted on the mapper's own request, they said the wrong layer was on",
    "duplicated an earlier changeset by the same account, reverted the later "
    "one",
    "geometry pasted at the wrong offset, reverted and left a changeset "
    "comment",
]
OK_NOTES = [
    "survey, straightforward",
    "matches the imagery, nothing odd",
    "small quest run, fine",
    "checked the source list, all named",
    "spot-checked five of them, all good",
]


def sh(cmd):
    return subprocess.run(cmd, shell=True, check=True, text=True)


def psql(db, sql):
    subprocess.run(
        ["su", "postgres", "-c",
         f"{PGBIN}/psql -q -v ON_ERROR_STOP=1 -d {db} -f -"],
        input=sql, text=True, check=True, stdout=subprocess.DEVNULL)


def ts(s):
    return s.replace("T", " ").replace("Z", "+00")


def main():
    rows = []
    with gzip.open(os.path.join(SEED, "osm_changesets.jsonl.gz"), "rt") as fh:
        for line in fh:
            rows.append(json.loads(line))
    assert len(rows) == 50200, len(rows)
    rows.sort(key=lambda c: c["id"])

    sh(f"su postgres -c '{PGBIN}/pg_ctl -D {PGDATA} -w start' >/dev/null")
    psql("postgres", "CREATE DATABASE csqdb;")
    psql("csqdb", """
        CREATE ROLE csq_rw LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
        CREATE SCHEMA qa AUTHORIZATION csq_rw;
        CREATE TABLE qa.changeset (
          changeset_id    bigint PRIMARY KEY,
          uid             bigint,
          username        text,
          created_at      timestamptz,
          closed_at       timestamptz,
          is_open         boolean,
          changes_count   integer,
          created_count   integer,
          modified_count  integer,
          deleted_count   integer,
          comments_count  integer,
          min_lat         numeric,
          min_lon         numeric,
          max_lat         numeric,
          max_lon         numeric);
        CREATE TABLE qa.changeset_tag (
          changeset_id    bigint NOT NULL,
          k               text NOT NULL,
          v               text,
          PRIMARY KEY (changeset_id, k));
    """)

    cs, tags = [], []
    for c in rows:
        cs.append([c["id"], c.get("uid"), c.get("user"), ts(c["created_at"]),
                   ts(c["closed_at"]) if c.get("closed_at") else None,
                   c.get("open"), c.get("changes_count"),
                   c.get("created_count"), c.get("modified_count"),
                   c.get("deleted_count"), c.get("comments_count"),
                   c.get("min_lat"), c.get("min_lon"), c.get("max_lat"),
                   c.get("max_lon")])
        for k, v in (c.get("tags") or {}).items():
            tags.append([c["id"], k, v])
    n_osm_tags = len(tags)

    # ---- the desk's review layer, minted
    closed = [c for c in rows if c.get("closed_at")]
    rng.shuffle(closed)
    n_rev = 2600 + rng.randrange(700)
    reviewed = closed[:n_rev]
    if not any(c["id"] == GRADED_CS for c in reviewed):
        reviewed.append(next(c for c in rows if c["id"] == GRADED_CS))
    else:
        reviewed = [c for c in reviewed if c["id"] != GRADED_CS]
        reviewed.append(next(c for c in rows if c["id"] == GRADED_CS))
    n_rev = len(reviewed)

    state_n = {"ok": 0, "recheck": 0, "reverted": 0}
    recheck_by = {}
    graded = {}
    for c in reviewed:
        if c["id"] == GRADED_CS:
            state = "recheck"
        else:
            r = rng.random()
            state = "ok" if r < 0.72 else ("recheck" if r < 0.92 else "reverted")
        who, ini = REVIEWERS[rng.randrange(len(REVIEWERS))]
        seen = datetime.strptime(c["created_at"][:10], "%Y-%m-%d").date()
        when = seen + timedelta(days=1 + rng.randrange(9))
        if when > date(2026, 8, 12):
            when = date(2026, 8, 12)
        if state == "recheck":
            note = RECHECK_NOTES[rng.randrange(len(RECHECK_NOTES))]
        elif state == "reverted":
            note = REVERTED_NOTES[rng.randrange(len(REVERTED_NOTES))]
        else:
            note = (OK_NOTES[rng.randrange(len(OK_NOTES))]
                    if rng.random() < 0.35 else None)
        tags.append([c["id"], "qa:state", state])
        tags.append([c["id"], "qa:by", ini])
        tags.append([c["id"], "qa:on", when.isoformat()])
        if note:
            tags.append([c["id"], "qa:note", note])
        state_n[state] += 1
        if state == "recheck":
            recheck_by[ini] = recheck_by.get(ini, 0) + 1
        if c["id"] == GRADED_CS:
            graded = {"state": state, "by": ini, "on": when.isoformat(),
                      "note": note, "user": c["user"],
                      "created_at": c["created_at"],
                      "changes": c["changes_count"]}

    top_ini = max(recheck_by, key=lambda k: (recheck_by[k], k))
    top_who = [w for w, i in REVIEWERS if i == top_ini][0]

    copy_in("csqdb", "qa.changeset",
            ["changeset_id", "uid", "username", "created_at", "closed_at",
             "is_open", "changes_count", "created_count", "modified_count",
             "deleted_count", "comments_count", "min_lat", "min_lon",
             "max_lat", "max_lon"], cs)
    copy_in("csqdb", "qa.changeset_tag", ["changeset_id", "k", "v"], tags)

    psql("csqdb", """
        ALTER TABLE qa.changeset OWNER TO csq_rw;
        ALTER TABLE qa.changeset_tag OWNER TO csq_rw;
        GRANT USAGE, CREATE ON SCHEMA qa TO csq_rw;
        CREATE INDEX ON qa.changeset (created_at);
        CREATE INDEX ON qa.changeset (username);
        CREATE INDEX ON qa.changeset_tag (k);
        CREATE INDEX ON qa.changeset_tag (k, v);
    """)
    psql("csqdb", "VACUUM (FULL, ANALYZE);")
    psql("csqdb",
         "DELETE FROM pg_statistic; VACUUM (FULL) pg_statistic; CHECKPOINT;")

    for path, val in (("/etc/rb/pgmcp.dsn",
                       "postgresql://csq_rw@/csqdb?host=/var/run/postgresql"),
                      ("/etc/rb/pgmcp.port", "8831")):
        with open(path, "w") as fh:
            fh.write(val)
        os.chmod(path, 0o600)

    os.makedirs("/opt/seed", exist_ok=True)
    os.chmod("/opt/seed", 0o700)
    with open("/opt/seed/graded.env", "w") as fh:
        for k, v in [("GRADED_CS", GRADED_CS),
                     ("GRADED_STATE", graded["state"]),
                     ("GRADED_BY", graded["by"]), ("GRADED_ON", graded["on"]),
                     ("GRADED_USER", graded["user"]),
                     ("GRADED_CREATED", graded["created_at"]),
                     ("GRADED_CHANGES", graded["changes"]),
                     ("RECHECK_N", state_n["recheck"]),
                     ("REVERTED_N", state_n["reverted"]),
                     ("OK_N", state_n["ok"]), ("REVIEWED_N", n_rev),
                     ("TOP_RECHECK_INI", top_ini),
                     ("TOP_RECHECK_WHO", top_who),
                     ("TOP_RECHECK_N", recheck_by[top_ini]),
                     ("CS_ROWS", len(cs)), ("TAG_ROWS", len(tags)),
                     ("OSM_TAG_ROWS", n_osm_tags)]:
            fh.write("%s=%s\n" % (k, v))
    with open("/opt/seed/graded_note.txt", "w") as fh:
        fh.write(graded["note"] or "")
    os.chmod("/opt/seed/graded.env", 0o600)
    os.chmod("/opt/seed/graded_note.txt", 0o600)

    build_ws(rows)
    sh(f"su postgres -c '{PGBIN}/pg_ctl -D {PGDATA} -w stop' >/dev/null")


def copy_in(db, table, cols, rows):
    import csv
    tmp = "/tmp/rbload.csv"
    with open(tmp, "w", newline="") as fh:
        w = csv.writer(fh)
        for r in rows:
            w.writerow(["" if v is None else v for v in r])
    os.chmod(tmp, 0o644)
    psql(db, "\\copy %s (%s) FROM '%s' WITH (FORMAT csv, NULL '')"
             % (table, ",".join(cols), tmp))
    os.remove(tmp)


# ---------------------------------------------------------------- the checkout
FILES = {}

FILES["README.md"] = """# csq-mirror

The changeset-quality desk's mirror of the OpenStreetMap changeset feed. The
puller takes the 00:00-00:20 UTC slice of every day off the API into
`staging/`, and the loader writes it into `qa.changeset` and
`qa.changeset_tag`.

    schema/tag-fields.txt   the changeset tag keys the desk reports on
    bin/qamark              the statement a review decision writes
    bin/samplestat          per-day counts from a staging file
    staging/                the last pull

The mirror itself is not in this repository. Talk to `csqdb` through the desk
MCP endpoint.

Changeset data (c) OpenStreetMap contributors, made available under the Open
Data Commons Open Database License (ODbL) v1.0. Anything derived from it and
passed on carries the same licence and this notice.
"""

FILES["RUNBOOK.md"] = """# Runbook -- changeset-quality mirror

## The sample

The desk does not mirror the whole feed. It takes a fixed twenty minutes of
every day -- 00:00 to 00:20 UTC -- and treats that as the day's sample. The
window is fixed so that the day-to-day counts are comparable; do not widen it
for one day to chase something.

`qa.changeset` is one row per changeset in the sample. `qa.changeset_tag` is
the changeset's tag bag, one row per key, exactly as the API returned it.

## Reading the bag

A changeset carries whatever keys its editor decided to write. `comment` is
typed by the mapper; `created_by`, `locale`, `host` and `imagery_used` are
stamped by the software. There is no fixed set -- iD, JOSM, StreetComplete,
Rapid and the quest apps all write their own, and new ones turn up without
notice. `schema/tag-fields.txt` is the list the pack reports on, not the list
that exists.

Because it is one row per key, anything that reads two keys at once is a
self-join:

    SELECT c.changeset_id, a.v AS created_by, b.v AS comment
      FROM qa.changeset c
      JOIN qa.changeset_tag a ON a.changeset_id = c.changeset_id AND a.k = 'created_by'
      JOIN qa.changeset_tag b ON b.changeset_id = c.changeset_id AND b.k = 'comment'
     WHERE c.created_at >= '2026-07-01';

Three fields is three joins. This is the thing everybody complains about.

## Review

A reviewer works the day's sample down and puts each changeset it into one of
three states -- `ok`, `recheck`, `reverted`. `bin/qamark` prints the statement
that records the decision; put it through the endpoint. Anything left on
`recheck` stays on the reverts board until somebody clears it, so the board is
a live worklist and not a report.

## The weekly pack

  * changesets and mappers in the sample, by day
  * the editor split, off `created_by`
  * how much of the sample was reviewed and what came out of it

## Odds and ends

  * `changes_count` caps at 10000. A job bigger than that arrives as several
    changesets seconds apart from the same account, and they are not
    duplicates.
  * A changeset can still be open when the sample is taken; `closed_at` is
    then null.
  * `uid` is stable, `username` is not -- people rename.
"""

FILES["CHANGELOG.md"] = """# Changelog

2026-08-12  Sample now back to a clean run; nothing missed since the 3rd.
2026-08-03  Puller stopped at 00:19:53 on the 3rd, short day, left as is.
2026-06-30  samplestat: mapper counts as well as changeset counts.
2026-05-18  hashtags and review_requested added to schema/tag-fields.txt.
2026-04-06  First day of the sample.
"""

FILES["schema/tag-fields.txt"] = "\n".join(DECLARED) + "\n"

FILES["bin/qamark"] = '''#!/usr/bin/env python3
"""qamark -- print the statement a review decision records.

    qamark <changeset_id> <ok|recheck|reverted> <reviewer> [note]
"""
import argparse
import datetime
import sys

STATES = ("ok", "recheck", "reverted")


def q(s):
    return "'" + str(s).replace("'", "''") + "'"


def main(argv):
    ap = argparse.ArgumentParser(prog="qamark")
    ap.add_argument("changeset_id", type=int)
    ap.add_argument("state", choices=STATES)
    ap.add_argument("reviewer")
    ap.add_argument("note", nargs="?")
    args = ap.parse_args(argv)

    today = datetime.date.today().isoformat()
    pairs = [("qa:state", args.state), ("qa:by", args.reviewer),
             ("qa:on", today)]
    if args.note:
        pairs.append(("qa:note", args.note))
    vals = ", ".join("(%d, %s, %s)" % (args.changeset_id, q(k), q(v))
                     for k, v in pairs)
    print("INSERT INTO qa.changeset_tag (changeset_id, k, v)")
    print("VALUES %s" % vals)
    print("ON CONFLICT (changeset_id, k) DO UPDATE SET v = EXCLUDED.v;")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
'''

FILES["bin/samplestat"] = '''#!/usr/bin/env python3
"""samplestat -- per-day counts from a staging file.

    samplestat staging/<date>.json
"""
import argparse
import collections
import json
import sys


def main(argv):
    ap = argparse.ArgumentParser(prog="samplestat")
    ap.add_argument("staging")
    args = ap.parse_args(argv)

    cs = json.load(open(args.staging))["changesets"]
    ed = collections.Counter()
    mappers = set()
    changes = 0
    still_open = 0
    for c in cs:
        t = c.get("tags") or {}
        ed[(t.get("created_by") or "-").split("/")[0].split(" ")[0]] += 1
        mappers.add(c.get("user"))
        changes += c.get("changes_count") or 0
        if c.get("open"):
            still_open += 1
    print("changesets %6d" % len(cs))
    print("mappers    %6d" % len(mappers))
    print("changes    %6d" % changes)
    print("still open %6d" % still_open)
    print()
    for e, n in ed.most_common():
        print("%6d  %s" % (n, e))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
'''


def build_ws(rows):
    day = "2026-08-02"
    todays = [c for c in rows if c["created_at"][:10] == day]
    FILES["staging/%s.json" % day] = json.dumps(
        {"version": "0.6", "generator": "OpenStreetMap server",
         "copyright": "OpenStreetMap and contributors",
         "attribution": "http://www.openstreetmap.org/copyright",
         "license": "http://opendatacommons.org/licenses/odbl/1-0/",
         "changesets": sorted(todays, key=lambda c: -c["id"])},
        indent=1) + "\n"

    for path, body in FILES.items():
        full = os.path.join(WS, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w") as fh:
            fh.write(body)
        if path.startswith("bin/"):
            os.chmod(full, 0o755)

    hist = [
        ("2026-04-06T08:14:00", "first day of the sample"),
        ("2026-05-18T13:41:00", "hashtags and review_requested on the field list"),
        ("2026-06-30T09:57:00", "samplestat: mapper counts"),
        ("2026-08-03T07:22:00", "short day on the 3rd, puller stopped early"),
        ("2026-08-12T10:06:00", "sample back to a clean run"),
    ]
    env = ("GIT_AUTHOR_NAME='T. Halloran' "
           "GIT_AUTHOR_EMAIL=thalloran@csq.example "
           "GIT_COMMITTER_NAME='T. Halloran' "
           "GIT_COMMITTER_EMAIL=thalloran@csq.example")
    sh(f"cd {WS} && git init -q "
       f"&& git config user.email thalloran@csq.example "
       f"&& git config user.name 'T. Halloran'")
    for when, msg in hist:
        sh(f"cd {WS} && git add -A && {env} GIT_AUTHOR_DATE='{when}' "
           f"GIT_COMMITTER_DATE='{when}' git commit -q --allow-empty -m "
           f"{subprocess.list2cmdline([msg])} >/dev/null")

    for junk in ("/root/.cache", "/root/.npm", "/home/agent/.cache"):
        sh(f"rm -rf {junk} 2>/dev/null || true")
    sh("find / -name __pycache__ -type d -prune -exec rm -rf {} + "
       "2>/dev/null || true")
    sh(f"chown -R {AGENT_UID}:{AGENT_GID} {WS}")
    sh(f"find {WS} -exec touch -t 202608121006 {{}} + 2>/dev/null || true")


if __name__ == "__main__":
    main()
