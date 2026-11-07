# The factory in Slack

One channel per task (`bot.mjs` header has the details). Runs next to the
Telegram bot until Slack has proven itself; both talk to factory-agents.

## Set up (once)

1. api.slack.com/apps -> Create New App -> From a manifest -> pick the
   workspace -> paste `manifest.yaml` -> Create.
2. Basic Information -> App-Level Tokens -> Generate, scope
   `connections:write` -> the `xapp-…` token.
3. Install App -> Install to Workspace -> the Bot User OAuth Token
   (`xoxb-…`).
4. On the box (root):
   ```bash
   install -d -m 750 -g 10010 /opt/factory/slack
   cp /opt/factory/bot/agents-token /opt/factory/slack/agents-token
   printf %s 'xoxb-…' > /opt/factory/slack/slack-bot-token
   printf %s 'xapp-…' > /opt/factory/slack/slack-app-token
   chgrp 10010 /opt/factory/slack/*; chmod 640 /opt/factory/slack/*
   ```
5. A Coolify app in project "factory" from this folder (docker compose,
   `slack/compose.yaml`); add its uuid to `box/coolify/factory-apps`.
6. Pair: the bot logs `{"event":"pairing","code":"…"}`; DM the bot
   `pair <code>`. From then on it answers only you.

## Use

- Create a channel `sayra-<something>` (Sayra), `cc-<something>` (ContentCoach)
  or anything else (the factory)
  and write the idea as its first message.
- Or DM the bot; it makes the channel.
- Archived when the PR is merged or closed. A bot can archive, not delete;
  a workspace admin can delete archived channels if wanted.

Test: `node slack/test.mjs` (fake Slack and fake factory-agents, no network).
