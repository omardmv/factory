# Factory: design spec

Status: draft, 2026-10-13. First user: ContentCoach (`contentcoach/contentcoach`).

## Goal

Code from anywhere (laptop, phone, Open-Inspect agents) and have every pull
request become something you can open, click and watch without checking
anything by hand:

1. every PR gets its own live preview: its own app containers, its own copy
   of the database (Postgres + pgvector, so the vectors come along) and of
   the media files;
2. e2e tests run against that preview and record a video of every test;
3. the PR gets one comment: preview URL, sign-in link, test results, videos;
4. closing the PR deletes all of it;
5. all of it runs on our own VPS for $0: no GitHub-hosted minutes, no
   per-PR DNS or Cloudflare work, no paid services.

Not in scope (from the "agentic software factory" picture): triage and
prioritizer agents, formal verification, auto-merge by blast radius. The
founder stays the gate to `main` (contentcoach AGENTS.md, step 4); previews
make that sign-off a two-minute phone check.

## What the box already has (checked 2026-10-13)

| | |
| --- | --- |
| CPU / RAM / disk | 12 cores, 47 GB (35 GB free), 299 GB free on ext4 |
| Load | under 1; all of prod uses ~1.2 GB |
| Databases | prod `contentcoach` 2.9 GB, staging 137 MB, both pgvector pg17 |
| Media | prod volume 57 GB, staging 1.3 GB |
| TLS | Cloudflare origin cert `/etc/ssl/cloudflare/contentcoach.org.pem` covers `*.contentcoach.org` until 2041 |
| Proxy | host nginx (all projects' vhosts) + `kamal-proxy` (staging api) |
| Agents | Open-Inspect at `software.contentcoach.org` (writes PRs) |
| Other tenants | satstation, ugcstation, sayra, other bots: the factory must never touch their containers, volumes or vhosts |

## Shape

Two halves:

- **The factory** (this repo), installed once on the VPS at `/opt/factory`:
  a `factory` CLI (bash), a gateway container, a Postgres for previews, the
  nightly snapshot job, the self-hosted runner. Knows nothing about
  ContentCoach.
- **The project** describes itself in `.factory/preview.yml` in its own
  repo: how to build, which services, env, migrate command, how to mint a
  sign-in link, how to run e2e.

Each project's CI calls the CLI that is already on the runner host
(`factory up`, `factory e2e`, `factory down`). No reusable workflow across
repos: a private reusable workflow can't be called from another owner's
repo, and a CLI keeps us able to leave GitHub Actions for Woodpecker later
without rewriting anything.

```
push to PR branch
  └─ GitHub ─▶ self-hosted runner on the VPS (no GitHub minutes)
       ├─ static checks (guard.py, check.mjs, …)   ← today's ci.yml, runs-on: self-hosted
       ├─ factory up contentcoach 123 <sha>
       │    ├─ build images from the branch (docker build, local cache)
       │    ├─ first push only: CREATE DATABASE cc_pr_123 TEMPLATE cc_snapshot
       │    │                   media: cp -al snapshot → pr_123 (hardlinks, instant, 0 bytes)
       │    ├─ migrate (one-shot container), then compose up project cc-pr-123
       │    └─ wait for health
       ├─ factory e2e contentcoach 123  → videos + report to /srv/factory/artifacts/…
       └─ factory comment               → one PR comment, edited on every push
PR closed/merged ─▶ factory down contentcoach 123 (containers, DB, media, artifacts)
nightly ─▶ factory snapshot contentcoach (staging → cc_snapshot, disarmed) + factory gc
```

## Routing: one DNS record, then nothing per PR

- Cloudflare, once: `A  *  <VPS IP>  proxied`. Records set by name
  (`staging`, `admin`, `software`, …) keep winning over the wildcard.
- Names are one level deep, `pr-123-preview.contentcoach.org`, because the
  free certificate covers only `*.contentcoach.org`.
- Host nginx, once: one server block,
  `server_name ~^(?<pv>pr-\d+)-preview\.contentcoach\.org$;` with the
  existing origin cert, basic auth, `proxy_pass` to the gateway on
  `127.0.0.1:<port>`.
- Gateway (an nginx container on the docker network `factory`, resolver
  `127.0.0.11`): sends the request to `http://cc-$pv-web`. Docker's own DNS
  finds the container by name, so there's no config to write per PR. A preview
  that doesn't exist returns a "no preview for this PR" page, not a 502.
- `/_factory/` on each preview host is served by the gateway from the
  artifacts directory (test videos, report).

## Data

### Where preview databases live

A dedicated `factory-pg` container (pgvector pg17, same image as prod),
not the staging cluster: a heavy preview can't slow staging down, and
`DROP DATABASE` mistakes can only ever hit preview data. It holds
`cc_snapshot` (the template, nobody connects to it) and one `cc_pr_<n>`
per open PR.

`CREATE DATABASE … TEMPLATE` refuses a template with open connections,
which is why the snapshot is a database nothing ever connects to.
At 137 MB a copy takes under a second.

### Nightly snapshot (`factory snapshot contentcoach`)

1. `pg_dump -Fc` of **staging** (read-only, from `staging-db-1`). Staging,
   not prod: the founder works on staging with their own account
   (`1000000000000001`), which on prod is a different, real creator, so a
   prod copy would sign them in as someone else (founder 2026-10-13).
2. Restore into `cc_snapshot_next` in `factory-pg`.
3. **Disarm** (see below).
4. Swap: rename `cc_snapshot` → `cc_snapshot_old`, `next` → `cc_snapshot`,
   drop old. Previews already running keep their own copy.
5. Media: `rsync -a --link-dest` from the `staging_media` volume (1.3 GB)
   into `/srv/factory/media/contentcoach/snapshot`: hardlinks, so it costs
   nothing new and a run takes seconds after the first.

Founder decision 2026-10-13: real data is fine, no anonymizing. Staging is
never refreshed from prod (it holds the founder's working account).

### Disarm: real data, no real side effects

Offline mode (`composition.build(offline=True)`) swaps in fakes for the
model, scraper, downloader, understanding and embedding, but **not** for
Telegram delivery or payments. Staging runs `PAYLOV_CARDS_LIVE=true`, so its
copy can hold real card tokens and real Telegram ids: a loaded gun. Disarm runs on every snapshot, in SQL,
before anything can connect:

| What | Action |
| --- | --- |
| `jobs` | delete everything not finished (no inherited renewals, refreshes, deliveries) |
| `paylov_cards` | null the card tokens; previews can never charge a real card |
| `billing` / LS subscription ids | keep the rows (plans still show), but previews get no LS/Paylov keys |
| `connect_tokens`, `web_login_tokens` | delete (staging sign-in links must not work on previews) |
| OAuth tokens (Google, LinkedIn integrations) | delete |
| `scheduled_posts` | keep the rows, no worker can post them (no keys) |

On top of that, the preview **env is an allowlist**, not a copy of
staging's env: no Telegram bot token, no Paylov/LS/Apify/Gemini keys, no
PostHog key (founder 2026-10-13: previews are recorded by the e2e runner
only).
A service with no key fails closed. The exact table and column list is
fixed in the implementation PR by reading `tables.py`, and a
`factory doctor` check refuses to start a preview if a known secret
column is non-null in its database.

### Per-PR copy

- First `factory up` for a PR: `CREATE DATABASE cc_pr_<n> TEMPLATE cc_snapshot`,
  then `cp -al` the media snapshot to `/srv/factory/media/contentcoach/pr-<n>`.
- Later pushes keep the database, so state you built while testing
  survives a push. The `fresh-db` PR label (or `factory reset`) re-copies.
- The branch's migrations run on every push (one-shot container), so a
  broken migration fails the preview on real data before it reaches staging.
- Hardlinked media: the app writes new files (new names), never edits one
  in place, so sharing inodes with the snapshot is safe. To verify in the
  implementation PR (`grep` for writes that open an existing path).

### Nothing flows back

Data made in a preview is thrown away with the PR. Merging preview data
back into staging collides on ids, carries columns of PRs that never
merged, and fills staging with test junk. Data worth keeping becomes a
seed or scenario script in the PR. Staging stays what the founder makes
it on staging itself; previews only ever read a copy of it.

## The preview stack (ContentCoach)

Compose project `cc-pr-<n>` on the `factory` network:

| Service | What |
| --- | --- |
| `migrate` | one-shot, the branch's alembic upgrade |
| `api` | `cc api`, offline, DB `cc_pr_<n>` |
| `work` | one `cc work` (its own DB, so it can't eat staging's jobs) |
| `web` | nginx serving the branch's SPA build + `/app/api` → `api`, the same paths prod uses |

No bot (web only, founder 2026-10-13), no admin, no webhook.

### Real model: only when necessary

Every preview runs offline ($0) by default. A PR that can't be judged
without the real model (prompt or coach-behaviour work) gets the `live`
label: `factory up` then adds the Gemini key (and Apify only if the
project's `live.keys` lists it) and the preview runs `offline=False`.
Before switching on, it checks the day's spend across dev + staging +
previews against the $10/day testing cap (Tashkent day) and refuses
past it. Removing the label goes back to offline on the next push. The
e2e suite stays model-free either way. Memory and CPU
limits per container; at most 15 previews running, the rest queue.

### Signing in

Google OAuth can't list a redirect URI per PR and the Telegram widget has
no domain, so previews sign in with a minted link: `factory up` runs the
project's `login` command (ContentCoach: `e2e/support/mint_login.py`) for
the founder's account and puts a 24-hour link in the PR comment, behind
basic auth anyway.

## E2E and recordings

- ContentCoach gets a `preview` target in `e2e/e2e.config.ts`
  (`APP_URL` = the preview URL) and `e2e/run.sh preview`.
- The factory runs it on the box with
  `npx e2e run --target preview --video on --reporter list,json,markdown`.
  Chromium is installed once on the runner host.
- Results are copied to `/srv/factory/artifacts/contentcoach/pr-<n>/<run>/`
  and served at `https://pr-<n>-preview.contentcoach.org/_factory/`: an
  index page built from `report.json`, with every test, its status, its
  WebM video playing inline, and the trace page on failure. The last 5
  runs per PR are kept.
- Which tests: the whole model-free suite. Tests seed their own synthetic
  users in the preview DB, so they don't depend on what's in the snapshot.
- No PostHog on previews (founder 2026-10-13): the only recordings are the
  e2e runner's (tester-army) videos. The preview's web build gets no
  PostHog key, so it records nothing.

## The PR comment

One comment, edited on every push:

```
Preview  https://pr-123-preview.contentcoach.org/app   (ready, sha 1a2b3c4)
Sign in  <24h link>
E2E      41 passed, 1 failed → https://pr-123-preview.contentcoach.org/_factory/
         ✗ web-entry › connect › keeps the round      ▶ video  ▶ trace
Data     copied from staging snapshot of 2026-10-13 03:00 (Tashkent)
```

Posted with a fine-grained token (the runner's `GITHUB_TOKEN` works for
same-repo PRs).

## CI on our own box

- A GitHub Actions self-hosted runner on the VPS: runner jobs use no GitHub
  minutes (GitHub announced a $0.002/min self-hosted fee for Mar 2026, then
  postponed it with no date; if it comes back, Woodpecker CI on the same box
  runs the same `factory` commands).
- contentcoach's `ci.yml` moves to `runs-on: [self-hosted, factory]`. Its
  path filters stay. A new `preview.yml` workflow listens for
  `pull_request: [opened, synchronize, reopened, closed, labeled]`.
- Runner registered at the `contentcoach` org level (serves every repo
  there). Repos under other owners register their own runner on the same
  box when they join.

### Security

A runner job runs any branch's code on the box that also runs prod. That's
acceptable because the repos are private and only the founder and his
agents push. Limits:

- the runner is its own Linux user `factory`, not root, ephemeral (fresh
  for every job, systemd restarts it);
- it can read nothing in `/opt/contentcoach`, `/opt/contentcoach-staging`
  or the prod/staging docker volumes; staging dump access goes through one
  root-owned script the runner may run with `sudo` (sudoers allows exactly
  that path);
- docker group membership is effectively root, so later we move to rootless
  docker for the runner;
- previews sit on the `factory` docker network only, never on
  `deploy_default` or `staging_default`;
- fork PRs never run on it (GitHub setting: require approval for all outside
  collaborators).

## Lifecycle and cleanup

| Event | Result |
| --- | --- |
| PR opened / pushed | `factory up` + `e2e` + comment |
| label `fresh-db` | DB + media re-copied from the current snapshot |
| no push for 72 h | containers stopped (DB kept); next push or `factory up` wakes it |
| PR closed or merged | `factory down`: containers, DB, media, artifacts gone |
| nightly | `factory gc`: anything with no open PR is deleted; snapshot refreshed |

## Phases

1. **Box setup, once**: DNS wildcard (founder, steps below), host nginx
   block, gateway, `factory-pg`, runner. Proof: a hello container at
   `pr-0-preview.contentcoach.org`.
2. **Previews**: `factory up/down`, snapshot + disarm, ContentCoach's
   `.factory/preview.yml`, PR comment with URL + sign-in link. Proof: a
   real PR opens, signs in as the founder's staging account, closes clean.
3. **E2E + recordings**: `preview` target, `factory e2e`, `/_factory/`
   gallery. Proof: a PR comment with playing videos.
4. **CI moves home**: `ci.yml` on the self-hosted runner, GitHub-hosted
   minutes at ~0.
5. **Second project** (sayra or satstation): whatever turned out to be
   ContentCoach-specific gets fixed here.

## Decided 2026-10-13

1. Staging is not refreshed from prod; previews copy staging.
2. Real model only behind the `live` label, when a PR truly needs it.
3. No PostHog on previews; tester-army e2e videos are the recordings.

## One-time DNS step (founder)

Cloudflare dashboard → `contentcoach.org` → DNS → Records → Add record:

- Type `A`, Name `*`, IPv4: the same IP the `staging` record points to,
  Proxy status: **Proxied** (orange cloud), TTL Auto → Save.

Nothing changes for existing names. Check: `dig +short pr-0-preview.contentcoach.org`
returns Cloudflare IPs.
