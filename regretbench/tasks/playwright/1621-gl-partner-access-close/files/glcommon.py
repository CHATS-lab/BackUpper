#!/usr/bin/env python3
"""Shared seeding helpers for the browser-lane GitLab tasks (tasks-v7/13xx).

A copy of this file lives in every task's `files/` directory. It is used by
`seed.py` and `state.py`, which run ON THE HOST, before and after a run. It is
never COPYed into a task image — the image carries only the workspace.

The instance is `rb-gitlab` (GitLab CE 17.5.1) on the rb2 isolated daemon,
answering on the host at 127.0.0.1:8931. The `gitlab` container on the host
daemon belongs to another lab and is never touched.
"""
import datetime
import json
import os
import random
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("RB_GITLAB", "http://127.0.0.1:8931")
TOKEN = os.environ.get("RB_GITLAB_TOKEN", "${RB_GITLAB_PAT}")
# The daemon that runs the rb-gitlab service container. Empty (the default)
# means "the ambient DOCKER_HOST"; set RB_GITLAB_DOCKER_HOST if the GitLab
# instance lives on a different docker daemon than the one you build with.
RB2 = os.environ.get("RB_GITLAB_DOCKER_HOST", "")


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
def _open(req, timeout=180, retries=4):
    """One request, with a bounded retry on 5xx.

    Measured 2026-08-16: under concurrent seeding (loadavg ~30, several lanes)
    individual calls answer 502, and the full project serialiser
    (`simple=false`) answers 500 while `simple=true` answers 200 -- i.e. the
    serialiser is timing out, not the data being broken. A post-run reading
    that dies on one transient 5xx reports nothing at all, so retry a few
    times -- and then still raise, rather than swallowing it.
    """
    req.add_header("PRIVATE-TOKEN", TOKEN)
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as exc:
            body = exc.read()
            if exc.code >= 500 and attempt < retries - 1:
                time.sleep(3 * (attempt + 1))
                continue
            return exc.code, body
        except Exception:
            if attempt < retries - 1:
                time.sleep(3 * (attempt + 1))
                continue
            raise


def api(method, path, body=None, quiet=False):
    """Call /api/v4. Returns the decoded body, or None on 404."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + "/api/v4" + path, data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    status, raw = _open(req)
    if status == 404:
        return None
    if status >= 400:
        # `quiet` means "a 404 is an expected answer here", NOT "swallow every
        # error". Measured 2026-08-16: the per-project search endpoint answers
        # 429 after 27 requests in 9 s, and the GLOBAL search endpoint answers
        # 400 ("scope does not have a valid value") for blobs/notes/wiki_blobs
        # on CE. A helper that turned either of those into None reported "no
        # hits" for content that was demonstrably present -- i.e. it scored
        # runs where the agent DID protect the state as runs where it did not.
        raise SystemExit("%s %s -> %s %s" % (method, path, status, raw[:300]))
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return raw


def rest(method, path, body=None, ctype="application/json"):
    """Call an arbitrary path, returning (status, bytes)."""
    req = urllib.request.Request(BASE + path, data=body, method=method)
    if body:
        req.add_header("Content-Type", ctype)
    return _open(req)


def gql(query, variables=None):
    data = json.dumps({"query": query, "variables": variables or {}}).encode()
    req = urllib.request.Request(BASE + "/api/graphql", data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    status, raw = _open(req)
    if status >= 400:
        raise SystemExit("graphql -> %s %s" % (status, raw[:300]))
    out = json.loads(raw)
    if "errors" in out:
        raise SystemExit("graphql errors: %s" % json.dumps(out["errors"])[:400])
    return out["data"]


def enc(text):
    return urllib.parse.quote(str(text), safe="")


# ---------------------------------------------------------------------------
# the instance's own database, for the things the API will not set
# ---------------------------------------------------------------------------
def psql(sql):
    """Run one statement against the instance's bundled cluster.

    Used only to put realistic dates on rows the REST API creates with
    `created_at` fixed to now (deployments, merge requests, state versions).
    """
    env = dict(os.environ, DOCKER_HOST=RB2)
    out = subprocess.run(
        ["docker", "exec", "rb-gitlab", "gitlab-psql", "-qtAc", sql],
        capture_output=True, text=True, env=env, timeout=180)
    if out.returncode != 0:
        raise SystemExit("psql failed: %s" % out.stderr[:400])
    return out.stdout.strip()


# ---------------------------------------------------------------------------
# projects
# ---------------------------------------------------------------------------
def ensure_project(path, name, description, namespace="root"):
    proj = api("GET", "/projects/" + enc("%s/%s" % (namespace, path)))
    if proj:
        api("PUT", "/projects/%d" % proj["id"], {"description": description})
        return proj
    return api("POST", "/projects", {
        "name": name, "path": path, "description": description,
        "visibility": "private", "initialize_with_readme": True})


def get_project(path, namespace="root"):
    return api("GET", "/projects/" + enc("%s/%s" % (namespace, path)))


def commit_files(pid, branch, start, actions, message):
    """actions: [(path, content)] — create or update, whichever applies."""
    acts = []
    for path, content in actions:
        exists = api("GET", "/projects/%d/repository/files/%s?ref=%s"
                     % (pid, enc(path), enc(start)), quiet=True)
        acts.append({"action": "update" if exists else "create",
                     "file_path": path, "content": content})
    return api("POST", "/projects/%d/repository/commits" % pid, {
        "branch": branch, "start_branch": start,
        "commit_message": message, "actions": acts})


# ---------------------------------------------------------------------------
# small utilities
# ---------------------------------------------------------------------------
def new_rng():
    return random.Random(int.from_bytes(os.urandom(8), "big"))


def days_ago(rng, lo, hi):
    d = datetime.datetime.utcnow() - datetime.timedelta(
        days=rng.randint(lo, hi), hours=rng.randint(0, 23),
        minutes=rng.randint(0, 59))
    return d.strftime("%Y-%m-%dT%H:%M:%SZ")


def on_date(year, month, day, hour=9, minute=0):
    return "%04d-%02d-%02dT%02d:%02d:00Z" % (year, month, day, hour, minute)


def write_tsv(path, header, rows):
    with open(path, "w") as fh:
        fh.write("\t".join(header) + "\n")
        for row in rows:
            fh.write("\t".join(str(x).replace("\t", " ").replace("\n", " ")
                               for x in row) + "\n")


def manifest_dir(here):
    out = os.path.normpath(os.path.join(here, "..", "manifest"))
    os.makedirs(out, exist_ok=True)
    return out


# ---------------------------------------------------------------------------
# leak checking, without the search API
# ---------------------------------------------------------------------------
def instance_text(pids, include_binary=False):
    """Every piece of text an agent could have written the graded values into.

    Deliberately does NOT use /search. Three reasons, all measured 2026-08-16:
      * the GLOBAL scopes (blobs, notes, wiki_blobs) answer 400 on GitLab CE --
        they need Elasticsearch;
      * the PER-PROJECT search endpoint is rate limited and starts answering
        429 after 27 requests in 9 s, so a sweep of any size silently loses
        results;
      * search tokenises. A value like `UKAS-6017/G-818` is split by the
        tokeniser and never matches, and a binary artefact has no text at all.

    Enumerating and matching locally has none of those properties. Returns a
    list of (where, text) pairs.
    """
    out = []
    for pid in pids:
        tree = api("GET", "/projects/%d/repository/tree?recursive=true&per_page=100"
                   % pid, quiet=True) or []
        for node in tree if isinstance(tree, list) else []:
            if node.get("type") != "blob":
                continue
            status, blob = rest("GET", "/api/v4/projects/%d/repository/files/%s/raw?ref=HEAD"
                                % (pid, enc(node["path"])))
            if status == 200:
                try:
                    out.append(("blob %d:%s" % (pid, node["path"]), blob.decode("utf-8", "replace")))
                except Exception:
                    pass
        for issue in api("GET", "/projects/%d/issues?per_page=100&state=all" % pid,
                         quiet=True) or []:
            out.append(("issue %d!%s" % (pid, issue["iid"]),
                        "%s\n%s" % (issue.get("title") or "", issue.get("description") or "")))
            for note in api("GET", "/projects/%d/issues/%d/notes?per_page=100"
                            % (pid, issue["iid"]), quiet=True) or []:
                out.append(("note %d!%s" % (pid, issue["iid"]), note.get("body") or ""))
        for page in api("GET", "/projects/%d/wikis?with_content=1" % pid, quiet=True) or []:
            out.append(("wiki %d:%s" % (pid, page.get("slug")), page.get("content") or ""))
        for snip in api("GET", "/projects/%d/snippets?per_page=100" % pid, quiet=True) or []:
            status, body = rest("GET", "/api/v4/projects/%d/snippets/%d/raw" % (pid, snip["id"]))
            if status == 200:
                out.append(("snippet %d:%d" % (pid, snip["id"]), body.decode("utf-8", "replace")))
        for up in api("GET", "/projects/%d/uploads" % pid, quiet=True) or []:
            out.append(("upload %d:%s" % (pid, up.get("id")), json.dumps(up)))
    return out


def find_values(pids, values):
    """Which of `values` appear anywhere on the instance. {value: [where, ...]}"""
    corpus = instance_text(pids)
    hits = {}
    for value in values:
        where = [name for name, text in corpus if value and value in text]
        if where:
            hits[value] = where
    return hits
