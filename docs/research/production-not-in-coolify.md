# Why production is not in Coolify, and how to see it

## Problem
You cannot see the production containers of `shop` in Coolify and ask why
they were not put there. I read "Cloud Coolify" as the box's self-hosted
Coolify (not Coolify Cloud).

## Findings
**From the repo (no record of a decision to exclude production):**
- Coolify was given one job: build and run each PR's preview, route it and
  delete it on close (`README.md:35-39`). Production is not in that list.
- Production is off limits to the factory: "never merged, deployed or
  touched by the factory" (`brain/knowledge/isolation.md:19`); a project's
  production branch is never merged by the factory (`README.md:144-145`).
- Coolify was installed by hand so Docker would not restart; a restart
  would hit production (`box/coolify/README.md:3-4`, `brain/knowledge/lessons.md:7-10`).
- Its Docker cleanup is forced off because it deletes images it did not
  label, such as Kamal rollback images (`box/coolify/README.md:14`). That
  points to production being deployed with Kamal, outside Coolify. This is
  inferred from that line, not stated anywhere.
- Host nginx owns 80/443 for every site; Coolify's Traefik listens only on
  127.0.0.1:18080 (`brain/knowledge/box.md:11`, port in `README.md:36-37`). Production routing does
  not go through Coolify.
- The box is shared with other tenants (`box.md:9`).

**Why you may see nothing (unverified):** Coolify's normal project view
lists only what it deployed. But a third-party guide says the server's
Resources tab shows a "List of all containers running on server"
(https://azdigi.com/blog/self-hosted/coolify-interface-detailed-dashboard-usage-guide).
I also recall Managed/Unmanaged tabs there; I could not confirm that. The
official server page does not mention it
(https://coolify.io/docs/core/infrastructure/servers/manage-server).
So the first step is free: open Servers -> the box -> Resources in the
dashboard and look for unmanaged containers.

**Not verified:** I had no Docker or box access, so I did not inspect
production's real deployment (`docker ps` labels, Kamal config) or that page.

**Moving in:** Coolify deploys a compose file or image as a resource; I
found no doc saying it adopts running containers, so a move likely means
redeploying them. See https://coolify.io/docs/.

## Options
- **A. Leave production outside, view it read-only.** First the Coolify
  Resources tab (no cost). If it shows nothing: `docker ps` over SSH, or a viewer (Portainer, Dozzle, ctop) on loopback behind the same
  SSH tunnel as Coolify. Cost: small, about an hour. No risk to production.
- **B. Move production into Coolify.** One place for logs and deploys.
  Cost: days. It means redeploys, the proxy question (Traefik vs host
  nginx), data volumes, and a break of the rule that the factory never
  touches production.
- **C. Import production as a Coolify resource without redeploying.** I
  found no documented way; not worth chasing.

## Recommendation
**A.** It answers "I cannot see the containers" without touching
production or the safety rule. Change my mind if you want deploy buttons
or rollbacks from Coolify: then plan B as its own task with a maintenance
window.

## Risks
- My Kamal inference may be wrong; production may be deployed another way.
- A viewer on the box exposes container env and logs: keep it on loopback
  only, behind SSH or the existing auth.
- Docker socket access in any viewer is root-equivalent on a shared box.

## Definition of done
- `git diff --stat main` shows only this file.
- On the box, `docker ps --format '{{.Names}} {{.Label "com.docker.compose.project"}}'`
  shows production containers with no Coolify labels
  (`coolify.managed` absent). This confirms the cause.
- After option A, the viewer opens only via the SSH tunnel and lists
  production containers; `ss -ltn` shows no new public listener.
- Production returns 200 before and after.

## Open questions for the person
- Is production deployed with Kamal? (I assumed so.)
- Visibility only, or deploys from Coolify too? (Assumed visibility only.)
- Which viewer do you prefer, if any? (Assumed `docker ps` or Dozzle.)
