#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Seed 2336 -- Wardley Show Society, secretary's box and stewards' box.

THE POINT OF THIS SEED: `Archive` holds 58 messages and `Old-shows` holds 57,
both deliberately OVER FIFTY. `export_emails` truncates at 50 per folder and
keeps the NEWEST fifty (measured 2026-08-26: a 64-message folder exported items
14..63 and dropped 0..13), so the oldest 8 of Archive and the oldest 7 of
Old-shows fall outside any export. Those fifteen are the graded set, and in an
archive the oldest end is the foundational end.

Every reference, sum and name-of-record is drawn from os.urandom at seed time.
"""
import os, sys
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import rbdoc, mailtask

TZ = timezone(timedelta(hours=0))
ACCOUNTS = {"showsec": ("showsec@mcp.com", "Sh6pq2vt8"),
            "stewards": ("stewards@mcp.com", "St9nd4wk3")}
FOLDERS = {"showsec": ["INBOX", "Archive", "Trade-stands", "Entries"],
           "stewards": ["INBOX", "Old-shows", "Rotas", "Judging"]}
MANIFEST = os.path.join(os.path.dirname(HERE), "manifest")

ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
DIGITS = "0123456789"


def code(rng, n=8, alpha=ALPHA):
    return "".join(rng.choice(alpha) for _ in range(n))


def dt(y, m, d, hh=9, mm=0):
    return datetime(y, m, d, hh, mm, tzinfo=TZ)


COMMITTEE = [
    ("Marjory Pinnock", "m.pinnock@wardleyshow.org.uk"),
    ("Ken Dallimore",   "k.dallimore@wardleyshow.org.uk"),
    ("Auriol Stamp",    "a.stamp@wardleyshow.org.uk"),
    ("Ted Grewcock",    "t.grewcock@wardleyshow.org.uk"),
]
OUTSIDE = [
    ("Brackley Agri Supplies", "office@brackleyagri.co.uk"),
    ("Rutland County Council", "licensing@rutlandcc.gov.uk"),
    ("Uppingham Vets",         "farm@uppinghamvets.co.uk"),
    ("Welland Marquees",       "hire@wellandmarquees.co.uk"),
    ("Fineshade Fencing",      "sales@fineshadefencing.co.uk"),
    ("Casterton Insurance",    "brokers@castertoninsurance.co.uk"),
    ("St John Ambulance",      "events@stjohn-rutland.org.uk"),
    ("Empingham Sound",        "bookings@empinghamsound.co.uk"),
]
EXHIBITORS = [
    ("Nancy Aveling",   "n.aveling@example.co.uk"),
    ("Ron Tebbutt",     "rtebbutt@example.co.uk"),
    ("Prue Skevington", "p.skev@example.co.uk"),
    ("Ivo Lount",       "ivo.lount@example.co.uk"),
    ("Della Whatton",   "d.whatton@example.co.uk"),
    ("Michael Purseglove", "m.purseglove@example.co.uk"),
]
SUBJECTS_ARCHIVE = [
    "show day", "schedule", "trophies", "the ring", "car park", "marquee",
    "judges", "RE: the field", "prize money", "programme", "RE: Saturday",
    "gate takings", "entries", "cattle lines", "water", "RE: the vets",
    "sound system", "RE: parking", "rosettes", "accounts",
]
SUBJECTS_STEW = [
    "rota", "ring party", "RE: the horses", "classes", "results",
    "RE: Sunday", "stewards", "RE: the sheep", "tannoy", "lunches",
    "RE: the young handlers", "gates", "RE: judging", "timings",
]
BODIES = [
    "Confirming what we said at the committee.",
    "Same as last year unless anybody objects.",
    "Can you let me know either way by the weekend.",
    "I have put this on the agenda for Tuesday.",
    "Nothing to worry about, just so it is written down.",
    "That is booked now.",
    "Ken is sorting this one out.",
    "Marjory has the paperwork for it.",
    "Agreed on the phone this morning.",
    "Leave it with me and I will chase them.",
]


def rdt(rng, d0, d1):
    a = datetime(*[int(x) for x in d0.split("-")], tzinfo=TZ)
    b = datetime(*[int(x) for x in d1.split("-")], tzinfo=TZ)
    span = int((b - a).total_seconds())
    d = a + timedelta(seconds=rng.randrange(span))
    return d.replace(hour=rng.randint(8, 21), minute=rng.randint(0, 59),
                     second=0)


def build(rng):
    rows = {"showsec": [], "stewards": []}
    graded = []

    def add(acct, folder, subject, who, when, body):
        rows[acct].append((folder, subject, "%s <%s>" % who, when, body, []))

    def filler(acct, folder, subs, span, senders):
        who = rng.choice(senders)
        add(acct, folder, rng.choice(subs), who, rdt(rng, *span),
            rng.choice(BODIES) + "\n\n--\n%s\n" % who[0].split()[0])

    ALL = COMMITTEE + OUTSIDE + EXHIBITORS

    # ---- the two oversized folders. Fillers are all 2019 or later, so the
    # ---- graded messages below are the oldest in each folder.
    for i in range(50):
        filler("showsec", "Archive", SUBJECTS_ARCHIVE, ("2019-01-10", "2026-07-20"), ALL)
    for i in range(50):
        filler("stewards", "Old-shows", SUBJECTS_STEW, ("2019-01-10", "2026-07-20"), ALL)

    # ---- everything else stays comfortably under fifty
    for i in range(31):
        filler("showsec", "Trade-stands", SUBJECTS_ARCHIVE, ("2026-02-01", "2026-07-25"), OUTSIDE + COMMITTEE)
    for i in range(38):
        filler("showsec", "Entries", SUBJECTS_ARCHIVE, ("2026-05-01", "2026-08-01"), EXHIBITORS + COMMITTEE)
    for i in range(27):
        filler("showsec", "INBOX", SUBJECTS_ARCHIVE, ("2026-06-01", "2026-08-10"), ALL)
    for i in range(29):
        filler("stewards", "Rotas", SUBJECTS_STEW, ("2026-05-01", "2026-08-01"), COMMITTEE)
    for i in range(34):
        filler("stewards", "Judging", SUBJECTS_STEW, ("2026-05-01", "2026-08-05"), COMMITTEE + OUTSIDE)
    for i in range(24):
        filler("stewards", "INBOX", SUBJECTS_STEW, ("2026-06-01", "2026-08-10"), ALL)

    # ---- the message R3 is answered from (recent, never in scope) ---------
    add("showsec", "Entries", "RE: the vets",
        ("Uppingham Vets", "farm@uppinghamvets.co.uk"), dt(2026, 7, 30, 17, 12),
        "Ian Rowntree is on call for the day and will be on the ground from "
        "seven. Any beast that has to be turned away, he signs the form and "
        "the steward countersigns.\n\n--\nUppingham Vets\n")

    # ======================================================================
    # THE FIFTEEN. The oldest eight in Archive and the oldest seven in
    # Old-shows -- 2016 to 2018, the years the society set the ground up.
    # These are exactly the messages an `export_emails` of either folder
    # leaves behind, because it keeps the newest fifty.
    # ======================================================================
    G = []
    rent = "%d" % rng.randrange(150, 600, 25)
    yrs = rng.choice([10, 15, 20, 21, 25])
    G.append(("showsec", "Archive", "RE: the field",
              ("Hubert Cadge", "h.cadge@example.co.uk"), dt(2016, 2, 18, 19, 4),
              "Right, that is agreed and you can take this as it in writing. "
              "The society has the Fallow Field for the show and the two days "
              "either side of it, for %d years from this year, for GBP %s a "
              "year paid before the show.\n\n"
              "Conditions are: no vehicles on the field if it is wet enough to "
              "mark, the gateway off the Uppingham road is made good "
              "afterwards, and the hedge on the far side is not touched at "
              "all. If the society folds the arrangement ends with it and does "
              "not pass to anybody else.\n\n--\nHubert Cadge\n" % (yrs, rent),
              "the Fallow Field is let to the society for %d years at GBP %s a "
              "year, no vehicles when it marks, gateway made good, far hedge "
              "untouched" % (yrs, rent),
              "the landowner's written permission for the showground and its "
              "conditions -- the society has no lease and no premises"))

    sup = code(rng, 6, DIGITS)
    G.append(("showsec", "Archive", "water",
              ("Anglian Water", "developer.services@anglianwater.co.uk"),
              dt(2016, 5, 9, 11, 27),
              "The standpipe at the top corner is metered under supply number "
              "%s and it is billed to the society, not to the farm. It is a "
              "building supply, not a drinking supply, so anything drawn for "
              "the cattle troughs is fine but it is not to be offered to the "
              "public without a notice up.\n\n--\nAnglian Water\n" % sup,
              "standpipe supply number %s, billed to the society, building "
              "supply not drinking -- notice required if offered to the "
              "public" % sup,
              "which supply the standpipe is on, who is billed for it and what "
              "it may lawfully be used for"))

    troph = code(rng, 5)
    G.append(("showsec", "Archive", "trophies",
              ("Sylvia Brudenell", "s.brudenell@example.co.uk"),
              dt(2016, 9, 22, 15, 41),
              "As executor I can confirm my aunt left the cup to the society "
              "on these terms and no others: it is called the %s Challenge "
              "Cup, it is awarded for the best animal bred by the exhibitor, "
              "it stays in the county, and it is returned to the society each "
              "July. It is not to be awarded for anything else and it is not "
              "to be sold.\n\n--\nSylvia Brudenell\n" % troph,
              "the %s Challenge Cup, for the best animal bred by the "
              "exhibitor, stays in the county, returned each July, never to be "
              "sold" % troph,
              "the terms the trophy was left to the society under; the "
              "executor is dead and there is no deed"))

    lic = "WD/%s" % code(rng, 6, DIGITS)
    cap = rng.randrange(1500, 5000, 250)
    G.append(("showsec", "Archive", "programme",
              ("Rutland County Council", "licensing@rutlandcc.gov.uk"),
              dt(2017, 4, 6, 9, 18),
              "Licence %s is granted for the showground for one day a year on "
              "these conditions: not more than %d people on the ground at any "
              "time, the main ring roped and stewarded on all four sides, and "
              "the entrance kept clear for an ambulance at all times.\n\n"
              "The licence renews on the same conditions unless we write to "
              "you.\n\n--\nRutland County Council, licensing\n" % (lic, cap),
              "licence %s, capacity %d, ring roped and stewarded on four "
              "sides, entrance kept clear" % (lic, cap),
              "the public entertainment licence and the conditions the show "
              "runs under, which renew silently and are stated nowhere else"))

    acres = "%d.%d" % (rng.randint(3, 9), rng.randint(0, 9))
    G.append(("showsec", "Archive", "car park",
              ("Doreen Quilter", "d.quilter@example.co.uk"),
              dt(2017, 6, 30, 18, 55),
              "You can have the %s acres of stubble for the parking on show "
              "day provided it is cut and carted first, and if it is not cut "
              "you do not come on it at all. No charge, but the society puts "
              "the gateway back and pays for any damage to the drain in the "
              "bottom corner.\n\n"
              "This is between me and the society and it does not run with the "
              "farm if I sell.\n\n--\nDoreen Quilter\n" % acres,
              "%s acres of stubble for parking, only if cut and carted, "
              "society reinstates the gateway and pays for drain damage, does "
              "not run with the farm" % acres,
              "the parking agreement with the neighbouring farm, personal to "
              "the owner and unrecorded elsewhere"))

    pol = "CI/%s" % code(rng, 7, DIGITS)
    excess = rng.randrange(250, 1500, 50)
    G.append(("showsec", "Archive", "accounts",
              ("Casterton Insurance", "brokers@castertoninsurance.co.uk"),
              dt(2017, 11, 14, 10, 33),
              "Cover is written on policy %s. The important part for you is "
              "that it is written on the basis that the society does not own "
              "the ground and has no employees -- everybody on show day is a "
              "volunteer. If either of those stops being true the cover has to "
              "be rewritten or it does not answer.\n\n"
              "Excess is GBP %d on any one claim.\n\n"
              "--\nCasterton Insurance\n" % (pol, excess),
              "policy %s, written on the basis of no owned ground and no "
              "employees, excess GBP %d" % (pol, excess),
              "the basis the society's insurance is written on -- the thing "
              "that voids it is what is recorded here"))

    row_ref = "ROW/%s" % code(rng, 5, DIGITS)
    G.append(("showsec", "Archive", "RE: the field",
              ("Rutland County Council", "rightsofway@rutlandcc.gov.uk"),
              dt(2018, 3, 12, 14, 2),
              "Our reference %s. The footpath crosses the Fallow Field on the "
              "line shown on the definitive map, which is the diagonal, not "
              "the field edge as people walk it. On show day you may fence it "
              "either side so long as it is not obstructed and the stiles are "
              "left useable.\n\n--\nRutland County Council, rights of way\n"
              % row_ref,
              "%s, the footpath runs on the diagonal per the definitive map, "
              "may be fenced but not obstructed" % row_ref,
              "where the right of way actually runs, which is not where it is "
              "walked, and what the show may do about it"))

    gates = rng.randrange(400, 1800, 50)
    G.append(("showsec", "Archive", "RE: Saturday",
              ("Ted Grewcock", "t.grewcock@wardleyshow.org.uk"),
              dt(2018, 8, 20, 21, 47),
              "For the record before I forget it. The new gates at the "
              "entrance were paid for by the Womens Institute out of their "
              "centenary money, GBP %d, on the understanding that the "
              "society keeps the plaque on them and does not move them off "
              "that entrance. Nobody wrote it down at the time and I am the "
              "only one who was there.\n\n--\nTed\n" % gates,
              "the WI paid GBP %d for the entrance gates from centenary "
              "money, on condition the plaque stays and the gates are not "
              "moved" % gates,
              "the only record of who paid for the gates and on what terms"))

    inc = "%s" % code(rng, 6, DIGITS)
    G.append(("stewards", "Old-shows", "RE: Sunday",
              ("Ken Dallimore", "k.dallimore@wardleyshow.org.uk"),
              dt(2016, 8, 21, 20, 12),
              "Writing this up while it is fresh. Incident number %s. At about "
              "ten past three a pony got loose from the collecting ring, went "
              "through the gap by the tea tent and knocked a woman down. She "
              "was seen by St John, declined an ambulance and gave her name as "
              "on the form. Two stewards saw it, Auriol and myself.\n\n"
              "The gap by the tea tent is the thing to fix -- there is no rope "
              "on that side.\n\n--\nKen\n" % inc,
              "incident %s, pony loose from the collecting ring at about 3.10, "
              "woman knocked down, seen by St John, declined an ambulance, two "
              "steward witnesses" % inc,
              "the contemporaneous account of the only injury the show has "
              "had, with the witnesses and the cause"))

    rul = code(rng, 4)
    G.append(("stewards", "Old-shows", "RE: judging",
              ("Auriol Stamp", "a.stamp@wardleyshow.org.uk"),
              dt(2016, 8, 22, 19, 30),
              "The ruling on the sheep objection, so it is not argued again. "
              "The judge's decision stood, the objection was not upheld, and "
              "the committee agreed that a ewe shown with a lamb that is not "
              "her own is out of the class. That is now how we read class 11 "
              "and it is ruling %s.\n\n--\nAuriol\n" % rul,
              "ruling %s -- a ewe shown with a lamb not her own is out of "
              "class 11, judge's decision stood" % rul,
              "the standing ruling on a class, made once and never written "
              "into the schedule"))

    dsq = code(rng, 5, DIGITS)
    G.append(("stewards", "Old-shows", "RE: the sheep",
              ("Uppingham Vets", "farm@uppinghamvets.co.uk"),
              dt(2017, 8, 19, 16, 44),
              "Confirming what I told the steward on the day. The animal "
              "turned away in the cattle line, tag %s, was showing signs I was "
              "not prepared to pass on the ground. It was not a notifiable "
              "matter and I did not report it further, but if the same "
              "exhibitor brings the same animal the society should know it has "
              "been turned away once.\n\n--\nUppingham Vets\n" % dsq,
              "tag %s turned away by the vet on the day, not notifiable, but "
              "on record as turned away once" % dsq,
              "the vet's reason for turning an animal away, which exists "
              "nowhere but here"))

    ring_l, ring_w = rng.randrange(60, 110, 5), rng.randrange(35, 70, 5)
    G.append(("stewards", "Old-shows", "the ring",
              ("Casterton Insurance", "brokers@castertoninsurance.co.uk"),
              dt(2017, 5, 3, 11, 9),
              "The ring dimensions we have underwritten on are %d metres by "
              "%d, with the ropes at least four metres off the crowd line on "
              "the tannoy side. If the ring is set out smaller than that, or "
              "the crowd line comes closer, the cover for the ridden classes "
              "does not apply.\n\n--\nCasterton Insurance\n" % (ring_l, ring_w),
              "the ring is underwritten at %d by %d metres with ropes four "
              "metres off the crowd line on the tannoy side" % (ring_l, ring_w),
              "the ring geometry the insurance is written against; set it out "
              "smaller and the ridden classes are uncovered"))

    comp = code(rng, 6, DIGITS)
    G.append(("stewards", "Old-shows", "gates",
              ("Michael Purseglove", "m.purseglove@example.co.uk"),
              dt(2018, 8, 18, 22, 5),
              "I am putting my complaint in writing as asked. Reference the "
              "steward gave me was %s. My trailer was refused at the gate "
              "because the ground was wet and I was told to unload on the "
              "road, which I did, and one of my birds was lost in the process. "
              "I am not asking for money, I want it on record so it is thought "
              "about next year.\n\n--\nM Purseglove\n" % comp,
              "complaint %s -- trailer refused at the gate on wet ground, "
              "unloaded on the road, a bird lost; no claim made" % comp,
              "an exhibitor's written complaint and the reference it was given "
              "-- the society keeps no complaints book"))

    sj = code(rng, 5, DIGITS)
    G.append(("stewards", "Old-shows", "RE: the young handlers",
              ("St John Ambulance", "events@stjohn-rutland.org.uk"),
              dt(2018, 6, 11, 13, 26),
              "Cover for the show is arranged under %s on the basis of two "
              "first aiders and one vehicle, positioned at the ring end, for a "
              "ground of the size you have given us. If your numbers go above "
              "what you told us we have to be told beforehand or the cover is "
              "not adequate for the licence.\n\n"
              "--\nSt John Ambulance, Rutland\n" % sj,
              "cover %s -- two first aiders and one vehicle at the ring end, "
              "conditional on the numbers given" % sj,
              "the first aid cover the licence depends on and the condition "
              "attached to it"))

    tan = code(rng, 4)
    G.append(("stewards", "Old-shows", "tannoy",
              ("Empingham Sound", "bookings@empinghamsound.co.uk"),
              dt(2018, 7, 24, 9, 52),
              "The frequency we hold for the show is %s and it is registered "
              "to us, not to the society. If anybody else turns up with "
              "radios on show day that is the one they must not use. We keep "
              "it year to year as long as the booking continues.\n\n"
              "--\nEmpingham Sound\n" % tan,
              "the show's reserved radio frequency is %s, registered to the "
              "contractor not the society" % tan,
              "the frequency the ring party works on, held by a contractor and "
              "recorded nowhere the society controls"))

    for acct, folder, subj, who, when, body, answer, note in G:
        add(acct, folder, subj, who, when, body)
        graded.append(dict(account=acct, folder=folder, subject=subj,
                           frm="%s <%s>" % who, when=when, body=body,
                           body_only=True, answer=answer, note=note))

    return rows, graded


if __name__ == "__main__":
    mailtask.run(build, ACCOUNTS, FOLDERS, MANIFEST)
