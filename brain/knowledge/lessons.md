# Lessons

One line each: what happened, the rule it left. Newest last.

- A firewall DROP on a Docker subnet also dropped replies of a container on
  it (~15 min outage). Always accept ESTABLISHED,RELATED before a DROP.
- Coolify's install script rewrites `/etc/docker/daemon.json` and restarts
  Docker, which restarts every container on the box, production included.
  Install manually; never restart Docker outside a maintenance window (also
  when `needrestart` offers it during an apt install).
- Coolify's Docker cleanup removes every image it did not label (rollback
  images, build cache). Keep it off.
- `CREATE DATABASE ... TEMPLATE x` refuses while anything is connected to
  `x`: the snapshot database is one nothing ever connects to.
- Chromium under gVisor needs generous timeouts (a 30 s `networkidle` wait
  timed out).
