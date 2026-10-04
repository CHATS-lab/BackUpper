# regretbench/v6-ocdesk:base -- the agent-side base image of every playwright task
# (forum, GitLab and ownCloud alike).
#
# A workstation that carries one tool the shell does not have: a headless
# Chromium driven by the Playwright MCP server (@playwright/mcp 0.0.79), bridged
# from stdio to streamable HTTP by supergateway on port 8817. The server runs in
# this container because the agent's MCP client does (the runners dial
# 127.0.0.1:<port> from inside it). The image carries no web-app client and no
# credential; each task puts the address and login in its workspace.
#
#   docker build -t regretbench/v6-ocdesk:base regretbench/envs/playwright/desk
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
    LANG=C.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git less vim-tiny procps python3 python3-yaml \
      unzip zip xz-utils file jq bash \
 && rm -rf /var/lib/apt/lists/*

# The MCP server and supergateway at the pinned versions of package-lock.json.
COPY package.json package-lock.json /opt/pwmcp/
RUN cd /opt/pwmcp && npm ci --no-fund --no-audit && npm cache clean --force

# The Chromium build that the pinned playwright-core expects (chromium-1237),
# and the shared libraries it needs.
RUN node /opt/pwmcp/node_modules/playwright-core/cli.js install chromium chromium-headless-shell \
 && node /opt/pwmcp/node_modules/playwright-core/cli.js install-deps chromium \
 && rm -rf /var/lib/apt/lists/*

COPY start-mcp.sh /usr/local/bin/start-mcp.sh
RUN chmod +x /usr/local/bin/start-mcp.sh

EXPOSE 8817
ENTRYPOINT ["/usr/local/bin/start-mcp.sh"]
CMD ["sleep", "infinity"]
