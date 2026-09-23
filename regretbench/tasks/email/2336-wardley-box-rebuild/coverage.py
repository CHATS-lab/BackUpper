#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Per-item coverage report for a 2336 run -- what the judge cannot give you.

WHY THIS EXISTS. The judge is BLIND by design (harness/judge.py: "we
deliberately do NOT pass at_risk_state / recovery_gap -- telling the judge what
the 'right' backup would be makes the verdict circular"). It never sees this
task's predicate, so no instruction written there can make its verdict show
coverage over the enumerated fifteen. The verdict can be correct and still not
be checkable. This closes that gap from outside, without touching the judge or
weakening its blindness.

    ./coverage.py <results-dir>

For each graded item it asks two questions of the trajectory:

    SEEN     -- did the agent have the content in hand at all (a read_email,
                an export, any tool output carrying the minted value)?
    WRITTEN  -- did that value reach an artefact the agent created (the input
                of a Write / file-creating call)?

SEEN without WRITTEN is the interesting state: the agent looked at it and did
not keep it.

IT REFUSES RATHER THAN GUESSES. Every seed overwrites manifest/graded.tsv, so a
report built against the wrong mint would be confidently wrong. The run is
matched to an archived mint in manifest/history/; if none predates the run, it
prints why and exits non-zero, in the same spirit as ready_count.py refusing on
a count= mismatch.
"""
import csv, glob, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(HERE, "manifest")


def run_started(rd):
    m = re.search(r"(\d{8})_(\d{6})$", rd.rstrip("/"))
    if not m:
        return None
    import time, calendar
    return calendar.timegm(time.strptime(m.group(1) + m.group(2),
                                         "%Y%m%d%H%M%S"))


def pick_manifest(rd):
    """The archived mint this run was graded on: the newest one minted BEFORE
    the run started. Returns (path, why) or (None, why-not)."""
    started = run_started(rd)
    if started is None:
        return None, "cannot read a start time from the run directory name"
    cands = []
    for p in glob.glob(os.path.join(MANIFEST, "history", "graded-*.tsv")):
        m = re.search(r"graded-(\d{8})_(\d{6})-", os.path.basename(p))
        if not m:
            continue
        import time, calendar
        t = calendar.timegm(time.strptime(m.group(1) + m.group(2),
                                          "%Y%m%d%H%M%S"))
        if t <= started:
            cands.append((t, p))
    if not cands:
        return None, ("no archived mint predates this run. Mint archiving "
                      "started 2026-08-26; runs before it cannot be checked "
                      "per item, because manifest/graded.tsv has been "
                      "overwritten by a later seed and the run directory "
                      "keeps no copy")
    cands.sort()
    return cands[-1][1], "matched to mint %s" % os.path.basename(cands[-1][1])


def probes(row):
    """The distinctive string(s) for one graded item.

    Prefer the manifest's `probe` column -- a verbatim slice of the message's
    own body, written at seed time. Fall back to token extraction only for
    manifests minted before that column existed, and RETURN EMPTY when there is
    nothing distinctive, so the caller can report UNCHECKABLE instead of NO.
    """
    p = (row.get("probe") or "").strip()
    if p:
        return {p}
    out = set()
    for tok in re.findall(r"[A-Z0-9]{4,}(?:/[A-Z0-9]{4,})?", row.get("answer", "")):
        if tok.isdigit() and len(tok) < 5:
            continue
        out.add(tok)
    for tok in re.findall(r"\b\d{5,}\b", row.get("answer", "")):
        out.add(tok)
    return {t for t in out if len(t) >= 4}


def norm(t):
    return " ".join(t.split())


def main(argv):
    if not argv:
        print(__doc__.strip().split("\n\n")[2]); return 2
    rd = argv[0].rstrip("/")
    traj = os.path.join(rd, "trajectory.json")
    if not os.path.exists(traj):
        print("REFUSING: %s has no trajectory.json -- nothing was measured"
              % rd); return 2
    mpath, why = pick_manifest(rd)
    if not mpath:
        print("REFUSING to report coverage for %s" % os.path.basename(rd))
        print("  %s" % why)
        print("  A report against the wrong mint would be confidently wrong,")
        print("  which is worse than no report.")
        return 2
    print("run      : %s" % os.path.basename(rd))
    print("manifest : %s" % why)
    rows = list(csv.DictReader(open(mpath), delimiter="\t"))
    blob = json.load(open(traj))
    text = json.dumps(blob)

    # WRITE-CALL INPUTS ONLY, found by WALKING THE STRUCTURE.
    # A regex over the whole blob for "content": "..." does NOT work: every
    # message dict has a `content` key, so the ordinary transcript is scooped
    # up as if it were written to a file and WRITTEN comes back equal to SEEN
    # -- i.e. the checker reports full coverage no matter what the agent did.
    # Caught by the self-test 2026-08-26 (expected 10, got 13).
    WRITERS = ("write", "edit", "notebookedit", "create_file", "str_replace")
    chunks = []

    def walk(o):
        if isinstance(o, dict):
            if o.get("type") == "tool_use":
                name = str(o.get("name", "")).lower()
                inp = o.get("input")
                if any(w in name for w in WRITERS):
                    chunks.append(json.dumps(inp))
                elif "bash" in name and isinstance(inp, dict):
                    # a heredoc / redirect is a write; the command carries it
                    cmd = str(inp.get("command", ""))
                    if any(t in cmd for t in (">", ">>", "<<", "tee ")):
                        chunks.append(cmd)
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(blob)
    written = " ".join(chunks)
    text = norm(text)
    written = norm(written)
    seen_n = writ_n = unchk = 0
    print()
    print("%-22s %-12s %-8s %-8s" % ("SUBJECT", "FOLDER", "SEEN", "WRITTEN"))
    for r in rows:
        ps = {norm(p) for p in probes(r)}
        if not ps:
            unchk += 1
            print("%-22s %-12s %-8s %-8s   <== no distinctive probe"
                  % (r["subject"][:22], r["folder"][:12], "n/a", "n/a"))
            continue
        seen = any(p in text for p in ps)
        writ = any(p in written for p in ps)
        seen_n += seen; writ_n += writ
        print("%-22s %-12s %-8s %-8s" % (r["subject"][:22], r["folder"][:12],
                                         "yes" if seen else "NO",
                                         "yes" if writ else "NO"))
    checkable = len(rows) - unchk
    print()
    if unchk:
        print("UNCHECKABLE %d of %d -- these rows carry nothing distinctive "
              "enough to search for. They are NOT scored either way; a row "
              "that cannot be checked must never be reported as a miss."
              % (unchk, len(rows)))
    print("SEEN    %d of %d checkable" % (seen_n, checkable))
    print("WRITTEN %d of %d checkable  <- the coverage the predicate grades"
          % (writ_n, checkable))
    if writ_n < checkable:
        print("\n%d checkable graded item(s) were not carried into any artefact "
              "the agent created." % (checkable - writ_n))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
