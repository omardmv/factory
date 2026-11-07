# Factory v2: design spec

Status: draft, 2026-11-07. Builds on what runs today (README "Agents"):
brief -> run -> checks -> independent QA -> review panel -> auto-merge into
staging. Production stays a manual merge by the founder, always.

## Goals

1. Slack is the front door; an idea becomes a PR that holds everything.
2. A research stage writes the spec and plan before any code.
3. One shared brain (skills + knowledge) for every agent, every project.
4. Improvement loops (performance, security, cleanup, docs) per project,
   the factory included.
5. The factory learns from its own tasks and improves its brain.
6. As autonomous as possible; the safety gates never change without the
   founder.

## 1. Slack intake

- Replaces Telegram as the chat adapter (`post()` / `say()` in
  `agents/server.mjs` are the only seam; the Telegram bot is ~270 lines).
  Socket Mode: the box connects out, no public webhook.
- One idea = one Slack channel (founder 2026-11-07): the founder creates it
  and writes the idea, or the factory creates it for an issue or loop
  finding. The channel follows the PR; when the PR is merged or closed the
  factory archives the channel (a bot can archive; deleting needs a
  workspace admin).
- `DECISION NEEDED`, round-limit stops and approvals arrive in the idea's
  channel (the morning summary in one `#factory` channel), with buttons where a reply is a choice.
- Telegram stays until Slack has run a week without a miss, then goes.

## 2. PR first, research stage

- The idea opens a **draft PR** at once (branch `agent/<task>`). The PR is
  the hub: every agent posts there, the Slack thread links it.
- **Researcher** (fresh session, read-only on code, web allowed): reads the
  code and outside sources, commits `docs/specs/<task>.md` to the branch:
  problem, findings with sources, the spec, the implementation plan, the
  definition of done as runnable checks.
- No approval step (founder 2026-11-07): the implementer starts as soon as
  the spec is in. The founder is asked only when the spec touches
  architecture or design, or is a big implementation: then `DECISION
  NEEDED` in the channel, and nothing is built until the answer.
- **Droids** are the agent roles (researcher, implementer, QA, reviewers),
  all Claude Code sessions as today; no second engine.
- Then the existing path: checks -> QA -> review panel -> merge to staging.
  The PR leaves draft when the panel passes.

## 3. The brain

`brain/` in the factory repo:

| Path | What |
| --- | --- |
| `brain/skills/` | factory-wide skills: playbooks, review, QA, security audit, cleanup, docs, factory-browse |
| `brain/knowledge/` | facts: the box, isolation, decisions (ADR-style), lessons learned |
| `brain/metrics.md` | how a task is measured (below) |

- Mounted read-only into every agent container as Claude Code skills;
  `playbooks.md` and the rule strings in `server.mjs` move here.
- A project's own skills (in its repo) win over factory skills.
- **New skills, outside or written by the factory, are proposed by the
  factory as a PR; they land only when the founder approves.**
  Edits to existing skills and knowledge go through the review panel like
  any change, except the safety gates (section 6).

## 4. Improvement loops

- Kinds: performance, security, cleanup / tech debt, docs drift.
- **Per project, switched on by the founder** ("run security weekly on
  contentcoach"). Stored per project in `agents/projects.json`
  (`loops: { security: "weekly", ... }`).
- A project with no loops configured: the factory asks once in its
  channel which loops to run and how often, and asks again if it stays
  unset. Later the factory may propose a cadence from what the loops find
  (founder approves).
- Each run is a report task: findings with evidence. Small, proven fixes
  become `ready-for-agent` and flow through the normal path; anything
  bigger becomes `ready-for-human` with the question.
- A daily spend cap per project for loop work; past it, loops wait.

## 5. Learning from its own tasks

- After each task ends (merged, stopped, or round limit), a **retro**
  session reads the decision log, failed rounds, review CHANGES and QA
  FAILs, and asks: what should an agent have known?
- Output: a PR against `brain/` (missing knowledge, a misleading skill, a
  skipped playbook step), or nothing.
- Measured, not claimed: per task, failed rounds, cost, wall time, QA pass
  on first try. A brain change whose numbers get worse over the next tasks
  is reverted.

## 6. Safety gates (never self-modified)

Any change to these is `DECISION NEEDED` and waits for the founder, even
inside the factory repo:

- review panel, QA, and what counts as a pass
- auto-merge targets and branch protection; production is never merged
  by the factory
- the round limit and spend caps
- agent isolation (container limits, network, firewall, runtime)
- secrets, tokens, GitHub App permissions
- this section itself

Enforced by the factory, not only by prompt: a PR touching the files that
hold these (list kept in `brain/knowledge/gates.md`) is never auto-merged.

## Order of work

1. Brain: move playbooks + rules into `brain/`, mount into containers
   (done in this PR).
2. Safety-gate file list + the auto-merge refusal for it.
3. Slack adapter alongside Telegram.
4. PR-first + researcher stage.
5. Loops per project.
6. Retro + metrics.
