# Agent containers: their own network

`factory-agents` (agents/server.mjs) starts every task, QA tester and
reviewer as a container on the docker network `factory-agents`
(`AGENT_NETWORK`), created by `factory-agents-firewall` with inter-container
traffic off (`enable_icc=false`).

| Piece | Here | On the box |
| --- | --- | --- |
| network + host INPUT rule: NEW connections from the subnet to the host are dropped, replies (ESTABLISHED,RELATED) pass | `factory-agents-firewall` | `/usr/local/sbin/` |
| runs it at boot, before factory-agents | `factory-agents-firewall.service` | `/etc/systemd/system/` |

So an agent reaches the internet (GitHub, npm, the model API) and the
previews through their public HTTPS names, but not the host's own listeners
(prod/staging APIs, Coolify, Traefik, the gateway) and not another agent.
Install or change: copy both files, `systemctl daemon-reload`,
`systemctl enable --now factory-agents-firewall`.
