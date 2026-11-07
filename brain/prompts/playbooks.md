# How you work: pick a playbook, keep a decision log

Adapted from Lauren Tan's pstack (poteto-mode, figure-it-out, show-me-your-work).

## 1. Pick the playbook first

Before any change, decide which playbook the task is, and say it in your
first reply as `Playbook: <name>` with one line why. A task that changes
shape midway switches playbook; log the switch.

- **bug**: something behaves wrong.
  1. Restate the symptom in your own words; find where it lives.
  2. Reproduce it before touching code, with the repository's own tools
     (its verification skill, e2e runner, scripts, a failing check). No
     reproduction yet means no fix yet: keep narrowing until you have one,
     or stop with what you tried.
  3. Find the root cause, not the nearest place to patch. Fix it there.
  4. Prove it: the reproduction now passes, and an e2e test that fails without
     the fix guards it. Check the neighbours of the change still work.
- **feature**: new behaviour.
  1. Definition of done as checks anyone can run (what a user sees/does).
  2. Smallest slice that is useful end to end first, then the rest.
  3. Every new behaviour gets an e2e test that would fail without it.
- **refactor**: structure only, zero behaviour change.
  1. Capture the behaviour before (tests, outputs, screenshots).
  2. Change in small steps, each verified against that baseline.
  3. Any behaviour difference is a bug in the refactor, not a feature.
- **performance**: something is slow.
  1. Measure first on a realistic case; write the number down.
  2. Find where the time goes (profile, logs, query plans) before changing.
  3. Change one thing at a time; keep it only if the number moves.
  4. Report before and after, same method.
- **investigation**: a question, no code change asked.
  1. Answer from evidence (code, data, logs), not memory.
  2. Reply with the answer first, then the evidence pointers. No PR
     unless the task asks for one.
- **large**: a migration, a multi-part change, anything over a day of work
  or with no matching playbook. Design the workflow before code:
  1. Frame: definition of done, scope in rough units, risks, rigor level.
  2. Split into independently landable units, riskiest unknown first,
     verification harness before the work.
  3. Run each unit as an experiment: smallest change, verify against the
     real artifact, keep or revert.
  If it truly needs several PRs, say so: it should become a program.

## Your tools

Use Claude Code's own toolkit; it is loaded for you:
- **Browser** (playwright MCP, headless Chromium): open the app, click, type,
  read the console and network, take screenshots and look at them.
- **Subagents** for wide searches or parallel independent work; **web
  search/fetch** for docs.
- **Plugins:** `feature-dev` (explore, design, build), `frontend-design` (UI
  that fits the product's design), `code-simplifier`, `code-review` and
  `pr-review-toolkit` (review your own diff before you push),
  `security-guidance` (it warns on risky edits and reviews your diff),
  `claude-md-management` (keep the repo's CLAUDE.md true), and language
  servers (pyright, TypeScript) for real type errors while you edit.

## See your change

For anything a user sees, look at it before and after:
1. Run the app locally in your container (its own dev setup; a local
   database if it needs one). If it needs a sign-in you can't do (Telegram,
   OAuth), use the repo's dev/test sign-in; if there is none, say so under
   Attention and verify what you can.
2. Before changing code: screenshot the screens the task touches at phone
   width (390x844) and desktop width (1280x800), into /workspace/screens.
3. After: the same screens and widths, plus every state you added (empty,
   error, loading, long text). Look at each screenshot. Fix what is off and
   look again until it is right.
4. Record the e2e tests this change adds or changes, with video, into
   /workspace/videos (Playwright: `video: 'on'` when `E2E_VIDEO` is set, and
   `--output /workspace/videos`). Record **your** tests, the ones that show
   this feature, not the whole suite: run the rest without video for the
   pass/fail count.
5. In the PR, under **Seen**: one line per screen and width, before → after,
   what you checked (layout, contrast, overflow, the states), the videos of
   your tests, and the link
   `https://factory.contentcoach.org/?task=$TASK_ID` where the person sees
   every screenshot and video. Screenshots go in /workspace/screens, videos
   in /workspace/videos; nothing else is shown.

Rules for every playbook: meet the quality bar
(/factory/brain/knowledge/quality.md: design, static analysis, e2e tests
only, verification). Verify by looking at the real artifact, never a
self-report. A result is VERIFIED, NOT VERIFIED or INCONCLUSIVE;
inconclusive is not a pass. Never relax the definition of done to finish.

## 2. Keep a decision log

Append one row per decision or checkpoint to `/workspace/decisions.tsv`
(outside the repository, never committed). Tab-separated, header on first
use:

    ts	phase	decision	why	evidence	result

- **decision**: what you chose or did, one line, plain words.
- **why**: the reason, plain words.
- **evidence**: a pointer, never prose: commit sha, file:line, command and
  its exit code, test name, screenshot path, PR number.
- **result**: `tests green`, `reverted`, `reproduced 2/2`, `INCONCLUSIVE`, `open`.

Log forks, pivots, reverts, verifications and blockers, not every action.
Append only: a wrong row gets a new row that supersedes it. Use
`printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" phase decision why evidence result >> /workspace/decisions.tsv`
with no tabs or newlines inside a cell.

Your PR description ends with **Attention**: what a reviewer should look at
first (risky choices, anything not verified, anything you are unsure of).
"Nothing" is a valid answer.
