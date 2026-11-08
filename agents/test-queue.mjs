// node agents/test-queue.mjs
import assert from 'node:assert/strict';
import { addAgentJob, takeJobs } from './queue.mjs';

let n = 0;
const test = (name, f) => { f(); n++; console.log('ok', name); };
const agent = (id, prompt, from = 'you', extra = {}) => ({ id, kind: 'agent', prompt, mode: 'bypassPermissions', from, ...extra });

// the 2026-11-08 incident: two person messages and a review's CHANGES queued for one
// task were all started at once, because a job only counted as running once its
// container had started (after an await), and pump() took jobs in one synchronous loop
test('three queued jobs of one task: one starts, the others wait', () => {
  const q = [agent('t', 'a'), { id: 't', kind: 'review' }, agent('t', 'b')];
  const started = takeJobs(q, new Set(), 5);
  assert.deepEqual(started.map((j) => j.id), ['t']);
  assert.equal(q.length, 2);
});
test('a task whose job is still being handled (container gone) gets no second job', () => {
  const q = [agent('t', 'a'), agent('u', 'b')];
  assert.deepEqual(takeJobs(q, new Set(['t']), 5).map((j) => j.id), ['u']);
  assert.deepEqual(q.map((j) => j.id), ['t']);
});
test('the cap counts busy tasks, and jobs started in this pass', () => {
  const q = [agent('a', '1'), agent('b', '2'), agent('c', '3')];
  assert.deepEqual(takeJobs(q, new Set(['x']), 3).map((j) => j.id), ['a', 'b']);
  assert.deepEqual(q.map((j) => j.id), ['c']);
  assert.deepEqual(takeJobs(q, new Set(['x', 'a', 'b']), 3), []);
});
test('queue order is kept across tasks', () => {
  const q = [agent('a', '1'), agent('a', '2'), agent('b', '3')];
  assert.deepEqual(takeJobs(q, new Set(), 5).map((j) => j.prompt), ['1', '3']);
});

test('a second message for a task with an agent job waiting: merged into that job', () => {
  const q = [agent('t', 'remove the topic thing')];
  addAgentJob(q, agent('t', 'make the voice room simpler'));
  assert.equal(q.length, 1);
  assert.match(q[0].prompt, /remove the topic thing[\s\S]*make the voice room simpler/);
  assert.equal(q[0].from, 'you');
});
test('a review fix merged with a message stays a review fix', () => {
  const q = [agent('t', 'msg')];
  addAgentJob(q, agent('t', '[review] changes', 'review'));
  assert.equal(q.length, 1);
  assert.ok([q[0].from, q[0].origin].includes('review'));
  const q2 = [agent('t', '[review] changes', 'review')];
  addAgentJob(q2, agent('t', 'msg'));
  assert.ok([q2[0].from, q2[0].origin].includes('review'));
});
test('not merged: another task, another mode, a pause, or a non-agent job in between', () => {
  const q = [agent('t', 'a')];
  addAgentJob(q, agent('u', 'b'));
  addAgentJob(q, { ...agent('t', 'plan it'), mode: 'plan' });
  addAgentJob(q, agent('t', 'pause', 'pause'));
  assert.equal(q.length, 4);
  const q2 = [agent('t', 'a'), { id: 't', kind: 'review' }];
  addAgentJob(q2, agent('t', 'b'));
  assert.equal(q2.length, 3);
});
console.log(`${n} passed`);
