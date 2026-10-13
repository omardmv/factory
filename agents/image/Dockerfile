# One factory agent's workspace: Claude Code headless plus what ContentCoach's
# local test stack needs (Node, Python + uv, Postgres 16 + pgvector, Chromium
# via the Playwright base). Runs as the unprivileged user `agent`.
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

# the playwright image ships user pwuser (uid 1000); give it our name
RUN usermod -l agent -d /home/agent -m pwuser && groupmod -n agent pwuser \
 && install -d -o agent -g agent /workspace /home/agent/.claude
COPY agent-entry.sh /usr/local/bin/agent-entry
USER agent
WORKDIR /workspace
ENV IS_SANDBOX=1 PATH=/usr/lib/postgresql/16/bin:$PATH
ENTRYPOINT ["agent-entry"]
