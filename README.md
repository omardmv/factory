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

## Commands

Laptop (`bin/factory`): `url`, `login`, `api`, `shot` against `staging` or a
PR number, signed in; `init`, `runner`, `push`.

Box (`factory-box`, runs from `/opt/factory/src`, pulled every 5 minutes):
`up`, `e2e`, `down`, `reset`, `snapshot`, `snapshot-all` (nightly 03:00),
`sync`, `runner-add`, `self-update`, `ls`.

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
