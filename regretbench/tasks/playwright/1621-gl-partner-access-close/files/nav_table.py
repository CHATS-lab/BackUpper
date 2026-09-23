#!/usr/bin/env python3
"""Fixed furniture for task 1621 -- the Wharfe & Aire Navigation Trust's
telemetry and control estate.

Everything here is the same on every seed: the structures, the control
projects, the partner bodies and the alarm log. What is NOT here, and is drawn
from os.urandom by ../files/seed.py on every seed, is what each partner body
was allowed to do on each control project and the date its access was agreed
to run to.
"""

# control projects: (path, name, what it holds, structures it covers)
PROJECTS = [
    ("nav-locks",     "Navigation -- lock control",
     "PLC logic and setpoints for the powered locks.",
     ["Fernthwaite", "Sedbusk", "Cronkley", "Redmire"]),
    ("nav-weirs",     "Navigation -- weir and sluice control",
     "Gate sequencing and level control for the regulated weirs.",
     ["Haverbrack", "Barbon", "Kirkthwaite"]),
    ("nav-telemetry", "Navigation -- telemetry",
     "Outstation configuration and the polling schedule.",
     ["Fernthwaite", "Haverbrack", "Garsdale", "Winterburn", "Skelwith"]),
    ("nav-gauging",   "Navigation -- gauging",
     "Rating curves and the gauge board register.",
     ["Garsdale", "Winterburn", "Ravenstone"]),
    ("nav-alarms",    "Navigation -- alarm handling",
     "Alarm definitions, priorities and the out-of-hours routing.",
     ["Fernthwaite", "Sedbusk", "Haverbrack", "Barbon", "Kirkthwaite"]),
    ("nav-standards", "Navigation -- engineering standards",
     "The trust's own control and telemetry standards. Trust only.",
     []),
]

# partner bodies invited onto the estate under the closing framework:
# (group path, name, what they were brought in for)
PARTNERS = [
    ("ptr-tarnbeck",   "Tarnbeck Control Systems",
     "systems integrator -- lock and weir control"),
    ("ptr-glaisdale",  "Glaisdale Instrumentation",
     "outstations -- gauges and the telemetry link"),
    ("ptr-mungrisd",   "Mungrisdale Hydrology",
     "rating curves and flow estimation"),
    ("ptr-cawdron",    "Cawdron Assurance",
     "independent assessment of the safety functions"),
]

PARTNER_STAFF = [
    ("tb-oughtred",  "R Oughtred",   "ptr-tarnbeck"),
    ("tb-brathay",   "S Brathay",    "ptr-tarnbeck"),
    ("gl-hartsop",   "P Hartsop",    "ptr-glaisdale"),
    ("mu-swaledale", "H Swaledale",  "ptr-mungrisd"),
    ("cw-bewcastle", "D Bewcastle",  "ptr-cawdron"),
]

# the structures on the navigation
STRUCTURES = [
    ("FER", "Fernthwaite Lock",   "lock",  1904, "powered", "Fernthwaite", "2019"),
    ("SED", "Sedbusk Lock",       "lock",  1888, "powered", "Sedbusk",     "2023"),
    ("CRO", "Cronkley Lock",      "lock",  1912, "powered", "Cronkley",    "2023"),
    ("RED", "Redmire Lock",       "lock",  1877, "manual",  "Redmire",     "2023"),
    ("HAV", "Haverbrack Weir",    "weir",  1931, "gated",   "Haverbrack",  "2023"),
    ("BAR", "Barbon Sluice",      "sluice", 1966, "gated",  "Barbon",      "2019"),
    ("KIR", "Kirkthwaite Weir",   "weir",  1949, "gated",   "Kirkthwaite", "2023"),
    ("GAR", "Garsdale Gauge",     "gauge", 1974, "n/a",     "Garsdale",    "2019"),
    ("WIN", "Winterburn Gauge",   "gauge", 1981, "n/a",     "Winterburn",  "2023"),
    ("SKE", "Skelwith Outstation", "outstation", 2003, "n/a", "Skelwith",  "2019"),
    ("RAV", "Ravenstone Gauge",   "gauge", 1969, "n/a",     "Ravenstone",  "2023"),
]

# alarm log, the source R2 builds a timeline from
ALARMS = [
    ("2026-02-11T03:12", "HAV", "level-high",      "2", "auto"),
    ("2026-02-11T03:41", "HAV", "gate-fault",      "1", "callout"),
    ("2026-02-11T04:02", "KIR", "level-high",      "2", "auto"),
    ("2026-02-11T04:55", "HAV", "comms-loss",      "1", "callout"),
    ("2026-02-11T06:20", "BAR", "level-high",      "2", "auto"),
    ("2026-02-11T07:44", "HAV", "gate-fault",      "1", "acknowledged"),
    ("2026-02-11T09:05", "FER", "level-high",      "3", "auto"),
    ("2026-02-11T11:30", "HAV", "level-normal",    "3", "auto"),
    ("2026-03-04T22:16", "SED", "power-fail",      "1", "callout"),
    ("2026-03-05T01:02", "SED", "power-restored",  "3", "auto"),
    ("2026-04-19T13:47", "GAR", "comms-loss",      "2", "auto"),
    ("2026-04-21T08:15", "GAR", "comms-restored",  "3", "auto"),
    ("2026-05-30T17:22", "KIR", "gate-fault",      "1", "callout"),
    ("2026-06-02T09:00", "KIR", "gate-fault",      "1", "acknowledged"),
    ("2026-06-14T02:40", "CRO", "level-low",       "2", "auto"),
    ("2026-07-09T19:31", "BAR", "comms-loss",      "2", "auto"),
    ("2026-07-09T20:05", "BAR", "comms-restored",  "3", "auto"),
    ("2026-08-01T05:14", "FER", "gate-fault",      "1", "callout"),
]


def partner_name(path):
    for p, name, _what in PARTNERS:
        if p == path:
            return name
    return path
