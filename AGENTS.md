# Rules for agents working on the factory itself

This repo is the factory: the agents service, review and QA, the brain, the
Slack and Telegram bots, the dashboard and the box scripts. These rules are
on top of `brain/prompts/agent.md`. Reviewers check them as the repository's
own rules.

- **The factory names no project but itself.** The projects it serves are box
  configuration (`/opt/factory/agents/projects.json`, and per-project files
  under `/opt/factory/projects/<name>/`), never code, docs, tests or examples
  in this repo. Examples use a made-up project (`shop`). Anything
  project-specific a change needs goes in the PR description under "For the
  box", to be installed there by hand.
- **Safety gates** (`brain/knowledge/gates.md`) change only with the founder:
  stop and ask (DECISION NEEDED).
- **Every decision the factory makes about a task lives in a pure, tested
  module** (`agents/lifecycle.mjs`, `merge.mjs`, `plan.mjs`, `watchdog.mjs`,
  `doctor.mjs`, …) with its `agents/test-*.mjs`. `server.mjs` wires them up.
  A fix for a stall or a wrong decision lands there, with a test that fails
  without it.
- **Tests:** run every `node agents/test-*.mjs` and `node slack/test.mjs`
  before you push; all must pass.
