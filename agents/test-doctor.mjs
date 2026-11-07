// node agents/test-doctor.mjs
import assert from 'node:assert/strict';
import { stallKey, needsDoctor, doctorPrompt, parseDiagnosis, doctorMessage } from './doctor.mjs';

let n = 0; const ok = (name) => console.log(`ok ${++n} - ${name}`);

// the real stall of 2026-11-07: a CI task at the round limit, unable to write .github/workflows
const ci = { id: '261107-71816d', project: 'shop', kind: 'change', title: 'Run the browser e2e suite in CI', status: 'waiting for you', waitingOn: 'your call: review findings are still open at the round limit', factoryRounds: 6, pr: { number: 4, state: 'open' }, verdict: 'CHANGES' };

const k = needsDoctor(ci);
assert.ok(k);
assert.equal(needsDoctor({ ...ci, doctorKey: k }), null, 'the same stall is diagnosed once');
assert.ok(needsDoctor({ ...ci, doctorKey: k, factoryRounds: 7 }), 'a new stall (another round) is diagnosed again');
ok('a task that gave up ("your call: …") needs the doctor, once per stall');

for (const [why, t] of [
  ['a brief waiting for go', { ...ci, waitingOn: 'your go-ahead on the plan (or your changes to it)' }],
  ['a decision the agent asked', { ...ci, status: 'decision needed', waitingOn: 'your answer to the decision the agent is asking for' }],
  ['a merged PR', { ...ci, pr: { number: 4, state: 'merged' } }],
  ['a stopped task', { ...ci, status: 'stopped' }],
  ['an epic (its stuck task is diagnosed instead)', { ...ci, kind: 'program' }],
  ['a working task', { ...ci, status: 'working', waitingOn: undefined }],
]) assert.equal(stallKey(t), null, why);
ok('briefs, decisions, merged or stopped tasks, epics and moving tasks are left alone');

assert.ok(needsDoctor({ ...ci, status: 'reviewing', waitingOn: undefined, watchEscalatedAt: '2026-11-08T00:00:00Z', watchState: 'reviewing' }));
ok('a task the watchdog escalated (frozen while it should move) needs the doctor');

const msgs = [{ from: 'you', at: 't0', text: 'Run the browser e2e suite in CI.' }, ...Array.from({ length: 20 }, (_, i) => ({ from: i % 2 ? 'review' : 'agent', at: `t${i + 1}`, text: i % 2 ? 'Must fix: tests/e2e/ci/e2e.yml is not under .github/workflows, GitHub never runs it.' : 'I cannot push to .github/workflows: the token lacks the workflows permission, so I parked the file.'.repeat(i === 18 ? 40 : 1) }))];
const p = doctorPrompt(ci, msgs, 'ts\tdecision\tparked workflow outside .github: no workflows scope');
assert.match(p, /TASK 261107-71816d/); assert.match(p, /Run the browser e2e suite in CI/);
assert.match(p, /failed rounds 6; PR #4 \(open\)/); assert.match(p, /no workflows scope/);
assert.ok(!p.includes('--- agent (t1)\n'), 'only the last 14 messages'); assert.match(p, /--- review \(t20\)/);
assert.match(p, /…\(cut\)/, 'a long message is cut');
assert.ok(p.length < 40000, 'bounded prompt');
ok('the prompt carries the task, its state, the decision log and the last 14 messages, bounded');

const d = parseDiagnosis('Here: {"category": "missing-permission", "cause": "The agent token cannot write .github/workflows, so the workflow can never run and every review fails.", "evidence": ["agent: the token lacks the workflows permission", "review x6: file not under .github/workflows", "a", "b"], "fix": "Grant agent tokens workflows: write, or move the file once by hand.", "who": "person", "reply": "Workflows permission granted: move the file and finish."}');
assert.equal(d.category, 'missing-permission'); assert.equal(d.who, 'person'); assert.equal(d.evidence.length, 3);
assert.equal(parseDiagnosis('no json here'), null);
assert.equal(parseDiagnosis('{"cause": "", "fix": "x"}'), null);
const odd = parseDiagnosis('{"category": "gremlins", "cause": "c", "fix": "f", "who": "nobody"}');
assert.equal(odd.category, 'other'); assert.equal(odd.who, 'person'); assert.equal(odd.reply, '');
ok('the diagnosis is parsed and checked: unknown category → other, unknown who → person, no cause or fix → none');

const m = doctorMessage(d);
assert.match(m, /^\[factory\] 🩺 Stuck doctor \(missing permission\)/);
assert.match(m, /\*\*Why it's stuck:\*\* The agent token cannot write/);
assert.match(m, /- review x6: file not under/);
assert.match(m, /\*\*What fixes it\*\* \(you\): Grant agent tokens/);
assert.match(m, /\*\*To unblock, reply:\*\* Workflows permission granted/);
assert.doesNotMatch(doctorMessage(odd), /To unblock/);
assert.match(doctorMessage(null), /could not work out why/);
ok('the message: cause, evidence, the fix and who acts, a reply to send when there is one');

console.log(`all ${n} passed`);
