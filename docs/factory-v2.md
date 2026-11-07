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
- Measured, not claimed: every task records failed rounds, cost, wall
  time and whether QA passed on the first try (`task.json`, collected into
  one metrics file the dashboard and the retro read).
- **Replay benchmark** (idea from Warp's "The factory stack"): a small
  suite of past tasks, each frozen as (task text as given, repo, base
  sha, how its result is judged). A proposed change to `brain/`, a prompt,
  a model or the panel runs the suite twice, current vs proposed, in the
  same containers against the same previews; the PR gets a table per task
  (failed rounds, QA first-try, cost, time) and the totals.
- A brain PR merges only when the benchmark is no worse; a change that
  loses goes back to its author with the table. A change to the benchmark
  itself (tasks, scoring) is a safety gate.
- The suite grows from real work: a task that needed the founder, hit the
  round limit or was reverted on staging is a candidate, added by PR.
- Runs cost money: the suite stays small (start with 5 tasks), runs only
  for brain, prompt, model or panel PRs, and counts against the factory's
  daily cap.

## 5a. Access: a remote factory MCP

Needed so the factory works from Claude anywhere, cloud sessions included
(founder 2026-11-07): a cloud session or claude.ai has no ssh, no
`bin/factory` and no reach into the box's loopback, so a remote MCP
server is its only way in.

- A remote MCP server (streamable HTTP) at `factory.contentcoach.org/mcp`,
  in front of the agents API; added once as a custom connector, it is
  then available in the founder's laptop sessions, cloud sessions and
  claude.ai.
- Tools: submit a task to a project, list tasks and their state, read a
  task's messages, PR and preview, reply, pause, stop.
- Auth: OAuth for the founder only (connectors expect it), or a bearer
  token where the client supports one; every call is in the audit trail.
- Adds no new powers: no merge, no gate changes, no secrets; the same
  limits as Slack and the dashboard, which sit on the same API.
- The MCP endpoint is internet-facing, unlike the agents API: rate-limit
  it and keep it behind Cloudflare.

## 5b. One factory, many projects

The factory is general; a project brings what is special about it.

| Layer | Lives in | Example |
| --- | --- | --- |
| How every agent works | `brain/` (factory repo) | playbooks, review, QA, security |
| How this project's previews run | `projects/<name>/` (factory repo) + `preview.compose.yaml` (project repo) | Postgres + pgvector, Redis, a Node or Python app, its snapshot and disarm |
| What the factory does for it | `agents/projects.json` | base branch, QA on/off, auto-merge target, loops |
| How to work in its code | the project repo: `AGENTS.md`, `.claude/skills/` | its test commands, conventions, verification skill |
| What its agents need installed | `projects/<name>/agent.Dockerfile`, `FROM factory-agent-base` | Postgres 16 + pgvector for ContentCoach; Go, Rust or nothing extra for others |
| Factory-side facts about it | `projects/<name>/knowledge/`, mounted only into that project's containers | its data quirks, its staging, what not to touch |

Today the agent image is ContentCoach's (Postgres + pgvector, Python + uv
baked in): it splits into a general `factory-agent-base` and a thin image
per project, built by self-update when its Dockerfile changes. Onboarding
stays `factory init`: a new project fills these in and nothing in the
factory changes.

## 5c. The quality bar

`brain/knowledge/quality.md` (founder 2026-11-07): good API design,
architecture and refactoring; static analysis (lint, types, compile) on
every push; e2e tests only, no unit tests; empirical verification (e2e on
the preview, QA) and formal verification where a bug is costly; the
project's rules, skills and AGENTS.md; then human review on staging.

## 5d. Epics and waves

A big goal becomes an **epic** (today's "program"): a coordinator agent that
plans and tracks, never codes. Founder 2026-11-08.

- **Talk first.** You and the coordinator discuss what to build and how to
  improve it; it reads the code, proposes options and trade-offs. It writes
  the plan only when you say so.
- **The whole plan up front:** every task, each one PR an agent can finish
  and prove alone, with what it **depends on**. Waves are just the result:
  wave 1 = no dependencies, wave 2 = depends only on wave 1, and so on.
- **A task starts as soon as everything it depends on has merged**, not when
  the whole previous wave has. Unrelated work never waits. After each merge
  the coordinator may revise the rest from what actually landed.
- **On GitHub:** an epic issue (goal, waves, build order, tables) with one
  sub-issue per task, in order; a sub-issue closes when its PR merges, so
  the epic shows progress (13/15).
- **In Slack:** a channel for the epic (plan, progress, decisions, each
  wave's results); each task keeps its own channel.
- **Parallel without jams:** up to 5 agents at once by default (the box fits
  6-8 at 4 CPU / 8 GB each; the Claude plan's usage is the real limit). When
  a parallel PR no longer merges cleanly into staging, the factory sends it
  back to its agent: merge staging into the branch, resolve, re-run the
  checks; then it is reviewed and merged again. At most 3 such rounds, then
  it waits for the founder.

Build order: (1) conflicts back to the agent + more agents at once; (2)
task-level dependencies; (3) the epic issue and sub-issues; (4) discussion
mode and the epic channel.

## 6. Safety gates (never self-modified)

Any change to these is `DECISION NEEDED` and waits for the founder, even
inside the factory repo:

- review panel, QA, and what counts as a pass
- auto-merge targets and branch protection; production is never merged
  by the factory
- the round limit and spend caps
- the replay benchmark: its tasks and how results are scored
- agent isolation (container limits, network, firewall, runtime)
- secrets, tokens, GitHub App permissions
- this section itself

Enforced by the factory, not only by prompt: a PR touching the files that
hold these (list kept in `brain/knowledge/gates.md`) is never auto-merged.

## Order of work

1. Brain: move playbooks + rules into `brain/`, mount into containers
   (done in this PR).
2. Safety-gate file list + the auto-merge refusal for it.
3. Slack adapter alongside Telegram (`slack/`).
4. PR-first + researcher stage.
5. Loops per project.
6. Retro + metrics, then the replay benchmark (5).
7. Remote factory MCP for cloud sessions (5a).
8. Per-project agent images and knowledge (5b).
