#!/usr/bin/env python3
"""Post a message into an Open-Inspect session as its `github-bot` service.

    oi-say.py <session-id> < message.md

The factory uses it to report a PR's preview, e2e result and videos back into
the agent conversation that opened the PR (branch `open-inspect/<session-id>`),
so the agent keeps going without waiting for a person. Signs requests with
Open-Inspect's sig1 scheme (packages/shared/src/service-auth.ts).
Env: OI_URL (default http://127.0.0.1:8787), OI_SECRET_FILE
(default /opt/factory/oi-github-bot-secret).
"""
import hashlib, hmac, json, os, secrets, sys, time, urllib.request, urllib.error

def main():
    if len(sys.argv) != 2 or not sys.argv[1].strip():
        sys.exit("usage: oi-say.py <session-id> < message")
    session = sys.argv[1].strip()
    base = os.environ.get("OI_URL", "http://127.0.0.1:8787").rstrip("/")
    secret = open(os.environ.get("OI_SECRET_FILE", "/opt/factory/oi-github-bot-secret")).read().strip()
    body = json.dumps({"content": sys.stdin.read()}).encode()
    path = f"/sessions/{session}/prompt"
    ts, nonce = str(int(time.time() * 1000)), secrets.token_hex(8)
    canonical = "\n".join(["sig1", "github-bot", ts, nonce, "POST", path, "",
                           hashlib.sha256(body).hexdigest(), ""])
    sig = hmac.new(secret.encode(), canonical.encode(), hashlib.sha256).hexdigest()
    req = urllib.request.Request(base + path, data=body, method="POST", headers={
        "Content-Type": "application/json",
        "X-OpenInspect-Service": "github-bot",
        "X-OpenInspect-Service-Signature": f"sig1.{ts}.{nonce}.{sig}",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            print(r.status, r.read(300).decode(errors="replace"))
    except urllib.error.HTTPError as e:
        print(e.code, e.read(300).decode(errors="replace"))
        sys.exit(1)

main()
