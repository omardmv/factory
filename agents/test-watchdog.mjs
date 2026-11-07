// node agents/test-watchdog.mjs
import assert from 'node:assert/strict';
import { statusClock, watchdogDecision, LIMIT_MIN, GRACE_MIN } from './watchdog.mjs';

let n = 0;
const test = async (name, f) => { await f(); n++; console.log('ok', name); };
const T0 = Date.parse('2026-11-07T10:00:00Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();
const task = (status, o = {}) => ({ status, statusSince: at(0), ...o });
const ctx = (min, o = {}) => ({ now: T0 + min * 60000, ...o });

await test('limits per state: just under is quiet, at the limit nudges', () => {
  for (const [state, limit] of Object.entries(LIMIT_MIN)) {
    assert.equal(watchdogDecision(task(state), ctx(limit - 1)).action, 'none', state);
    const d = watchdogDecision(task(state), ctx(limit));
    assert.equal(d.action, 'nudge', state);
    assert.equal(d.state, state);
    assert.match(d.text, new RegExp(`${state} for ${limit} min`));
  }
});
await test('defaults: queued is the shortest (about 5 min), long states are longer', () => {
  assert.equal(LIMIT_MIN.queued, 5);
  for (const s of ['working', 'reviewing', 'testing', 'waiting for checks']) assert.ok(LIMIT_MIN[s] > LIMIT_MIN.queued * 3, s);
  assert.ok(GRACE_MIN < LIMIT_MIN.working);
});
await test('states that are not moving by design are never watched', () => {
  for (const s of ['waiting for you', 'decision needed', 'ready for you', 'paused', 'pausing', 'stopped', 'done', 'merged', 'running · 1/3 merged', 'verifying'])
    assert.equal(watchdogDecision(task(s), ctx(10000)).action, 'none', s);
});
await test('queued: only stuck when nothing is running; busy slots are just waiting their turn', () => {
  assert.equal(watchdogDecision(task('queued'), ctx(60, { anyRunning: true })).action, 'none');
  assert.equal(watchdogDecision(task('queued'), ctx(60, { running: true })).action, 'none');
  assert.equal(watchdogDecision(task('queued'), ctx(5)).action, 'nudge');
});
await test('a queued job behind full slots is waiting its turn in any state, not stuck', () => {
  for (const s of ['working', 'reviewing', 'testing', 'waiting for checks']) {
    assert.equal(watchdogDecision(task(s), ctx(500, { inQueue: true, slotsFull: true })).action, 'none', s);
    assert.equal(watchdogDecision(task(s, { watchNudgedAt: at(30) }), ctx(500, { inQueue: true, slotsFull: true })).action, 'none', s);
  }
  // free slots but still queued for 30 min: that is stuck
  assert.equal(watchdogDecision(task('working'), ctx(40, { inQueue: true, slotsFull: false })).action, 'nudge');
});
await test('a sign of life (agent activity) restarts the clock', () => {
  assert.equal(watchdogDecision(task('working'), ctx(40, { running: true, lastActivityAt: at(35) })).action, 'none');
  assert.equal(watchdogDecision(task('working'), ctx(40, { running: true, lastActivityAt: at(5) })).action, 'nudge');
});
await test('one nudge only: after it, quiet until the grace period passes', () => {
  const nudged = task('working', { watchNudgedAt: at(30) });
  assert.equal(watchdogDecision(nudged, ctx(31)).action, 'none');
  assert.equal(watchdogDecision(nudged, ctx(30 + GRACE_MIN - 1)).action, 'none');
  assert.notEqual(watchdogDecision(nudged, ctx(30 + GRACE_MIN + 100)).action, 'nudge');
});
await test('escalation after the grace period: exact text, ping, state and why', () => {
  const d = watchdogDecision(task('reviewing', { watchNudgedAt: at(30) }), ctx(30 + GRACE_MIN));
  assert.equal(d.action, 'escalate');
  assert.equal(d.ping, true);
  assert.match(d.text, /^\[factory\] STUCK: this task has been reviewing for 35 min and did not move 5 min after the automatic nudge\. Why: the review panel has not reported in 35 min; no container is running\./);
  const q = watchdogDecision(task('queued', { watchNudgedAt: at(5) }), ctx(10));
  assert.match(q.text, /queued for 10 min[\s\S]*nothing running/);
  const w = watchdogDecision(task('working', { watchNudgedAt: at(30) }), ctx(36, { running: true }));
  assert.match(w.text, /container is running but silent/);
});
await test('escalated once, never again (until the status changes and the marks are cleared)', () => {
  const t = task('working', { watchNudgedAt: at(30), watchEscalatedAt: at(36) });
  assert.equal(watchdogDecision(t, ctx(500)).action, 'none');
});
await test('activity after the nudge restarts the grace clock', () => {
  const t = task('working', { watchNudgedAt: at(30) });
  assert.equal(watchdogDecision(t, ctx(37, { running: true, lastActivityAt: at(34) })).action, 'none');
  assert.equal(watchdogDecision(t, ctx(40, { running: true, lastActivityAt: at(34) })).action, 'escalate');
});
await test('a stalled fake task: nudge, then ping, then silence', () => {
  let t = task('waiting for checks');
  const seen = [];
  for (let m = 0; m <= 120; m++) {
    const d = watchdogDecision(t, ctx(m));
    if (d.action === 'nudge') t = { ...t, watchNudgedAt: at(m) };
    if (d.action === 'escalate') t = { ...t, watchEscalatedAt: at(m) };
    if (d.action !== 'none') seen.push([m, d.action]);
  }
  assert.deepEqual(seen, [[LIMIT_MIN['waiting for checks'], 'nudge'], [LIMIT_MIN['waiting for checks'] + GRACE_MIN, 'escalate']]);
});

await test('waiting for checks: the nudge turn (working and back) keeps the marks; then a ping, never a second nudge', () => {
  let t = { status: 'waiting for checks' }; statusClock(t, at(0));
  const seen = [];
  const step = (m) => {
    const d = watchdogDecision(t, ctx(m)); if (d.action === 'none') return;
    seen.push([m, d.action]);
    if (d.action === 'escalate') t.watchEscalatedAt = at(m);
    else { t.watchNudgedAt = at(m); t.watchState = d.state; t.job = { from: 'nudge' }; }
  };
  for (let m = 1; m <= 200; m++) {
    step(m);
    if (m === 32) { t.status = 'working'; statusClock(t, at(m)); }            // the nudge turn starts
    if (m === 34) { t.status = 'waiting for checks'; statusClock(t, at(m)); delete t.job; } // ...ends, nothing changed
  }
  assert.deepEqual(seen.map((x) => x[1]), ['nudge', 'escalate']);
  assert.ok(seen[1][0] >= 34 + GRACE_MIN);
});
await test('real movement (a new status other than the nudge turn) clears the marks', () => {
  const t = { status: 'waiting for checks', watchNudgedAt: at(30), watchState: 'waiting for checks', job: { from: 'nudge' } }; statusClock(t, at(30)); t.statusOf = 'waiting for checks';
  t.status = 'reviewing'; statusClock(t, at(40));
  assert.equal(t.watchNudgedAt, undefined);
  const u = { status: 'working', watchNudgedAt: at(30) }; statusClock(u, at(31)); // legacy task: adopted, marks kept
  assert.equal(u.watchNudgedAt, at(30));
});

console.log(`${n} groups passed`);
