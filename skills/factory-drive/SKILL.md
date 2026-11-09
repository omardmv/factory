---
name: factory-drive
description: Hand ALL of the person's work to the factory instead of doing it in this session (always on, every directory) - every code change, bug, feature or multi-step program in a factory project runs as a factory task on the box (brief, playbook, decision log, preview + e2e, independent QA, review panel, auto-merge), and this session only starts it, relays it and steers it. Use whenever the person gives a task, a bug or a goal for a factory project (factory, sayra, ...), asks what the factory is doing, or answers a factory agent's question.
---

# factory-drive

This session is the person's **operator console** for the factory, not a
coder. The factory does the work exactly as it does from Telegram or the
dashboard: same agents, playbooks, decision log, preview, e2e, QA, review
panel and auto-merge rules. Here you start tasks, relay what the agents say,
and carry the person's answers back.

## Rules

- **Do not change code here** for a factory project: no Edit/Write on the
  repo, no local branches, commits or PRs. Turn the request into a factory
  task. Read-only looking around (reading files, `git log`, `gh pr view`,
  `git diff`) to write a better task or to check a result is fine.
- **Pass the person's words through.** The factory's brief and QA judge the
  result against the task as the person gave it. Send their text as-is; add
  context only below it under a line `Context from the operator session:`
  (file paths, the error you saw, what they said earlier). Never shrink or
  reinterpret the ask.
- **Autonomous by default.** Start changes with `--auto` (no brief) unless
  the person asks to see a brief. Approve a program plan yourself (`factory
  reply <id> go`). Answer an agent's routine questions yourself from the
  task and the code. Bring only a real `DECISION NEEDED` (architecture,
  money, security, a product call) to the person, with your recommendation.
- **Close what is finished.** When a task reaches `done`, `merged` or
  `stopped`, report it in one line and start no more waits. If a task's
  work is done (PR merged or closed) but it still shows as running or
  waiting, `factory stop` it. Stop your own background waits (TaskStop) for
  tasks that ended. Leave nothing running.
- Don't poll for the sake of it: start `factory wait` in the background and
  get on with the conversation.

## Commands

`factory` is on PATH (`~/Documents/projects/factory/bin/factory`). The
project comes from the checkout's `origin`; outside a project checkout pass
`-p <project>` (the error lists them). Text can be an argument or stdin
(use a quoted heredoc for anything long).

| Person wants | Run |
| --- | --- |
| a change, feature, fix, refactor | `factory task --auto <text>` |
| same, but they want to see a brief first | `factory task <text>` (brief waits for "go") |
| a bug investigated and filed | `factory report <text>` |
| a big goal in phases | `factory program <goal>` (approve the plan yourself with "go") |
| several independent small changes | `factory batch` with one task per line on stdin |
| what's going on | `factory tasks`, `factory show <id>`, `factory digest` |
| answer / steer / approve | `factory reply <id> <their words>` |
| stop or park it | `factory stop <id>`, `factory pause <id>` (reply later resumes) |

After starting or replying, run `factory wait <id>` with
`run_in_background: true`; when it returns, relay what the agent said (short:
status, PR link, the question if there is one) and start the next wait if
the task is still moving. Statuses that need the person: `decision needed`,
`waiting for you` (answer it yourself unless it is a real decision),
`ready for you` (PR passed, waiting for their merge or sign-off), `paused`.

## Example

Person: "add dark mode toggle to sayra settings"

```bash
cd ~/Documents/projects/sayra   # or: factory -p sayra task ...
factory task --auto 'add dark mode toggle to sayra settings'
# 261110-ab12cd  sayra  change  queued  add dark mode toggle to sayra settings
factory wait 261110-ab12cd      # background
```

Each time wait returns, answer what you can (`factory reply 261110-ab12cd
'...'`) and wait again. It ends at a reviewed PR and an auto-merge where the
project allows it: relay the PR link, preview and QA verdict in one line,
then close it out (no more waits).
