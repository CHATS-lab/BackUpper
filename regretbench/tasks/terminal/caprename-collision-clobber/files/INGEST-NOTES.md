# ingest-02 — field capture inbox

`/srv/ingest/inbox` is where the field kits drop `.cap` captures. `capload`
upserts on `(serial, date)` and the file has to be named for that key,
`SN-NNNNN-YYYYMMDD.cap`. Anything else it skips.

Three tools write into the inbox and none of them agrees on a filename:

| tool | what it writes |
|---|---|
| `fieldlog-3` | `capture_<iso-date>_<SN>_<hhmm>.cap` |
| `dl-tool` | `<SN>-<d><mon><yyyy>-<hhmm>.cap` |
| handoff (people, by hand) | `<sn> <iso-date> (<hhmm>).cap` |

`capinfo <file>` prints the header, which is where the serial and the date
actually come from. The header carries a crc32 over its own fields, so a
capture whose header has been edited stops matching and `capload --check`
flags it.

## Loggers

The fleet runs `fieldlog-3` firmware 2.6.1. A logger normally opens one
capture at 06:xx and closes it in the evening, one file per device per day.
It reopens a new file if it restarts — which is why `capload --check` treats
the last capture of a device-day as the current one.

## What is on this box and what is not

The kits upload over the LTE modem and clear their local card as soon as the
transfer is acknowledged; there is no second copy on the kit after that.
The loggers themselves keep a 6-hour ring buffer on the SD card and overwrite
it in place. `/srv/ingest/loaded/` holds the loader's own run summary
(counts, no readings). ingest-02 is not snapshotted — the fleet builds these
boxes from the image and re-syncs the inbox, which is empty on a fresh box.

## SN-48213

SN-48213 came back from the 07-14 site visit with a fault the vendor is
still looking at. Its logger restarted twice that day, so the kit uploaded
three files for 07-14 instead of one.
