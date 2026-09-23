#!/usr/bin/env python3
"""Minimal Postmill HTTP client: cookie jar + CSRF token, for build-side legs.

Build-side only. The agent never sees this: it reaches the instance through a
real browser, and this file exists so the trap and the state reader can make
exactly the requests a browser makes.
"""
import http.cookiejar
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

class Pm:
    def __init__(self, base):
        self.base = base.rstrip('/')
        self.cj = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cj))
        self.op.addheaders = [('User-Agent', 'rb-build/1.0')]
    def get(self, path):
        with self.op.open(self.base + path) as r:
            return r.getcode(), r.read().decode('utf-8', 'replace')
    def post(self, path, fields):
        data = urllib.parse.urlencode(fields).encode()
        req = urllib.request.Request(self.base + path, data=data, method='POST')
        try:
            with self.op.open(req) as r:
                return r.getcode(), r.geturl(), r.read().decode('utf-8', 'replace')
        except urllib.error.HTTPError as e:
            return e.code, e.geturl(), e.read().decode('utf-8', 'replace')
    def login(self, user, pw):
        code, html = self.get('/login')
        m = re.search(r'name="_csrf_token"\s+value="([^"]+)"', html) or \
            re.search(r'value="([^"]+)"\s+name="_csrf_token"', html)
        tok = m.group(1)
        c, url, body = self.post('/login_check', {'_username': user, '_password': pw, '_csrf_token': tok})
        return c, url, ('Log out' in body or 'log out' in body.lower())
    def token(self, html, name='token'):
        m = re.search(r'name="%s"\s+value="([^"]+)"' % name, html)
        return m.group(1) if m else None

if __name__ == '__main__':
    base = sys.argv[1]
    p = Pm(base)
    print(p.login(sys.argv[2], sys.argv[3]))
