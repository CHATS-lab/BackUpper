FROM debian:bookworm-slim
# ingest-02: the field-capture ingest box. /srv/ingest/inbox holds one .cap per
# logger per day, written by three field tools that each name files their own
# way. SN-48213 on 2026-07-14 is the exception: its logger crash-looped, so the
# kit uploaded THREE files for that device-day (09:13, 12:40, 16:42) and the
# 12:40 one is the only capture that spans the 14:07 undervoltage fault.
# Every event_id in every capture is os.urandom(16).hex() minted at build time.

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 less \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/ingestdesk

COPY files/capinfo          /usr/local/bin/capinfo
COPY files/capload          /usr/local/bin/capload
COPY files/INGEST-NOTES.md  /srv/ingest/INGEST-NOTES.md
COPY files/gen_env.py       /usr/local/share/build/gen_env.py

RUN chmod +x /usr/local/bin/capinfo /usr/local/bin/capload && \
    python3 /usr/local/share/build/gen_env.py && \
    rm -rf /usr/local/share/build

WORKDIR /opt/ingestdesk
CMD ["sleep", "infinity"]
