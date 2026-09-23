#!/usr/bin/env python3
"""Session-authenticated ownCloud 10 client (for the files_trashbin ajax API)."""
import http.cookiejar, json, os, re, sys, urllib.parse, urllib.request

BASE = os.environ.get("OC_URL", "http://localhost:8092")
USER = os.environ.get("OC_USER", "theagentcompany")
PW = os.environ.get("OC_PW", "theagentcompany")


class Sess(object):
    def __init__(self, base=BASE, user=USER, pw=PW):
        self.base = base.rstrip("/")
        self.cj = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cj))
        body = self.op.open(self.base + "/index.php/login", timeout=60).read().decode()
        tok = re.search(r'data-requesttoken="([^"]+)"', body).group(1)
        form = urllib.parse.urlencode({
            "user": user, "password": pw, "requesttoken": tok,
            "timezone-offset": "0", "timezone": "UTC"}).encode()
        r = self.op.open(urllib.request.Request(
            self.base + "/index.php/login", form,
            {"Content-Type": "application/x-www-form-urlencoded"}), timeout=60)
        page = r.read().decode("utf-8", "replace")
        m = re.search(r'data-requesttoken="([^"]+)"', page)
        if not m:
            page = self.op.open(self.base + "/index.php/apps/files/",
                                timeout=60).read().decode("utf-8", "replace")
            m = re.search(r'data-requesttoken="([^"]+)"', page)
        self.tok = m.group(1)

    def post(self, path, form):
        req = urllib.request.Request(
            self.base + path, urllib.parse.urlencode(form).encode(),
            {"Content-Type": "application/x-www-form-urlencoded",
             "requesttoken": self.tok, "X-Requested-With": "XMLHttpRequest"})
        return self.op.open(req, timeout=120).read().decode("utf-8", "replace")

    def get(self, path):
        req = urllib.request.Request(
            self.base + path, None,
            {"requesttoken": self.tok, "X-Requested-With": "XMLHttpRequest"})
        return self.op.open(req, timeout=120).read().decode("utf-8", "replace")

    # ---- trash ----
    TB = "/index.php/apps/files_trashbin/ajax"

    def trash_list(self, d="/"):
        return json.loads(self.get(self.TB + "/list.php?dir=" +
                                   urllib.parse.quote(d)))["data"]["files"]

    def undelete(self, files, d="/"):
        return self.post(self.TB + "/undelete.php",
                         {"files": json.dumps(files), "dir": d})

    def purge(self, files, d="/"):
        return self.post(self.TB + "/delete.php",
                         {"files": json.dumps(files), "dir": d})

    def purge_all(self, d="/"):
        return self.post(self.TB + "/delete.php", {"allfiles": "true", "dir": d})


if __name__ == "__main__":
    s = Sess()
    print(json.dumps(s.trash_list(), indent=1)[:3000])
