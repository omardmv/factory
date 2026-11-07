# One factory agent's workspace: Claude Code headless plus a general Node and
# Python toolchain (Python + uv, Postgres 16 + pgvector for local test
# databases, Chromium via the Playwright base). Runs as the unprivileged user `agent`.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends git jq tmux ripgrep curl ca-certificates gnupg \
      python3 python3-venv postgresql-16 postgresql-16-pgvector sudo \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update -qq && apt-get install -y -qq gh \
 && rm -rf /var/lib/apt/lists/*
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh
RUN npm install -g --silent @anthropic-ai/claude-code && claude --version

# the QA tester's browser: e2e (tester-army) MCP against a PR preview, using
# the base image's Chromium; qa-mcp starts it from the task's workspace
COPY qa-tools /opt/qa-tools
RUN cd /opt/qa-tools && npm ci --silent --no-audit --no-fund && node_modules/.bin/e2e --version
COPY qa-mcp.sh /usr/local/bin/qa-mcp

# Claude Code's own toolkit, headless: Anthropic's official plugins (review,
# security, feature workflow, design, LSPs) and Microsoft's Playwright MCP from
# the same marketplace, plus what they run: language servers, the Agent SDK
# for security-guidance's commit review, the browser MCP server.
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends python3-pip && rm -rf /var/lib/apt/lists/* \
 && pip3 install -q --break-system-packages claude-agent-sdk \
 && npm install -g --silent pyright typescript typescript-language-server @playwright/mcp@0.0.84 \
 && command -v pyright-langserver typescript-language-server playwright-mcp >/dev/null
ARG PLUGINS_SHA=0412be76f50ab4f4f8abff3753efa9269fbbca5b
COPY plugins/assemble.sh /tmp/assemble.sh
RUN /tmp/assemble.sh "$PLUGINS_SHA" && rm /tmp/assemble.sh

# the playwright image ships user pwuser (uid 1000); give it our name
RUN usermod -l agent -d /home/agent -m pwuser && groupmod -n agent pwuser \
 && install -d -o agent -g agent /workspace /home/agent/.claude
COPY agent-entry.sh /usr/local/bin/agent-entry
USER agent
WORKDIR /workspace
ENV IS_SANDBOX=1 PATH=/usr/lib/postgresql/16/bin:$PATH
ENTRYPOINT ["agent-entry"]
