"""Shared helpers for seeding and reading the mail-desk task environments.

Messages are put on the server with IMAP APPEND rather than SMTP: APPEND is the
only way to set INTERNALDATE and flags exactly, and it is ~200x faster than a
delivery per message.

Reading back is done the same way, straight over IMAP, so the reader never
disturbs what it is reading -- note that the MCP surface cannot be used for this:
its get_emails/read_email do a non-peek FETCH RFC822 and clear \\Seen on a whole
page just by listing it.
"""
import email, email.message, email.utils, hashlib, imaplib, json, os, re, time
from datetime import datetime, timezone, timedelta

HOST = os.environ.get("RBMAIL_HOST", "127.0.0.1")
PORT = int(os.environ.get("RBMAIL_PORT", "1143"))


def conn(addr, pw):
    m = imaplib.IMAP4(HOST, PORT)
    m.login(addr, pw)
    return m


def folders(m):
    ok, data = m.list()
    out = []
    for row in data or []:
        if not row:
            continue
        s = row.decode() if isinstance(row, bytes) else row
        mt = re.match(r'\((?P<f>[^)]*)\) "(?P<sep>[^"]*)" (?P<name>.*)$', s)
        if not mt:
            continue
        name = mt.group("name").strip().strip('"')
        out.append((name, mt.group("f")))
    return out


def ensure(m, name):
    m.create(name)


def internaldate(dt):
    return imaplib.Time2Internaldate(dt.timestamp())


def mkmsg(subject, frm, to, dt, body, attachments=None, cc=None, msgid=None,
          in_reply_to=None, references=None):
    """attachments: list of (filename, bytes, maintype, subtype)"""
    m = email.message.EmailMessage()
    m["Subject"] = subject
    m["From"] = frm
    m["To"] = to
    if cc:
        m["Cc"] = cc
    m["Date"] = email.utils.format_datetime(dt)
    m["Message-ID"] = msgid or email.utils.make_msgid(domain="mcp.com")
    if in_reply_to:
        m["In-Reply-To"] = in_reply_to
    if references:
        m["References"] = references
    m.set_content(body)
    for (fn, data, maintype, subtype) in (attachments or []):
        m.add_attachment(data, maintype=maintype, subtype=subtype, filename=fn)
    return m


def append(m, folder, msg, dt, seen=True, flagged=False):
    flags = []
    if seen:
        flags.append("\\Seen")
    if flagged:
        flags.append("\\Flagged")
    ok, resp = m.append('"%s"' % folder,
                        "(%s)" % " ".join(flags) if flags else "",
                        internaldate(dt), msg.as_bytes())
    if ok != "OK":
        raise RuntimeError("APPEND to %s failed: %r" % (folder, resp))


def read_folder(m, folder):
    """[(subject, from, date, body_sha, [(filename, sha256, size)], raw_sha)]"""
    ok, _ = m.select('"%s"' % folder, readonly=True)
    if ok != "OK":
        return None
    ok, data = m.search(None, "ALL")
    out = []
    ids = (data[0].split() if data and data[0] else [])
    for i in ids:
        ok, d = m.fetch(i, "(BODY.PEEK[])")
        raw = None
        for part in d or []:
            if isinstance(part, tuple):
                raw = part[1]
        if raw is None:
            continue
        msg = email.message_from_bytes(raw)
        atts, body = [], b""
        for p in msg.walk():
            if p.get_content_maintype() == "multipart":
                continue
            fn = p.get_filename()
            payload = p.get_payload(decode=True) or b""
            if fn:
                atts.append((fn, hashlib.sha256(payload).hexdigest(), len(payload)))
            elif p.get_content_type() == "text/plain" and not body:
                body = payload
        out.append({
            "subject": msg.get("Subject", ""),
            "from": msg.get("From", ""),
            "date": msg.get("Date", ""),
            "body_sha": hashlib.sha256(body).hexdigest(),
            "body": body.decode("utf-8", "replace"),
            "attachments": atts,
            "raw_sha": hashlib.sha256(raw).hexdigest(),
        })
    return out


def read_account(addr, pw):
    m = conn(addr, pw)
    try:
        out = {}
        for name, flags in folders(m):
            if "\\Noselect" in flags:
                continue
            r = read_folder(m, name)
            if r is not None:
                out[name] = r
        return out
    finally:
        try:
            m.logout()
        except Exception:
            pass


def wipe_account(addr, pw, keep=("INBOX", "Sent", "Drafts", "Junk", "Trash")):
    """Empty every folder and remove every non-system folder. Used by --clean."""
    m = conn(addr, pw)
    try:
        for name, flags in folders(m):
            if "\\Noselect" in flags:
                continue
            ok, data = m.select('"%s"' % name)
            if ok == "OK":
                n = int(data[0]) if data and data[0] else 0
                if n:
                    m.store("1:%d" % n, "+FLAGS", "\\Deleted")
                    m.expunge()
                m.close()
        for name, flags in sorted(folders(m), key=lambda x: -len(x[0])):
            if name in keep:
                continue
            m.delete('"%s"' % name)
    finally:
        try:
            m.logout()
        except Exception:
            pass
