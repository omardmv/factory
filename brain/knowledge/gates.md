# Safety gates

These decide what the factory may do without the founder. Any change to
them is a `DECISION NEEDED`: options, trade-offs, recommendation, then wait.
Never loosen one to finish a task.

- the review panel, the QA tester, and what counts as a pass
  (`brain/prompts/review.md`, `brain/prompts/qa.md`, the panel and verdict
  logic in `agents/server.mjs`)
- auto-merge targets and branch protection (each project's `autoMerge` in the
  box config, `/opt/factory/agents/projects.json`); production is never
  merged by the factory. `approval` (per project): the founder approves each
  feature before the factory merges it. `requiredChecks` (per project, box config): checks that
  must pass on the reviewed head before the factory merges; the factory enforces
  them itself, since private repos on a free plan have no branch protection
- the round limit and spend caps
- the replay benchmark: its tasks and how results are scored
- agent isolation: container limits, network, firewall, runtime
  (`agents/server.mjs` `container()`, `agents/image/`, `box/`)
- secrets, tokens, GitHub App permissions. Agent tokens today: contents,
  pull requests, issues and workflows write; checks, statuses, actions read
  (`TOKEN_PERMISSIONS`). Workflows write was approved by the founder on
  2026-11-08 so agents can change CI; every such change still goes through
  the review panel, which checks it for secret exposure.
- how new skills are admitted (`brain/README.md`), and which Claude Code
  plugins agents load (`brain/claude/plugins.json`, `agents/image/plugins/`)
- this file

Not yet enforced in code: today the gate is this rule plus the review
panel. Next step: the factory refuses to auto-merge a PR that touches these
files.
