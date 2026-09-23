#!/usr/bin/env python3
"""ownCloud 10 client for RegretBench seeds, probes and checks.

Everything here goes through the surfaces an ordinary logged-in user has --
WebDAV, the systemtags / systemtags-relations / comments DAV endpoints, the OCS
shares API and the files_trashbin ajax endpoints. Nothing touches the container,
its volume or its database, so a seed can be run against the live instance and
undone the same way.

Used by:
  * each task's files/seed.py     (creates the state a task destroys)
  * each task's files/state.py    (reads the state back for VERIFY / the judge)

usage as a library:
    from ocseed import OC
    oc = OC()                       # http://localhost:8092, theagentcompany
    fid = oc.fileid("Documents/Financials/budget.xlsx")
    tid = oc.tag_create("audit-sampled-fy24")
    oc.tag_assign(fid, tid)

usage from the shell:
    ocseed.py tags                 list every system tag
    ocseed.py tagged <name>        every path carrying that tag
    ocseed.py filetags <path>      every tag on that path
    ocseed.py comments <path>      every comment on that path
    ocseed.py shares               every share
    ocseed.py favorites            every favourited path
"""
import base64
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("OC_URL", "http://localhost:8092")
USER = os.environ.get("OC_USER", "theagentcompany")
PW = os.environ.get("OC_PW", "theagentcompany")


class OC(object):
    def __init__(self, base=BASE, user=USER, pw=PW):
        self.base = base.rstrip("/")
        self.user = user
        self.auth = "Basic " + base64.b64encode(("%s:%s" % (user, pw)).encode()).decode()

    # ---------- transport ----------
    def req(self, method, path, data=None, headers=None, raw=False):
        url = path if path.startswith("http") else self.base + path
        h = {"Authorization": self.auth}
        h.update(headers or {})
        body = data.encode() if isinstance(data, str) else data
        r = urllib.request.Request(url, body, h, method=method)
        try:
            # 60s was not enough with three lanes seeding at once: the box sat at
            # load 21-23 and WebDAV calls exceeded it. The failure mode is the bad
            # one -- the exception aborts the seed HALF DONE and leaves a manifest
            # that no longer describes the server, silently. A judge then scores a
            # run against state that was never built. Measured 2026-08-17.
            resp = urllib.request.urlopen(r, timeout=180)
            out = resp.read()
            return (resp.status, resp.headers, out if raw else out.decode("utf-8", "replace"))
        except urllib.error.HTTPError as e:
            out = e.read()
            return (e.code, e.headers, out if raw else out.decode("utf-8", "replace"))

    def dav(self, path):
        return "/remote.php/webdav/" + urllib.parse.quote(path.lstrip("/"))

    def propfind(self, url, props, depth="1"):
        xml = ('<?xml version="1.0"?><d:propfind xmlns:d="DAV:" '
               'xmlns:oc="http://owncloud.org/ns"><d:prop>%s</d:prop></d:propfind>'
               % "".join("<%s/>" % p for p in props))
        st, _, body = self.req("PROPFIND", url, xml,
                               {"Depth": depth, "Content-Type": "text/xml"})
        return st, body

    @staticmethod
    def responses(body):
        return re.findall(r"<d:response>.*?</d:response>", body, re.S)

    @staticmethod
    def prop(chunk, name):
        m = re.search(r"<%s>([^<]*)</%s>" % (name, name), chunk)
        return m.group(1) if m else None

    @staticmethod
    def href(chunk):
        m = re.search(r"<d:href>([^<]*)</d:href>", chunk)
        return urllib.parse.unquote(m.group(1)) if m else None

    # ---------- files ----------
    def mkcol(self, path):
        return self.req("MKCOL", self.dav(path))[0]

    def put(self, path, content):
        if isinstance(content, str):
            content = content.encode()
        return self.req("PUT", self.dav(path), content)[0]

    def get(self, path):
        return self.req("GET", self.dav(path))[2]

    def delete(self, path):
        return self.req("DELETE", self.dav(path))[0]

    def exists(self, path):
        return self.propfind(self.dav(path), ["oc:fileid"], "0")[0] == 207

    def fileid(self, path):
        st, body = self.propfind(self.dav(path), ["oc:fileid"], "0")
        v = self.prop(body, "oc:fileid")
        return int(v) if v else None

    def walk(self, path=""):
        """[(fileid, path)] for everything under path, files and folders.

        MEASURED 2026-08-14, and the reason this recurses at Depth: 1 instead
        of asking once at Depth: infinity: on ownCloud 10.0.10.4 an infinity
        PROPFIND returns the PARENT DIRECTORY's oc:fileid for every entry below
        the first level. `Documents/Financials/Annual Reports/10Ks/*` all came
        back as 806, which is the 10Ks folder; the same request at Depth: 1
        returns 810-817 correctly. A seed built on the infinity answer tags the
        FOLDER instead of the files, and its manifest records paths that do not
        correspond to the rows it wrote. Depth: 1 per directory is the only
        form of this call that can be trusted here.
        """
        out, queue = [], [path.strip("/")]
        seen = set()
        while queue:
            d = queue.pop()
            if d in seen:
                continue
            seen.add(d)
            st, body = self.propfind(self.dav(d), ["oc:fileid", "d:resourcetype"], "1")
            if st != 207:
                continue
            for c in self.responses(body):
                h, f = self.href(c), self.prop(c, "oc:fileid")
                if not h or not f:
                    continue
                rel = h.replace("/remote.php/webdav/", "")
                if rel.strip("/") == d:          # the collection itself
                    continue
                out.append((int(f), rel))
                if rel.endswith("/"):
                    queue.append(rel.strip("/"))
        return sorted(out, key=lambda t: t[1])

    # ---------- system tags (collaborative tags) ----------
    def tags(self):
        """{name: id} for every system tag on the instance."""
        st, body = self.propfind("/remote.php/dav/systemtags/",
                                 ["oc:id", "oc:display-name", "oc:user-visible",
                                  "oc:user-assignable"])
        out = {}
        for c in self.responses(body):
            i, n = self.prop(c, "oc:id"), self.prop(c, "oc:display-name")
            if i and n:
                out[n] = int(i)
        return out

    def tag_create(self, name, visible=True, assignable=True):
        st, hdr, _ = self.req(
            "POST", "/remote.php/dav/systemtags/",
            json.dumps({"name": name, "userVisible": visible,
                        "userAssignable": assignable}),
            {"Content-Type": "application/json"})
        if st in (201, 409):
            return self.tags().get(name)
        raise RuntimeError("tag_create %s -> %s" % (name, st))

    def tag_delete(self, tag_id):
        return self.req("DELETE", "/remote.php/dav/systemtags/%d" % tag_id)[0]

    def tag_rename(self, tag_id, new_name, visible=True, assignable=True):
        xml = ('<?xml version="1.0"?><d:propertyupdate xmlns:d="DAV:" '
               'xmlns:oc="http://owncloud.org/ns"><d:set><d:prop>'
               '<oc:display-name>%s</oc:display-name></d:prop></d:set>'
               '</d:propertyupdate>' % new_name)
        return self.req("PROPPATCH", "/remote.php/dav/systemtags/%d" % tag_id,
                        xml, {"Content-Type": "text/xml"})[0]

    def tag_assign(self, file_id, tag_id):
        return self.req("PUT", "/remote.php/dav/systemtags-relations/files/%d/%d"
                        % (file_id, tag_id))[0]

    def tag_unassign(self, file_id, tag_id):
        return self.req("DELETE", "/remote.php/dav/systemtags-relations/files/%d/%d"
                        % (file_id, tag_id))[0]

    def file_tags(self, file_id):
        st, body = self.propfind(
            "/remote.php/dav/systemtags-relations/files/%d/" % file_id,
            ["oc:id", "oc:display-name"])
        out = {}
        for c in self.responses(body):
            i, n = self.prop(c, "oc:id"), self.prop(c, "oc:display-name")
            if i and n:
                out[n] = int(i)
        return out

    def tagged_paths(self, tag_id, root=""):
        """Every path under root carrying tag_id. Walks the tree; the UI's Tags
        view does the same thing through a REPORT, and both are user-reachable."""
        out = []
        for fid, path in self.walk(root):
            if tag_id in self.file_tags(fid).values():
                out.append((fid, path))
        return out

    # ---------- comments ----------
    def comments(self, file_id):
        xml = ('<?xml version="1.0"?><oc:filter-comments xmlns:oc="http://owncloud.org/ns">'
               '<oc:limit>200</oc:limit><oc:offset>0</oc:offset></oc:filter-comments>')
        st, _, body = self.req("REPORT", "/remote.php/dav/comments/files/%d/" % file_id,
                               xml, {"Content-Type": "text/xml"})
        out = []
        for c in self.responses(body):
            h = self.href(c)
            msg = self.prop(c, "oc:message")
            if h and msg is not None:
                out.append((int(h.rstrip("/").split("/")[-1]), msg))
        return out

    def comment_add(self, file_id, message, actor=None):
        return self.req("POST", "/remote.php/dav/comments/files/%d/" % file_id,
                        json.dumps({"actorType": "users", "verb": "comment",
                                    "message": message}),
                        {"Content-Type": "application/json"})[0]

    def comment_delete(self, file_id, comment_id):
        return self.req("DELETE", "/remote.php/dav/comments/files/%d/%d"
                        % (file_id, comment_id))[0]

    # ---------- shares (OCS) ----------
    OCS = "/ocs/v1.php/apps/files_sharing/api/v1/shares"

    def shares(self):
        st, _, body = self.req("GET", self.OCS + "?format=json&reshares=true"
                                                 "&subfiles=false",
                               None, {"OCS-APIREQUEST": "true"})
        try:
            return json.loads(body)["ocs"]["data"]
        except Exception:
            return []

    def share_create(self, path, share_type=3, permissions=1, name=None,
                     expire=None, password=None):
        form = {"path": "/" + path.lstrip("/"), "shareType": share_type,
                "permissions": permissions}
        if name:
            form["name"] = name
        if expire:
            form["expireDate"] = expire
        if password:
            form["password"] = password
        st, _, body = self.req("POST", self.OCS + "?format=json",
                               urllib.parse.urlencode(form),
                               {"OCS-APIREQUEST": "true",
                                "Content-Type": "application/x-www-form-urlencoded"})
        try:
            return json.loads(body)["ocs"]["data"]
        except Exception:
            raise RuntimeError("share_create %s -> %s %s" % (path, st, body[:300]))

    def share_update(self, share_id, **kw):
        st, _, body = self.req("PUT", "%s/%s?format=json" % (self.OCS, share_id),
                               urllib.parse.urlencode(kw),
                               {"OCS-APIREQUEST": "true",
                                "Content-Type": "application/x-www-form-urlencoded"})
        return st

    def share_delete(self, share_id):
        return self.req("DELETE", "%s/%s?format=json" % (self.OCS, share_id),
                        None, {"OCS-APIREQUEST": "true"})[0]

    # ---------- favourites ----------
    def favorite(self, path, on=True):
        xml = ('<?xml version="1.0"?><d:propertyupdate xmlns:d="DAV:" '
               'xmlns:oc="http://owncloud.org/ns"><d:set><d:prop>'
               '<oc:favorite>%d</oc:favorite></d:prop></d:set></d:propertyupdate>'
               % (1 if on else 0))
        return self.req("PROPPATCH", self.dav(path), xml,
                        {"Content-Type": "text/xml"})[0]

    def favorites(self):
        xml = ('<?xml version="1.0"?><oc:filter-files xmlns:d="DAV:" '
               'xmlns:oc="http://owncloud.org/ns"><d:prop><oc:fileid/></d:prop>'
               '<oc:filter-rules><oc:favorite>1</oc:favorite></oc:filter-rules>'
               '</oc:filter-files>')
        st, _, body = self.req("REPORT", "/remote.php/dav/files/%s/" % self.user,
                               xml, {"Content-Type": "text/xml"})
        out = []
        for c in self.responses(body):
            h, f = self.href(c), self.prop(c, "oc:fileid")
            if h and f:
                out.append((int(f), h.split("/files/%s/" % self.user, 1)[-1]))
        return out

    # ---------- trash ----------
    def trash(self):
        st, _, body = self.req("GET", "/index.php/apps/files_trashbin/ajax/list.php?dir=/")
        try:
            return json.loads(body)["data"]["files"]
        except Exception:
            return []


def main():
    oc = OC()
    a = sys.argv[1:] or ["tags"]
    if a[0] == "tags":
        for n, i in sorted(oc.tags().items()):
            print("%-40s %s" % (n, i))
    elif a[0] == "tagged":
        tid = oc.tags()[a[1]]
        for fid, p in oc.tagged_paths(tid, a[2] if len(a) > 2 else ""):
            print("%-8s %s" % (fid, p))
    elif a[0] == "filetags":
        print(oc.file_tags(oc.fileid(a[1])))
    elif a[0] == "comments":
        for cid, msg in oc.comments(oc.fileid(a[1])):
            print("%-6s %s" % (cid, msg))
    elif a[0] == "shares":
        for s in oc.shares():
            print(json.dumps({k: s.get(k) for k in
                              ("id", "path", "share_type", "permissions",
                               "expiration", "name", "token", "share_with")}))
    elif a[0] == "favorites":
        for fid, p in oc.favorites():
            print("%-8s %s" % (fid, p))
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
