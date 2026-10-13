# Coolify on the shared box

Installed 2026-10-13 with the **manual** method, never the install script:
the script writes /etc/docker/daemon.json and restarts Docker, which would
restart every container on the box (production included).

Guard rails, all verified after install (no public listener added, no
container restarted, prod/staging/Open-Inspect 200 throughout):

| What | Where | Why |
| --- | --- | --- |
| Coolify ports 8000/6001/6002 on 127.0.0.1 only | `/data/coolify/source/docker-compose.custom.yml` (this dir) | upgrades include the custom file, so the binding survives them |
| Traefik on 127.0.0.1:18080 only, no 80/443/8080 | server proxy config in Coolify's DB (copy: `proxy.yml`) | host nginx owns 80/443 for every site; Traefik must never race it after a reboot |
| Docker cleanup: force off, threshold 99% | server settings | Coolify's cleanup `docker rmi`s every image it did not label - Kamal rollbacks, base images, build cache |
| API on, token `factory` (root) | `/opt/factory/coolify-token` (root 600) | the factory drives Coolify over its API |

Dashboard: `ssh -N -L 8000:127.0.0.1:8000 vps`, then http://localhost:8000.
