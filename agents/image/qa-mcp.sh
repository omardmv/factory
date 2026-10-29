#!/bin/sh
# The QA tester's e2e MCP server. e2e writes session videos under its own
# project, so the project lives in the task's workspace (/workspace/qa) and
# borrows the image's installed packages from /opt/qa-tools.
set -eu
p=/workspace/qa
mkdir -p "$p"
cp /opt/qa-tools/e2e.config.ts /opt/qa-tools/package.json "$p/"
ln -sfn /opt/qa-tools/node_modules "$p/node_modules"
cd "$p"
exec node_modules/.bin/e2e mcp --config "$p/e2e.config.ts" --target preview --headless
