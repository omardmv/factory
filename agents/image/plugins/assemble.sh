#!/bin/sh
# Builds /opt/claude-plugins/<name>: Anthropic's official Claude Code plugins
# (claude-plugins-official, pinned) that run headless, as plugin folders
# `claude --plugin-dir` can load. Which ones an agent gets is chosen per run
# by brain/claude/plugins.json (agent-entry adds the --plugin-dir flags).
set -eu
SHA="$1"; OUT=/opt/claude-plugins; SRC=/tmp/claude-plugins-official
git clone -q https://github.com/anthropics/claude-plugins-official.git "$SRC"
git -C "$SRC" checkout -q "$SHA"
mkdir -p "$OUT"
for p in code-review pr-review-toolkit security-guidance frontend-design feature-dev code-simplifier claude-md-management; do
  cp -r "$SRC/plugins/$p" "$OUT/$p"
done
# LSP plugins keep their server config in the marketplace index: write it into
# the plugin itself so --plugin-dir sees it
for p in pyright-lsp typescript-lsp; do
  mkdir -p "$OUT/$p/.claude-plugin"
  cp "$SRC/plugins/$p/LICENSE" "$OUT/$p/" 2>/dev/null || true
  jq --arg n "$p" '.plugins[] | select(.name == $n) | {name, description, version, lspServers}' \
    "$SRC/.claude-plugin/marketplace.json" > "$OUT/$p/.claude-plugin/plugin.json"
done
# Playwright (Microsoft's browser MCP, listed in the official marketplace):
# the installed server, headless, on the image's own Chromium, no download per start;
# --no-sandbox because Chromium's sandbox cannot start in an unprivileged container
# (the container is the sandbox: non-root, own network, host firewalled)
mkdir -p "$OUT/playwright/.claude-plugin"
cp "$SRC/external_plugins/playwright/.claude-plugin/plugin.json" "$OUT/playwright/.claude-plugin/"
CHROME="$(ls -d /ms-playwright/chromium-*/chrome-linux64/chrome | head -1)"
jq -n --arg chrome "$CHROME" '{playwright: {command: "playwright-mcp", args: ["--headless", "--isolated", "--no-sandbox", "--executable-path", $chrome, "--output-dir", "/workspace/screens"]}}' > "$OUT/playwright/.mcp.json"
printf '%s\n' "$SHA" > "$OUT/SOURCE_SHA"
rm -rf "$SRC"
ls "$OUT"
