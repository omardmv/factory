# Factory v2: design spec

Status: updated 2026-11-08 (night) to match the code. Each section says what is
built (with file pointers) and, under "Not built", what is still only a plan.
Builds on README "Agents": brief -> run -> checks -> independent QA ->
review panel -> auto-merge into the project's base branch. Production stays
a manual merge by the founder, always.

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
- **Naming standard** (founder 2026-11-08): every message is classified once
  (`/classify`, a haiku one-shot) into a project, a **type** (feature, fix,
  hotfix, refactor, perf, design, test, docs, ci, chore, research, epic) and a
  3-6 word **title**. Channels the bot makes are `<type>-<title>`, renamed
  `pr-<N>-<type>-<title>` when the PR opens; epics are `epic-<title>`. A
  channel the founder made keeps its name. PR titles are conventional commits,
  `type(scope): summary`. A message classified `epic` starts an epic, with no
  `epic:` prefix needed.
- **Images both ways:** images attached in Slack are saved in the task's
  workspace and named in the message (`agents/attachments.mjs`, needs
  `files:read`); after each agent, coordinator or QA turn, its new screenshots
  and videos are posted under its message (needs `files:write`). Factory
  messages are shown whole in Slack (stall lists, stuck-doctor diagnoses).
- Telegram stays until Slack has run a week without a miss, then goes.

## 2. Research stage

Droids are the agent roles (researcher, implementer, QA, reviewers), all
Claude Code sessions; no second engine. The path after the research is the
existing one: checks -> QA -> review panel -> merge.

Not built: a draft PR opened at once for every idea as the hub, and
`docs/specs/<task>.md` committed by the researcher. As built, the research
runs as its own task inside an epic (below), and a task without an epic
starts straight at its brief.

### The research step (built)

- A task is researched first when the coordinator marks it `"research": true` in the plan, or, with no mark, when its text matches the rule in `agents/plan.mjs` (a new dependency, a data model, a public interface, or an unclear approach). The words "no research" in the task, or `"research": false`, skip it.
- `parsePlan` adds a task `<key>-research` (type `research`) and makes the task depend on it, so the implementation starts only when the research PR is **merged**.
- The researcher (prompt: `brain/prompts/research.md`) writes `docs/research/<key>.md` and opens it as a docs-only PR: no code, no checks, QA or review panel.
- The researcher is told to write the document and open the PR; `agents/lifecycle.mjs` (`afterAgentRun`) sends a research task to `research review` instead of checks, QA or the panel.
- The task then rests in the status `research review`, with the reason "your comments on the research PR, then your merge of it". The person comments on the PR (replies to the researcher in the task chat update the document), then merges it.
- The implementation task is given the document path and the research PR number, with the commands to read the person's comments (`researchHandoff` in `agents/lifecycle.mjs`), and says under "Decisions" where it departs from the document.
- The approval step is the merge: the founder is asked nothing else, unless the research ends with a `DECISION NEEDED` block.
- **On auto-go (the default, below)** there is no hand merge: a research PR goes through checks, QA and the review panel and merges like any other PR (`afterAgentRun` gets `autoGo`). The `research review` park above applies only with auto-go off.
- Tests: `agents/test-plan.mjs` (rule, mark, "no research", blocked until merged) and `agents/test-lifecycle.mjs` (the new state).

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
- **Per project, switched on by the founder.** Stored per project in the box
  config (`/opt/factory/agents/projects.json`): `loops: { security: "weekly", docs: "monthly" }`.
- **Set from Slack:** a panel with a dropdown per loop (off, daily, weekly,
  every 2 weeks, monthly) and **Recommended** / **All off** buttons; a choice
  saves at once through `POST /projects/:name/loops` (validated by
  `normalizeLoops`, written atomically with a `.bak`, live without a restart;
  no other config key is writable this way). The reminder for a project with
  no loops arrives as this panel; `/factory loops [project]` shows it any time.
  Cadences: `daily`, `weekly`, `biweekly`, `monthly`; `true` means weekly.
  `loops: false` (or `{}`) is an explicit off.
- **Scheduler** (decisions in `agents/loops.mjs`, tested by `agents/test-loops.mjs`; `loopsTick` in `server.mjs`'s poll): a kind is
  due when its cadence has passed since it last started (never run = due).
  A due loop starts a normal pre-approved task marked `loop: <kind>`: it
  makes one small, proven change as a PR and goes through review, QA and the
  evidence report like any task. Nothing merges outside review. Bigger
  findings go in the PR body as a question for the person.
- **Cap:** at most one open loop task (one open loop PR) per project. A due
  loop waits while one is open; at most one loop starts per tick, the most
  overdue first. A loop task stops holding the cap when its PR is merged or
  closed (the scheduler refreshes the PR state, so a hand merge counts), when
  it ends `done` (a loop that finds nothing opens no PR and finishes cleanly),
  or when the person stops it. A loop parked on a question holds the cap until
  answered or stopped.
- **Unset vs off:** a project with no `loops` key gets a Slack DM reminder
  (the agents service queues it at `/notices`; the Slack bot posts and
  acknowledges it), at most once a week. An explicit off is never reminded.
  Later the factory may propose a cadence from what the loops find
  (founder approves).
- **State** lives under the agents state dir in `loops.json`: per project
  `lastStarted` per kind and `lastReminder`, plus unsent notices.
- Not built yet: the daily spend cap per project for loop work; past it,
  loops would wait.

## 5. Learning from its own tasks

Not built: this whole section is still a plan (no retro session, no metrics
file, no replay benchmark).

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

## 5a. Access: a remote factory MCP (built)

Needed so the factory works from Claude anywhere, cloud sessions included
(founder 2026-11-07): a cloud session or claude.ai has no ssh, no
`bin/factory` and no reach into the box's loopback.

- `agents/mcp.mjs` is a remote MCP server (streamable HTTP, stateless JSON
  replies, protocol `2025-03-26`), mounted by `agents/server.mjs` at `/mcp`
  on the agents API. Tested by `agents/test-mcp.mjs`, including the client
  handshake.
- Tools: `list_tasks`, `get_task` (status, PR, last messages), `list_projects`,
  `start_task`, `start_epic`, `reply_to_task`. Three are read-only.
- Auth: the same API token as the rest of the agents API, as a bearer token
  (no header: 401; wrong token: 403). No OAuth. Each `tools/call` is written to
  the audit log (tool name and outcome).
- Adds no new powers: no merge, no stop, no pause, no gate changes, no
  secrets. Output passes an allow-list in code (`TASK_FIELDS`, `PR_FIELDS`, …)
  and free text is scrubbed of token-shaped strings, so a task's tokens, env
  and GitHub App key paths can never be listed.
- Limits: POST only, one message per request (batches refused), body up to
  256 KB, 120 calls per minute per process (429 past that).
- Not built: pause and stop tools, OAuth, and a public route. This repo
  has no gateway or Cloudflare route for `/mcp`; reaching it from outside
  the box is box configuration.

## 5b. One factory, many projects

The factory is general; a project brings what is special about it. **The
factory repo names no project but itself** (founder 2026-11-08, `AGENTS.md`):
which projects it serves is box configuration (`/opt/factory/agents/projects.json`,
shape in `agents/projects.example.json`), read through `GET /projects` by the
Slack and Telegram bots and the dashboard. Examples use a made-up `shop`.

| Layer | Lives in | Example |
| --- | --- | --- |
| How every agent works | `brain/` (factory repo) | playbooks, review, QA, security |
| How this project's previews run | `projects/<name>/` (factory repo) + `preview.compose.yaml` (project repo) | Postgres + pgvector, Redis, a Node or Python app, its snapshot and disarm |
| What the factory does for it | `agents/projects.json` (on the box) | base branch, QA on/off, auto-merge target, loops |
| How to work in its code | the project repo: `AGENTS.md`, `.claude/skills/` | its test commands, conventions, verification skill |
| What its agents need installed | `<PROJECTS_DIR>/<name>/agent.Dockerfile` on the box, `FROM factory-agent:latest` | Postgres 16 + pgvector for a project that needs it; Go, Rust or nothing extra for others |
| Factory-side facts about it | `<PROJECTS_DIR>/<name>/knowledge/` on the box, mounted only into that project's containers | its data quirks, its staging, what not to touch |

As built (`agents/launch.mjs`, tested by `agents/test-launch.mjs`):

- The general image is `factory-agent` (`agents/image`). A project may name its
  own in `projects.json` as `"image"`. It lives on the box, not in this repo:
  `<PROJECTS_DIR>/<name>/agent.Dockerfile` (`FROM factory-agent:latest`, default
  dir `/opt/factory/projects`), and `factory-box self-update` builds it as
  `factory-agent-<name>:latest` when its content hash changed or the image is
  missing. The general image is not rebuilt by self-update.
- `<PROJECTS_DIR>/<name>/knowledge/` is mounted read-only at
  `/factory/brain/project` in that project's containers only.
- Unset, unknown or malformed settings fall back to the default image and no
  mount. `brain/projects/_example/` is a made-up template.

Not done: slimming the general image. It still carries Postgres, pgvector
and Python + uv from the factory's first project; they move into that
project's own image later. Onboarding stays `factory init`.

## 5c. The quality bar

`brain/knowledge/quality.md` (founder 2026-11-07): good API design,
architecture and refactoring; static analysis (lint, types, compile) on
every push; e2e tests only, no unit tests; empirical verification (e2e on
the preview, QA) and formal verification where a bug is costly; the
project's rules, skills and AGENTS.md; then human review on staging.

## 5d. Epics and waves

A big goal becomes an **epic** (today's "program"): a coordinator agent that
plans and tracks, never codes. Founder 2026-11-08.

- **Talk first, only with auto-go off** (done). On auto-go (the default) an
  epic skips the discussion: the coordinator plans at once and a valid plan
  with no `DECISION NEEDED` starts by itself. With auto-go off, a new epic starts in a discussion (`phase: talk`):
  you and the coordinator talk through what to build and how to improve it;
  it reads the code, proposes options and trade-offs, and is told not to
  write a plan block or change files. It writes the plan only when you write
  `plan` (also `plan it`, `plan:`, `make the plan`; not "Plan B looks
  better") or press **Plan it** in Slack, which sends the same word. A bare
  `go` in the discussion gets "there is no plan yet". After `plan` the
  coordinator writes the whole plan, you can still reply to revise it, and
  `go` (the **Go** button in Slack) approves it and starts the work.
- **The whole plan up front:** every task, each one PR an agent can finish
  and prove alone, with what it **depends on**. Waves are just the result:
  wave 1 = no dependencies, wave 2 = depends only on wave 1, and so on.
- **No two parallel tasks on one file** (`fileOverlap` in `agents/plan.mjs`):
  each task lists the `files` it edits, and a plan where two tasks share a file
  and neither depends on the other (directly or through a chain) is refused with
  the reason, so the coordinator fixes it before anything starts.
- **A task starts as soon as everything it depends on has merged**, not when
  the whole previous wave has. That means the whole dependency chain, not only
  the direct dependencies (`agents/plan.mjs`, `ready`); a task behind a failed one is blocked, not waiting. Unrelated work never waits. After each merge
  the coordinator may revise the rest from what actually landed.
- **On GitHub** (done): when you approve the plan (`go`), the factory opens
  one epic issue in the project repo (goal, progress `M/T tasks merged`,
  waves, build order, a table of each task's dependencies, wave and state)
  and one sub-issue per planned task, in plan order, linked to the epic. A
  started task is told to put `Refs #<sub-issue>` in its PR, and the
  sub-issue is closed when that PR merges, so the epic shows progress
  (13/15). No tasks start until the issues are opened; if GitHub fails the
  epic carries on without them and says so. The epic issue is kept in step:
  a revised plan adds sub-issues for new tasks and closes dropped ones as
  not planned, a failed task's sub-issue is closed as not planned, and the
  epic issue is closed on `PROGRAM DONE`. It is updated only when something
  changed.
- **In Slack** (done): the epic gets its own channel named `epic-<title>`
  where the discussion happens (with the Plan it button) and the plan gets a
  Go button. Once the plan is approved the bot posts a plan summary (tasks
  by wave, link to the epic issue) once, and keeps the channel topic at
  `M/T merged` plus the epic issue link. The factory's reports (task merged,
  wave done, stuck) arrive in the same channel; each task keeps its own
  channel. The epic's channel is archived when the epic is done or stopped.
- **Reports in the epic's conversation:** `[factory] merged: <task> (PR link). M/T`
  when a task merges, and `[factory] wave N done: <tasks with PR links>. M/T
  merged; next: ...` when every task of a wave has merged. Each is said once
  (remembered on the epic as `mergedAnnounced` / `wavesAnnounced`, a wave by its
  task keys), also across restarts. A wave that gains a task through a
  revised plan is announced again once that new task merges (it is new work).
- **Parallel without jams:** up to 5 agents at once by default (the box fits
  6-8 at 4 CPU / 8 GB each; the Claude plan's usage is the real limit). When
  a parallel PR no longer merges cleanly into staging, the factory sends it
  back to its agent: merge staging into the branch, resolve, re-run the
  checks; then it is reviewed and merged again. At most 3 such rounds, then
  it waits for the founder.
- **The coordinator sees the live epic** (`epicStatus` in `server.mjs`): every
  reply the person sends to a running epic carries, for each task, its state,
  task status, PR, what it waits on, what blocks it, and a stuck task's last
  message, so "why is it stuck?" gets a real answer instead of a guess.
- **Coordinator turns** are decided by `afterCoordinator` in `agents/lifecycle.mjs`:
  a `DECISION NEEDED` reply parks the epic, `PROGRAM DONE` closes it, a reply
  in `talk` or `brief` waits for the person's `plan` or `go`, and a ```plan block
  in a running epic revises the plan.

Build order (all four done): (1) conflicts back to the agent + more agents
at once; (2) task-level dependencies; (3) the epic issue and sub-issues; (4)
discussion mode and the epic channel.

## 5e. Reliability: no silent stalls (built)

From the stalls of 2026-11-07. Rule: a task never stops moving without the
person being told what it waits on. Every decision below is a pure module with
its own test; `agents/server.mjs` only wires them (see `AGENTS.md`).

- **Task lifecycle** (`agents/lifecycle.mjs`, `agents/test-lifecycle.mjs`):
  what happens after each agent run (`afterAgentRun`), QA verdict (`afterQa`),
  review panel (`afterReview`, `panelVerdict`), check report (`afterFactoryReport`)
  and coordinator reply (`afterCoordinator`), and what a job found on disk after
  a restart does (`pickupJob`). Failed rounds (red e2e, QA FAIL, review CHANGES)
  stop at 6 (`MAX_FACTORY_ROUNDS`, an env var read in `server.mjs`). Covered stalls: an answer to review findings
  with no new commit goes back to the panel (a CHANGES verdict counts toward the
  limit, so it is bounded); a turn that dies without a reply is retried up to 2
  times (`MAX_CRASH_RETRIES`, also env) with a prompt that warns against killing processes
  by name; a restart keeps a job's origin, so a review fix stays a review fix;
  a run turn that ends with no PR and no question is nudged up to 2 times
  (`MAX_NO_PR_NUDGES`) before it parks. An improvement-loop task that finds
  nothing finishes `done`.
- **`waitingOn`**: every parked status (`waiting for you`, `decision needed`,
  `ready for you`, `paused`, `waiting for merges`, `research review`) carries a
  one-line reason. `parkReason` in `agents/lifecycle.mjs` fills a default, and
  `save()` in `server.mjs` always fills it in for a parked task (the given reason, else the default), so no parked task is saved without one. Slack, the dashboard
  and the MCP show it.
- **Unasked questions** (`agents/unasked.mjs`, `agents/test-unasked.mjs`): after a
  turn that has no `DECISION NEEDED` block, one cheap model call (60 s) asks
  whether the reply still asks the person to decide something. If so the factory
  posts it as a `DECISION NEEDED` message and the task parks as `decision needed`.
  It fails open: an error, timeout or unreadable answer means no question.
- **Stall watchdog** (`agents/watchdog.mjs`, `agents/test-watchdog.mjs`): checked
  every 60 s. A task in `queued` (5 min), `working`, `briefing`, `planning`,
  `reviewing`, `waiting for checks` (30 min) or `testing` (40 min) with no sign of
  life (status change or a write to its activity log) gets one automatic nudge
  and a `[factory]` message. If it has not moved 5 min later, a `[factory] STUCK`
  message says what is stuck and why; the Slack bot posts it as a ping to the
  owner. After that, silence until the task changes state. A task waiting for a
  free slot is not stalled.
- **Stuck doctor** (`agents/doctor.mjs`, `agents/test-doctor.mjs`): when a task
  gives up (a `your call: …` park) or the watchdog escalates, one model call
  (`DOCTOR_MODEL`, default `sonnet`) reads its history and posts the cause, evidence,
  fix and who must act, once per stall. It diagnoses only.
- **Restart without interrupting** (`agents/drain.mjs`, `agents/test-drain.mjs`,
  `agents/factory-agents.service`): on SIGTERM the server starts no new job and
  finishes the running turns, then exits. The limit is 30 min
  (`DRAIN_TIMEOUT_S`); past it the remaining turns are cut off and listed in
  `drain.json`, and the next start re-queues them from their saved session and
  tells the task. The unit has `KillMode=process` and `TimeoutStopSec=1900`, so
  a deploy never kills the agents' containers. `factory-box self-update` installs
  the unit whenever it differs, and restarts with `--no-block`.
- **Panels see the evidence** (`agents/evidence.mjs`, `agents/test-evidence.mjs`):
  the review and QA prompts get the last 10 PR comments written by bots (the agent
  and the factory; text only, images and videos stripped, 3000 characters each),
  the agent's reply to the last review or QA findings, and the agent's
  expectation → proof mapping next to the media files that really exist.
- **Evidence report** (`agents/report.mjs`, `agents/test-report.mjs`): one comment
  per PR, edited in place, replaces the old media comment. It is posted when the
  panel passes or the round limit stops the loop. The factory writes every fact
  (head sha, check result on that head, open findings, files); the agent supplies
  only a fenced `evidence` block of `<expected result> | video|screenshot|test <ref>|not shown`
  lines. A video or screenshot the factory cannot find shows as "not shown".
- **Required checks** (`requiredChecks` in `agents/merge.mjs`, `agents/test-merge.mjs`):
  a project may list `requiredChecks`; the factory itself holds the auto-merge
  until they pass on the reviewed head (free private repos have no branch
  protection). A failing one goes back to the agent (3 rounds), a pending one is
  waited on (45 min), then the task parks with the reason.
- **Slack extras**: images the person attaches are saved in the task workspace
  and named in the message (`agents/attachments.mjs`); after a turn, new
  screenshots and videos are posted under its message in the task channel.

## 5f. Auto-go: nobody waits for a Go (built)

Founder 2026-11-08: "why other tasks doesn't automatically run, why waiting
for my thing, just tell it to go". Default on; a project opts out with
`"autoGo": false`, the whole factory with `AUTO_GO=0`.

- A task's brief is accepted by itself when it has no `DECISION NEEDED` and no
  question caught by the unasked check: the factory says "▶️ auto-go" and starts
  the run, telling the agent to settle its own open questions and log them.
- An epic plans at once and a valid plan starts by itself.
- Agents and coordinators are told: state assumptions, don't ask; stop only for
  a real architecture, design-taste, money or security call that is expensive
  to undo, or for something only the person can do (a permission, an account,
  a secret).
- The unasked check follows the same rule on auto-go: a question the agent
  answers with its own suggestion is its decision, not a stop.

## 5g. Never block on the founder (built)

**Why.** An audit of every task on 2026-11-07/08 found 19 stops. 9 were an
agent asking the founder something mid-run (median wait 22 min, longest 68,
because nobody was there to answer), and 6 "epic is stuck" notices were their
knock-on effect. Of the 9, only one truly needed the founder (rotate leaked
secrets); the rest were product defaults the agent had already suggested
(chat-list scope, icon sizes), engineering trade-offs it should own (a
duplicate reminder, a symlink mount), and one misunderstood answer ("2").

**Prior art.** Lauren Tan (poteto, Cursor) in pstack
(`github.com/cursor/plugins`, `principle-never-block-on-the-human`,
`poteto-mode`): proceed, then present; classify every question before asking;
a fact a run can observe is answered by a throwaway probe, never by the human;
only a product or preference call no experiment can settle is the human's, and
even then the agent goes ahead with a default and logs why; pausing is kept
for irreversible actions. The decision log is how the human audits afterwards.

**The rule.** A task never waits on the founder for anything reversible.

1. **Classify the question** (the unasked check and the agent prompts):
   - *a fact* (does X build, is the API slow, what does the code do) → the
     agent runs a probe and decides; never asked;
   - *a reversible product or engineering call* → the agent takes its
     recommended default, logs it, **keeps going**, and the factory posts a
     non-blocking **"📌 Decided for you"** message: the question, the choice
     taken, the alternatives as buttons. Pressing another option sends it to
     the task as a change (or, after merge, as a follow-up task);
   - *irreversible or only-the-founder* (rotate a secret, grant a permission,
     create an account, spend money, deploy to production, delete data,
     message users) → the only stop: `DECISION NEEDED`, pinged, with the
     stuck doctor behind it.
2. **Questions first for epics** (the founder's idea, without the wait): at
   planning time the coordinator lists the product and preference calls the
   whole epic needs, each with its recommended default, as one message with
   buttons in the epic channel. Work starts at once on the defaults; an answer
   that arrives before a task starts goes into that task's prompt, a later one
   reaches the running task or becomes a follow-up. Every task of the epic gets
   the epic's decisions so far, so no task asks what another already settled.
3. **Answers by number:** a reply like "2" to a question with numbered options
   is expanded to that option's text before it reaches the agent.
4. **Measured:** stops per task and minutes waiting on the founder, in the
   metrics (section 5); the target is zero waits for reversible calls.

Builds on: auto-go (5f), the unasked check, the decision log, the stuck doctor.

As built:
- `agents/unasked.mjs` classifies a question as `fact`, `reversible` (with the
  agent's own pick) or `blocking`; an unknown kind or a reversible one with no
  pick is blocking. On auto-go an explicit `DECISION NEEDED` block is classified
  too. `agentRun` sends a fact back to be found out, takes a reversible call and
  records it on the task (`decisions`), posted as "📌 Decided for you" with a
  Slack button per other option; at most `MAX_AUTO_DECIDED` (3) per task, then a
  question stops as before. A press sends the change to the task, or starts a
  follow-up task when its work already merged.
- Epics: the plan block carries `decisions` (`parseDecisions`, `mergeDecisions`,
  `changeDecision`, `decisionsBrief` in `agents/plan.mjs`). On approval each is
  posted with its default taken and buttons; every sub-task's brief starts with
  the epic's decisions; `POST /tasks/:epic/decisions` changes one: running tasks
  are told, merged ones are flagged to the coordinator for follow-ups, the
  coordinator's live status lists them.
- `expandNumberAnswer`: "2" becomes "2: <option>".
- `brain/prompts/agent.md` and the auto-go prompt carry the three-step
  classification. Not built: the stops-per-task metric (needs section 5).

## 5h. The founder approves every feature (built)

Founder 2026-11-08: "each feature/task should be ready for me to review with e2e
screen recordings, preview for me to test and see, then approval and merge to
staging". A project with `"approval": true` in its box config:

- When a task passes review (and QA and its required checks), the factory does
  not merge. It posts **"✅ Ready for your check"** in the task's channel: the PR
  and its evidence report, the recordings and screenshots (already posted after
  each turn), and the preview link when the project has previews, with an
  **Approve & merge** button. Asked once per reviewed head (`approvalGate` in
  `agents/merge.mjs`).
- Approve (`POST /tasks/:id/approve`, `approveCheck`) merges exactly the head the
  founder was shown; if the PR changed since, the press is refused and the new
  head is asked about after its review. Changes: reply in the channel.
- Inside an epic, a task waiting for approval counts as waiting, not stuck; its
  dependents start after it merges.
- **Previews** (project `"previews": true`): before asking, the factory builds a
  preview of exactly the reviewed commit (`git archive` of it, then
  `factory-box up <project> <PR> <src> <type-title>`), one build at a time, and
  puts its link in the "Ready for your check" message; a failed build still asks,
  with the reason. The preview is removed when the PR merges or closes, or the
  task ends (`previewSweep`). The project's preview config is box config
  (`/opt/factory/projects/<name>/project.sh` + `preview.compose.yaml`): it builds
  the images, copies a disarmed snapshot of staging's database per PR, may give
  each preview its own network (`pre_up`/`post_down`) and prints its own
  sign-in link (`preview_login`). Previews are behind the factory's sign-in at
  `<type-title>-pr<N>.<domain>`.
- **Is it live?** (project `"deployCheck": { "url": ".../version.json", "field":
  "version", "withinMin": 45 }`): after each merge the factory records the merge
  commit and asks staging which version it runs on every poll; when that version
  includes the merge it posts "🌐 Live on staging" in the task's channel. Not live
  within `withinMin` minutes: one "⏳ Not live" ping saying how far behind staging
  is; it keeps checking and says when it lands; it gives up after 24 h
  (`deployState` in `agents/merge.mjs`, `deploySweep`).

## 6. Safety gates (never self-modified)

Any change to these is `DECISION NEEDED` and waits for the founder, even
inside the factory repo:

- review panel, QA, and what counts as a pass
- auto-merge targets, the per-project `approval` switch, and branch
  protection; production is never merged by the factory
- the round limit and spend caps
- the replay benchmark: its tasks and how results are scored
- agent isolation (container limits, network, firewall, runtime)
- secrets, tokens, GitHub App permissions (agent tokens: contents, pull
  requests, issues and workflows write; checks, statuses and actions read;
  workflows write approved by the founder 2026-11-08, CI changes are reviewed
  as security)
- required checks per project (`requiredChecks`, enforced by the factory before
  it merges)
- this section itself

The list is kept in `brain/knowledge/gates.md`. Not built: the factory
refusing to auto-merge a PR that touches those files. Today the panel and the
rule in `AGENTS.md` carry it.

## Order of work

Done: (1) brain mounted into containers; (3) Slack adapter (`slack/`, alongside
Telegram); (4) research step, inside epics; (5) loops per project; (7) remote
factory MCP; (8) per-project agent images and knowledge; and the reliability
work (5e); auto-go (5f); never block on the founder (5g). Not done: (2) the auto-merge refusal for gate files; (4) a
draft PR at once for every idea; (6) retro + metrics, then the replay
benchmark (section 5 is still a plan).
