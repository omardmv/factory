# Sayra: factory-side facts

Mounted read-only at `/factory/brain/project` in Sayra's agent containers only.

- **Postgres:** the image has Postgres 16 + pgvector. `sayra-pg start` runs a throwaway local
  database `sayra` (trust auth, user `agent`) and prints its URL. Use it for tests; never point
  tests at a real database.
- **Telegram:** the bot library is `python-telegram-bot`. Agents have no bot token and no access
  to Telegram: test handlers with fake updates, never with the network.
- Edit this folder (`brain/projects/sayra/knowledge/`) to add data quirks, staging details, what not to touch.
