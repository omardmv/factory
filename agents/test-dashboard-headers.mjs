// node agents/test-dashboard-headers.mjs : the real dashboard refuses to be framed, on every kind of response
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
let n = 0; const ok = (s) => console.log(`ok ${++n} - ${s}`);
const sec = mkdtempSync(`${tmpdir()}/sec-`);
writeFileSync(`${sec}/password`, 'right'); writeFileSync(`${sec}/session-secret`, 'x'); writeFileSync(`${sec}/agents-token`, 'x');
const PORT = 19000 + Math.floor(Math.random() * 900), SELF = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, ['dashboard/server.mjs'], { env: { ...process.env, PORT: String(PORT), SECRETS_DIR: sec, SELF_URL: SELF }, stdio: 'ignore' });
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${SELF}/healthz`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  const framed = (r, what) => {
    assert.equal(r.headers.get('x-frame-options'), 'DENY', `${what}: X-Frame-Options`);
    assert.match(r.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/, `${what}: CSP frame-ancestors`);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', `${what}: nosniff`);
  };
  framed(await fetch(`${SELF}/login`), 'login page');
  framed(await fetch(`${SELF}/`, { redirect: 'manual' }), 'redirect to login');
  framed(await fetch(`${SELF}/nope`, { redirect: 'manual' }), 'redirect for unknown path');
  framed(await fetch(`${SELF}/login`, { method: 'POST', headers: { origin: SELF, 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=wrong' }), 'failed login');
  framed(await fetch(`${SELF}/healthz`), 'healthz');
  ok('login, redirects, failed login and healthz all carry the anti-framing headers');
} finally { srv.kill(); }
