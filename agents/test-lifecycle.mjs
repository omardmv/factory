// node agents/test-lifecycle.mjs
import assert from 'node:assert/strict';
import { verdictOf, qaVerdictOf, afterAgentRun, crashRetryPrompt, afterCoordinator, pickupJob, afterQa, panelVerdict, afterReview, afterFactoryReport } from './lifecycle.mjs';

let n = 0;
const test = async (name, f) => { await f(); n++; console.log('ok', name); };
const openPr = (head = 'bbb2222') => ({ number: 7, state: 'open', head });
const task = (o = {}) => ({ kind: 'change', status: 'working', factoryRounds: 0, ...o });
const deps = (o = {}) => ({ findPr: async () => openPr(), hasChecks: () => true, hasQa: () => false, ...o });
const run = (t, o = {}, d = deps()) => afterAgentRun({ task: t, from: 'start', mode: 'bypassPermissions', reply: 'done', maxCrashRetries: 2, ...o }, d);
const status = async (t, o, d) => (await run(t, o, d)).status;

await test('verdict lines are parsed', () => {
  assert.equal(verdictOf('x\nVERDICT: pass'), 'PASS');
  assert.equal(verdictOf('VERDICT: CHANGES'), 'CHANGES');
  assert.equal(verdictOf('no verdict'), null);
  assert.equal(verdictOf(undefined), null);
  assert.equal(qaVerdictOf('QA VERDICT: not applicable'), 'NOT APPLICABLE');
  assert.equal(qaVerdictOf('QA VERDICT: FAIL'), 'FAIL');
  assert.equal(qaVerdictOf('VERDICT: PASS'), null);
});

// ---- after an agent turn ----
await test('stopped by the person: nothing else happens', async () => {
  assert.deepEqual(await run(task({ status: 'stopped' })), { type: 'stopped' });
});
await test('pausing: one checkpoint turn; the checkpoint turn itself rests', async () => {
  assert.deepEqual(await run(task({ status: 'pausing' })), { type: 'checkpoint' });
  const r = await run(task({ status: 'pausing' }), { from: 'pause' });
  assert.equal(r.status, 'paused');
});
await test('plan mode on a change: waits for the person', async () => {
  assert.equal(await status(task(), { mode: 'plan' }), 'waiting for you');
});
await test('DECISION NEEDED on a change', async () => {
  assert.equal(await status(task(), { reply: 'DECISION NEEDED\noptions' }), 'decision needed');
});
await test('no open PR: waiting for you', async () => {
  assert.equal(await status(task(), {}, deps({ findPr: async () => null })), 'waiting for you');
  assert.equal(await status(task(), {}, deps({ findPr: async () => ({ number: 7, state: 'merged', head: 'x' }) })), 'waiting for you');
});
await test('the PR found is returned; the old PR is kept when the lookup fails', async () => {
  assert.equal((await run(task())).pr.number, 7);
  const old = { number: 3, state: 'open', head: 'old' };
  assert.deepEqual((await run(task({ pr: old }), {}, deps({ findPr: async () => null }))).pr, old);
});
await test('no checks configured: straight to the panel (or QA when the project has it)', async () => {
  assert.equal(await status(task(), {}, deps({ hasChecks: () => false })), 'reviewing');
  assert.equal(await status(task(), {}, deps({ hasChecks: () => false, hasQa: () => true })), 'testing');
});
await test('checks configured, not green yet: waiting for checks', async () => {
  assert.equal(await status(task(), {}), 'waiting for checks');
  assert.equal(await status(task({ greenSha: 'aaa1111' }), {}), 'waiting for checks');
});
await test('green head: panel, or QA once per head', async () => {
  const t = task({ greenSha: 'bbb2222' });
  assert.equal(await status(t, {}), 'reviewing');
  assert.equal(await status(t, {}, deps({ hasQa: () => true })), 'testing');
  assert.equal(await status({ ...t, qaTestedSha: 'bbb2222' }, {}, deps({ hasQa: () => true })), 'reviewing'); // QA already saw this head
});
await test('nothing new since the review: ready if it passed, else waiting', async () => {
  assert.equal(await status(task({ reviewedSha: 'bbb2222', verdict: 'PASS' })), 'ready for you');
  assert.equal(await status(task({ reviewedSha: 'bbb2222', verdict: 'CHANGES' })), 'waiting for you');
  assert.equal(await status(task({ reviewedSha: 'bbb2222', verdict: null })), 'waiting for you');
});
await test('STALL 1 (PR 25): an answer to review findings with no new commit goes back to the panel', async () => {
  const t = task({ reviewedSha: 'bbb2222', verdict: 'CHANGES' });
  assert.equal(await status(t, { from: 'review' }), 'reviewing');
  assert.equal(await status(t, { from: 'pickup', origin: 'review' }), 'reviewing'); // restarted mid-answer
  assert.equal(await status(t, { from: 'person' }), 'waiting for you'); // not a review fix: parked with a reason
  assert.equal(await status({ ...t, verdict: null }, { from: 'review' }), 'reviewing');
  // a passing verdict is not sent back
  assert.equal(await status({ ...t, verdict: 'PASS' }, { from: 'review' }), 'ready for you');
  // a new commit takes the normal path
  assert.equal(await status({ ...t, greenSha: 'bbb2222' }, { from: 'review' }, deps({ findPr: async () => openPr('bbb2222') })), 'reviewing');
  assert.equal(await status({ ...t, reviewedSha: 'old0000' }, { from: 'review' }), 'waiting for checks');
});
await test('STALL 2 (PR 26): a turn that dies without a reply carries on, bounded by MAX_CRASH_RETRIES', async () => {
  let r = await run(task(), { reply: '' });
  assert.deepEqual(r, { type: 'retry', retry: 1, from: 'start' });
  r = await run(task({ crashRetries: 1 }), { reply: '' });
  assert.deepEqual(r, { type: 'retry', retry: 2, from: 'start' });
  r = await run(task({ crashRetries: 2 }), { reply: '' }, deps({ findPr: async () => null })); // exhausted: falls through to the normal decision, not looped
  assert.equal(r.type, 'status');
  assert.equal(r.status, 'waiting for you');
  assert.equal(r.resetCrash, false);
  r = await run(task({ crashRetries: 0 }), { reply: '', maxCrashRetries: 0 });
  assert.equal(r.type, 'status');
  // a reply resets the counter
  assert.equal((await run(task({ crashRetries: 2 }))).resetCrash, true);
  // the pause checkpoint is never retried
  assert.equal((await run(task(), { reply: '', from: 'pause' })).status, 'paused');
  // a stop wins over a retry; a pause request wins too
  assert.equal((await run(task({ status: 'stopped' }), { reply: '' })).type, 'stopped');
  assert.equal((await run(task({ status: 'pausing' }), { reply: '' })).type, 'checkpoint');
  assert.match(crashRetryPrompt(1, 2), /retry 1 of 2/);
});
await test('a retry keeps a review fix a review fix (so its answer reaches the panel)', async () => {
  assert.equal((await run(task(), { reply: '', from: 'review' })).from, 'review');
  assert.equal((await run(task(), { reply: '', from: 'pickup', origin: 'review' })).from, 'review');
  assert.equal((await run(task(), { reply: '', from: 'qa' })).from, 'qa');
  assert.equal((await run(task(), { reply: '', from: 'pickup', origin: 'qa' })).from, 'pickup');
});
await test('reports: done, or decision, or waiting after a brief', async () => {
  const t = { kind: 'report', status: 'working' };
  assert.equal(await status(t, {}), 'done');
  assert.equal(await status(t, { reply: 'DECISION NEEDED' }), 'decision needed');
  assert.equal(await status(t, { mode: 'plan' }), 'waiting for you');
  assert.equal(await status(t, { from: 'pause' }), 'paused');
});
await test('programs hand over to the coordinator logic', async () => {
  assert.deepEqual(await run({ kind: 'program' }, { reply: 'PROGRAM DONE' }), { type: 'coordinator', decision: false, resetCrash: true });
  assert.equal((await run({ kind: 'program' }, { reply: 'DECISION NEEDED' })).decision, true);
});

await test('coordinator: decision, done, talk, brief, running, revision', () => {
  assert.deepEqual(afterCoordinator({ phase: 'run', reply: 'x', decision: true }), { status: 'decision needed' });
  assert.deepEqual(afterCoordinator({ phase: 'run', reply: 'PROGRAM DONE\nall', decision: false }), { status: 'done', closeEpic: true });
  assert.deepEqual(afterCoordinator({ phase: 'talk', reply: '```plan\n{}\n```' }), { status: 'waiting for you' });
  assert.deepEqual(afterCoordinator({ phase: 'brief', reply: 'plan' }), { status: 'waiting for you' });
  assert.deepEqual(afterCoordinator({ phase: 'run', reply: 'just an answer' }), { status: 'running', revise: false });
  assert.deepEqual(afterCoordinator({ phase: 'run', reply: 'new\n```plan\n{}\n```' }), { status: 'running', revise: true });
});

// ---- restart ----
await test('STALL 3: a restart mid-review-fix keeps the job origin', () => {
  const job = { id: 'a', kind: 'agent', prompt: 'p', mode: 'bypassPermissions', from: 'review' };
  const p = pickupJob({ status: 'working', sessionId: 's1', job });
  assert.equal(p.job.from, 'pickup');
  assert.equal(p.job.origin, 'review');
  assert.match(p.job.prompt, /interrupted/);
  // restarted again before it finished: the origin is still the review
  const again = pickupJob({ status: 'working', sessionId: 's1', job: p.job });
  assert.equal(again.job.origin, 'review');
  assert.equal(again.job.from, 'pickup');
});
await test('pickup: no session starts over; pause stays; review/qa run again; stopped/paused drop', () => {
  const job = { id: 'a', kind: 'agent', prompt: 'p', from: 'start' };
  assert.deepEqual(pickupJob({ status: 'working', job }).job, job);
  assert.deepEqual(pickupJob({ status: 'pausing', sessionId: 's', job: { ...job, from: 'pause' } }).job.from, 'pause');
  assert.deepEqual(pickupJob({ status: 'reviewing', sessionId: 's', job: { id: 'a', kind: 'review' } }).job, { id: 'a', kind: 'review' });
  assert.deepEqual(pickupJob({ status: 'testing', sessionId: 's', job: { id: 'a', kind: 'qa' } }).job, { id: 'a', kind: 'qa' });
  assert.equal(pickupJob({ status: 'stopped', job }).drop, true);
  assert.equal(pickupJob({ status: 'paused', job }).drop, true);
});

// ---- QA ----
await test('QA: PASS and NOT APPLICABLE go to the panel', () => {
  for (const verdict of ['PASS', 'NOT APPLICABLE']) assert.deepEqual(afterQa({ task: task(), verdict, maxRounds: 6 }), { action: 'review', status: 'reviewing' });
});
await test('QA: FAIL goes back to the agent, counted, until the round limit', () => {
  assert.deepEqual(afterQa({ task: task({ factoryRounds: 5 }), verdict: 'FAIL', maxRounds: 6 }), { action: 'fix', status: 'working', factoryRounds: 6 });
  const o = afterQa({ task: task({ factoryRounds: 6 }), verdict: 'FAIL', maxRounds: 6 });
  assert.equal(o.action, 'wait'); assert.equal(o.status, 'waiting for you'); assert.match(o.say, /round limit \(6\).*QA failures/);
});
await test('QA: no verdict is a person\'s call, with a reason', () => {
  const o = afterQa({ task: task(), verdict: null, maxRounds: 6 });
  assert.equal(o.status, 'waiting for you'); assert.match(o.say, /no clear verdict/);
});
await test('QA: stop and pause win', () => {
  assert.equal(afterQa({ task: task({ status: 'stopped' }), verdict: 'FAIL', maxRounds: 6 }).action, 'stopped');
  assert.deepEqual(afterQa({ task: task({ status: 'pausing' }), verdict: 'PASS', maxRounds: 6 }), { action: 'paused', status: 'paused' });
});

// ---- review ----
await test('panel verdict: every reviewer must pass', () => {
  assert.equal(panelVerdict(['PASS', 'PASS'], 2), 'PASS');
  assert.equal(panelVerdict(['PASS', 'CHANGES'], 2), 'CHANGES');
  assert.equal(panelVerdict(['PASS', null], 2), null);
  assert.equal(panelVerdict(['PASS'], 2), null); // stopped half way
  assert.equal(panelVerdict(['CHANGES'], 2), 'CHANGES');
  assert.equal(panelVerdict([], 2), null);
});
await test('review PASS: ready; merges by itself only with autoMerge and no QA dispute', () => {
  assert.deepEqual(afterReview({ task: task(), verdict: 'PASS', headSha: 'h', autoMerge: 'dev', maxRounds: 6 }), { action: 'pass', status: 'ready for you', mergeWanted: true, disputed: false });
  assert.equal(afterReview({ task: task(), verdict: 'PASS', headSha: 'h', autoMerge: undefined, maxRounds: 6 }).mergeWanted, false);
  const o = afterReview({ task: task({ qaVerdict: 'FAIL', qaTestedSha: 'h' }), verdict: 'PASS', headSha: 'h', autoMerge: 'dev', maxRounds: 6 });
  assert.equal(o.mergeWanted, false); assert.equal(o.disputed, true);
  // a QA fail on an older head is not a dispute
  assert.equal(afterReview({ task: task({ qaVerdict: 'FAIL', qaTestedSha: 'old' }), verdict: 'PASS', headSha: 'h', autoMerge: 'dev', maxRounds: 6 }).mergeWanted, true);
});
await test('review CHANGES: back to the agent, counted, until the round limit', () => {
  assert.deepEqual(afterReview({ task: task({ factoryRounds: 2 }), verdict: 'CHANGES', headSha: 'h', maxRounds: 6 }), { action: 'fix', status: 'working', factoryRounds: 3 });
  const o = afterReview({ task: task({ factoryRounds: 6 }), verdict: 'CHANGES', headSha: 'h', maxRounds: 6 });
  assert.equal(o.action, 'wait'); assert.match(o.say, /round limit \(6\).*review findings/);
});
await test('review: no verdict waits with a reason; stop and pause win', () => {
  const o = afterReview({ task: task(), verdict: null, headSha: 'h', maxRounds: 6 });
  assert.equal(o.status, 'waiting for you'); assert.match(o.say, /no clear verdict/);
  assert.equal(afterReview({ task: task({ status: 'stopped' }), verdict: 'PASS', headSha: 'h', maxRounds: 6 }).action, 'stopped');
  assert.equal(afterReview({ task: task({ status: 'pausing' }), verdict: 'CHANGES', headSha: 'h', maxRounds: 6 }).status, 'paused');
});

// ---- [factory] reports from the checks ----
await test('checks report: red counts a round, green does not, the limit stops', () => {
  const t = task({ phase: 'run', factoryRounds: 1, previewHost: 'https://old' });
  assert.deepEqual(afterFactoryReport({ task: t, text: '[factory] ❌ e2e failed', maxRounds: 6 }), { action: 'run', green: false, factoryRounds: 2 });
  assert.deepEqual(afterFactoryReport({ task: t, text: '[factory] ✅ green (`abc1234`) preview ready at https://pr-7.example.org/app/', maxRounds: 6 }), { action: 'run', green: true, greenSha: 'abc1234', previewHost: 'https://pr-7.example.org' });
  assert.equal(afterFactoryReport({ task: t, text: '✅ green (`abc1234`)', maxRounds: 6 }).previewHost, 'https://old');
  assert.equal(afterFactoryReport({ task: { ...t, factoryRounds: 6 }, text: '❌ red', maxRounds: 6 }).action, 'limit');
  assert.equal(afterFactoryReport({ task: { ...t, factoryRounds: 6 }, text: '✅ (`abc1234`)', maxRounds: 6 }).action, 'run'); // green never hits the limit
  assert.equal(afterFactoryReport({ task: { ...t, factoryRounds: 6 }, text: '✅ no sha', maxRounds: 6 }).action, 'limit');
});
await test('checks report: ignored when not running a change', () => {
  for (const o of [{ phase: 'brief' }, { status: 'stopped' }, { status: 'paused' }, { status: 'pausing' }, { status: 'merged' }, { kind: 'program' }, { kind: 'report' }])
    assert.equal(afterFactoryReport({ task: task({ phase: 'run', ...o }), text: '❌', maxRounds: 6 }).action, 'ignore');
});

console.log(`${n} groups passed`);
