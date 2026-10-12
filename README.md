# factory

Per-PR preview environments on our own VPS: every pull request gets its own
app, its own copy of the database and media, e2e tests with video
recordings, and one PR comment with the link. Closing the PR deletes it.
CI runs on the same box on a self-hosted runner, so it uses no GitHub
minutes.

Design: [docs/spec.md](docs/spec.md). First user: ContentCoach.
