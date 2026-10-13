# factory

Our own software factory on the VPS, for every project: each pull request
becomes a live preview with its own copy of the data, e2e tests run against
it with a video of every test, and one PR comment carries the link and the
results. Closing the PR deletes everything. CI runs on self-hosted runners
on the same box, so it uses no GitHub minutes.

![architecture](docs/architecture.png)

Design: [docs/spec.md](docs/spec.md).

## Projects

| Project | Repo | Previews | Prefix |
| --- | --- | --- | --- |
| contentcoach | contentcoach/contentcoach | `pr<N>.contentcoach.org` (Coolify, `preview.compose.yaml` in the repo) | `cc` |

A project is a folder in `projects/`: `project.sh` (domain, prefix, repo,
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
log (`agents/playbooks.md`), independent review, an audit trail you read in
the morning.

- **change** (branch `agent/<task>`): brief (skipped for issues, queues and
  "skip brief": questions, plan, definition of done) -> run (playbook: bug,
  feature, refactor, performance, investigation, large; decision log in
  `/workspace/decisions.tsv`; pauses only with `DECISION NEEDED` for
  architecture, money, security or a product call) -> checks (`[factory]`
  preview + e2e reports) -> review: a fresh reviewer (`REVIEW_MODEL`, own
  session, no GitHub token, no edit tools) at a green head, or as soon as the
  PR exists for a project without previews. PASS = ready for you, CHANGES =
  back to the agent; at most 6 rounds.
- **report** (benny-style triage): classify, find duplicates, reproduce twice
  with the repo's own tools, file or update the issue and label it
  `ready-for-agent` / `ready-for-human` / `needs-info`. A `ready-for-agent`
  issue then becomes a change by itself.
- **program** (orchestrate): a coordinator plans phases of independent
  changes; you approve the plan once ("go"); each phase runs as a batch; when
  you have merged a phase, the coordinator plans the next from what landed,
  until `PROGRAM DONE`.

Tasks come from Telegram or the dashboard, from issues labelled
`ready-for-agent` (change) or `needs-triage` (report; issues already labelled
when triage first ran are left alone), polled every 2 minutes, or as a queue.
The queue and the running jobs are on disk: after a restart (every deploy)
an interrupted job resumes its session, told it was interrupted. `/pause`
leaves a work-in-progress commit and a resume note. A summary arrives on
Telegram at 08:00 Tashkent (`/digest` any time). Agents never merge.

## Commands

Laptop (`bin/factory`): `url`, `login`, `api`, `shot` against `staging` or a
PR number, signed in; `init`, `runner`, `push`.

Box (`factory-box`, runs from `/opt/factory/src`, pulled every 5 minutes):
`up`, `e2e`, `down`, `reset`, `snapshot`, `snapshot-all` (nightly 03:00),
`sync`, `runner-add`, `self-update`, `ls`.

## On the box

`/opt/factory` (config, gateway, Node, Chromium, runners, this repo in
`src/`) and `/srv/factory` (preview data, media, artifacts, state). Linux
user `factory` runs the runners. Previews sit behind basic auth (user
`factory`, password in `/opt/factory/preview-password`). Nothing outside
these is touched; the source data of a project is only read.
