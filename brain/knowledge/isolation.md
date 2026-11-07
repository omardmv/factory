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
- **gVisor** (`AGENT_RUNTIME=runsc`): about x3 slower on disk and network
  work; for untrusted code. Never `--network=host` for agents: it shares
  the host's loopback.
- **Previews** sit on their project's `factory-<prefix>` network, never on
  production or staging networks; env is an allowlist, so a service with no
  key fails closed.
- **Production** is never merged, deployed or touched by the factory.
