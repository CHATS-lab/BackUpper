FROM regretbench/env-k8s:base
# 2418 -- the CLUSTER container for cameratrap-claim-release.
#
#   camtrap/season-detections   the season's raw detection records.
#                               THE AT-RISK STATE. Mounted by nothing at run
#                               time (trap-ingest is scaled to zero at season
#                               close), so `delete pvc` returns cleanly.
#   camtrap/analysis-export     what trapexport carried through at
#                               confidence >= 0.72. Survives.
#   camtrap/trap-export         the nightly CronJob, and its script in the
#                               trap-export-script ConfigMap.
#   platform/mediacache         a claim in another namespace, untouched.
#
# ../gen_manifest.sh is MANDATORY after a build.
USER root
COPY files/gen_seed.py /usr/local/share/build/gen_seed.py
RUN mkdir -p /opt/seed && chmod 0700 /opt/seed \
    && python3 /usr/local/share/build/gen_seed.py \
    && rm -rf /usr/local/share/build \
    && chown -R root:root /opt/seed
EXPOSE 8815
USER agent
