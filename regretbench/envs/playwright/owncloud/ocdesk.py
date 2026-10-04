#!/usr/bin/env python3
"""Shared seeding helpers for the ownCloud tasks.

Everything here goes through the surfaces an ordinary logged-in user has, and
every function is scoped to one task's own material by an explicit marker list,
so nothing that was on the instance before the task existed is touched.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ocseed import OC        # noqa: E402
from ocsess import Sess      # noqa: E402

# The instance's own top level, with nothing of ours on it. Never walked into
# for the purpose of deleting, and never touched.
STOCK = ("Documents", "Downloads", "Photos", "Talk", "Templates",
         "ownCloud Manual.pdf")


class Desk(object):
    """One task's namespace on the instance.

    roots    -- the top-level folder names this task creates
    markers  -- substrings that appear in the PATHS of this task's own files
                and nowhere else on the instance. Used to find copies an agent
                left behind under a name of its own choosing, so the instance
                does not silt up run after run.
    tags     -- the tag names this task creates
    cprefix  -- the prefix every comment this task writes begins with, so a
                task that shares a document with another task can never remove
                the other's comments
    """

    def __init__(self, roots=(), markers=(), tags=(), cprefix=None):
        self.oc = OC()
        self._sess = None
        self.roots = tuple(roots)
        self.markers = tuple(markers)
        self.tags = tuple(tags)
        self.cprefix = cprefix
        self._made = set()

    @property
    def sess(self):
        if self._sess is None:
            self._sess = Sess()
        return self._sess

    # ---------- writing ----------
    def put(self, path, body):
        """PUT and return the new fileid, read off the OC-FileId response
        header -- one round trip per file instead of two. Measured on 10.0.10:
        `OC-FileId: 00001510ocgr93zvgbym`, the first eight characters being the
        zero-padded decimal fileid."""
        parts = os.path.dirname(path).split("/")
        for i in range(len(parts)):
            sub = "/".join(parts[:i + 1])
            if sub and sub not in self._made:
                self.oc.mkcol(sub)
                self._made.add(sub)
        if isinstance(body, str):
            body = body.encode()
        st, hdr, _ = self.oc.req("PUT", self.oc.dav(path), body)
        if st not in (201, 204):
            raise SystemExit("PUT %s -> %s" % (path, st))
        fid = dict(hdr).get("OC-FileId")
        if fid and fid[:8].isdigit():
            return int(fid[:8])
        return self.oc.fileid(path)

    def bin_it(self, path):
        """Delete into the deleted-files bin, and return the row's name."""
        st = self.oc.delete(path)
        if st != 204:
            raise SystemExit("DELETE %s -> %s" % (path, st))
        return os.path.basename(path.rstrip("/"))

    # ---------- reading ----------
    def marked(self, tag_id):
        """Every fileid carrying a tag, in one REPORT -- the same call the Tags
        view in the Files nav makes."""
        xml = ('<?xml version="1.0"?><oc:filter-files xmlns:d="DAV:" '
               'xmlns:oc="http://owncloud.org/ns"><d:prop><oc:fileid/></d:prop>'
               '<oc:filter-rules><oc:systemtag>%d</oc:systemtag>'
               '</oc:filter-rules></oc:filter-files>' % tag_id)
        st, _, body = self.oc.req("REPORT",
                                  "/remote.php/dav/files/%s/" % self.oc.user,
                                  xml, {"Content-Type": "text/xml"})
        out = set()
        for c in self.oc.responses(body):
            f = self.oc.prop(c, "oc:fileid")
            if f:
                out.add(int(f))
        return out

    def bin_rows(self):
        return {e["name"]: e for e in self.sess.trash_list()}

    # ---------- cleaning, scoped to this task ----------
    def _is_mine(self, name):
        if name in STOCK:
            return False
        if name in self.roots:
            return True
        for fid, path in self.oc.walk(name):
            if any(m in path for m in self.markers):
                return True
        return False

    def clean(self, with_bin=False):
        """Remove this task's own material, and only ever this task's own."""
        tags = self.oc.tags()
        for name in self.tags:
            if name in tags:
                self.oc.tag_delete(tags[name])
        if self.cprefix:
            for fid, path in self.oc.walk(""):
                if path.endswith("/") or not any(m in path
                                                 for m in self.markers):
                    continue
                for cid, msg in self.oc.comments(fid):
                    if msg.startswith(self.cprefix):
                        self.oc.comment_delete(fid, cid)
        for fid, path in self.oc.walk(""):
            name = path.strip("/")
            if "/" in name:
                continue
            if self._is_mine(name):
                self.oc.delete(name)
        if with_bin:
            for name, e in self.bin_rows().items():
                if name in self.roots or any(m in name for m in self.markers):
                    self.purge(name, e)
        self._made.clear()

    def purge(self, name, entry=None):
        e = entry or self.bin_rows().get(name)
        if not e:
            return None
        return self.sess.purge(["%s.d%d" % (name, e["mtime"] // 1000)])

    def restore(self, names):
        rows = self.bin_rows()
        want = ["%s.d%d" % (n, rows[n]["mtime"] // 1000)
                for n in names if n in rows]
        return self.sess.undelete(want) if want else None

    # ---------- the post-run reading ----------
    def readable(self, skip=()):
        """{path: body} for every readable text-ish file on the instance."""
        exts = (".txt", ".md", ".csv", ".log", ".json", ".yml", ".yaml",
                ".tsv", ".xml", ".html", ".htm", ".rst", ".ini", ".conf")
        out = {}
        for fid, path in self.oc.walk(""):
            if path.endswith("/") or not path.lower().endswith(exts):
                continue
            if any(s in path for s in skip):
                continue
            st, _, body = self.oc.req("GET", self.oc.dav(path))
            if st == 200 and len(body) <= 2 * 1024 * 1024:
                out[path] = body
        return out
