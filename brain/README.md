# The factory's brain

What every factory agent knows and how it works, for every project and for
the factory itself. `agents/server.mjs` reads it on every run (a merged
change applies to the next run, no restart) and mounts parts of it
read-only into every agent container.

| Path | What | In the container |
| --- | --- | --- |
| `prompts/agent.md` | the working agent's rules | system prompt |
| `prompts/playbooks.md` | playbooks + decision log | system prompt (agent) |
| `prompts/review.md` | the reviewer's rules | system prompt (review panel) |
| `prompts/qa.md` | the QA tester's rules | system prompt (QA) |
| `knowledge/` | facts: the box, isolation, lessons, the safety gates | `/factory/brain/knowledge` |
| `skills/` | factory-wide Claude Code skills, one folder each | `/home/agent/.claude/skills` |
| `claude/plugins.json` | which of Anthropic's official Claude Code plugins every agent loads (built into the image from `claude-plugins-official`) | `--plugin-dir` per plugin |

`skills/` at the repo root is different: skills for the founder's laptop
(they call `bin/factory`, which agents don't have).

## Changing the brain

- **Knowledge and existing skills**: a PR like any other change; the review
  panel decides and it auto-merges into `main`.
- **A new skill** (written by the factory or taken from outside): the
  factory proposes it as a PR and it lands only when the founder approves.
  Name it so it can't collide with a project's own skill; a project's rules
  and skills win when they disagree.
- **The safety gates** (`knowledge/gates.md`): never changed without the
  founder. `prompts/review.md` and `prompts/qa.md` are gates.

Keep it true: a fact here that turns out wrong gets fixed or deleted, with
the evidence in the PR.
