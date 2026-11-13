# Isolation

- **Agent containers** (`fa-<task>-*`, image `factory-agent:latest`): one
  per run, non-root user `agent`, 4 CPUs, 8 GB, 2048 pids,
  `no-new-privileges`, NET_RAW/MKNOD/SYS_CHROOT/AUDIT_WRITE/SETFCAP
  dropped, no Docker socket. Network: `factory-agents` (`AGENT_NETWORK`
  in `agents/server.mjs`); `factory-agents-firewall` (`box/agents/`) drops
  new connections from that subnet to the host itself (replies pass), so agents reach GitHub, npm
  and the previews' public URLs but not the box's loopback services.
- **Credentials**: the working agent gets a short-lived GitHub App token
  for its one repository. Reviewers and the QA tester get no GitHub token;
  QA gets no checkout either.
- **Read-only database** (projects.json `readDb`, `agents/readdb.mjs`): off
  unless a project sets it. The working agent (never reviewers or QA) gets
  `PGHOST/PGUSER/PGPASSWORD/...` so plain `psql` reads. The protection is the
  role: SELECT only, ideally on a replica; the session is also opened
  `default_transaction_read_only`. Config naming a write-looking role, an
  unknown key or a path as password file is refused. The password is read from
  the secrets folder and masked (plain and JSON-escaped) in the agent's messages and activity log. Limit: the Claude session transcript inside the task's `.claude` folder is not masked, so a tool result that prints the password lands there; the SELECT-only role is what bounds the damage.
  The box firewall must allow the agents' subnet to reach that host and port.
  No SSH or shell on the server.
- **gVisor** (`AGENT_RUNTIME=runsc`): about x3 slower on disk and network
  work; for untrusted code. Never `--network=host` for agents: it shares
  the host's loopback.
- **Previews** sit on their project's `factory-<prefix>` network, never on
  production or staging networks; env is an allowlist, so a service with no
  key fails closed.
- **Production** is never merged, deployed or touched by the factory.
