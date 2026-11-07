// node agents/test-lifecycle.mjs
import assert from 'node:assert/strict';
import { nextStatusAfterAgentTurn as next } from './lifecycle.mjs';
import { checkUnasked } from './unasked.mjs';
import { SAYRA, REPORT } from './test-unasked.mjs';

const change = (o = {}) => ({ kind: 'change', reviewedSha: null, verdict: null, ...o });
const base = (o = {}) => ({ task: change(), mode: 'bypassPermissions', from: 'person', head: 'aaa1111', hasChecks: false, hasQa: false, ...o });
const cases = [
  ['new head, no checks: panel', base(), 'reviewing'],
  ['new head, no checks, QA available: QA first', base({ hasQa: true }), 'testing'],
  ['new head with checks: wait for them', base({ hasChecks: true }), 'waiting for checks'],
  ['checks green: panel', base({ hasChecks: true, task: change({ greenSha: 'aaa11' }) }), 'reviewing'],
  ['no PR: waiting for you', base({ head: null }), 'waiting for you'],
  ['plan mode: waiting for you', base({ mode: 'plan' }), 'waiting for you'],
  ['pause: paused', base({ from: 'pause' }), 'paused'],
  ['DECISION NEEDED block: decision needed', base({ decision: true }), 'decision needed'],
  // stall fixed in PR 25
  ['answer to review findings, no new commit: back to the panel', base({ from: 'review', task: change({ reviewedSha: 'aaa1111', verdict: 'CHANGES' }) }), 'reviewing'],
  ['restart mid-review-fix keeps the origin: back to the panel', base({ from: 'pickup', origin: 'review', task: change({ reviewedSha: 'aaa1111', verdict: 'CHANGES' }) }), 'reviewing'],
  ['no new commit, not a review answer: waiting for you', base({ task: change({ reviewedSha: 'aaa1111', verdict: 'CHANGES' }) }), 'waiting for you'],
  ['no new commit after PASS: ready for you', base({ task: change({ reviewedSha: 'aaa1111', verdict: 'PASS' }) }), 'ready for you'],
  ['person answers a caught question from a review round (origin kept), no commit: back to the panel', base({ from: 'person', origin: 'review', task: change({ reviewedSha: 'aaa1111', verdict: 'CHANGES' }) }), 'reviewing'],
  // unasked questions
  ['plain-text question: decision needed, no panel', base({ unasked: true }), 'decision needed'],
  ['plain-text question beats an answer-to-review panel return', base({ unasked: true, from: 'review', task: change({ reviewedSha: 'aaa1111', verdict: 'CHANGES' }) }), 'decision needed'],
  ['plain-text question with no PR: decision needed', base({ unasked: true, head: null }), 'decision needed'],
  ['plain-text question in a report: decision needed', base({ unasked: true, task: { kind: 'report' } }), 'decision needed'],
  ['report without a question: done', base({ task: { kind: 'report' } }), 'done'],
  ['pause wins over a question', base({ unasked: true, from: 'pause' }), 'paused'],
];
for (const [name, input, want] of cases) { assert.equal(next(input), want, name); console.log(`ok - ${name}`); }

// the stubbed turn: a reply ending in a plain-text question lands on 'decision needed' with no panel run
const stub = async (reply) => {
  const asked = await checkUnasked(reply, { ask: async () => (reply === SAYRA ? '{"asks":true,"question":"purple or teal?","options":["purple","teal"]}' : '{"asks":false}') });
  return next(base({ unasked: asked.asks }));
};
assert.equal(await stub(SAYRA), 'decision needed'); console.log('ok - stubbed Sayra turn lands on decision needed (not reviewing)');
assert.equal(await stub(REPORT), 'reviewing'); console.log('ok - stubbed plain report goes on to the panel');
console.log(`all ${cases.length + 2} passed`);
