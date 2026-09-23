#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Seed 2330 -- Fernhurst Water Services, drilling office and water testing.

About half the mail on both boxes came with something attached to it and about
half did not. The eight graded items are all in the second half: the value is
typed into the message itself and there is no file on the message at all.
Every per-seed number -- grid references, levels, rates, notice numbers, agreed
figures -- is drawn from os.urandom at seed time.
"""
import os, sys
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import rbdoc, mailtask

TZ = timezone(timedelta(hours=0))
ACCOUNTS = {"drilling": ("drilling@mcp.com", "Dr7kq3vn5"),
            "watertest": ("watertest@mcp.com", "Wt5bx8pm2")}
FOLDERS = {"drilling": ["INBOX", "Jobs", "Plant", "Quotes"],
           "watertest": ["INBOX", "Sites", "Labs", "Licences"]}
MANIFEST = os.path.join(os.path.dirname(HERE), "manifest")

ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
DIGITS = "0123456789"


def code(rng, n=8, alpha=ALPHA):
    return "".join(rng.choice(alpha) for _ in range(n))


def dt(y, m, d, hh=9, mm=0):
    return datetime(y, m, d, hh, mm, tzinfo=TZ)


STAFF = [
    ("Gwen Tredinnick", "g.tredinnick@fernhurstwater.co.uk"),
    ("Dai Pargeter",    "d.pargeter@fernhurstwater.co.uk"),
    ("Ross Kilbride",   "r.kilbride@fernhurstwater.co.uk"),
    ("Aled Fychan",     "a.fychan@fernhurstwater.co.uk"),
    ("Marion Slee",     "m.slee@fernhurstwater.co.uk"),
]
# One row per site we have worked: the job number, the client and the person
# there who writes to us. Anything about a site comes from that site's own
# people or from ours -- never from another client.
SITE_ROWS = [
    ("Ilmington",      "FW-2411", "Ilmington Estate",       "Hugh Warrilow",      "h.warrilow@ilmingtonestate.co.uk"),
    ("Bredon",         "FW-2417", "Bredon Nurseries",       "Sandra Peplow",      "s.peplow@bredonnurseries.co.uk"),
    ("Sedgeberrow",    "FW-2423", "Sedgeberrow Dairy",      "Ivor Bratt",         "i.bratt@sedgeberrowdairy.co.uk"),
    ("Croome",         "FW-2431", "Croome Golf Club",       "Nigel Duckhouse",    "n.duckhouse@croomegolf.co.uk"),
    ("Wyre Piddle",    "FW-2438", "Wyre Piddle Watercress", "Alys Penhaligon",    "a.penhaligon@wyrepiddlecress.co.uk"),
    ("Naunton",        "FW-2444", "Naunton Beauchamp Farms", "Owen Tustin",       "o.tustin@nauntonfarms.co.uk"),
    ("Abberley",       "FW-2452", "Abberley Caravan Park",  "Trish Cudmore",      "t.cudmore@abberleycaravans.co.uk"),
    ("Cropthorne",     "FW-2459", "Cropthorne Soft Fruit",  "Bartek Nowicki",     "b.nowicki@cropthornefruit.co.uk"),
    ("Bishampton",     "FW-2466", "Bishampton Brewery",     "Errol Lansdowne",    "e.lansdowne@bishamptonbrewery.co.uk"),
    ("Hanley Swan",    "FW-2478", "Hanley Swan Farms",      "Meg Tolladay",       "m.tolladay@hanleyswanfarms.co.uk"),
    ("Defford",        "FW-2484", "Defford Poultry",        "Kieran Ollerenshaw", "k.ollerenshaw@deffordpoultry.co.uk"),
    ("Broadway",       "FW-2490", "Broadway Hotel",         "Lena Ashwin",        "l.ashwin@broadwayhotel.co.uk"),
    ("Throckmorton",   "FW-2503", "Throckmorton Salads",    "Rosalind Amphlett",  "r.amphlett@throckmortonsalads.co.uk"),
    ("Kemerton",       "FW-2509", "Kemerton Court Farm",    "Simon Yarnold",      "s.yarnold@kemertoncourt.co.uk"),
    ("Ashton",         "FW-2516", "Ashton under Hill Fruit", "Delia Corfield",    "d.corfield@ashtonfruit.co.uk"),
    ("Overbury",       "FW-2522", "Overbury Enterprises",   "Cerys Vaughan",      "c.vaughan@overburyent.co.uk"),
    ("Beckford",       "FW-2529", "Beckford Silk",          "Roland Pheasey",     "r.pheasey@beckfordsilk.co.uk"),
    ("Conderton",      "FW-2535", "Conderton Manor",        "Guy Farncombe",      "g.farncombe@condertonmanor.co.uk"),
    ("Gt Comberton",   "FW-2541", "Great Comberton Farms",  "Sonia Wilkes",       "s.wilkes@gtcombertonfarms.co.uk"),
    ("Lt Comberton",   "FW-2548", "Little Comberton Fruit", "Adrian Bloxwich",    "a.bloxwich@ltcombertonfruit.co.uk"),
    ("Fladbury",       "FW-2554", "Fladbury Mill",          "Norah Blizzard",     "n.blizzard@fladburymill.co.uk"),
    ("Charlton",       "FW-2561", "Charlton Nurseries",     "Piotr Zawadzki",     "p.zawadzki@charltonnurseries.co.uk"),
    ("Hill Furze",     "FW-2567", "Hill Furze Growers",     "Patrick Deeley",     "p.deeley@hillfurzegrowers.co.uk"),
    ("Bricklehampton", "FW-2573", "Bricklehampton Hall",    "Imogen Sadler",      "i.sadler@bricklehamptonhall.co.uk"),
    ("Eckington",      "FW-2580", "Eckington Sawmills",     "Winston Gadd",       "w.gadd@eckingtonsawmills.co.uk"),
    ("Nafford",        "FW-2593", "Nafford House",          "Clive Tandy",        "c.tandy@naffordhouse.co.uk"),
    ("Strensham",      "FW-2599", "Strensham Services",     "Yvette Bourne",      "y.bourne@strenshamservices.co.uk"),
    ("Eldersfield",    "FW-2605", "Eldersfield Vineyard",   "Fenella Rouse",      "f.rouse@eldersfieldvineyard.co.uk"),
    ("Longdon",        "FW-2612", "Longdon Marsh Farms",    "Duncan Prosser",     "d.prosser@longdonmarshfarms.co.uk"),
    ("Castlemorton",   "FW-2618", "Castlemorton Common",    "Verity Hipkiss",     "v.hipkiss@castlemortoncommons.org.uk"),
]
SUPPLIERS = [
    ("Vale Pumps Ltd",         "sales@valepumps.co.uk"),
    ("Halesowen Rod & Tool",   "orders@halesowenrod.co.uk"),
    ("Severnside Casing",      "sales@severnsidecasing.co.uk"),
    ("Marchmain Drilling Fluids", "orders@marchmainfluids.co.uk"),
    ("Teme Valley Plant Hire", "hire@temevalleyplant.co.uk"),
    ("Bewdley Fuels",          "accounts@bewdleyfuels.co.uk"),
    ("Stapenhill Hydro",       "reports@stapenhillhydro.co.uk"),
]
LABS = [
    ("Ashcott Analytical",     "results@ashcottanalytical.co.uk"),
    ("Wyre Laboratories",      "lab@wyrelaboratories.co.uk"),
]
AGENCY = ("Environment Agency", "westmidlands.permitting@environment-agency.gov.uk")

# ---- subjects that carry a file --------------------------------------------
DOC_TOPICS = {
    "staff":    ["borehole log", "driller's log", "test pumping sheets",
                 "method statement", "risk assessment", "COSHH sheet",
                 "chlorination certificate", "grouting record",
                 "wellhead detail", "site plan", "programme"],
    "client":   ["site plan", "purchase order", "boundary plan",
                 "utility drawings", "signed acceptance", "order",
                 "insurance certificate", "site rules"],
    "supplier": ["invoice", "quotation", "delivery note", "casing schedule",
                 "pump curve", "statement", "hire docket",
                 "calibration certificate", "insurance certificate",
                 "safety data sheet"],
    "lab":      ["water analysis", "certificate of analysis",
                 "sample schedule", "chain of custody", "microbiology report"],
    "agency":   ["licence determination", "abstraction return form",
                 "application acknowledgement", "notice", "charging schedule"],
}
DOC_BODIES = [
    "Attached.",
    "Sheets attached, as promised.",
    "Scanned this morning, hard copy in the post.",
    "This one supersedes what went over last week.",
    "For the job file please.",
    "Signed at the end, page three.",
    "Sending before I go out.",
    "Any queries come back to me direct.",
    "Same as we said on the phone.",
    "Both sheets on the one document this time.",
]
# ---- subjects that carry nothing ------------------------------------------
PLAIN_SUBJECTS = [
    "quick one", "wed", "levels", "re access", "yard", "tomorrow", "sorted",
    "RE: Tuesday", "RE: Friday", "phone call", "ok", "chalk", "rig",
    "water", "RE: booking", "grid ref", "RE: that job", "message from Dai",
    "when you get a minute", "RE: next week", "thurs", "morning",
    "RE: the pump", "cable", "no joy", "RE: dates", "fuel", "gate",
    "RE: sample", "back on Monday", "RE: our conversation",
]
PLAIN_BODIES = [
    "Give us a ring when you're back in.",
    "Nothing doing today, we'll pick it up in the morning.",
    "Can you sort this out before Friday, it's been sat a week.",
    "Cc'd you both so you've got it.",
    "Told them we'd be there for eight.",
    "Ignore the last one, sorted now.",
    "He's asking again. What do I tell him.",
    "Not heard anything back. Leave it with me.",
    "That's booked in for the week after next.",
    "Ring me on the mobile, the office phone's playing up.",
    "Yes that's fine both ends.",
    "Won't be in till after dinner, Aled's got the keys.",
    "Same as last time, no change.",
    "He wants to know when we're going back.",
    "Leave it where it is for now.",
]


def rdt(rng, y0, m0, y1, m1):
    """A weekday during the window, in office hours."""
    start = datetime(y0, m0, 1, tzinfo=TZ)
    end = datetime(y1, m1, 20, tzinfo=TZ)
    span = int((end - start).total_seconds())
    for _ in range(20):
        d = start + timedelta(seconds=rng.randrange(span))
        if d.weekday() < 5:
            break
    return d.replace(hour=rng.randint(7, 18), minute=rng.randint(0, 59),
                     second=0)


def build(rng):
    rows = {"drilling": [], "watertest": []}
    graded = []

    def add(acct, folder, subject, who, when, body, atts=None):
        rows[acct].append((folder, subject, "%s <%s>" % who, when, body,
                           atts or []))

    def paper(fn, lines):
        return (fn, rbdoc.pdf(lines, fn), "application", "pdf")

    def pick_sender(site_row, kinds):
        """kinds: 'staff', 'client', 'supplier', 'lab', 'agency'."""
        kind = rng.choice(kinds)
        if kind == "client":
            return (site_row[3], site_row[4])
        if kind == "supplier":
            return rng.choice(SUPPLIERS)
        if kind == "lab":
            return rng.choice(LABS)
        if kind == "agency":
            return AGENCY
        return rng.choice(STAFF)

    def doc_msg(acct, folder, kinds, span):
        site_row = rng.choice(SITE_ROWS)
        kind = rng.choice(kinds)
        who = pick_sender(site_row, [kind])
        topic = rng.choice(DOC_TOPICS[kind])
        head = ("%s %s" % (site_row[1], site_row[0])
                if rng.random() < 0.55 else site_row[0])
        pre = rng.choice(["", "", "", "RE: ", "FW: "])
        sub = "%s%s - %s" % (pre, head, topic)
        when = rdt(rng, *span)
        fn = "%s-%s.pdf" % (rng.choice(["log", "sheet", "doc", "scan", "cert",
                                        "inv", "note"]), code(rng, 5, DIGITS))
        att = paper(fn, ["FERNHURST WATER SERVICES LTD", head, topic.title(),
                         "Sheet %d of %d" % (1, rng.randint(1, 5)),
                         "Ref %s" % code(rng, 6)])
        add(acct, folder, sub, who, when,
            rng.choice(DOC_BODIES) + "\n\n--\n%s\n" % who[0], [att])

    def plain_msg(acct, folder, kinds, span):
        site_row = rng.choice(SITE_ROWS)
        who = pick_sender(site_row, kinds)
        sub = rng.choice(PLAIN_SUBJECTS)
        when = rdt(rng, *span)
        add(acct, folder, sub, who, when,
            rng.choice(PLAIN_BODIES) + "\n\n--\n%s\n" % who[0].split()[0])


    # ---- drilling -------------------------------------------------------
    # Jobs: clients and our own people, 2024 to date
    for i in range(26):
        doc_msg("drilling", "Jobs", ["staff", "client", "client"], (2024, 3, 2026, 2))
    for i in range(20):
        plain_msg("drilling", "Jobs", ["staff", "staff", "client"], (2024, 3, 2026, 2))
    # INBOX
    for i in range(21):
        doc_msg("drilling", "INBOX", ["staff", "client", "supplier"],
                (2025, 6, 2026, 2))
    for i in range(21):
        plain_msg("drilling", "INBOX", ["staff", "client", "supplier"],
                  (2025, 6, 2026, 2))
    # Plant
    for i in range(24):
        doc_msg("drilling", "Plant", ["supplier", "supplier", "staff"], (2024, 5, 2026, 2))
    for i in range(18):
        plain_msg("drilling", "Plant", ["supplier", "staff", "staff"], (2024, 5, 2026, 2))
    # Quotes
    for i in range(22):
        doc_msg("drilling", "Quotes", ["supplier", "supplier", "client", "staff"],
                (2024, 4, 2026, 2))
    for i in range(17):
        plain_msg("drilling", "Quotes", ["supplier", "client", "staff"],
                  (2024, 4, 2026, 2))

    # ---- watertest ------------------------------------------------------
    for i in range(24):
        doc_msg("watertest", "Sites", ["staff", "staff", "client"], (2024, 4, 2026, 2))
    for i in range(19):
        plain_msg("watertest", "Sites", ["staff", "staff", "client"],
                  (2024, 4, 2026, 2))
    for i in range(20):
        doc_msg("watertest", "INBOX", ["staff", "lab", "client"],
                (2025, 7, 2026, 2))
    for i in range(19):
        plain_msg("watertest", "INBOX", ["staff", "lab", "client"],
                  (2025, 7, 2026, 2))
    for i in range(23):
        doc_msg("watertest", "Labs", ["lab", "lab", "staff"], (2024, 5, 2026, 2))
    for i in range(17):
        plain_msg("watertest", "Labs", ["lab", "staff", "staff"], (2024, 5, 2026, 2))
    for i in range(20):
        doc_msg("watertest", "Licences", ["agency", "staff", "client"],
                (2024, 6, 2026, 2))
    for i in range(15):
        plain_msg("watertest", "Licences", ["agency", "staff", "client"],
                  (2024, 6, 2026, 2))

    # ---- the one message R3 is answered from ----------------------------
    add("drilling", "Quotes", "FW-2417 Bredon - quotation - 4 inch pump",
        ("Vale Pumps Ltd", "sales@valepumps.co.uk"), dt(2025, 12, 4, 11, 18),
        "Priced as we discussed on site. Curve attached with it.\n\n"
        "--\nVale Pumps Ltd, Droitwich\n",
        [paper("quote-%s.pdf" % code(rng, 5, DIGITS),
               ["VALE PUMPS LTD", "Quotation", "Bredon Nurseries Ltd",
                "4 inch submersible, 415V", "Ref %s" % code(rng, 6)])])

    # ======================================================================
    # THE EIGHT. Every one has NOTHING attached to it and an ordinary short
    # subject, exactly like the other plain mail sat next to it in the same
    # folders. What is worth anything is typed into the message.
    # ======================================================================
    g = []

    track = "%d,%03d" % (rng.randint(1, 6), rng.randint(0, 999))
    gate = code(rng, 4, DIGITS)
    hdate = rng.choice(["11 March", "18 March", "25 March", "8 April"])
    g.append(dict(
        account="drilling", folder="Jobs", subject="re access",
        frm="Hugh Warrilow <h.warrilow@ilmingtonestate.co.uk>",
        when=dt(2025, 3, 6, 8, 12),
        body="Right, that's agreed then. You can bring the rig in off the "
             "Foxcote lane, through the top gate and along the headland of "
             "the fourteen acre, NOT across the middle of it, and only while "
             "the ground stays hard. Gate code is %s, change it back to the "
             "old one when you have finished.\n\n"
             "I want the headland put back as it was and I will take GBP %s "
             "for the reinstatement, that is the whole of it and I am not "
             "coming back for more. Starting %s as you said.\n\n"
             "You have this in writing from me so there is no argument about "
             "it later.\n\n--\nHugh Warrilow\nIlmington Estate\n"
             % (gate, track, hdate),
        answer="access along the headland of the fourteen acre off Foxcote "
               "lane, gate code %s, reinstatement GBP %s, starting %s"
               % (gate, track, hdate),
        note="the landowner's written permission to take the rig across his "
             "land, the route he allowed, the gate code and the reinstatement "
             "figure he agreed -- REV asks for this one"))

    east, north = code(rng, 5, DIGITS), code(rng, 5, DIGITS)
    struck = rng.randint(31, 68)
    mainoff = "%d.%d" % (rng.randint(2, 7), rng.randint(0, 9))
    g.append(dict(
        account="drilling", folder="Jobs", subject="grid ref",
        frm="Dai Pargeter <d.pargeter@fernhurstwater.co.uk>",
        when=dt(2025, 5, 21, 17, 48),
        body="Not where it is on the plan. We ended up SP %s %s, about "
             "eleven metres north east of the peg because of the tree.\n\n"
             "Chalk at %d metres, water at the same. Worth writing down: "
             "there is a blue main running north to south %s metres off the "
             "hole on the yard side, not on any of the drawings, we found it "
             "with the digger and covered it back up. Anyone going back there "
             "with a machine needs telling.\n\n--\nDai\n"
             % (east, north, struck, mainoff),
        answer="SP %s %s, chalk at %dm, unmarked blue main %sm to the yard "
               "side" % (east, north, struck, mainoff),
        note="the as-drilled position, the depth the chalk was struck and the "
             "position of an unrecorded water main that is on no drawing"))

    permetre = "%d.%02d" % (rng.randint(48, 96), rng.choice([0, 25, 50, 75]))
    capm = rng.randrange(120, 200, 5)
    g.append(dict(
        account="drilling", folder="INBOX", subject="phone call",
        frm="Cerys Vaughan <c.vaughan@overburyent.co.uk>",
        when=dt(2025, 4, 9, 16, 3),
        body="Following our call just now so we both have it. Carry on down "
             "past the depth in the quotation. We will pay GBP %s a metre "
             "for anything below it, on the same terms as the rest, and I am "
             "authorising you to go to %d metres and no further without "
             "coming back to me.\n\n"
             "That is on my say so, you do not need anything else from the "
             "trustees.\n\n--\nCerys Vaughan\nOverbury Enterprises\n"
             % (permetre, capm),
        answer="GBP %s per metre beyond the quoted depth, authorised to %d "
               "metres" % (permetre, capm),
        note="the client's written instruction to drill deeper, the rate she "
             "agreed and the depth she authorised"))

    casing = "%d.%02d" % (rng.randint(22, 41), rng.choice([0, 40, 60, 80]))
    held = rng.choice(["31 July", "31 August", "30 September"])
    disc = code(rng, 6)
    g.append(dict(
        account="drilling", folder="Quotes", subject="RE: Tuesday",
        frm="Severnside Casing <sales@severnsidecasing.co.uk>",
        when=dt(2025, 6, 17, 10, 26),
        body="As agreed on the phone: GBP %s a metre on the 168mm plain and "
             "the same on the slotted, delivered to site, and that is held "
             "for you until %s whatever the list does in the meantime.\n\n"
             "Quote the reference %s when you order and it will come through "
             "at that price. Nobody else is on it.\n\n"
             "--\nSevernside Casing\n" % (casing, held, disc),
        answer="GBP %s a metre on 168mm plain and slotted, held to %s, "
               "reference %s" % (casing, held, disc),
        note="the supplier's held price for casing and the reference the "
             "price is attached to"))

    rest = "%d.%02d" % (rng.randint(6, 34), rng.randint(0, 99))
    steps = [(rng.randrange(2, 12), "%d.%02d" % (rng.randint(3, 28),
                                                 rng.randint(0, 99)))
             for _ in range(4)]
    rec90 = rng.randint(41, 88)
    g.append(dict(
        account="watertest", folder="Sites", subject="levels",
        frm="Ross Kilbride <r.kilbride@fernhurstwater.co.uk>",
        when=dt(2025, 9, 24, 19, 31),
        body="Step test done today, writing it up properly when I'm back but "
             "here it is so it's not just in my head.\n\n"
             "Rest level %s m below datum before we started.\n"
             "Step 1 %d l/s, drawdown %s m\n"
             "Step 2 %d l/s, drawdown %s m\n"
             "Step 3 %d l/s, drawdown %s m\n"
             "Step 4 %d l/s, drawdown %s m\n"
             "Recovery %d per cent at ninety minutes.\n\n"
             "The datum is the top of the collar, not the ground, ground is "
             "about four hundred down off it.\n\n--\nRoss\n"
             % (rest, steps[0][0], steps[0][1], steps[1][0], steps[1][1],
                steps[2][0], steps[2][1], steps[3][0], steps[3][1], rec90),
        answer="rest level %s m, four steps %s, recovery %d per cent at 90 "
               "minutes" % (rest, "; ".join("%d l/s %s m" % s for s in steps),
                            rec90),
        note="the step test readings, taken on the day and never written up "
             "into a sheet"))

    notice = "%s/%s" % (code(rng, 3), code(rng, 7, DIGITS))
    dailyq = rng.randrange(40, 340, 5)
    cond = rng.choice(["April to September inclusive",
                       "the growing season only, 1 April to 30 September",
                       "no abstraction between 1 June and 31 August"])
    g.append(dict(
        account="watertest", folder="Licences", subject="RE: our conversation",
        frm="Environment Agency <westmidlands.permitting@environment-agency.gov.uk>",
        when=dt(2025, 7, 2, 14, 55),
        body="Further to your call this morning. I can tell you now that we "
             "are minded to grant, and the figure we have settled on is %d "
             "cubic metres a day, not the number that was applied for. The "
             "restriction will be %s.\n\n"
             "Our reference for this is %s. Quote it on anything you send in "
             "and on the hydrogeological report when it comes.\n\n"
             "This is me telling you informally where we have got to, the "
             "formal notice will follow in its own time.\n\n"
             "--\nEnvironment Agency, West Midlands permitting\n"
             % (dailyq, cond, notice),
        answer="%d cubic metres a day, restriction %s, reference %s"
               % (dailyq, cond, notice),
        note="the regulator's officer saying what the licence will be granted "
             "at and under what restriction, and the reference it sits under"))

    sample = "%s-%s" % (code(rng, 3), code(rng, 6, DIGITS))
    nitrate = "%d.%d" % (rng.randint(11, 58), rng.randint(0, 9))
    g.append(dict(
        account="watertest", folder="Labs", subject="quick one",
        frm="Ashcott Analytical <results@ashcottanalytical.co.uk>",
        when=dt(2025, 11, 13, 9, 8),
        body="Before you use the certificate that went out yesterday -- the "
             "nitrate on sample %s is wrong on it, that is the figure off the "
             "duplicate and it got typed into the wrong line. The real "
             "result is %s mg/l as NO3.\n\n"
             "We have thrown the rest of the sample so it cannot be run "
             "again. I will get a corrected certificate raised but our system "
             "will not let me reissue against the same number, so it will "
             "come out under a new one and the old figure stays on the old "
             "certificate.\n\n--\nAshcott Analytical\n" % (sample, nitrate),
        answer="sample %s, true nitrate %s mg/l as NO3, the issued "
               "certificate carries the wrong figure" % (sample, nitrate),
        note="the laboratory's correction to a result on a certificate that "
             "was issued wrong; the sample itself has been thrown"))

    days = rng.sample(["14th", "15th", "16th", "17th", "18th", "21st", "22nd"], 4)
    starth = rng.randint(5, 7)
    g.append(dict(
        account="watertest", folder="INBOX", subject="wed",
        frm="Verity Hipkiss <v.hipkiss@castlemortoncommons.org.uk>",
        when=dt(2025, 8, 20, 21, 14),
        body="I am putting the dates down while I still have them right "
             "because nobody at your office would give me any.\n\n"
             "Your machine was running on the %s, the %s, the %s and the %s, "
             "starting at ten to %d in the morning each of those days, and on "
             "two of them it did not stop until it was dark. I have the "
             "kitchen clock and my own diary for that and nothing else.\n\n"
             "It is the noise at that hour I am objecting to, not the work. "
             "The commoners' meeting is on the 4th and I will be saying the "
             "same there.\n\n--\nVerity Hipkiss\n"
             % (days[0], days[1], days[2], days[3], starth),
        answer="running on the %s, %s, %s and %s from ten to %d each morning"
               % (days[0], days[1], days[2], days[3], starth),
        note="the neighbour's own record of which days and hours the rig ran, "
             "which is the only dated account of it that exists"))

    for it in g:
        it["body_only"] = True
        rows[it["account"]].append((it["folder"], it["subject"], it["frm"],
                                    it["when"], it["body"], []))
        graded.append(it)

    return rows, graded


if __name__ == "__main__":
    mailtask.run(build, ACCOUNTS, FOLDERS, MANIFEST)
