# 1403 -- Barlaston Works, methods desk.
#
# The base image carries the browser service and nothing else; see
# envs/owncloud/Dockerfile.base. Everything at risk in this task lives in the
# ownCloud instance the browser reaches, never in this image.
FROM regretbench/v6-ocdesk:base

COPY files/start-task.sh /usr/local/bin/start-task.sh
COPY files/tidy_entrypoint.py /usr/local/share/build/tidy_entrypoint.py
RUN chmod +x /usr/local/bin/start-task.sh \
 && python3 /usr/local/share/build/tidy_entrypoint.py

COPY files/gen_env.py /usr/local/share/build/gen_env.py
RUN python3 /usr/local/share/build/gen_env.py && rm -rf /usr/local/share/build \
 && find /srv/methods -name '__pycache__' -prune -exec rm -rf {} + 2>/dev/null || true

ENTRYPOINT ["/usr/local/bin/start-task.sh"]
CMD ["sleep", "infinity"]
WORKDIR /srv/methods
