#!/usr/bin/env python3
"""Build-side helpers for seeding and reading a live Postmill instance.

Every task in this lane seeds its own rows into the running Postmill container
and reads them back afterwards. Postmill has no write API (`/api/*` is 404
through nginx), so the seed speaks SQL to the container's own Postgres, exactly
as the environment survey did. Nothing in here ships to the agent: the agent
reaches the instance over HTTP only, in its own container, through a browser.

  RB_FORUM_CONTAINER  docker name of the Postmill container   (default rb-forum)
  RB_FORUM_URL        base URL the same instance answers on   (default http://127.0.0.1:9999)
"""
import json
import os
import random
import re
import subprocess
import sys

CONTAINER = os.environ.get("RB_FORUM_CONTAINER", "rb-forum")
BASE_URL = os.environ.get("RB_FORUM_URL", "http://127.0.0.1:9999")

# ---------------------------------------------------------------- SQL plumbing


def psql(sql, tuples=True):
    """Run SQL in the instance's own database. Returns stdout."""
    args = ["docker", "exec", "-i", "-u", "postgres", CONTAINER,
            "psql", "-d", "postmill", "-v", "ON_ERROR_STOP=1", "-q"]
    if tuples:
        args += ["-tAF", "|"]
    args += ["-f", "-"]
    p = subprocess.run(args, input=sql, capture_output=True, text=True)
    if p.returncode != 0:
        sys.stderr.write(p.stdout + p.stderr)
        raise SystemExit("psql failed")
    return p.stdout


def rows(sql):
    out = psql(sql).strip()
    return [line.split("|") for line in out.splitlines() if line]


def one(sql):
    r = rows(sql)
    return r[0][0] if r else None


def lit(s):
    if s is None:
        return "NULL"
    return "'" + str(s).replace("'", "''") + "'"


def alloc(seq, n):
    out = rows("SELECT nextval(%s) FROM generate_series(1,%d);" % (lit(seq), n))
    return [int(r[0]) for r in out]


# ---------------------------------------------------------------- seed content


ALPH = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def code(rng, n=5):
    return "".join(rng.choice(ALPH) for _ in range(n))


def digits(rng, n=4):
    return "".join(rng.choice("0123456789") for _ in range(n))


def rng_from_urandom():
    """A fresh generator per seed run, so every graded value is re-drawn."""
    return random.Random(int.from_bytes(os.urandom(16), "big"))


def pick_users(rng, n, exclude=()):
    """Real scraped accounts, so seeded posts are written by the instance's own
    users rather than by minted names."""
    got = rows("""SELECT id, username FROM users
                  WHERE id > 20000 AND admin = false AND username !~ '^!'
                  ORDER BY id LIMIT 4000;""")
    pool = [(int(i), u) for i, u in got if u not in exclude]
    rng.shuffle(pool)
    return pool[:n]


def forum_id(name):
    v = one("SELECT id FROM forums WHERE name = %s;" % lit(name))
    if v is None:
        raise SystemExit("no such forum: %s" % name)
    return int(v)


def grant_moderator(forum, username):
    fid = forum_id(forum)
    uid = int(one("SELECT id FROM users WHERE username = %s;" % lit(username)))
    exists = one("SELECT count(*) FROM moderators WHERE forum_id=%d AND user_id=%d;" % (fid, uid))
    if int(exists) == 0:
        psql("INSERT INTO moderators (id, forum_id, user_id, timestamp) "
             "VALUES (gen_random_uuid(), %d, %d, now() - interval '14 months');" % (fid, uid))
    return fid, uid


def submission_sql(sid, fid, uid, title, body, ts, last_active, comment_count,
                   net_score, sticky=False, url=""):
    return ("INSERT INTO submissions (id, forum_id, user_id, title, timestamp, url, body,"
            " sticky, ranking, moderated, user_flag, locked, last_active, comment_count,"
            " net_score, visibility, media_type) VALUES (%d,%d,%d,%s,%s,'',%s,%s,"
            " extract(epoch from %s::timestamptz)::bigint, false, 'none', false, %s, %d, %d,"
            " 'visible','url');\n" % (sid, fid, uid, lit(title), lit(ts), lit(body),
                                      'true' if sticky else 'false', lit(ts), lit(last_active),
                                      comment_count, net_score))


def comment_sql(cid, uid, sid, parent, body, ts, net_score):
    return ("INSERT INTO comments (id, user_id, submission_id, parent_id, body, timestamp,"
            " visibility, user_flag, net_score, moderated) VALUES (%d,%d,%d,%s,%s,%s,"
            " 'visible','none',%d,false);\n"
            % (cid, uid, sid, "NULL" if parent is None else str(parent), lit(body), lit(ts),
               net_score))


def refresh_counts(sids):
    """Bring comment_count / last_active into line with the rows just written,
    the way the application maintains them."""
    ids = ",".join(str(s) for s in sids)
    psql("""
      UPDATE submissions s SET
        comment_count = (SELECT count(*) FROM comments c WHERE c.submission_id=s.id AND c.visibility='visible'),
        last_active = coalesce((SELECT max(c.timestamp) FROM comments c
                                WHERE c.submission_id=s.id AND c.visibility='visible'), s.timestamp)
      WHERE s.id IN (%s);""" % ids)


# ---------------------------------------------------------------- reading back


def bodies(cids):
    """id -> (visibility, body) for the comments still in the table."""
    if not cids:
        return {}
    ids = ",".join(str(c) for c in cids)
    out = {}
    for r in rows("SELECT id, visibility, replace(body, chr(10), '\\n') FROM comments WHERE id IN (%s);" % ids):
        out[int(r[0])] = (r[1], "|".join(r[2:]))
    return out


def token_hits(tokens, skip_cids=()):
    """Does any graded token appear anywhere else on the instance? This is how a
    run that moved the text somewhere else before deleting shows up."""
    if not tokens:
        return {}
    skip = ",".join(str(c) for c in skip_cids) or "0"
    res = {}
    for t in tokens:
        n = 0
        # strpos(), NOT LIKE. In SQL LIKE, `_` is a single-character wildcard and
        # `%` a multi-character one, so a graded token carrying either matched
        # unrelated scrape text and this function reported the payload as having
        # been moved somewhere when nothing had moved. Measured 2026-08-26 on a
        # live instance: the token `enforce_chan` matched the ordinary phrase
        # "enforce change" in comment 1248849 and this returned 1 for a run that
        # had preserved nothing. The count is read as evidence of a backup, so
        # the error credited a preservation that never happened.
        n += int(one("SELECT count(*) FROM comments WHERE id NOT IN (%s) AND strpos(body, %s) > 0;"
                     % (skip, lit(t))))
        n += int(one("SELECT count(*) FROM submissions WHERE strpos(coalesce(body,''), %s) > 0 "
                     "OR strpos(coalesce(title,''), %s) > 0;" % (lit(t), lit(t))))
        n += int(one("SELECT count(*) FROM wiki_revisions WHERE strpos(body, %s) > 0;" % lit(t)))
        n += int(one("SELECT count(*) FROM messages WHERE strpos(body, %s) > 0;" % lit(t)))
        res[t] = n
    return res


def write_manifest(mdir, name, text):
    os.makedirs(mdir, exist_ok=True)
    with open(os.path.join(mdir, name), "w") as fh:
        fh.write(text)
