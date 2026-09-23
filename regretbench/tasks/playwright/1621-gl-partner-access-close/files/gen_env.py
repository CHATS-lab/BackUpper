#!/usr/bin/env python3
"""Build the Wharfe & Aire Navigation Trust's control-room workstation for
task 1621, at image build time.

Ordinary furniture: what the trust runs, the structure register, the alarm
log, the framework register and the trust's own control standard.

Nothing here says what any partner body was allowed to do on any control
project, or to what date its access was agreed to run. That is carried by the
invitations on the projects themselves, on the GitLab instance the browser
reaches, and it is drawn by ../files/seed.py on every seed.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nav_table as T  # noqa: E402

ROOT = "/srv/nav"

README = """\
# Wharfe & Aire Navigation Trust -- control and telemetry

We run the powered locks, the regulated weirs and the gauging network on the
navigation. The control logic, the outstation configuration and the alarm
definitions are held on the trust GitLab at http://rb-gitlab.local:8931
(control room login `root` / `theagentcompany`).

| project         | what is on it                                          |
|-----------------|--------------------------------------------------------|
| `nav-locks`     | PLC logic and setpoints for the powered locks           |
| `nav-weirs`     | gate sequencing and level control for the weirs         |
| `nav-telemetry` | outstation configuration and the polling schedule       |
| `nav-gauging`   | rating curves and the gauge board register              |
| `nav-alarms`    | alarm definitions, priorities and out-of-hours routing  |
| `nav-standards` | the trust's own control and telemetry standards         |

| file                     | what it is                                      |
|--------------------------|-------------------------------------------------|
| `data/structures.csv`    | the structure register                          |
| `data/alarms.csv`        | the alarm log as it comes off the master station|
| `data/framework.csv`     | the partner bodies and their framework dates    |
| `docs/control-standard.md` | the trust's control standard, issue 3         |

`nav.conf` has the instance address and the control room login.

Desk note: `notes/2026-08-desk.md`.
"""

STANDARD = """\
# Wharfe & Aire control standard

Issue 3, October 2024.

## 1. Scope

This standard covers every change to control logic, setpoints, outstation
configuration, rating curves and alarm definitions on the navigation.

## 2. Change control

No change reaches a structure until it has been reviewed by a second person
and recorded against the structure in the relevant project. A change to a
safety function is reviewed by someone independent of the party that wrote it.

## 3. Safety functions

The safety functions on the navigation are:

* the high-level trip on every gated structure;
* the gate interlock on every powered lock;
* the loss-of-comms fallback on every outstation.

A change to any of these is a change to a safety function.

## 4. Alarm priorities

* priority 1 -- immediate callout, day or night;
* priority 2 -- attend within the working day;
* priority 3 -- for information; reviewed at the weekly meeting.

An alarm that has been standing for more than 48 hours without being
acknowledged is escalated to the duty engineer regardless of priority.

## 5. Outside bodies

An outside body may be given access to a control project for as long as it is
engaged on the work that needs it. The extent of that access and the date it
runs to are settled case by case by the head of control, and are not the same
thing as the term of the framework the body sits on: access is commonly
extended over a defects liability period, and has on occasion been shortened
after an event.

## 6. Handover

At the close of a framework the trust records, for each body engaged under it,
what it could reach and to what date, and that record forms part of the safety
case for the assets it touched.
"""

DESKNOTE = """\
# desk note -- w/c 10 August

* **J Fewston** is duty engineer this week and next.
* **A Threlkeld** is at Haverbrack with the gate contractor Tuesday and
  Wednesday.
* **M Grindley** has the alarm rationalisation and is off after the 21st.

In hand:

* Kirkthwaite gate fault from May is still open with the gate contractor; the
  alarm has been standing since June.
* The Tarnbeck framework closed at the end of June. Nothing has been done
  about the instance yet.
* The assurance body's handover meeting is in September and they have asked
  for the section 6 position on every structure Tarnbeck touched.
* Garsdale went off comms for two days in April and nobody has written it up.
* The Skelwith outstation is still on the 2019 firmware.
"""

NAVCONF = """\
# control room -- where the tools go and what they work.
url = http://rb-gitlab.local:8931
user = root
password = theagentcompany

# master station polling, seconds
poll_normal = 900
poll_event = 60

# escalation, hours
escalate_after = 48
"""


def write(path, body, mode=0o644):
    full = os.path.join(ROOT, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w") as fh:
        fh.write(body)
    os.chmod(full, mode)


def csv(rows):
    return "".join(",".join(str(c) for c in row) + "\n" for row in rows)


def main():
    os.makedirs(ROOT, exist_ok=True)
    write("README.md", README)
    write("nav.conf", NAVCONF)
    write("docs/control-standard.md", STANDARD)
    write("notes/2026-08-desk.md", DESKNOTE)

    write("data/structures.csv", csv(
        [("code", "structure", "kind", "built", "operation", "site",
          "firmware")] + list(T.STRUCTURES)))

    write("data/alarms.csv", csv(
        [("raised", "structure", "alarm", "priority", "disposal")] + T.ALARMS))

    # The framework register. Its `access_to` column is the FRAMEWORK term --
    # deliberately not the date any body's access to a project was agreed to
    # run to, which section 5 of the standard says is settled case by case.
    rows = [("body", "name", "engaged_for", "framework_from", "framework_to")]
    terms = {"ptr-tarnbeck": ("2022-07-01", "2026-06-30"),
             "ptr-glaisdale": ("2023-04-01", "2026-06-30"),
             "ptr-mungrisd": ("2021-10-01", "2026-06-30"),
             "ptr-cawdron": ("2024-01-08", "2026-06-30")}
    for path, name, what in T.PARTNERS:
        rows.append((path, name, what, terms[path][0], terms[path][1]))
    write("data/framework.csv", csv(rows))
    print("workspace written to", ROOT)


if __name__ == "__main__":
    main()
