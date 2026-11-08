// node agents/test-loops.mjs
import assert from 'node:assert/strict';
import { loopsConfig, dueKinds, loopDecision, openLoopTasks, afterStart, afterRemind, REMINDER_EVERY_MS, loopTaskText } from './loops.mjs';

let n = 0;
const test = (name, f) => { f(); n++; console.log('ok', name); };
const T0 = Date.parse('2026-11-08T10:00:00Z');
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();

test('unset vs off vs on', () => {
  assert.equal(loopsConfig({}).mode, 'unset');
  assert.equal(loopsConfig({ loops: null }).mode, 'unset');
  assert.equal(loopsConfig({ loops: false }).mode, 'off');
  assert.equal(loopsConfig({ loops: {} }).mode, 'off');
  assert.equal(loopsConfig({ loops: { security: 'off' } }).mode, 'off');
  assert.equal(loopsConfig({ loops: { security: 'nonsense' } }).mode, 'off');
  assert.equal(loopsConfig({ loops: { security: 'weekly', bogus: 'daily' } }).mode, 'on');
  assert.deepEqual(Object.keys(loopsConfig({ loops: { security: 'weekly', bogus: 'daily' } }).kinds), ['security']);
});
test('default cadence is weekly', () => {
  assert.equal(loopsConfig({ loops: { docs: true } }).kinds.docs, 7 * DAY);
  assert.equal(loopsConfig({ loops: { docs: 'on' } }).kinds.docs, 7 * DAY);
});
test('due: never run is due; before the cadence is not; at the cadence is', () => {
  const c = loopsConfig({ loops: { security: 'weekly' } });
  assert.deepEqual(dueKinds(c, {}, T0), ['security']);
  assert.deepEqual(dueKinds(c, { lastStarted: { security: iso(T0 - 6 * DAY) } }, T0), []);
  assert.deepEqual(dueKinds(c, { lastStarted: { security: iso(T0 - 7 * DAY) } }, T0), ['security']);
});
test('start: most overdue kind first, one at a time', () => {
  const project = { loops: { security: 'weekly', docs: 'weekly' } };
  const state = { lastStarted: { security: iso(T0 - 8 * DAY), docs: iso(T0 - 20 * DAY) } };
  const d = loopDecision({ name: 'shop', project, state, now: T0 });
  assert.equal(d.action, 'start');
  assert.equal(d.kind, 'docs');
  assert.deepEqual(d.due, ['docs', 'security']);
});
test('not due: waits', () => {
  const d = loopDecision({ name: 'shop', project: { loops: { cleanup: 'monthly' } }, state: { lastStarted: { cleanup: iso(T0 - 7 * DAY) } }, now: T0 });
  assert.deepEqual(d, { action: 'wait', why: 'not due' });
});
test('cap: a due loop waits while one loop PR is open, starts once it closes', () => {
  const project = { loops: { security: 'weekly' } };
  const tasks = [{ id: 'a', project: 'shop', loop: 'docs', status: 'reviewing' }, { id: 'b', project: 'shop', loop: 'docs', status: 'merged' }, { id: 'c', project: 'other', loop: 'docs', status: 'working' }, { id: 'd', project: 'shop', status: 'working' }];
  const open = openLoopTasks(tasks, 'shop');
  assert.deepEqual(open.map((t) => t.id), ['a']);
  const d = loopDecision({ name: 'shop', project, state: {}, openLoops: open, now: T0 });
  assert.equal(d.action, 'wait'); assert.equal(d.why, 'cap'); assert.deepEqual(d.due, ['security']);
  assert.equal(loopDecision({ name: 'shop', project, state: {}, openLoops: [], now: T0 }).action, 'start');
});
test('a loop PR merged or closed by hand frees the cap, whatever the task status says', () => {
  const tasks = ['merged', 'closed', 'open'].map((state, i) => ({ id: String(i), project: 'shop', loop: 'docs', status: 'ready for you', pr: { state } }));
  assert.deepEqual(openLoopTasks(tasks, 'shop').map((t) => t.id), ['2']);
});
test('a stopped or done loop task does not hold the cap', () => {
  const tasks = ['stopped', 'done', 'merged'].map((status, i) => ({ id: String(i), project: 'shop', loop: 'docs', status }));
  assert.equal(openLoopTasks(tasks, 'shop').length, 0);
});
test('reminder: unset project is reminded, then throttled to a week', () => {
  const d = loopDecision({ name: 'shop', project: {}, state: {}, now: T0 });
  assert.equal(d.action, 'remind'); assert.match(d.text, /shop/); assert.match(d.text, /loops/);
  const s = afterRemind({}, T0);
  assert.equal(loopDecision({ name: 'shop', project: {}, state: s, now: T0 + REMINDER_EVERY_MS - 1 }).action, 'none');
  assert.equal(loopDecision({ name: 'shop', project: {}, state: s, now: T0 + REMINDER_EVERY_MS }).action, 'remind');
});
test('off is never reminded and never started', () => {
  const d = loopDecision({ name: 'shop', project: { loops: false }, state: {}, now: T0 });
  assert.deepEqual(d, { action: 'wait', why: 'off' });
});
test('an on project is never reminded', () => {
  assert.notEqual(loopDecision({ name: 'shop', project: { loops: { docs: 'weekly' } }, state: {}, now: T0 }).action, 'remind');
});
test('afterStart records the kind and keeps the rest', () => {
  const s = afterStart({ lastReminder: 'x', lastStarted: { docs: 'y' } }, 'security', T0);
  assert.equal(s.lastStarted.security, iso(T0)); assert.equal(s.lastStarted.docs, 'y'); assert.equal(s.lastReminder, 'x');
});
test('task text names the kind, the project, and keeps to one small PR', () => {
  const t = loopTaskText('security', 'shop');
  assert.match(t, /security/); assert.match(t, /shop/); assert.match(t, /ONE small/);
});
console.log(`${n} passed`);
