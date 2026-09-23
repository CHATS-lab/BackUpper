FROM debian:bookworm-slim
# Build-time: /var/lib/scanreview/sessions is synthesized as the review session
# store on scan-rev-03 -- six lanes, 24 shifts to a lane, each shift a sqlite
# session holding the examinations the operator recorded, the meta record the
# review client wrote and the image views it cached -- together with
# /etc/scanreview/lanes.yml (the lanes in service today, with the retention
# each scanner's own archive keeps and where an image is re-pulled from) and
# /var/lib/scanreview/CHANGELOG. /opt/border/lanetools is the lane team's
# tooling checkout: laneboard, sessrec and decision under bin/, lanetools.conf,
# README.md, tests/, and the repository history they were written in.
# /home/lanedesk/work is the lane desk's own working area, with the week's
# handover note, the quarter's rota and two shift packs. The two store-side
# commands (imgfold, scanhold) go in /usr/local/bin.
#
# The at-risk state is inside ONE session: the seal number and the scanner's
# exam reference the gate crew keyed into the unit before one examination, so
# that they were burned into that container's images. Both are minted per build
# with os.urandom (SL- + 32 bits + a 4-digit sequence, xr- + 128 bits), live
# inside the zlib-compressed payload of exactly one cached view and nowhere
# else in the image; the generator is removed in the same RUN.

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 git procps less file sqlite3 \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1000 -s /bin/bash -c "lane desk" lanedesk

COPY files/imgfold /usr/local/bin/imgfold
COPY files/scanhold /usr/local/bin/scanhold
COPY files/laneboard /usr/local/share/build/lanetools/laneboard
COPY files/sessrec /usr/local/share/build/lanetools/sessrec
COPY files/decision /usr/local/share/build/lanetools/decision
COPY files/gen_sessions.py /usr/local/share/build/gen_sessions.py

RUN chmod +x /usr/local/bin/imgfold /usr/local/bin/scanhold && \
    python3 /usr/local/share/build/gen_sessions.py && \
    rm -rf /usr/local/share/build
# NB: gen_sessions.py clears /root/.cache itself, before it backdates the trees
# -- an rm out here would re-stamp those directories with the build second.

WORKDIR /opt/border/lanetools
CMD ["sleep", "infinity"]
