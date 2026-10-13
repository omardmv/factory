#!/usr/bin/env bash
# One-time (and idempotent) setup of the factory on the VPS. Run as root on
# the box from a checkout of this repo:  sudo box/install.sh
# Touches only: /opt/factory, /srv/factory, the docker network "factory",
# compose project "factory", and /etc/nginx/sites-enabled/factory-previews.conf.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

install -d -m 755 /opt/factory /opt/factory/gateway /srv/factory/artifacts /srv/factory/media
install -m 644 "$here/compose.yaml" /opt/factory/compose.yaml
install -m 644 "$here/gateway/nginx.conf" /opt/factory/gateway/default.conf
[ -f /opt/factory/gateway/projects.map.inc ] || : > /opt/factory/gateway/projects.map.inc

# factory-pg credentials, generated once
if [ ! -f /opt/factory/.env ]; then
  umask 077
  printf 'POSTGRES_USER=factory\nPOSTGRES_PASSWORD=%s\nPOSTGRES_DB=factory\n' \
    "$(openssl rand -hex 24)" > /opt/factory/.env
fi

# preview basic-auth: user "factory", password generated once, readable by root only
if [ ! -f /opt/factory/htpasswd ]; then
  umask 077
  pw="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
  printf '%s\n' "$pw" > /opt/factory/preview-password
  printf 'factory:%s\n' "$(openssl passwd -apr1 "$pw")" > /opt/factory/htpasswd
  chgrp www-data /opt/factory/htpasswd && chmod 640 /opt/factory/htpasswd
fi

docker network inspect factory >/dev/null 2>&1 || docker network create factory
docker compose -f /opt/factory/compose.yaml up -d --wait

ln -sf "$here/../bin/factory-box" /usr/local/bin/factory-box
# per-project networks, gateway routes and host vhosts, from projects/*
factory-box sync
install -m 644 "$here/factory.cron" /etc/cron.d/factory
echo "factory installed"
