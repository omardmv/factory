#!/usr/bin/env bash
# Exercises coolify_watch and the deployment_uuid parse under the script's own
# set -euo pipefail, including replies where grep finds nothing.
set -euo pipefail
src="$(dirname "$0")/../bin/factory-box"
log(){ echo "LOG $*"; }; sleep(){ :; }; cat(){ echo tok; }; curl(){ echo "$BODY"; }
eval "$(sed -n '/^coolify_watch()/,/^}/p' "$src")"
fail=0
check(){ out="$(coolify_watch app d || true)"; [[ "$out" == *"$1"* ]] || { echo "FAIL: want '$1' got '$out'"; fail=1; }; }
BODY='{"status":"finished"}'; check "app deployed"
BODY='{"status":"failed","logs":"[]"}'; check "deploy failed: status failed"
BODY='{"status":"failed","logs":"Client.Timeout exceeded"}'; check "Timeout"
BODY='{"message":"x"}'; check "after 10 minutes"
BODY='{"status":"in_progress"}'; check "still in_progress"
resp='{"message":"ok"}'
dep="$(printf '%s' "$resp" | grep -o '"deployment_uuid" *: *"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
[ -z "$dep" ] || { echo "FAIL uuid"; fail=1; }
exit $fail
