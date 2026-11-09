// node agents/test-basebuild.mjs
import assert from 'node:assert/strict';
import { baseBuildConfig, baseBuildApplies, baseBuildDecision, runBaseBuild } from './basebuild.mjs';

// config
assert.equal(baseBuildConfig({}), null);
assert.equal(baseBuildConfig({ baseBuild: { branch: 'staging', checkout: 'rel' } }), null);
assert.equal(baseBuildConfig({ baseBuild: { branch: 'staging', checkout: '/a/../b' } }), null);
assert.equal(baseBuildConfig({ baseBuild: { branch: '-x', checkout: '/srv/x' } }), null);
assert.equal(baseBuildConfig({ baseBuild: { branch: 'staging', checkout: '/srv/x', script: '../evil.sh' } }), null);
assert.equal(baseBuildConfig({ baseBuild: { branch: 'staging', checkout: '/srv/x', user: 'a b' } }), null);
assert.deepEqual(baseBuildConfig({ baseBuild: { branch: 'staging', checkout: '/srv/x/' } }), { branch: 'staging', checkout: '/srv/x', script: 'scripts/ensure-base.sh', user: null, timeoutMin: 30, retryMin: 15 });

// decision
const now = Date.parse('2026-01-01T01:00:00Z');
assert.equal(baseBuildDecision({ state: {}, sha: 'a', now }).run, true);
assert.equal(baseBuildDecision({ state: { sha: 'a', ok: true, at: '2026-01-01T00:00:00Z' }, sha: 'a', now }).run, false);
assert.equal(baseBuildDecision({ state: { sha: 'a', ok: true }, sha: 'b', now }).run, true);
assert.equal(baseBuildDecision({ state: { sha: 'a', ok: false, at: '2026-01-01T00:55:00Z' }, sha: 'a', now }).run, false);
assert.equal(baseBuildDecision({ state: { sha: 'a', ok: false, at: '2026-01-01T00:30:00Z' }, sha: 'a', now }).run, true);
assert.equal(baseBuildDecision({ state: {}, sha: undefined, now }).run, false);

// runner
const p = { repo: 'o/shop' }, cfg = baseBuildConfig({ baseBuild: { branch: 'staging', checkout: '/srv/x' } });
const mk = (over = {}) => {
  const st = { v: over.state ?? {} }, calls = { exec: [], logs: [], mkdir: [] };
  const d = {
    githubToken: async () => 'SECRETTOK', gh: async (_t, url) => { calls.gh = url; if (over.ghFail) throw new Error('boom SECRETTOK'); return { commit: { sha: over.sha ?? 'abcdef1234' } }; },
    exec: async (cmd, args, o) => { calls.exec.push([cmd, args, o]); return (over.exec ?? (() => ({ status: 0, out: 'ok' })))(cmd, args, o); },
    exists: (f) => (over.exists ?? (() => true))(f), mkdir: (f) => calls.mkdir.push(f),
    loadState: () => st.v, saveState: (_n, s) => { st.v = s; }, log: (e, x) => calls.logs.push([e, x]), now: () => now, baseEnv: () => ({ PATH: '/bin' }),
  };
  return { d, calls, st };
};
{ // success: fetch, checkout, script; token only in git env, not in script env or args
  const { d, calls, st } = mk();
  const r = await runBaseBuild(d, 'shop', p, cfg);
  assert.equal(r.ok, true); assert.match(r.text, /ran OK/);
  assert.equal(calls.gh, '/repos/o/shop/branches/staging');
  const script = calls.exec.at(-1); assert.equal(script[0], 'bash'); assert.deepEqual(script[1], ['scripts/ensure-base.sh']);
  assert.ok(!JSON.stringify(script).includes('SECRETTOK') && !JSON.stringify(script).includes('c2VjcmV0'));
  assert.ok(!JSON.stringify(calls.exec.map((c) => c[1])).includes('SECRETTOK'));
  assert.equal(st.v.sha, 'abcdef1234'); assert.equal(st.v.ok, true);
  const again = await runBaseBuild(d, 'shop', p, cfg); assert.equal(again.ran, false); // same sha: not rerun
}
{ // fresh checkout is initialised
  const { d, calls } = mk({ exists: (f) => !f.endsWith('/.git') });
  await runBaseBuild(d, 'shop', p, cfg);
  assert.deepEqual(calls.mkdir, ['/srv/x']); assert.ok(calls.exec.some((c) => c[1].includes('init')));
}
{ // script fails: reported, token redacted, retry later
  const { d, st } = mk({ exec: (cmd) => (cmd === 'bash' ? { status: 3, out: 'push denied SECRETTOK' } : { status: 0, out: '' }) });
  const r = await runBaseBuild(d, 'shop', p, cfg);
  assert.equal(r.ok, false); assert.match(r.text, /exit 3/); assert.ok(!r.text.includes('SECRETTOK'));
  assert.equal(st.v.ok, false);
}
{ // fetch fails
  const { d } = mk({ exec: (cmd, a) => (a.includes('fetch') ? { status: 128, out: 'no' } : { status: 0, out: '' }) });
  const r = await runBaseBuild(d, 'shop', p, cfg); assert.equal(r.ok, false); assert.match(r.text, /fetch failed/);
}
{ // repo without the script: nothing runs, nothing to report
  const { d, calls } = mk({ exists: (f) => !f.endsWith('ensure-base.sh') });
  const r = await runBaseBuild(d, 'shop', p, cfg); assert.equal(r.ran, false);
  assert.ok(!calls.exec.some((c) => c[0] === 'bash'));
}
{ // GitHub lookup fails: no throw, token redacted in the log
  const { d, calls } = mk({ ghFail: true });
  const r = await runBaseBuild(d, 'shop', p, cfg); assert.equal(r.ran, false);
  assert.ok(!JSON.stringify(calls.logs).includes('SECRETTOK'));
}
{ // a second trigger during a run is not run in parallel; it reruns after
  let release; const gate = new Promise((r) => { release = r; });
  const { d, calls, st } = mk({ exec: async (cmd) => { if (cmd === 'bash') await gate; return { status: 0, out: 'ok' }; } });
  const first = runBaseBuild(d, 'shop', p, cfg);
  await new Promise((r) => setTimeout(r, 10));
  const second = await runBaseBuild(d, 'shop', p, cfg, { reason: 'merge' });
  assert.equal(second.ran, false); assert.equal(second.why, 'already running');
  release(); const r1 = await first;
  assert.equal(r1.ran, true); assert.match(r1.text, /ran OK/); // the first result survives the coalesced rerun
  assert.equal(calls.exec.filter((c) => c[0] === 'bash').length, 1); // same sha, so the rerun decided "already done"
  assert.equal(st.v.ok, true);
}
{ // user: chown + HOME from passwd
  const ucfg = baseBuildConfig({ baseBuild: { branch: 'staging', checkout: '/srv/x', user: 'dock' } });
  const { d, calls } = mk({ exec: (cmd) => (cmd === 'getent' ? { status: 0, out: 'dock:x:1:1::/home/dock:/bin/sh\n' } : { status: 0, out: '' }) });
  await runBaseBuild(d, 'shop', p, ucfg);
  assert.ok(calls.exec.some((c) => c[0] === 'chown' && c[1].includes('dock')));
  assert.equal(calls.exec.at(-1)[2].env.HOME, '/home/dock'); assert.equal(calls.exec.at(-1)[2].user, 'dock');
}
{ // retry after failure runs once retryMin passed
  const { d, calls } = mk({ state: { sha: 'abcdef1234', ok: false, at: '2026-01-01T00:00:00Z' } });
  assert.equal((await runBaseBuild(d, 'shop', p, cfg)).ran, true); assert.ok(calls.exec.some((c) => c[0] === 'bash'));
}
// merge hook only for the deploy branch
assert.equal(baseBuildApplies({ autoMerge: 'staging' }, cfg, 'merge'), true);
assert.equal(baseBuildApplies({ autoMerge: 'main' }, cfg, 'merge'), false);
assert.equal(baseBuildApplies({ autoMerge: 'main' }, cfg, 'tick'), true);
assert.equal(baseBuildApplies({}, null, 'tick'), false);
console.log('ok - basebuild');
