# The box

One VPS runs everything: production and staging of the projects, the
factory, Coolify, previews, agents, CI runners.

- 12 cores, 47 GB RAM, ~480 GB disk; no KVM (no `/dev/kvm`), so no
  Firecracker, Kata or other micro VMs. Docker containers, optionally under
  gVisor (`--runtime=runsc`).
- Other tenants share it (satstation, ugcstation, sayra, other bots). Never
  touch their containers, volumes, networks or vhosts.
- Host nginx owns 80/443 for every site, behind Cloudflare. Coolify and its
  Traefik listen on 127.0.0.1 only.
- Factory layout: `/opt/factory` (config, secrets, this repo in `src/`,
  pulled every 5 minutes from `main`), `/srv/factory` (preview data, media,
  artifacts, agent tasks).
- Project prefix names everything of a project: containers
  `<prefix>-pr-<N>-*`, databases `<prefix>_pr_<N>`, network
  `factory-<prefix>`, files under `/srv/factory/*/<prefix>/`.
- Production data is never read for previews: previews copy a disarmed
  nightly snapshot of staging (no card tokens, no OAuth tokens, no pending
  jobs, no real keys).
