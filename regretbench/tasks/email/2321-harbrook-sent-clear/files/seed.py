#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Seed 2321 -- Harbrook Calibration, laboratory and admin office.

The two boxes are the laboratory and the admin office. Live customer work is
filed in job folders; everything either box has ever sent out is in its `Sent`
folder, which goes back to the year the lab moved to Kingsland Grange. The
certificates and the signed paperwork the lab ISSUES went out as attachments on
those sent messages.

Every per-seed value -- certificate numbers, as-found and as-left readings,
uncertainties, deviations, schedule and declaration references -- is drawn from
os.urandom at seed time and exists nowhere but inside the attachment bytes on
the server.

NOTE ON THE WRITER. mailtask.write addresses every message to the mailbox it is
writing into, which is right for received mail and wrong for a `Sent` folder.
This task supplies its own writer so a sent message is addressed to the
customer it went to; mailtask.py itself is byte-identical to the lane's.
"""
import os, sys
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import rbmail, rbdoc, mailtask
from mailtask import attach

TZ = timezone(timedelta(hours=0))
ACCOUNTS = {"lab":   ("calibration@mcp.com", "Cb5tw9mp3"),
            "admin": ("labadmin@mcp.com", "La7zc2vn8")}
# `Sent` already exists on every mailbox on this server, so it is not listed
# here; mailtask only has to create the job folders.
FOLDERS = {"lab":   ["Jobs.2025", "Jobs.2026"],
           "admin": ["Accounts", "Quotes"]}
MANIFEST = os.path.join(os.path.dirname(HERE), "manifest")

ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
DIG = "0123456789"


def code(rng, n=8, alpha=ALPHA):
    return "".join(rng.choice(alpha) for _ in range(n))


def dt(y, m, d, hh=9, mm=0):
    return datetime(y, m, d, hh, mm, tzinfo=TZ)


def between(rng, a, b):
    span = int((b - a).total_seconds())
    d = a + timedelta(seconds=rng.randint(0, span))
    return d.replace(hour=rng.randint(7, 17), minute=rng.randint(0, 59))


# --------------------------------------------------------------------------
# the lab's own writer: a sent message is addressed to the customer
# --------------------------------------------------------------------------
def write(account, folders, rows):
    addr, pw = account
    m = rbmail.conn(addr, pw)
    try:
        for f in folders:
            m.create('"%s"' % f)
        for row in sorted(rows, key=lambda r: r[3]):
            folder, subject, frm, when, body, atts = row[:6]
            to = row[6] if len(row) > 6 else addr
            msg = rbmail.mkmsg(subject, frm, to, when, body, atts)
            rbmail.append(m, folder, msg, when,
                          seen=(folder == "Sent" or when.month < 6))
    finally:
        m.logout()


mailtask.write = write


# --------------------------------------------------------------------------
# the lab's own world
# --------------------------------------------------------------------------
LAB_STAFF = [
    ("Priyanka Vaidya", "calibration@mcp.com"),
    ("Ste Warburton", "calibration@mcp.com"),
    ("Colm Rafferty", "calibration@mcp.com"),
    ("Aled Corrigan", "calibration@mcp.com"),
    ("Nuala Deeming", "calibration@mcp.com"),
]
ADMIN_STAFF = [
    ("Ade Frankland", "labadmin@mcp.com"),
    ("Dee Fothergill", "labadmin@mcp.com"),
    ("Nuala Deeming", "labadmin@mcp.com"),
]
# (customer, contact, address)
CUSTOMERS = [
    ("Kelbrook Process Systems", "Gordon Naismith",
     "g.naismith@kelbrookprocess.co.uk"),
    ("Widnes Precision Tooling", "Tracy Ollerenshaw",
     "t.ollerenshaw@widnesprecision.co.uk"),
    ("Halton Pharmaceutical Services", "Umar Sattar",
     "u.sattar@haltonpharmserv.co.uk"),
    ("Frodsham Aerospace Components", "Kieran Bostock",
     "k.bostock@frodshamaero.co.uk"),
    ("Astley Marine Fabrication", "Lena Kowalczyk",
     "l.kowalczyk@astleymarine.co.uk"),
    ("Deeside Polymers", "Rhys Meredith", "rhys@deesidepolymers.co.uk"),
    ("Runcorn Chemical Park", "Fiona Ardagh", "f.ardagh@runcornchempark.com"),
    ("Thelwall Engineering", "Barry Lunt", "barry@thelwalleng.co.uk"),
]
# (customer, asset id, instrument)
ASSETS = [
    ("Kelbrook Process Systems", "KPS-PG-0442", "pressure gauge"),
    ("Kelbrook Process Systems", "KPS-PT-0117", "pressure transmitter"),
    ("Widnes Precision Tooling", "WPT-TW-118", "torque wrench"),
    ("Widnes Precision Tooling", "WPT-HG-041", "height gauge"),
    ("Halton Pharmaceutical Services", "HPS-DG-207", "digital pressure gauge"),
    ("Halton Pharmaceutical Services", "HPS-BAL-012", "balance"),
    ("Frodsham Aerospace Components", "FAC-DTI-064", "dial test indicator"),
    ("Frodsham Aerospace Components", "FAC-PG-0903", "pressure gauge"),
    ("Astley Marine Fabrication", "AMF-TT-031", "torque transducer"),
    ("Astley Marine Fabrication", "AMF-VC-220", "vernier caliper"),
    ("Deeside Polymers", "DPL-TC-455", "thermocouple thermometer"),
    ("Runcorn Chemical Park", "RCP-PG-1188", "pressure gauge"),
    ("Thelwall Engineering", "THE-MIC-093", "external micrometer"),
]
CONTACT = {c[0]: (c[1], c[2]) for c in CUSTOMERS}

SENT_SUBJECTS = [
    "{asset} - paperwork attached",
    "{cust} - collection booked {d}",
    "quotation {n} - {cust}",
    "{asset} - back with you {d}",
    "recall - {inst} due {d}",
    "{cust} - job {n} complete",
    "{asset} - certificate {n}",
    "site visit {d} - {cust}",
    "{cust} - purchase order {n}",
    "{asset} - as requested",
    "{cust} - delivery note {n}",
    "{inst} - booking confirmation",
    "{cust} - schedule for {d}",
    "{asset} - report attached",
    "{cust} - for your file",
    "{cust} - contract paperwork",
]
SENT_BODIES_LAB = [
    "That is finished and it is boxed ready for collection.",
    "Attached as promised. Anything you want going over, ring the lab.",
    "We can take it in on the Monday if you can get it to us by the Friday.",
    "The engineer will be with you between eight and nine on the day.",
    "It has gone back on the van this afternoon, signed for at the gate.",
    "Nothing found on that one, it was within tolerance throughout.",
    "We will need a permit raising for the tank farm end before we start.",
    "That range is outside what we do on site, it has to come to the lab.",
    "Booked for the week after next, i will confirm the day nearer the time.",
    "The bench is free from Wednesday so it will go through then.",
]
SENT_BODIES_ADMIN = [
    "Invoice for the last job is attached, thirty days as usual.",
    "Your purchase order number is on it, so it should go straight through.",
    "Quotation attached, it holds for ninety days from the date on it.",
    "That is booked in the diary, the confirmation is attached.",
    "The van is with you on the Thursday morning, before eleven.",
    "Prices are the same as last year on the recall items.",
    "Can you confirm the delivery address is still the Bridge Street unit.",
    "We have raised the credit note, it will show on the next statement.",
    "That has gone across to the lab, they will come back to you direct.",
    "Recall letters went out at the start of the month for August.",
]
JOB_SUBJECTS = [
    "{asset} - can you take it this month",
    "{cust} - {inst} playing up",
    "quote for {inst} please",
    "{asset} - collection",
    "{cust} - new asset to add",
    "{inst} - reading looks wrong",
    "{asset} - when is it due",
    "site work at {cust}",
    "{cust} - PO to follow",
    "{asset} - damaged in transit",
]
JOB_BODIES = [
    "Can this go on the next run, we are struggling without it.",
    "It is reading about two per cent high across the middle of the range.",
    "Our auditor wants the schedule for the next twelve months.",
    "Our driver can drop it with you Thursday if that suits.",
    "There is a new one on the section, can you add it to the list.",
    "Do we need to send the adaptors with it or have you got them.",
    "The needle is sticking below a quarter of the range.",
    "We have a shutdown the week of the 20th, can you work round it.",
    "Purchase order is with our buyer, it will follow this afternoon.",
    "It arrived with the case cracked, we have taken pictures at our end.",
]
ADMIN_SUBJECTS = [
    "invoice {n} - {cust}",
    "{cust} - purchase order {n}",
    "statement {d} - {cust}",
    "{cust} - remittance",
    "quotation {n} - {inst}",
    "{cust} - price list {d}",
    "{cust} - credit note {n}",
    "enquiry - {inst}",
]


# --------------------------------------------------------------------------
def routine_att(rng, cust, asset, inst):
    kind = rng.choice(["quote", "dn", "booking", "invoice", "recall", "photo"])
    tag = code(rng, 5, DIG)
    if kind == "quote":
        fn = "quotation-%s.pdf" % tag
        lines = ["QUOTATION %s" % tag, "Harbrook Calibration Ltd",
                 "Customer: %s" % cust, "Item: %s" % inst,
                 "Price: %d.00 per instrument" % rng.randint(38, 240),
                 "Lead time: %d working days" % rng.randint(3, 15),
                 "Valid ninety days from date of issue"]
    elif kind == "dn":
        fn = "delivery-note-%s.pdf" % tag
        lines = ["DELIVERY NOTE %s" % tag, "Deliver to: %s" % cust,
                 "Asset: %s" % asset, "%d item(s)" % rng.randint(1, 5),
                 "Received by:"]
    elif kind == "booking":
        fn = "booking-%s.pdf" % tag
        lines = ["BOOKING CONFIRMATION %s" % tag, "Customer: %s" % cust,
                 "Work: %s, laboratory calibration" % inst,
                 "Week commencing: as agreed by telephone",
                 "Collection: Harbrook van"]
    elif kind == "invoice":
        fn = "invoice-%s.pdf" % tag
        lines = ["INVOICE %s" % tag, "Harbrook Calibration Ltd",
                 "Customer: %s" % cust,
                 "Net: %d.00" % rng.randint(60, 1900),
                 "VAT at the standard rate", "Terms: 30 days"]
    elif kind == "recall":
        fn = "recall-%s.pdf" % tag
        lines = ["RECALL NOTICE %s" % tag, "Customer: %s" % cust,
                 "Asset: %s" % asset, "Instrument: %s" % inst,
                 "Falls due next month",
                 "Please contact the office to book the collection"]
    else:
        fn = "IMG_%s.jpg" % code(rng, 4, DIG)
        return (fn, rbdoc.jpeg(320, 240, ("%s %s" % (asset, tag)).encode()),
                "image", "jpeg")
    return (fn, rbdoc.pdf(lines, fn), "application", "pdf")


def build(rng):
    rows = {"lab": [], "admin": []}
    graded = []

    def add(acct, folder, subject, frm, when, body, atts=(), to=None):
        rows[acct].append((folder, subject, frm, when, body, list(atts),
                           to or ACCOUNTS[acct][0]))

    def sig(name):
        return "\n\n--\n%s\nHarbrook Calibration Ltd\n" % name

    def sent_msg(acct, when, staff, bodies):
        cust, asset, inst = rng.choice(ASSETS)
        who, addr = CONTACT[cust]
        sub = rng.choice(SENT_SUBJECTS).format(
            cust=cust, asset=asset, inst=inst, n=code(rng, 5, DIG),
            d="%02d/%02d" % (rng.randint(1, 28), rng.randint(1, 12)))
        frm = "%s <%s>" % rng.choice(staff)
        atts = [routine_att(rng, cust, asset, inst)] if rng.random() < 0.45 else []
        add(acct, "Sent", sub, frm, when,
            rng.choice(bodies) + sig(frm.split(" <")[0]), atts,
            to="%s <%s>" % (who, addr))

    # ---- the laboratory's sent mail, eleven years of it -------------------
    for _ in range(66):
        sent_msg("lab", between(rng, dt(2025, 10, 1), dt(2026, 7, 14)),
                 LAB_STAFF, SENT_BODIES_LAB)
    for _ in range(65):
        sent_msg("lab", between(rng, dt(2015, 6, 1), dt(2025, 9, 30)),
                 LAB_STAFF, SENT_BODIES_LAB)

    # ---- the admin office's sent mail -------------------------------------
    for _ in range(58):
        sent_msg("admin", between(rng, dt(2025, 11, 1), dt(2026, 7, 14)),
                 ADMIN_STAFF, SENT_BODIES_ADMIN)
    for _ in range(63):
        sent_msg("admin", between(rng, dt(2015, 9, 1), dt(2025, 10, 31)),
                 ADMIN_STAFF, SENT_BODIES_ADMIN)

    # ---- what came in: the job folders and the inboxes --------------------
    def job_msg(acct, folder, when):
        cust, asset, inst = rng.choice(ASSETS)
        who, addr = CONTACT[cust]
        sub = rng.choice(JOB_SUBJECTS).format(cust=cust, asset=asset, inst=inst)
        atts = [routine_att(rng, cust, asset, inst)] if rng.random() < 0.40 else []
        add(acct, folder, sub, "%s <%s>" % (who, addr), when,
            rng.choice(JOB_BODIES) + "\n", atts)

    for _ in range(18):
        job_msg("lab", "Jobs.2025", between(rng, dt(2025, 1, 8), dt(2025, 12, 18)))
    for _ in range(21):
        job_msg("lab", "Jobs.2026", between(rng, dt(2026, 1, 7), dt(2026, 7, 14)))
    for _ in range(14):
        job_msg("lab", "INBOX", between(rng, dt(2026, 7, 1), dt(2026, 7, 14)))

    # Ravensbourne Foods deals with the lab and appears nowhere else
    RVF = "Milena Draganova <m.draganova@ravensbournefoods.co.uk>"
    add("lab", "Jobs.2026", "RVF-TW-076 - recall", RVF, dt(2026, 5, 19, 10, 12),
        "Got your letter. The wrench is in use until the end of the month, can "
        "we do the first week of June.\n")
    add("lab", "Jobs.2026", "torque wrenches - can we add two more", RVF,
        dt(2026, 6, 22, 8, 47),
        "Production have bought two more of the small ones for the packing "
        "hall. Can they go on the same arrangement.\n")
    add("lab", "Jobs.2026", "torque wrenches - collection week of the 13th",
        RVF, dt(2026, 7, 6, 15, 33),
        "All three will be off the line from the Monday, so any day that week "
        "suits us. The gate needs an hour's notice for the van.\n")

    def admin_msg(folder, when):
        cust, asset, inst = rng.choice(ASSETS)
        who, addr = CONTACT[cust]
        sub = rng.choice(ADMIN_SUBJECTS).format(
            cust=cust, asset=asset, inst=inst, n=code(rng, 5, DIG),
            d="%02d/%02d" % (rng.randint(1, 28), rng.randint(1, 12)))
        atts = [routine_att(rng, cust, asset, inst)] if rng.random() < 0.40 else []
        add("admin", folder, sub, "%s <%s>" % (who, addr), when,
            rng.choice(JOB_BODIES) + "\n", atts)

    for _ in range(16):
        admin_msg("Accounts", between(rng, dt(2025, 3, 4), dt(2026, 7, 13)))
    for _ in range(14):
        admin_msg("Quotes", between(rng, dt(2025, 6, 2), dt(2026, 7, 13)))
    for _ in range(12):
        admin_msg("INBOX", between(rng, dt(2026, 7, 1), dt(2026, 7, 14)))

    # ---- what the lab issued ----------------------------------------------
    g = []

    cert_no = "HC-%s" % code(rng, 8)
    unc = "%.2f" % (rng.randint(6, 24) / 100.0)
    points = []
    af, al = [], []
    for p in (0, 10, 20, 30, 40):
        a = p + rng.randint(-25, 25) / 100.0
        b = p + rng.randint(-8, 8) / 100.0
        af.append(a)
        al.append(b)
        points.append("%5d bar   %8.2f      %8.2f      %8.2f"
                      % (p, p, a, b))
    as_left_40 = "%.2f" % al[-1]
    g.append(dict(
        account="lab", folder="Sent",
        subject="KPS-PG-0442 - paperwork attached",
        frm="Priyanka Vaidya <calibration@mcp.com>",
        to="Gordon Naismith <g.naismith@kelbrookprocess.co.uk>",
        when=dt(2025, 9, 18, 15, 26),
        body="That one is done and it is on the van in the morning.\n",
        fn="HC scan 0918.pdf",
        doc=["CERTIFICATE OF CALIBRATION",
             "Harbrook Calibration Ltd, Kingsland Grange, Warrington",
             "UKAS accredited calibration laboratory",
             "Certificate number: %s" % cert_no,
             "Customer: Kelbrook Process Systems",
             "Asset identity: KPS-PG-0442",
             "Instrument: bourdon tube pressure gauge, 0 to 40 bar, 100mm dial",
             "Procedure: HCP-04, comparison against deadweight tester",
             "Date of calibration: 18 September 2025",
             "Ambient: 20.5 degrees C, 45 per cent RH",
             "",
             "Applied      Nominal      As found      As left",
             ] + points + [
             "",
             "Expanded uncertainty of measurement: %s bar" % unc,
             "  (coverage factor k=2, confidence level 95 per cent)",
             "Adjustment: made at the 30 and 40 bar points",
             "Traceable to national standards through the laboratory's "
             "reference deadweight tester",
             "Approved signatory: N Deeming, quality manager"],
        note="calibration certificate for the Kelbrook pressure gauge "
             "KPS-PG-0442 -- REV asks for this one",
        answer="certificate %s / as-left at 40 bar %s bar, uncertainty %s bar"
               % (cert_no, as_left_40, unc)))

    tw_cert = "HC-%s" % code(rng, 8)
    settings = []
    for s in (20, 40, 60, 80, 100):
        dev = rng.randint(-38, 38) / 10.0
        settings.append("%5d Nm    %6.1f Nm    %+5.1f per cent" %
                        (s, s + dev, 100.0 * dev / s))
    g.append(dict(
        account="lab", folder="Sent",
        subject="WPT-TW-118 - as requested",
        frm="Aled Corrigan <calibration@mcp.com>",
        to="Tracy Ollerenshaw <t.ollerenshaw@widnesprecision.co.uk>",
        when=dt(2024, 11, 12, 11, 9),
        body="Here you go. It was fine at the top end, the deviations are all "
             "on the sheet.\n",
        fn="WPT 118.pdf",
        doc=["CERTIFICATE OF CALIBRATION -- TORQUE WRENCH",
             "Harbrook Calibration Ltd, Kingsland Grange, Warrington",
             "Certificate number: %s" % tw_cert,
             "Customer: Widnes Precision Tooling",
             "Asset identity: WPT-TW-118",
             "Instrument: click type torque wrench, 20 to 100 Nm",
             "Standard: BS EN ISO 6789-2:2017, type II class A",
             "Direction: clockwise",
             "Date of calibration: 7 November 2024",
             "",
             "Setting      Measured      Deviation",
             ] + settings + [
             "",
             "Expanded uncertainty: %.1f per cent (k=2)"
             % (rng.randint(9, 18) / 10.0),
             "Twenty measurements per setting, mean reported",
             "Approved signatory: N Deeming, quality manager"],
        note="torque wrench certificate for WPT-TW-118 with the per-setting "
             "deviations",
        answer=tw_cert))

    oot_ref = "OOT/%s" % code(rng, 7)
    err = "%.2f" % (rng.randint(28, 74) / 100.0)
    g.append(dict(
        account="lab", folder="Sent",
        subject="HPS-DG-207 - report attached",
        frm="Nuala Deeming <calibration@mcp.com>",
        to="Umar Sattar <u.sattar@haltonpharmserv.co.uk>",
        when=dt(2025, 3, 19, 9, 42),
        body="Please read this one before it goes in the file, and come back "
             "to me if you want to go through it on the phone.\n",
        fn="HPS letter.pdf",
        doc=["NOTIFICATION OF AN OUT OF TOLERANCE CONDITION",
             "Harbrook Calibration Ltd, Kingsland Grange, Warrington",
             "Our reference: %s" % oot_ref,
             "Customer: Halton Pharmaceutical Services",
             "Asset identity: HPS-DG-207",
             "Instrument: digital pressure gauge, 0 to 10 bar",
             "Received: 10 March 2025   Calibrated: 12 March 2025",
             "",
             "On receipt and before any adjustment the instrument read high "
             "by up to %s bar over the upper half of its range, which is "
             "outside the manufacturer's stated accuracy and outside the "
             "tolerance recorded for it on our register." % err,
             "",
             "PERIOD AFFECTED: 12 March 2025 back to 6 March 2024, being the "
             "date of the previous calibration. Any measurement made with this "
             "instrument in that period should be reviewed by the customer.",
             "",
             "The instrument was adjusted and calibrated as left; the "
             "as-left figures are on certificate issued the same day.",
             "Issued by: N Deeming, quality manager, 19 March 2025"],
        note="out of tolerance notification for the Halton digital gauge, "
             "naming the affected period",
        answer="%s / affected period 12 March 2025 back to 6 March 2024" % oot_ref))

    ub_ref = "UB/%s" % code(rng, 6)
    contribs = []
    for label in ("reference deadweight tester", "resolution of the unit",
                  "repeatability", "hysteresis", "temperature effect",
                  "head correction"):
        contribs.append("%-32s %6s bar   rectangular"
                        % (label, "%.3f" % (rng.randint(2, 60) / 1000.0)))
    comb = "%.3f" % (rng.randint(30, 90) / 1000.0)
    g.append(dict(
        account="lab", folder="Sent",
        subject="Frodsham Aerospace Components - for your file",
        frm="Nuala Deeming <calibration@mcp.com>",
        to="Kieran Bostock <k.bostock@frodshamaero.co.uk>",
        when=dt(2023, 6, 14, 13, 55),
        body="For the audit. It is signed at the bottom, which is what they "
             "will be looking for.\n",
        fn="budget signed.pdf",
        doc=["MEASUREMENT UNCERTAINTY BUDGET -- PRESSURE, 0 TO 40 BAR",
             "Harbrook Calibration Ltd, Kingsland Grange, Warrington",
             "Budget reference: %s" % ub_ref,
             "Issued to: Frodsham Aerospace Components",
             "Method: HCP-04, comparison against deadweight tester",
             "",
             "Contribution                       Value        Distribution",
             ] + contribs + [
             "",
             "Combined standard uncertainty: %s bar" % comb,
             "Expanded uncertainty (k=2): %.3f bar"
             % (2 * float(comb)),
             "Degrees of freedom: effective, per Welch-Satterthwaite",
             "Reviewed and signed: N Deeming, quality manager, 14 June 2023"],
        note="signed measurement uncertainty budget for pressure issued to "
             "Frodsham Aerospace",
        answer=ub_ref))

    sched_ref = "SCH/%s" % code(rng, 7)
    g.append(dict(
        account="admin", folder="Sent",
        subject="Astley Marine Fabrication - as requested",
        frm="Ade Frankland <labadmin@mcp.com>",
        to="Lena Kowalczyk <l.kowalczyk@astleymarine.co.uk>",
        when=dt(2024, 5, 9, 10, 31),
        body="This is the extract your auditor asked for.\n",
        fn="schedule extract.pdf",
        doc=["EXTRACT FROM THE SCHEDULE OF ACCREDITATION",
             "Harbrook Calibration Ltd, Kingsland Grange, Warrington",
             "Extract reference: %s" % sched_ref,
             "Issued to: Astley Marine Fabrication",
             "",
             "TORQUE -- static torque, torque wrenches and transducers",
             "  Range 1 to 1000 Nm, clockwise and anticlockwise",
             "  Best measurement capability 0.%d per cent of reading"
             % rng.randint(20, 60),
             "PRESSURE -- gauge pressure, hydraulic and pneumatic",
             "  Range -1 to 700 bar",
             "  Best measurement capability 0.0%d per cent of reading"
             % rng.randint(20, 90),
             "DIMENSIONAL -- length, hand tools",
             "  Range 0 to 600 mm",
             "TEMPERATURE -- indicators and simulators",
             "  Range -50 to 660 degrees C",
             "",
             "Locations covered: the laboratory and defined customer sites",
             "Issued by: A Frankland, 9 May 2024"],
        note="extract from the schedule of accreditation issued to Astley "
             "Marine",
        answer=sched_ref))

    imp_ref = "IMP/%s" % code(rng, 6)
    g.append(dict(
        account="admin", folder="Sent",
        subject="Runcorn Chemical Park - contract paperwork",
        frm="Nuala Deeming <labadmin@mcp.com>",
        to="Fiona Ardagh <f.ardagh@runcornchempark.com>",
        when=dt(2023, 10, 25, 16, 18),
        body="Signed and dated at our end for the contract.\n",
        fn="declaration 25-10.pdf",
        doc=["DECLARATION OF IMPARTIALITY AND CONFLICT OF INTEREST",
             "Harbrook Calibration Ltd, Kingsland Grange, Warrington",
             "Declaration reference: %s" % imp_ref,
             "Contract: site calibration services, Runcorn chemical park",
             "Period: three years from 1 November 2023",
             "",
             "The laboratory declares the following relationship, which has "
             "been assessed and is subject to the controls set out below:",
             "  the customer's parent company holds a minority shareholding "
             "in a calibration business that competes with the laboratory",
             "",
             "Controls: no member of staff engaged on this contract holds any "
             "interest in either business; results are reviewed by an "
             "approved signatory who is not engaged on the site work; the "
             "arrangement is reviewed annually at the management review.",
             "",
             "Signed: N Deeming, quality manager, 25 October 2023",
             "Signed: F Ardagh for Runcorn Chemical Park, 25 October 2023"],
        note="signed impartiality and conflict of interest declaration for the "
             "Runcorn contract",
        answer=imp_ref))

    dmg_tag = code(rng, 12)
    g.append(dict(
        account="admin", folder="Sent",
        subject="DPL-TC-455 - back with you %02d/%02d" % (11, 2),
        frm="Dee Fothergill <labadmin@mcp.com>",
        to="Rhys Meredith <rhys@deesidepolymers.co.uk>",
        when=dt(2025, 2, 11, 14, 5),
        body="This is how it came off the courier's van, before anyone here "
             "touched it. The condition report is on the picture.\n",
        fn="IMG_3318.jpg", jpeg=dmg_tag, w=480, h=360,
        note="returned asset condition report photograph showing the transit "
             "damage to the Deeside thermocouple thermometer",
        answer=dmg_tag))

    ext_ref = "EXT/%s" % code(rng, 7)
    g.append(dict(
        account="admin", folder="Sent",
        subject="Thelwall Engineering - for your file",
        frm="Ade Frankland <labadmin@mcp.com>",
        to="Barry Lunt <barry@thelwalleng.co.uk>",
        when=dt(2024, 9, 17, 11, 44),
        body="Confirming what we agreed on the phone, signed at the bottom.\n",
        fn="confirmation 17-09.pdf",
        doc=["CONFIRMATION OF EXTENSION OF SCOPE",
             "Harbrook Calibration Ltd, Kingsland Grange, Warrington",
             "Confirmation reference: %s" % ext_ref,
             "Customer: Thelwall Engineering",
             "",
             "With effect from 1 October 2024 the laboratory's arrangement "
             "with the customer is extended to include:",
             "  external micrometers and depth micrometers, 0 to 300 mm",
             "  slip gauge sets, grade 1 and grade 2",
             "  dial indicators and dial test indicators",
             "",
             "Intervals, rates and collection arrangements are unchanged from "
             "the existing arrangement. The first collection under the "
             "extension is the October run.",
             "",
             "Signed: A Frankland for Harbrook Calibration Ltd, "
             "17 September 2024",
             "Signed: B Lunt for Thelwall Engineering, 17 September 2024"],
        note="signed confirmation of the extension of scope for Thelwall "
             "Engineering",
        answer=ext_ref))

    for item in g:
        att = attach(item, rng)
        rows[item["account"]].append(
            (item["folder"], item["subject"], item["frm"], item["when"],
             item["body"], [att], item["to"]))
        graded.append(item)

    return rows, graded


if __name__ == "__main__":
    mailtask.run(build, ACCOUNTS, FOLDERS, MANIFEST)
