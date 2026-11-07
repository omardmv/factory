# Sayra's agents: the general factory-agent (Node, Python + uv, Postgres 16 + pgvector, Chromium)
# plus what Sayra's tests need for its Postgres and Telegram bot.
# Built by `factory-box self-update` as factory-agent-sayra:latest; named in agents/projects.json as "image".
FROM factory-agent:latest
USER root
RUN pip3 install -q --break-system-packages "psycopg[binary]" pgvector "python-telegram-bot>=21"
# a throwaway local Postgres with pgvector for tests: `sayra-pg start` -> postgresql://agent@127.0.0.1:5432/sayra
COPY sayra-pg.sh /usr/local/bin/sayra-pg
RUN chmod 755 /usr/local/bin/sayra-pg
USER agent
