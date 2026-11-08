// node agents/test-unasked.mjs
import assert from 'node:assert/strict';
import { checkUnasked, parseUnasked, hasDecisionBlock, decisionMessage, waitingOnLine } from './unasked.mjs';

// realistic fixtures from the real stalls (the stub "model" answers by keyword, as haiku would)
export const SHOP_REPLY = `The Edit profile button is done and the e2e test passes.

Two things need your call:
1. The design doc (PRODUCT.md) says the primary button is purple, but the live app uses the teal accent everywhere else. I used purple for Edit profile to match the doc.
2. Should the button also appear on other people's profiles?

Let me know and I'll adjust.`;
export const CI = `PR is up. The Playwright e2e job fails in CI because the runner has no browsers installed; locally it passes.

Do you want me to (a) add a browser install step to the workflow, or (b) skip the e2e job for this PR? I'd lean to (a) but it changes CI for every project.`;
export const REPORT = `Done. Added the profile page route, 3 e2e tests (all green), screenshots in the PR comment. Decisions: kept the teal accent, logged in decisions.tsv. Nothing else open.`;
const answers = new Map([
  [SHOP_REPLY, '{"asks": true, "question": "Edit profile button: purple (PRODUCT.md) or the live app\'s teal? And show it on other profiles?", "options": ["purple per the doc", "teal like the live app"]}'],
  [CI, 'Sure: {"asks": true, "question": "Add a browser install step to CI, or skip e2e for this PR?", "options": ["add install step", "skip e2e"]}'],
  [REPORT, '{"asks": false, "question": "", "options": []}'],
]);
const ask = async (prompt) => { for (const [k, v] of answers) if (prompt.includes(k.slice(0, 60))) return v; throw new Error('no stub'); };

let n = 0; const ok = (name) => console.log(`ok - ${name}`) || n++;
let r = await checkUnasked(SHOP_REPLY, { ask });
assert.equal(r.asks, true); assert.equal(r.options.length, 2); assert.match(r.question, /purple/); ok('the purple-button question is caught');
r = await checkUnasked(CI, { ask });
assert.equal(r.asks, true); assert.match(r.question, /browser install/); ok('CI/Playwright question is caught (JSON inside prose)');
assert.deepEqual(await checkUnasked(REPORT, { ask }), { asks: false }); ok('a plain report is not');

let calls = 0;
const counting = async () => { calls++; return '{"asks": true, "question": "x", "options": []}'; };
assert.deepEqual(await checkUnasked('DECISION NEEDED\nA or B?', { ask: counting }), { asks: false });
assert.equal(calls, 0); ok('no model call when the reply already has DECISION NEEDED');
assert.deepEqual(await checkUnasked('  ', { ask: counting }), { asks: false }); assert.equal(calls, 0); ok('no call on an empty reply');

const logs = [];
const log = (k) => logs.push(k);
assert.deepEqual(await checkUnasked(SHOP_REPLY, { ask: async () => { throw new Error('boom'); }, log }), { asks: false }); ok('fails open on error');
assert.deepEqual(await checkUnasked(SHOP_REPLY, { ask: () => new Promise(() => {}), timeoutMs: 20, log }), { asks: false }); ok('fails open on timeout');
assert.deepEqual(await checkUnasked(SHOP_REPLY, { ask: async () => 'I think so', log }), { asks: false }); ok('fails open on unreadable answer');
assert.deepEqual(logs, ['unasked.failed', 'unasked.failed', 'unasked.unreadable']); ok('each failure is logged');
assert.equal(parseUnasked('{"asks": true, "question": "", "options": []}').asks, false); ok('asks with no question is not a question');
assert.equal(hasDecisionBlock('x\nDECISION NEEDED\n'), true); assert.equal(hasDecisionBlock('we need a DECISION NEEDED block'), false); ok('hasDecisionBlock');
const m = decisionMessage({ question: 'Purple or teal?', options: ['purple', 'teal'] });
assert.ok(/^DECISION NEEDED\b/m.test(m) && m.includes('1. purple') && m.includes('2. teal')); ok('message starts with DECISION NEEDED and lists options');
assert.match(waitingOnLine({ question: 'Purple\nor teal?' }), /^your answer to: Purple or teal\?$/); ok('waitingOn is one line');
console.log(`all ${n} passed`);
