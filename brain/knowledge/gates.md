# Safety gates

These decide what the factory may do without the founder. Any change to
them is a `DECISION NEEDED`: options, trade-offs, recommendation, then wait.
Never loosen one to finish a task.

- the review panel, the QA tester, and what counts as a pass
  (`brain/prompts/review.md`, `brain/prompts/qa.md`, the panel and verdict
  logic in `agents/server.mjs`)
- auto-merge targets and branch protection (`agents/projects.json`
  `autoMerge`); production is never merged by the factory
- the round limit and spend caps
- the replay benchmark: its tasks and how results are scored
- agent isolation: container limits, network, firewall, runtime
  (`agents/server.mjs` `container()`, `agents/image/`, `box/`)
- secrets, tokens, GitHub App permissions
- how new skills are admitted (`brain/README.md`), and which Claude Code
  plugins agents load (`brain/claude/plugins.json`, `agents/image/plugins/`)
- this file

Not yet enforced in code: today the gate is this rule plus the review
panel. Next step: the factory refuses to auto-merge a PR that touches these
files.
