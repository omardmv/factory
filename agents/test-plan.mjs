// node agents/test-plan.mjs
import assert from 'node:assert/strict';
import { parsePlan, mergePlan, progress, MAX_PLAN_TASKS, isPlanCommand, talkAction } from './plan.mjs';

let n = 0; const ok = (name) => console.log(`ok ${++n} - ${name}`);
const block = (tasks) => 'Here is the plan.\n```plan\n' + JSON.stringify({ tasks }) + '\n```\n';
const T = (key, deps = [], title) => ({ key, title: title ?? key, task: `do ${key}`, depends_on: deps });

// the Endless Horde shape: a flag first, then parallel work, zones in order
const horde = [T('flag'), T('map1-core', ['flag']), T('late-join', ['map1-core']), T('admin-panel', ['map1-core']),
  T('leaderboard', ['map1-core']), T('fence', ['map1-core']), T('zones', ['flag']), T('zone-s2', ['zones']),
  T('zone-s3', ['zone-s2']), T('zone-s4', ['zone-s3']), T('zone-s1', ['zone-s4']), T('balance', ['leaderboard', 'zone-s1'])];

const p = parsePlan(block(horde));
assert.ok(!p.error, p.error);
const wave = Object.fromEntries(p.tasks.map((t) => [t.key, t.wave]));
assert.deepEqual([wave.flag, wave['map1-core'], wave.zones, wave['late-join'], wave['zone-s1'], wave.balance], [1, 2, 2, 3, 6, 7]);
ok('waves come from dependencies (flag 1; map1-core and zones 2 in parallel; zone chain 3-6; balance after both)');

for (const [name, tasks, re] of [
  ['no block', null, /no ```plan/],
  ['not JSON', 'bad', /not JSON/],
  ['empty', [], /no tasks/],
  ['bad key', [T('Bad Key')], /key "Bad Key"/],
  ['duplicate key', [T('a'), T('a')], /used twice/],
  ['unknown dependency', [T('a', ['zzz'])], /depends on "zzz", which is not in the plan/],
  ['self dependency', [T('a', ['a'])], /depends on itself/],
  ['cycle', [T('a', ['c']), T('b', ['a']), T('c', ['b'])], /cycle: a → c → b → a/],
  ['too many', Array.from({ length: MAX_PLAN_TASKS + 1 }, (_, i) => T(`t${i}`)), /at most 40/],
  ['no task text', [{ key: 'a', depends_on: [] }], /no task text/],
]) {
  const text = tasks === null ? 'just words' : tasks === 'bad' ? '```plan\n{nope\n```' : block(tasks);
  const r = parsePlan(text);
  assert.match(r.error ?? '', re, name);
}
ok('bad plans are refused with a reason (no block, not JSON, empty, bad/duplicate key, unknown/self dependency, cycle, too many, no text)');

const items = p.tasks.map((t) => ({ ...t }));
const at = (states) => (i) => states[i.key] ?? 'pending';
let g = progress(items, at({}));
assert.deepEqual(g.ready.map((i) => i.key), ['flag']); assert.equal(g.done, false); assert.equal(g.stalled, false);
ok('at the start only the task with no dependencies is ready');

g = progress(items, at({ flag: 'merged' }));
assert.deepEqual(g.ready.map((i) => i.key).sort(), ['map1-core', 'zones']);
ok('when flag merges, both tasks that only need flag start at once');

g = progress(items, at({ flag: 'merged', 'map1-core': 'merged', zones: 'running' }));
assert.deepEqual(g.ready.map((i) => i.key).sort(), ['admin-panel', 'fence', 'late-join', 'leaderboard']);
assert.ok(!g.ready.some((i) => i.key === 'zone-s2'), 'zone-s2 waits for zones');
ok('a task starts when its own dependencies merge, without waiting for the rest of its wave');

g = progress(items, at({ flag: 'merged', 'map1-core': 'merged', zones: 'merged', 'zone-s2': 'failed', leaderboard: 'merged', 'late-join': 'merged', 'admin-panel': 'merged', fence: 'merged' }));
assert.deepEqual(g.blocked.map((b) => b.item.key).sort(), ['balance', 'zone-s1', 'zone-s3', 'zone-s4']);
assert.equal(g.ready.length, 0); assert.equal(g.stalled, true);
ok('a failed task blocks everything after it, down the chain, and the epic is reported stalled');

g = progress(items, at({ flag: 'merged', 'map1-core': 'stuck' }));
assert.ok(g.blocked.some((b) => b.item.key === 'late-join' && b.on.includes('map1-core')));
assert.deepEqual(g.ready.map((i) => i.key), ['zones']);
ok('a task waiting on the person blocks its dependents but not unrelated work');

g = progress(items, at(Object.fromEntries(items.map((i) => [i.key, 'merged']))));
assert.equal(g.done, true); assert.equal(g.merged, 12); assert.equal(g.stalled, false);
ok('all merged: done');

// revising: started tasks keep their task ids, unstarted ones are replaced
const cur = items.map((i) => (['flag', 'map1-core'].includes(i.key) ? { ...i, taskId: `id-${i.key}` } : i));
const rev = parsePlan(block([T('flag'), T('map1-core', ['flag']), T('zones', ['flag']), T('zone-s2', ['zones']), T('new-thing', ['map1-core'])])).tasks;
const m = mergePlan(cur, rev);
assert.ok(!m.error);
assert.equal(m.items.find((i) => i.key === 'flag').taskId, 'id-flag');
assert.ok(m.items.some((i) => i.key === 'new-thing') && !m.items.some((i) => i.key === 'fence'));
ok('a revised plan keeps started tasks and replaces the rest');

const kept = mergePlan(cur, parsePlan(block([T('zones'), T('zone-s2', ['zones'])])).tasks);
assert.ok(kept.items.some((i) => i.key === 'map1-core' && i.taskId === 'id-map1-core'));
ok('a started task dropped from the new plan is kept (it is already running)');

const tricky = 'Plan below.\n```plan\n' + JSON.stringify({ tasks: [T('talk-mode', [], 'talk'), { key: 'docs', title: 'docs', task: 'Explain that the coordinator must NOT emit a ```plan block yet, and show ``` fences in docs', depends_on: ['talk-mode'] }] }) + '\n```\nThat is all.';
const tp = parsePlan(tricky);
assert.ok(!tp.error, tp.error); assert.equal(tp.tasks.length, 2); assert.equal(tp.tasks[1].wave, 2);
assert.match(parsePlan('```plan\n{"tasks": []').error, /not closed/);
const two = parsePlan('old:\n```plan\n' + JSON.stringify({ tasks: [T('old')] }) + '\n```\nnew:\n```plan\n' + JSON.stringify({ tasks: [T('new')] }) + '\n```');
assert.equal(two.tasks[0].key, 'new');
ok('fences inside task text are ignored; an unclosed block is refused; the last block wins');

for (const y of ['plan', 'Plan it', 'plan:', 'plan it!', 'make the plan', '  Make a plan please', 'PLAN!']) assert.ok(isPlanCommand(y), y);
for (const x of ['go', 'planning is hard', 'what is the plan?', 'I would not plan yet', 'Plan B looks better', 'plan it later', 'plans', '', null]) assert.ok(!isPlanCommand(x), String(x));
ok('isPlanCommand: plan / plan it / plan: / make the plan at the start, not go or other words');

// the real talk handler, with injected deps
const prog = { id: 'e1', phase: 'talk' }, sent = [], notes = [], thread = [{ from: 'you', text: 'goal' }, { from: 'coordinator', text: 'Server or bot?' }];
const deps = { say: (id, f, x) => notes.push(x), save: () => {}, enqueue: (id, p, m, f) => sent.push(p), planningPrompt: (n) => 'PLAN:' + n, continuePrompt: (x) => 'TALK:' + x };
const seq = ['yes, the server, and keep it small', 'ok but small', 'go', 'Plan B looks better', 'plan it'].map((m) => `${m} -> ${talkReply(prog, m, thread, deps)} (${prog.phase})`);
console.log(seq.join('\n'));
assert.deepEqual(sent.map((s) => s.slice(0, 5)), ['TALK:', 'TALK:', 'TALK:', 'PLAN:']);
assert.equal(notes.length, 1); assert.match(notes[0], /no plan yet/);
assert.match(sent[3], /Server or bot\?/);
assert.deepEqual(seq.map((l) => l.split('(').pop()), ['talk)', 'talk)', 'talk)', 'talk)', 'brief)']);
ok('talk handler: "yes, ..." and "ok but" reach the coordinator, bare go approves nothing, "Plan B" is not a command, "plan it" sets brief and sends the discussion');

console.log(`all ${n} passed`);
