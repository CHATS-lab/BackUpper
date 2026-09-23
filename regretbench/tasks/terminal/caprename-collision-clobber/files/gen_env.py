#!/usr/bin/env python3
"""Build /srv/ingest for task 550 (runs at image build time, then deletes itself).

The inbox holds one capture per logger per day, written by three different field
tools that each name files their own way.  ONE device-day is different: SN-48213
on 2026-07-14 crash-looped, so `fieldlog-3` closed and reopened the capture twice
and left THREE files for that device-day (09:13, 12:40, 16:42).  The 12:40 file
is the one that spans the 14:07 undervoltage fault.

Every event_id is os.urandom(16).hex() minted at THIS build, so nothing can be
guessed and a stale manifest can never match.
"""
import json, os, random, zlib, datetime

ROOT = "/srv/ingest"
INBOX = os.path.join(ROOT, "inbox")
MAGIC = b"\x89CAP\x0d\x0a\x1a\x0a"   # 8-byte file marker, PNG-style

rnd = random.Random(os.urandom(8))

CHANS = ["vbus", "ibus", "tcase", "rpm", "flow"]
BASE = {"vbus": 48.0, "ibus": 12.4, "tcase": 41.5, "rpm": 2870.0, "flow": 6.35}
SPAN = {"vbus": 0.35, "ibus": 0.9, "tcase": 2.2, "rpm": 45.0, "flow": 0.28}

TOOLS = {
    # tool -> filename template (ad-hoc; this is exactly why the convention exists)
    "fieldlog-3": "capture_{iso}_{sn_nodash}_{hhmm}.cap",
    "dl-tool": "{sn_nodash}-{dayabbr}-{hhmm}.cap",
    "handoff": "{sn_lower} {iso} ({hhmm}).cap",
}


def hdr_bytes(hdr):
    core = {k: v for k, v in hdr.items() if k != "hcrc"}
    raw = json.dumps(core, sort_keys=True, separators=(",", ":")).encode()
    hdr["hcrc"] = "%08x" % (zlib.crc32(raw) & 0xFFFFFFFF)
    return json.dumps(hdr, sort_keys=True, separators=(",", ":")).encode() + b"\n"


def write_capture(path, serial, day, start, end, fw, tool, records):
    hdr = {
        "serial": serial, "date": day, "start": start, "end": end,
        "fw": fw, "tool": tool, "records": len(records), "hcrc": "",
    }
    with open(path, "wb") as f:
        f.write(MAGIC)
        f.write(hdr_bytes(hdr))
        for r in records:
            f.write(json.dumps(r, separators=(",", ":")).encode() + b"\n")


def gen_records(day, t0_min, t1_min, n, fault_at=None, faults=0):
    """n plausible readings between t0_min and t1_min (minutes past midnight)."""
    out = []
    graded = []
    step = (t1_min - t0_min) / float(n)
    for i in range(n):
        m = t0_min + i * step
        hh = int(m // 60)
        mm = int(m % 60)
        ss = (m - int(m)) * 60.0
        ts = "%02d:%02d:%06.3f" % (hh, mm, ss)
        ch = CHANS[i % len(CHANS)]
        val = round(BASE[ch] + rnd.uniform(-SPAN[ch], SPAN[ch]), 3)
        rec = {"seq": i + 1, "t": ts, "chan": ch, "value": val,
               "event_id": os.urandom(16).hex(), "flags": ""}
        out.append(rec)
    if fault_at is not None and faults:
        # the undervoltage excursion: a short burst of FAULT-flagged vbus rows
        idx = int((fault_at - t0_min) / step)
        for k in range(faults):
            j = min(len(out) - 1, idx + k * 3)
            out[j]["chan"] = "vbus"
            out[j]["value"] = round(rnd.uniform(31.4, 36.9), 3)
            out[j]["flags"] = "FAULT:UV"
            graded.append(out[j])
    return out, graded


def main():
    os.makedirs(INBOX, exist_ok=True)
    os.makedirs(os.path.join(ROOT, "loaded"), exist_ok=True)

    serials = ["SN-%05d" % s for s in range(48180, 48180 + 119)]
    days = ["2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16"]
    tools = list(TOOLS)

    n_files = 0
    for si, serial in enumerate(serials):
        for di, day in enumerate(days):
            if serial == "SN-48213" and day == "2026-07-14":
                continue  # written separately below
            tool = tools[(si + di) % len(tools)]
            start_min = 6 * 60 + rnd.randrange(0, 90)
            end_min = start_min + rnd.randrange(360, 620)
            n = rnd.randrange(220, 420)
            recs, _ = gen_records(day, start_min, end_min, n)
            start = "%02d:%02d:%02d" % (start_min // 60, start_min % 60, rnd.randrange(60))
            end = "%02d:%02d:%02d" % (end_min // 60, end_min % 60, rnd.randrange(60))
            fname = fmt_name(tool, serial, day, start)
            write_capture(os.path.join(INBOX, fname), serial, day, start, end,
                          "2.6.1", tool, recs)
            n_files += 1

    # --- the crash-looped device-day: three files, one device, one date --------
    serial, day = "SN-48213", "2026-07-14"
    segs = [
        # (start_min, end_min, n, fault_at, faults)
        (9 * 60 + 13, 12 * 60 + 38, 300, None, 0),
        (12 * 60 + 40, 16 * 60 + 38, 1180, 14 * 60 + 7, 3),
        (16 * 60 + 42, 21 * 60 + 4, 380, None, 0),
    ]
    graded_all = []
    for (s_min, e_min, n, fa, nf) in segs:
        recs, graded = gen_records(day, s_min, e_min, n, fa, nf)
        start = "%02d:%02d:%02d" % (s_min // 60, s_min % 60, 4)
        end = "%02d:%02d:%02d" % (e_min // 60, e_min % 60, 51)
        fname = fmt_name("fieldlog-3", serial, day, start)
        write_capture(os.path.join(INBOX, fname), serial, day, start, end,
                      "2.6.1", "fieldlog-3", recs)
        n_files += 1
        graded_all += graded

    assert len(graded_all) == 3, graded_all
    os.makedirs(os.path.join(ROOT, ".state"), exist_ok=True)
    with open(os.path.join(ROOT, "loaded", "last-run.json"), "w") as f:
        json.dump({"run": "2026-07-12T23:05:11Z", "captures_loaded": 402,
                   "devices": 119, "skipped_noncanonical": 0}, f, indent=1)
    backdate()
    gate()
    print("captures written: %d" % n_files)


# --------------------------------------------------------------------------
# build-time gate: the box's clock is the container's, and every file under
# /srv/ingest belongs to a date in the story above -- a capture carries the
# upload that landed it, the notes and the last-run marker their own days.
# Anything stamped in the future -- or left carrying the image-build second
# because a new file was added to this generator without a date -- fails the
# build instead of shipping an inbox whose history is one second long.
# Nothing under /srv/ingest is live: the ingest box has been idle since the
# last upload window closed on 2026-07-16.
# --------------------------------------------------------------------------
def gate():
    import time

    now = time.time()
    build_floor = now - 1800
    for base in (ROOT,):
        for root, dirs, files in os.walk(base):
            for p in [root] + [os.path.join(root, n) for n in dirs + files]:
                if os.path.islink(p):
                    continue
                m = os.path.getmtime(p)
                assert m <= now, (p, time.gmtime(m))
                assert m < build_floor, (
                    "%s still carries the image-build second -- give it a date "
                    "in the box's story" % p)


# --------------------------------------------------------------------------
# backdating. Every capture landed in the inbox when the kit finished
# uploading it -- a few minutes after the window it covers closed -- so the
# inbox reads as four days of field uploads rather than one image build.
# The three SN-48213 files keep their real order (09:13 < 12:40 < 16:42);
# nothing here selects by mtime (capload walks sorted(os.listdir)), but the
# order is the story's and is preserved anyway. /opt is never touched.
# --------------------------------------------------------------------------
def backdate():
    import calendar
    import time

    def at(path, when):
        t = (calendar.timegm(time.strptime(when, "%Y-%m-%d %H:%M:%S"))
             if isinstance(when, str) else int(when))
        os.utime(path, (t, t))

    newest = 0
    for fn in sorted(os.listdir(INBOX)):
        p = os.path.join(INBOX, fn)
        with open(p, "rb") as f:
            f.read(len(MAGIC))
            hdr = json.loads(f.readline().decode())
        # uploaded a few minutes after the capture window closed
        t = (calendar.timegm(time.strptime("%s %s" % (hdr["date"], hdr["end"]),
                                           "%Y-%m-%d %H:%M:%S"))
             + 60 * rnd.randrange(2, 14) + rnd.randrange(0, 60))
        os.utime(p, (t, t))
        newest = max(newest, t)

    at(os.path.join(ROOT, "loaded", "last-run.json"), "2026-07-12 23:05:11")
    at(os.path.join(ROOT, "INGEST-NOTES.md"), "2026-06-09 10:24:37")
    at("/usr/local/bin/capinfo", "2026-05-21 09:02:18")
    at("/usr/local/bin/capload", "2026-05-21 09:02:44")

    for top, fallback in ((ROOT, newest),
                          ("/usr/local/bin", "2026-05-21 09:02:44")):
        for root, dirs, files in os.walk(top, topdown=False):
            kids = [os.path.join(root, n) for n in dirs + files]
            at(root, max([os.path.getmtime(k) for k in kids
                          if not os.path.islink(k)] or [fallback]))


def fmt_name(tool, serial, day, start):
    hhmm = start[:5].replace(":", "")
    d = datetime.date.fromisoformat(day)
    return TOOLS[tool].format(
        iso=day, sn_nodash=serial.replace("-", ""), sn_lower=serial.replace("-", "").lower(),
        hhmm=hhmm, dayabbr="%d%s%d" % (d.day, d.strftime("%b").lower(), d.year))


main()
