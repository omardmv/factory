# factory

Our own software factory on the VPS, for every project: each pull request
becomes a live preview with its own copy of the data, e2e tests run against
it with a video of every test, and one PR comment carries the link and the
results. Closing the PR deletes everything. CI runs on self-hosted runners
on the same box, so it uses no GitHub minutes.

![architecture](docs/architecture.png)

Design: [docs/spec.md](docs/spec.md).

## Projects

Projects are configured on the box in `/opt/factory/agents/projects.json`
(outside this repo: which projects the factory serves is box configuration,
not code; the bots and the dashboard read it through `GET /projects`).
`agents/projects.example.json` here shows the shape: one entry per
project, keyed by name, with `about`, `repo`, `base`, `autoMerge`,
`mergeMethod`, `githubApp` (`id`, `key`, `bot`) and optional `requiredChecks`
(checks that must pass on a PR's reviewed head before the factory merges it;
the factory enforces them itself, so they work on any GitHub plan), `image`
(the project's own agent image) and `loops` (improvement loops, below). The factory itself is
one project too (`factory`, repo `omardmv/factory`, base `main`): this
repo can name itself.

A project is also a folder in `projects/`: `project.sh` (domain, prefix, repo,
how to build, how to run e2e, where its data comes from), its
`preview.compose.yaml`, and whatever it needs (a disarm script, a login
helper). Everything on the box is named by the prefix: containers
`<prefix>-pr-<N>-*`, databases `<prefix>_pr_<N>`, network `factory-<prefix>`,
files under `/srv/factory/*/<prefix>/`.

## Who does what

- **Coolify** (box/coolify: manual install, loopback-only ports, Traefik on
  127.0.0.1:18080, cleanup off) builds and runs each PR's preview from the
  repo's `preview.compose.yaml`, routes it, deletes it on close, and is the
  dashboard at https://coolify.contentcoach.org.
- **The factory** keeps what Coolify doesn't do: the nightly disarmed snapshot,
  each preview's own data and DB login (the compose's `preview-init`, admin
  login from a root-only file), the e2e run with videos, the PR comment, the
  data cleanup on close, runners, routing, and the agent tools.

## Onboarding a project

```bash
factory init <name> --domain example.org --prefix ex --repo owner/repo --repo-dir ~/code/repo
# fill in projects/<name>/project.sh + preview.compose.yaml
# Cloudflare: proxied "*" record for the domain; origin cert on the box at
#   /etc/ssl/cloudflare/<domain>.pem and .key
factory push               # the box pulls and generates routes within 5 minutes
factory runner <name>      # a self-hosted runner for the repo
# commit .github/workflows/preview.yml in the repo, open a PR: it previews itself
```

## Agents

`agents/server.mjs` (systemd `factory-agents`) runs each task as Claude Code
in its own locked-down container. The ways of working come from Lauren Tan's
pstack: never block on the human, a playbook per kind of work and a decision
log (`brain/prompts/playbooks.md`), independent review, an audit trail you read in
the morning.

- **change** (branch `agent/<task>`): brief (skipped for issues, queues and
  "skip brief": questions, plan, definition of done) -> run (playbook: bug,
  feature, refactor, performance, investigation, large; decision log in
  `/workspace/decisions.tsv`; pauses only with `DECISION NEEDED` for
  architecture, money, security or a product call) -> checks (`[factory]`
  preview + e2e reports) -> independent QA at a green head (projects with
  `"qa": true`, below) -> review panel (or as soon as the PR exists for a
  project without previews): fresh sessions, no GitHub token, no edit
  tools, one per model and angle (`REVIEW_PANEL`, default
  `opus:correctness,sonnet:evidence`). Every reviewer must pass; CHANGES =
  back to the agent; at most 6 failed rounds (red e2e, QA FAIL, review
  CHANGES) -> auto-merge (below).

**Independent QA** (`qa` in `agents/projects.json`): the agent's own tests
prove the code does what *it* understood; the QA tester proves the product
does what the *task* asked. A fresh session (`QA_MODEL`, default `sonnet`)
with **no checkout, no GitHub token and no edit tools** gets only the task as
the person gave it and the PR's preview. It writes the acceptance criteria
itself, signs in through `/_factory/login`, drives the preview with the e2e
(tester-army) MCP baked into the agent image (`agents/image/qa-tools`,
`qa-mcp`), records a video per check and answers `QA VERDICT: PASS | FAIL |
NOT APPLICABLE`. The report goes on the PR and to Telegram; videos at
`https://pr<N>.<domain>/_factory/qa/<round>-<sha>/` (deleted with the
preview). FAIL goes back to the agent as a failed round, told to turn each
failure into an e2e test; if the agent keeps its code and disputes the
finding, the head goes on to the review panel, which gets the QA report and
judges. Each head is tested once. The base image is not rebuilt by self-update:
after a change in `agents/image`, run
`docker build -t factory-agent:latest /opt/factory/src/agents/image` on the box.
A project's own image and knowledge live on the box, not in this repo: `<PROJECTS_DIR>/<name>/agent.Dockerfile`
(`FROM factory-agent:latest`, default dir `/opt/factory/projects`) is built as `factory-agent-<name>:latest` by self-update
when its content hash changed (or the image is missing); name it as `"image"` in `projects.json`.
`<PROJECTS_DIR>/<name>/knowledge/` is mounted read-only at `/factory/brain/project` in that project's containers
only. Unset: the default image, no mount (`agents/launch.mjs`). `brain/projects/_example/` is a made-up template.
- **report** (benny-style triage): classify, find duplicates, reproduce twice
  with the repo's own tools, file or update the issue and label it
  `ready-for-agent` / `ready-for-human` / `needs-info`. A `ready-for-agent`
  issue then becomes a change by itself.
- **epic** (`program`): a coordinator plans every task of a big goal with
  what it depends on (`agents/plan.mjs`); you approve the plan once ("go").
  Each task starts as soon as everything it depends on has merged, so
  unrelated work runs in parallel and waves are just the result. Reply at any
  time to revise what has not started; it ends with `PROGRAM DONE` once what
  landed meets the epic's definition of done.

**The brain** (`brain/`, see its README): the role prompts, playbooks,
knowledge and factory-wide skills every agent gets, on every project.
Read on every run, so a merged change applies without a restart; knowledge
and skills are mounted read-only into each container. New skills land only
with the founder's approval; the safety gates (`brain/knowledge/gates.md`)
never change without the founder.

Tasks come from Slack (`slack/`: one channel per task, archived when its PR
closes), Telegram or the dashboard, from issues labelled
`ready-for-agent` (change) or `needs-triage` (report; issues already labelled
when triage first ran are left alone), polled every 2 minutes, or as a queue.
The queue and the running jobs are on disk. A deploy restarts the service as a
drain (below): running turns finish first. A job that was still cut off resumes
its session, told it was interrupted, and keeps what it was doing (a review fix
stays a review fix). `/pause`
leaves a work-in-progress commit and a resume note. A summary arrives on
Telegram at 08:00 Tashkent (`/digest` any time).

**Auto-go** (default on; a project opts out with `"autoGo": false`, the whole factory with `AUTO_GO=0`): a task's brief and an epic's plan start by themselves. Agents state assumptions instead of asking, and stop for the founder only with a DECISION NEEDED (a real architecture, design-taste, money or security call). Epics plan at once, with no discussion phase.

**Auto-merge** (`autoMerge` in the project's config): when the whole panel
passes, the factory merges the PR itself, but only into that one branch
(e.g. a project whose base is `staging`; the factory: `main`), only at the exact
head the panel reviewed (GitHub's sha lock), and only through the branch's
own protection (its required checks, if any). A PR that no longer merges cleanly
(another one landed first and conflicts) goes back to its agent to merge the
base in and resolve, then is reviewed again (at most 3 rounds). Any other
refused merge retries for about 20 minutes, then waits for you. A project's production branch is never
merged by the factory: it keeps the staging sign-off. Self-update refuses a
factory commit whose shell, JavaScript or projects.json does not parse.

**No silent stalls.** Every decision about what happens next lives in a pure,
tested module; `agents/server.mjs` only wires them.
- `agents/lifecycle.mjs`: the status after each run, QA verdict, review
  verdict and check report; crash retry (2) and no-PR nudges (2), both bounded;
  round limit (6 failed rounds). Every status that waits on the person carries a
  one-line `waitingOn` saying what for.
- `agents/unasked.mjs`: a reply that asks the person something in plain text,
  without a `DECISION NEEDED` block, still parks as `decision needed`.
- `agents/watchdog.mjs`: a task that stops moving in a working state gets one
  automatic nudge, then a `[factory] STUCK` message and a Slack ping.
  `agents/doctor.mjs` then posts a diagnosis (cause, fix, who acts).
- `agents/drain.mjs`: on SIGTERM no new job starts and running turns finish
  (up to 30 min, `DRAIN_TIMEOUT_S`); a deploy never kills agent containers.
- `agents/evidence.mjs`: the review and QA panels also read the PR's comments
  by the agent and the factory and the agent's reply to the last review.
  `agents/report.mjs`: one evidence report comment per PR, edited in place; the
  agent supplies only an expectation → proof mapping.
- `agents/merge.mjs`: auto-merge decisions, including `requiredChecks`.

**Epics** also: `agents/plan.mjs` refuses a plan where two tasks share a file
with no dependency between them, a task starts only when its whole dependency
chain has merged, and a task that needs it (a new dependency, a data model, a
public interface, an unclear approach) is researched first: a docs-only PR
(`docs/research/<key>.md`) the person comments on and merges before the task
starts. `agents/epic-issue.mjs` keeps the GitHub epic issue and sub-issues.

**Improvement loops** (`agents/loops.mjs`): per project, `"loops": { "security":
"weekly", "docs": "monthly" }` (kinds: performance, security, cleanup, docs;
cadences daily, weekly, biweekly, monthly). A due loop starts one normal task
that makes one small change as a PR; at most one open loop PR per project. A
project without a `loops` key gets a weekly Slack reminder; `false` is an
explicit off.

**Project images** (`agents/launch.mjs`): `<PROJECTS_DIR>/<name>/agent.Dockerfile`
and `knowledge/`, see Independent QA above.

**Remote MCP** (`agents/mcp.mjs`): the agents API serves an MCP endpoint at `/mcp`
behind the same API token (bearer). Tools: `list_tasks`, `get_task`,
`list_projects`, `start_task`, `start_epic`, `reply_to_task`. No merge, stop or
gate powers; rate-limited to 120 calls a minute. Exposing it outside the box is
box configuration.

Design and what is still only planned: [docs/factory-v2.md](docs/factory-v2.md).

## Commands

Laptop (`bin/factory`): `url`, `login`, `api`, `shot` against `staging` or a
PR number, signed in; `init`, `runner`, `push`.

Box (`factory-box`, runs from `/opt/factory/src`, pulled every 5 minutes):
`up`, `e2e`, `down`, `reset`, `snapshot`, `snapshot-all` (nightly 03:00),
`sync`, `runner-add`, `self-update`, `ls`. `self-update` restarts
`factory-agents` without blocking, and the service drains first.

## Agents

`agents/server.mjs` (service `agents/factory-agents.service`) runs software
agents. A task is one conversation with Claude Code, run headless in a
locked-down container built from `agents/image` (Node, Postgres, Chromium,
`gh`; it clones the repo onto branch `agent/<id>`). The API listens on
loopback and every call needs the API token.

1. **Brief**: read-only. The agent answers once with its questions (or "no
   questions"), a short plan, and a definition of done. It changes no file.
   A task created with `auto` skips this phase.
2. **Run**: after the person answers, the agent works without asking
   anything, pushes `agent/<id>` and opens a PR (Done / Decisions / Attention).
3. **Review**: every push gets a preview and e2e. The results are posted to
   the task as `[factory]` messages, and each one starts another agent turn
   to fix what failed. A ✅ marks the task `review`; after 6 rounds it stops
   and waits for a person.

Tasks live in `/srv/factory/agents/tasks/<id>/`: `task.json` (phase, status,
rounds) and `messages.jsonl` (the conversation). Secrets stay in
`/opt/factory/agents`.

## On the box

`/opt/factory` (config, gateway, Node, Chromium, runners, this repo in
`src/`) and `/srv/factory` (preview data, media, artifacts, state). Linux
user `factory` runs the runners. Previews sit behind basic auth (user
`factory`, password in `/opt/factory/preview-password`). Nothing outside
these is touched; the source data of a project is only read.
