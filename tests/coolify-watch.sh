#!/usr/bin/env bash
# Exercises coolify_watch and the deployment_uuid parse under the script's own
# set -euo pipefail, including replies where grep finds nothing.
set -euo pipefail
src="$(dirname "$0")/../bin/factory-box"
log(){ echo "LOG $*"; }; sleep(){ SECONDS=$((SECONDS+10)); }; cat(){ echo tok; }; curl(){ echo "$BODY"; }
eval "$(sed -n '/^coolify_dep_uuid()/,/^}/p;/^coolify_watch()/,/^}/p' "$src")"
fail=0
check(){ SECONDS=0; out="$(coolify_watch app d || true)"; [[ "$out" == *"$1"* ]] || { echo "FAIL: want '$1' got '$out'"; fail=1; }; }
BODY='{"status":"finished"}'; check "app deployed"
BODY='{"status":"failed","logs":"[]"}'; check "deploy failed: status failed"
BODY='{"status":"failed","logs":"Client.Timeout exceeded"}'; check "Timeout"
BODY='{"message":"x"}'; check "after 10 minutes"
BODY='{"status":"in_progress"}'; check "still in_progress"
dep="$(coolify_dep_uuid '{"deployments":[{"message":"queued","resource_uuid":"r1","deployment_uuid":"abc123"}]}')"
[ "$dep" = abc123 ] || { echo "FAIL uuid: '$dep'"; fail=1; }
[ -z "$(coolify_dep_uuid '{"message":"x"}')" ] || { echo "FAIL uuid empty"; fail=1; }
grep -q 'coolify_dep_uuid "\$resp"' "$src" || { echo "FAIL: self_update does not use coolify_dep_uuid"; fail=1; }
grep -q 'coolify_watch "\$dir" "\$dep" </dev/null &' "$src" || { echo "FAIL: watcher not started in background"; fail=1; }
# curl that always fails (hung/down API): the loop must end at the deadline and log
curl(){ return 28; }
check "deploy failed: still unknown after 10 minutes"
grep -q 'curl -fsS -m 10 -H' "$src" || { echo "FAIL: poll curl has no timeout"; fail=1; }
exit $fail
