// node agents/test-throttle.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loginThrottle } from '../dashboard/throttle.mjs';
let n = 0; const ok = (s) => console.log(`ok ${++n} - ${s}`);

let t = 0; const th = loginThrottle({ max: 3, globalMax: 5, windowMs: 60000, now: () => t });
for (let i = 0; i < 3; i++) { assert.equal(th.wait('a'), 0); th.fail('a'); t += 1000; }
assert.equal(th.wait('a'), 57, 'three failures: wait until the first leaves the window');
assert.equal(th.wait('b'), 0, 'another source is not locked out by a');
th.fail('a'); t += 57000;
assert.equal(th.wait('a'), 0, 'ages out; the failure while blocked was not counted');
th.fail('a'); t += 1000; assert.equal(th.wait('a'), 0, 'only one failure counted again');
ok('per-source cap, bounded, ages out');
const g = loginThrottle({ max: 3, globalMax: 5, windowMs: 60000, now: () => t });
for (const s of ['a', 'a', 'b', 'b', 'c']) g.fail(s);
assert.ok(g.wait('d') > 0, 'the global cap blocks everyone');
t += 61000; assert.equal(g.wait('d'), 0);
ok('global cap, then released');

// the wiring: the real server, wrong passwords until 429 (checked with the right password too)
const sec = mkdtempSync(`${tmpdir()}/sec-`);
writeFileSync(`${sec}/password`, 'right'); writeFileSync(`${sec}/session-secret`, 'x'); writeFileSync(`${sec}/agents-token`, 'x');
const PORT = 18000 + Math.floor(Math.random() * 1000), SELF = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, ['dashboard/server.mjs'], { env: { ...process.env, PORT: String(PORT), SECRETS_DIR: sec, SELF_URL: SELF }, stdio: 'ignore' });
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${SELF}/healthz`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  const login = (password, ip) => fetch(`${SELF}/login`, { method: 'POST', redirect: 'manual', headers: { origin: SELF, 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': `1.2.3.4, ${ip}` }, body: new URLSearchParams({ password }) });
  for (let i = 0; i < 10; i++) assert.equal((await login('wrong', '9.9.9.9')).status, 401);
  const r = await login('wrong', '9.9.9.9');
  assert.equal(r.status, 429); assert.ok(Number(r.headers.get('retry-after')) > 0);
  assert.equal((await login('right', '9.9.9.9')).status, 429, 'locked source: even the right password waits');
  assert.equal((await login('right', '8.8.8.8')).status, 303, 'another source still signs in');
  ok('POST /login: 401 x10, then 429 + retry-after; other sources unaffected');
} finally { srv.kill(); }
