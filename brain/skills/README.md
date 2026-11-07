# Factory-wide skills

One folder per skill with a `SKILL.md` (Claude Code format: `name` and
`description` front matter, then the instructions). Mounted read-only at
`/home/agent/.claude/skills` in every agent container, so every agent, on
every project, has them.

A new skill lands only with the founder's approval (see `../README.md`).
