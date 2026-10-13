# gVisor on the shared box

Installed 2026-10-13: `runsc` release-20261005.0 from gVisor's apt repo, added
to Docker as the runtime `runsc` in `/etc/docker/daemon.json` and picked up
with `systemctl reload docker` (SIGHUP). Docker was NOT restarted (still up
since 2026-08-22); every existing container keeps `runc`. A container uses
gVisor only when started with `--runtime=runsc`. `needrestart` listed
docker.service under "deferred" during the apt install: never accept that
restart outside a maintenance window.

The box has no KVM (no vmx/svm, no /dev/kvm), so gVisor runs on its systrap
platform, and Firecracker / Kata / E2B self-hosted / microsandbox are not
possible here.

## Agent toolchain, plain Docker vs gVisor (2 CPUs, 4 GB, same image)

| Step | runc | runsc | |
| --- | --- | --- | --- |
| git clone --depth 1 | 0.9 s | 2.2 s | x2.5 |
| npm install -g Claude Code | 13.3 s | 37.4 s | x2.8 |
| npm i playwright | 3.8 s | 12.8 s | x3.4 |
| Chromium: open staging, screenshot | 3.6 s | 12.0 s | x3.3 |

Chromium works under runsc but needs generous timeouts (a 30 s
`networkidle` wait timed out). `--network=host` made it 8.3 s but shares the
host's loopback (Coolify API, Traefik, gateway): never use it for agents.

## Use

- Trusted agents (ours): plain Docker, hardened (no docker socket, non-root,
  caps dropped, own network, limits). Fast.
- Untrusted code (unknown repos, dependencies, user input): `--runtime=runsc`.
  Expect about x3 on disk/network work.
- Sysbox (Apache-2.0, Docker Inc.) would give near-native speed and Docker
  inside agent containers, but installing it restarts Docker: maintenance
  window only.
