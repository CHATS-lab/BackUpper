# End-to-end image: Node 20 + git + the packed agents-backupper tarball, installed globally
# exactly as a user would install it. Built by test/e2e/run.sh; not part of the npm package.
FROM node:20-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Opt-in: the real Claude Code CLI, for BACKUPPER_E2E_REAL=1 runs only.
ARG WITH_CLAUDE=0
RUN if [ "$WITH_CLAUDE" = "1" ]; then npm install -g @anthropic-ai/claude-code && npm cache clean --force; fi

COPY agents-backupper.tgz /tmp/agents-backupper.tgz
RUN npm install -g /tmp/agents-backupper.tgz && rm /tmp/agents-backupper.tgz

# The checks and the smoke test run against the globally installed `backupper`.
COPY checks.sh real-agent.sh /e2e/
COPY smoke.mjs /e2e/smoke.mjs
RUN chmod +x /e2e/*.sh \
 && git config --global user.email e2e@example.invalid \
 && git config --global user.name e2e

WORKDIR /work
CMD ["/e2e/checks.sh"]
