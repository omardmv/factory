# Open-Inspect agent sandboxes: hardening

Open-Inspect (software.contentcoach.org) already runs its agents on this box,
not on Modal: `open-inspect-sandbox-shim.service` (selfhost-sandbox/server.mjs,
"Modal-compatible") launches each session as a local container `oi-sb-*` from
`open-inspect-sandbox:local`. `MODAL_API_URL` points at the shim.

Found 2026-10-13: sandboxes ran with `--network host`, as root, no
capabilities dropped: an agent could reach every loopback service on the box
(prod/staging APIs, Coolify API, preview router, the shim).

## What changed (all opt-in in the shim; unset = original behaviour)

| Piece | File here | On the box |
| --- | --- | --- |
| shim patch: `SANDBOX_NETWORK`, `SANDBOX_CP_URL`, `SANDBOX_RUNTIME`; off-host sandboxes get `no-new-privileges` and drop NET_RAW, MKNOD, SYS_CHROOT, AUDIT_WRITE, SETFCAP | `patch-shim.py` (patches from `server.mjs.orig`) | `/opt/open-inspect/selfhost-sandbox/server.mjs` (+ `.orig-20261013`) |
| settings | - | `shim.env`: `SANDBOX_NETWORK=oi-sandboxes`, `SANDBOX_CP_URL=https://software-api.contentcoach.org` (+ `.orig-20261013`) |
| network `oi-sandboxes` (172.25.0.0/16); host INPUT drops NEW connections from it, replies pass | `factory-sandbox-firewall`, `.service` | `/usr/local/sbin/`, `/etc/systemd/system/` |
| the app joins `oi-sandboxes` whenever the shim starts | `shim-dropin-factory.conf` | `open-inspect-sandbox-shim.service.d/factory.conf` |

`SANDBOX_CP_URL` is the public HTTPS address because the sandbox runtime
refuses a plain-HTTP control plane unless it is loopback.

Lesson (cost ~15 min of software-api being unreachable): a DROP on a subnet
also drops the replies of a container that lives on it. Always allow
ESTABLISHED,RELATED first.

## Proven

A probe sandbox launched through the shim: network oi-sandboxes, caps
dropped, no-new-privileges; it reached the control plane over HTTPS and got
401 for its fake session token. From oi-sandboxes: host services (3000, 8090,
5051, the shim) blocked; GitHub, npm and the app reachable.

## gVisor

`SANDBOX_RUNTIME=runsc` in shim.env + restart the shim (see box/gvisor:
about x3 slower on disk/network work here).

## Rollback

`cp server.mjs.orig-20261013 server.mjs; cp shim.env.orig-20261013 shim.env;
systemctl restart open-inspect-sandbox-shim`.
