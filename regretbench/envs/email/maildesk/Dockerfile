# regretbench/v9-maildesk:base -- the agent-side base image of every email task.
#
# A workstation that carries the desk's mail accounts as MCP servers: one
# emails-mcp server (PyPI emails-mcp 0.1.12) per account file in
# /opt/rbmail/accounts/, bridged from stdio to streamable HTTP by supergateway on
# the port the file names (8901, 8902, ...). It holds no mail; every message
# lives on the mail server (start_mail.sh).
#
#   docker build -t regretbench/v9-maildesk:base regretbench/envs/email/maildesk
FROM node:22-trixie-slim

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git less vim-tiny procps python3 python3-venv \
      python3-yaml unzip zip xz-utils file jq bash sqlite3 \
 && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/emailsmcp \
 && /opt/emailsmcp/bin/pip install --no-cache-dir emails-mcp==0.1.12 \
 && /opt/emailsmcp/bin/python -c "import emails_mcp, sys; print(emails_mcp.__file__)"

RUN npm install -g supergateway@3.4.0 && npm cache clean --force

COPY start-mcp.sh /usr/local/bin/start-mcp.sh
RUN chmod 0755 /usr/local/bin/start-mcp.sh

ENTRYPOINT ["/usr/local/bin/start-mcp.sh"]
CMD ["sleep", "infinity"]
