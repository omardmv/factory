// node agents/test-plan.mjs
import assert from 'node:assert/strict';
import { parsePlan, mergePlan, progress, wavesReport, announcements, MAX_PLAN_TASKS, isPlanCommand, talkAction, talkReply, needsResearch } from './plan.mjs';

let n = 0; const ok = (name) => console.log(`ok ${++n} - ${name}`);
const block = (tasks) => 'Here is the plan.\n```plan\n' + JSON.stringify({ tasks }) + '\n```\n';
const T = (key, deps = [], title) => ({ key, title: title ?? key, task: `do ${key}`, depends_on: deps });

// a game-epic shape: a flag first, then parallel work, zones in order
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

// a revision keeps the GitHub sub-issue of a kept key (and of a started task dropped from the plan)
const withIssue = cur.map((i) => (i.key === 'flag' ? { ...i, issue: 41, issueId: 9041 } : i.key === 'map1-core' ? { ...i, issue: 42, issueId: 9042 } : i));
const mi = mergePlan(withIssue, parsePlan(block([T('flag'), T('zones', ['flag'])])).tasks);
assert.deepEqual([mi.items.find((i) => i.key === 'flag').issue, mi.items.find((i) => i.key === 'flag').issueId], [41, 9041]);
assert.equal(mi.items.find((i) => i.key === 'map1-core').issue, 42);
assert.equal(mi.items.find((i) => i.key === 'zones').issue, undefined);
ok('a revised plan keeps sub-issue numbers and ids; new tasks have none yet');

const tricky = 'Plan below.\n```plan\n' + JSON.stringify({ tasks: [T('talk-mode', [], 'talk'), { key: 'docs', title: 'docs', task: 'Explain that the coordinator must NOT emit a ```plan block yet, and show ``` fences in docs', depends_on: ['talk-mode'] }] }) + '\n```\nThat is all.';
const tp = parsePlan(tricky);
assert.ok(!tp.error, tp.error); assert.equal(tp.tasks.length, 2); assert.equal(tp.tasks[1].wave, 2);
assert.match(parsePlan('```plan\n{"tasks": []').error, /not closed/);
const two = parsePlan('old:\n```plan\n' + JSON.stringify({ tasks: [T('old')] }) + '\n```\nnew:\n```plan\n' + JSON.stringify({ tasks: [T('new')] }) + '\n```');
assert.equal(two.tasks[0].key, 'new');
ok('fences inside task text are ignored; an unclosed block is refused; the last block wins');

const wp = parsePlan(block([T('a'), T('b'), T('c', ['a', 'b']), T('d', ['c'])])).tasks;
let r = wavesReport(wp, { a: 'merged', b: 'running', c: 'pending', d: 'pending' });
assert.deepEqual(r.map((w) => [w.wave, w.merged, w.total, w.complete]), [[1, 1, 2, false], [2, 0, 1, false], [3, 0, 1, false]]);
r = wavesReport(wp, (i) => (['a', 'b'].includes(i.key) ? 'merged' : 'pending'));
assert.deepEqual(r.map((w) => w.complete), [true, false, false]);
assert.equal(r[0].items.length, 2);
ok('wavesReport: per wave merged/total and complete; takes a map or a function');

// revised plan: a new task joins a finished wave, a started task is dropped from the plan but kept
const done1 = wp.map((i) => (i.key === 'a' ? { ...i, taskId: 'id-a' } : i));
const revd = mergePlan(done1, parsePlan(block([T('b'), T('e'), T('c', ['b', 'e'])])).tasks).items;
const rr = wavesReport(revd, { a: 'merged', b: 'merged', e: 'pending', c: 'pending' });
assert.deepEqual(rr.map((w) => [w.wave, w.merged, w.total, w.complete]), [[1, 2, 3, false], [2, 0, 1, false]]);
assert.ok(revd.some((i) => i.key === 'a'));
const rr2 = wavesReport(revd, { a: 'merged', b: 'merged', e: 'merged', c: 'pending' });
assert.deepEqual(rr2.map((w) => w.complete), [true, false]);
assert.deepEqual(wavesReport([], {}), []);
ok('wavesReport: revised plans (added and kept-though-dropped items) and an empty plan');

const lk = (i) => i.title;
const gOf = (st) => progress(wp, (i) => st[i.key]);
let a1 = announcements(wp, gOf({ a: 'merged', b: 'running', c: 'pending', d: 'pending' }), undefined, lk);
assert.deepEqual(a1.lines, ['[factory] merged: a. 1/4 tasks merged.']);
let a2 = announcements(wp, gOf({ a: 'merged', b: 'running', c: 'pending', d: 'pending' }), a1.said, lk);
assert.deepEqual(a2.lines, []);
const a3 = announcements(wp, gOf({ a: 'merged', b: 'merged', c: 'pending', d: 'pending' }), a1.said, lk);
assert.deepEqual(a3.lines, ['[factory] merged: b. 2/4 tasks merged.', '[factory] wave 1 done: a; b. 2/4 merged; next: c.']);
assert.deepEqual(announcements(wp, gOf({ a: 'merged', b: 'merged', c: 'pending', d: 'pending' }), a3.said, lk).lines, []);
const a4 = announcements(wp, gOf({ a: 'merged', b: 'merged', c: 'merged', d: 'merged' }), a3.said, lk);
assert.match(a4.lines.at(-1), /wave 3 done: d\. 4\/4 merged; next: nothing, that was the last wave/);
ok('announcements: first merge, a second pass says nothing, a wave completing, the last wave');

// c announced as wave 2, then a revision puts e before it: c is wave 3 now, and e's wave is announced when e merges
const w2 = parsePlan(block([T('a'), T('c', ['a'])])).tasks;
const s1 = announcements(w2, progress(w2, () => 'merged'), undefined, lk).said;
const w3 = mergePlan(w2.map((i) => ({ ...i, taskId: 'x' })), parsePlan(block([T('a'), T('e', ['a']), T('c', ['e'])])).tasks).items;
const st3 = { a: 'merged', c: 'pending', e: 'merged' };
const a5 = announcements(w3, progress(w3, (i) => st3[i.key]), s1, lk);
assert.ok(a5.lines.some((l) => /wave 2 done: e/.test(l)), a5.lines.join('|'));
ok('announcements: waves are remembered by their tasks, so renumbering does not hide one');

// a wave that gains a task after it was announced is announced again when the new task merges (new work finished)
const w1 = parsePlan(block([T('a'), T('b'), T('c', ['a', 'b'])])).tasks;
const sA = announcements(w1, progress(w1, (i) => (i.key === 'c' ? 'pending' : 'merged')), undefined, lk).said;
const w1r = mergePlan(w1.map((i) => ({ ...i, taskId: 'x' })), parsePlan(block([T('a'), T('b'), T('e'), T('c', ['a', 'b'])])).tasks).items;
const stR = { a: 'merged', b: 'merged', e: 'running', c: 'pending' };
assert.deepEqual(announcements(w1r, progress(w1r, (i) => stR[i.key]), sA, lk).lines, []);
stR.e = 'merged';
const aR = announcements(w1r, progress(w1r, (i) => stR[i.key]), sA, lk);
assert.match(aR.lines.at(-1), /wave 1 done: a; b; e\. 3\/4 merged; next: c\./);
assert.deepEqual(announcements(w1r, progress(w1r, (i) => stR[i.key]), aR.said, lk).lines.filter((l) => /wave/.test(l)), []);
ok('announcements: a wave that gains a task is announced again once, when the new task merges; "next" only names what can start');

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

{
  // the chain a → b → c, where b merged before a (it started before a revision put it after a)
  const chain = [{ key: 'a', deps: [] }, { key: 'b', deps: ['a'] }, { key: 'c', deps: ['b'] }];
  let g2 = progress(chain, (i) => ({ a: 'running', b: 'merged' })[i.key] ?? 'pending');
  assert.deepEqual(g2.ready.map((i) => i.key), []); assert.deepEqual(g2.waiting.map((i) => i.key), ['c']);
  g2 = progress(chain, (i) => ({ a: 'merged', b: 'merged' })[i.key] ?? 'pending');
  assert.deepEqual(g2.ready.map((i) => i.key), ['c']);
}
ok('a task waits for its whole chain: a link that merged early does not let the next one skip ahead');


// declared files: overlap needs a dependency, in either direction, direct or through a chain
const F = (key, files, deps = []) => ({ ...T(key, deps), ...(files ? { files } : {}) });
const ro = parsePlan(block([F('a', ['agents/server.mjs']), F('b', ['agents/server.mjs', 'x.js'])]));
assert.match(ro.error, /"a" and "b" both edit agents\/server\.mjs/);
ok('two tasks on the same file with no dependency are refused, naming both tasks and the file');
assert.ok(!parsePlan(block([F('a', ['s.mjs']), F('b', ['s.mjs'], ['a'])])).error);
assert.ok(!parsePlan(block([F('a', ['s.mjs'], ['b']), F('b', ['s.mjs'])])).error);
ok('overlap with a direct dependency (either direction) is accepted');
assert.ok(!parsePlan(block([F('a', ['s.mjs']), F('m', null, ['a']), F('b', ['./s.mjs'], ['m'])])).error);
ok('overlap with a transitive dependency is accepted');
assert.ok(!parsePlan(block([F('a', null), F('b', null), F('c', ['x'])])).error);
assert.match(parsePlan(block([F('a', ['s.mjs']), F('b', ['s.mjs'], ['c']), F('c', null)])).error, /"a" and "b"/);
ok('tasks without files are unaffected; a dependency on a third task does not excuse an overlap');

{
  const typed = parsePlan(block([{ ...T('a'), type: 'Refactor' }, { ...T('b', ['a']), type: 'banana' }, T('c')]));
  assert.ok(!typed.error, typed.error);
  assert.deepEqual(typed.tasks.map((t) => t.type ?? null), ['refactor', null, null]);
}
ok('a plan task keeps a known type (any case) and drops an unknown one');

{
  const R = (key, extra = {}, deps = []) => ({ key, title: key, task: `do ${key}`, depends_on: deps, ...extra });
  const keysOf = (tasks) => tasks.map((t) => t.key);
  // marked by the coordinator
  let r = parsePlan(block([R('a', { research: true })]));
  assert.ok(!r.error, r.error);
  assert.deepEqual(keysOf(r.tasks), ['a-research', 'a']);
  const [res, impl] = r.tasks;
  assert.equal(res.type, 'research'); assert.equal(res.researchFor, 'a');
  assert.match(res.task, /docs\/research\/a\.md/);
  assert.deepEqual(impl.deps, ['a-research']); assert.equal(impl.researchKey, 'a-research'); assert.equal(impl.researchDoc, 'docs/research/a.md');
  assert.deepEqual([res.wave, impl.wave], [1, 2]);
  assert.ok(!('research' in impl));
  ok('research: true adds a research task and the implementation depends on it');
  // the dependency is kept and the research starts with the same dependencies
  r = parsePlan(block([R('base'), R('b', { research: true }, ['base'])]));
  assert.deepEqual(r.tasks.find((t) => t.key === 'b-research').deps, ['base']);
  assert.deepEqual(r.tasks.find((t) => t.key === 'b').deps, ['base', 'b-research']);
  ok('research starts when the task would have; the task also waits for the research');
  // the rule, with no mark
  for (const text of ['add a new dependency on zod', 'change the data model of orders', 'a database migration', 'new public API for export', 'the approach is unclear here']) {
    assert.ok(needsResearch({ key: 'x', title: 'x', task: text }), text);
    assert.deepEqual(keysOf(parsePlan(block([R('x', { task: text })])).tasks), ['x-research', 'x'], text);
  }
  assert.ok(!needsResearch({ key: 'x', title: 'x', task: 'fix the button colour on the profile page' }));
  assert.deepEqual(keysOf(parsePlan(block([R('x', { task: 'fix the button colour' })])).tasks), ['x']);
  ok('the rule decides research for a dependency, data model, public interface or unclear approach, and not for a plain change');
  // skipped
  assert.deepEqual(keysOf(parsePlan(block([R('x', { task: 'new data model for orders. No research.' })])).tasks), ['x']);
  assert.deepEqual(keysOf(parsePlan(block([R('x', { task: 'new data model, no-research please', research: true })])).tasks), ['x']);
  assert.deepEqual(keysOf(parsePlan(block([R('x', { task: 'new data model', research: false })])).tasks), ['x']);
  ok('"no research" in the task, or research: false, skips research even when marked or matched by the rule');
  // a research task is not researched again; a taken key is refused
  assert.deepEqual(keysOf(parsePlan(block([R('x', { type: 'research', research: true, task: 'new data model' })])).tasks), ['x']);
  assert.match(parsePlan(block([R('a', { research: true }), R('a-research')])).error, /"a-research" is taken/);
  ok('a research task is never researched; a key clash is refused');
  // blocked until the research PR is merged
  const plan = parsePlan(block([R('a', { research: true })])).tasks;
  const st = (m) => progress(plan, (i) => m[i.key] ?? 'pending');
  assert.deepEqual(st({}).ready.map((i) => i.key), ['a-research']);
  assert.deepEqual(st({ 'a-research': 'running' }).ready, []);
  assert.deepEqual(st({ 'a-research': 'stuck' }).blocked.map((b) => b.item.key), ['a']);
  assert.deepEqual(st({ 'a-research': 'merged' }).ready.map((i) => i.key), ['a']);
  ok('the implementation is blocked until the research PR is merged, then it starts');
  // a revised plan keeps a running research task
  const kept = mergePlan(plan.map((t) => (t.key === 'a-research' ? { ...t, taskId: 'T1' } : t)), parsePlan(block([R('a', { research: true })])).tasks);
  assert.equal(kept.items.find((t) => t.key === 'a-research').taskId, 'T1');
  ok('a revised plan keeps the started research task');
  // the coordinator sends the research task back with the whole plan: accepted, not refused
  r = parsePlan(block([R('a-research', { type: 'research', task: 'r' }), R('a', { research: true }, ['a-research'])]));
  assert.ok(!r.error, r.error); assert.deepEqual(keysOf(r.tasks), ['a-research', 'a']); assert.equal(r.tasks[0].researchFor, 'a');
  ok('a research task sent back in a revision is reused, not refused');
  // a revision that lists the research task but leaves the mark out keeps the link
  r = parsePlan(block([R('a-research', { type: 'research', task: 'r' }), R('a', { task: 'do login' })]));
  assert.deepEqual(r.tasks.find((t) => t.key === 'a').deps, ['a-research']);
  const keep = mergePlan(plan.map((t) => ({ ...t, taskId: t.key === 'a-research' ? 'T1' : undefined })), [{ key: 'a-research', type: 'research', title: 'r', task: 'r', deps: [], wave: 1 }, { key: 'a', title: 'a', task: 'do login', deps: [], wave: 1 }]);
  assert.deepEqual(keep.items.find((t) => t.key === 'a').deps, ['a-research']);
  assert.equal(keep.items.find((t) => t.key === 'a').researchKey, 'a-research');
  assert.deepEqual(parsePlan(block([R('a-research', { type: 'research', task: 'r' }), R('a', { task: 'no research here' })])).tasks.find((t) => t.key === 'a').deps, []);
  ok('a revision that lists the research task without the mark keeps the research link, unless "no research"');
  // a started task never gains research from a revision
  const cur = [{ key: 'a', title: 'a', task: 'do a', deps: [], wave: 1, taskId: 'T1' }];
  const rev = mergePlan(cur, parsePlan(block([R('a', { task: 'now with a new schema' })])).tasks);
  assert.deepEqual(rev.items.map((t) => t.key), ['a']); assert.deepEqual(rev.items[0].deps, []); assert.ok(!rev.items[0].researchKey);
  const rev2 = mergePlan(cur, parsePlan(block([R('a', { task: 'x' }), R('b', { research: true })])).tasks);
  assert.deepEqual(rev2.items.map((t) => t.key), ['a', 'b-research', 'b']);
  ok('a revision adds no research to a started task, but still to a new one');
}

console.log(`all ${n} passed`);
