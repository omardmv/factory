---
name: factory-browse
description: Look at and talk to a running ContentCoach environment (staging, or a PR preview at <feature>-pr<N>.contentcoach.org) as a signed-in user - call its API with auth, take screenshots at phone or desktop width, or drive a live browser (tester-army e2e) to click through a flow and record a video. Use when checking a change on staging or a preview, reproducing a UI bug, verifying an API response, or producing a screenshot/video for a PR.
---

# factory-browse

Two tools, both signed in as the founder's staging account (human
`1000000000000001`, `@omarmdv`), never anyone else:

- **`factory` CLI** (`~/Documents/projects/factory/bin/factory`, on PATH as
  `factory`): one-shot API calls and screenshots. Fast, no session to manage.
- **e2e MCP live browser** (tester-army, `mcp__e2e__*` tools): click, type,
  navigate, observe, screenshot, record video. For flows with several steps.

`<target>` is `staging` or a PR number (`458`). A preview's hostname is
`<feature>-pr<N>.contentcoach.org`; routing only reads the number, so any
`<anything>-pr458` reaches PR 458. Previews arrive with factory phase 2;
until then only `staging` has an app behind it.

## API calls

```bash
factory api staging GET /me
factory api staging GET /threads
factory api 458 POST /some/path '{"key":"value"}'
```

Paths are relative to the API root (`/app/api`). The body prints on stdout,
`HTTP <code>` on stderr, exit is non-zero unless 2xx. The session is minted
on first use, cached in `~/.cache/factory/`, and re-minted on a 401.

## Screenshots

```bash
factory shot staging /                     # desktop 1280x800
factory shot staging /reports --width 390  # phone (390x844 @3x)
factory shot 458 /calendar --full --out /tmp/cal.png
```

Prints JSON: `screenshot` (the PNG path: Read it to look), final `url`,
`status`, `title`, and `console_errors` (check it - a clean screenshot with
errors in the console is not a pass). `--wait <ms>` for pages that keep
loading after network idle.

## Live browser (click through a flow, record a video)

1. Open a session on the factory's own config (works from any project):
   `mcp__e2e__open_session` with
   `config: "/Users/omarmdv/Documents/projects/factory/tools/e2e.config.ts"`
   and `target: "staging"` or `"preview"`. The preview target answers the
   preview password itself.
2. Sign in: `factory login <target>` prints a single-use URL
   (`…/app/enter#t=…`). Call `navigate` with it, then `observe` until the
   path is `/app` (the page shows "Signing you in…" for a moment). The token
   dies on first use; never paste it anywhere else, mint a new one instead.
3. Act with `tap` / `type` / `navigate` using node ids from the newest
   observation; `screenshot` to look.
4. Video: `start_recording {name}` before the flow, `stop_recording` after;
   it returns the `.webm` path (under `factory/tools/.e2e/videos/`).
5. `mcp__e2e__close_session` when done.

## Rules

- **Staging is real.** Don't send chat messages, start analyses or press
  anything that spends credits or calls the model on staging unless the user
  asked for exactly that; reading pages and GET calls are free. Previews run
  offline (fake model) and are safe to click through.
- Never run against prod: `factory` has no prod target, keep it that way.
- Never print the preview password or a sign-in token in a reply or a PR.
  The password lives in `~/.config/factory/preview-password` (fetched from
  the box on first preview use).
- Needs `ssh vps` (minting runs inside the staging/preview api container),
  so it works from the founder's Mac, not from remote sandboxes.
