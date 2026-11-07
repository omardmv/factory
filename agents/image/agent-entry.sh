#!/bin/bash
# Prepare the task's repository (once), then run whatever command was given
# (normally `claude -p ...`). Env from factory-agents: TASK_ID, REPO
# (owner/name), BASE (branch), GH_TOKEN (short-lived GitHub App token).
set -euo pipefail
# commits are signed as the GitHub App's bot (GIT_NAME / GIT_EMAIL from factory-agents);
# never a made-up noreply address, which GitHub attributes to whoever owns that login
git config --global user.name "${GIT_NAME:-omar-factory[bot]}"
git config --global user.email "${GIT_EMAIL:-353544174+omar-factory[bot]@users.noreply.github.com}"
git config --global credential.helper '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'
if [ -n "${REPO:-}" ] && [ ! -d /workspace/repo/.git ]; then
  git clone -q --filter=blob:none "https://github.com/$REPO.git" /workspace/repo
  git -C /workspace/repo checkout -q -b "agent/$TASK_ID" "origin/${BASE:-main}"
fi
cd /workspace/repo 2>/dev/null || cd /workspace
# the factory's chosen plugins (FACTORY_PLUGINS, from brain/claude/plugins.json):
# each one this image has is loaded with --plugin-dir
if [ "${1:-}" = claude ] && [ -n "${FACTORY_PLUGINS:-}" ]; then
  for p in $(printf '%s' "$FACTORY_PLUGINS" | tr ',' ' '); do
    [ -d "/opt/claude-plugins/$p" ] && set -- "$@" --plugin-dir "/opt/claude-plugins/$p"
  done
fi
exec "$@"
