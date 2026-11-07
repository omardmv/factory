// node agents/test-epic-issue.mjs
import assert from 'node:assert/strict';
import { renderEpicBody, renderSubIssueBody, createEpicIssue, syncEpicIssue } from './epic-issue.mjs';

let n = 0; const ok = (name) => console.log(`ok ${++n} - ${name}`);
const P = (key, deps, wave) => ({ key, title: `Title ${key}`, task: `do ${key}\nmore`, deps, wave });
const mkPlan = () => [P('a', [], 1), P('b', ['a'], 2), P('c', ['a'], 2), P('d', ['b', 'c'], 3)];

function fakeGh() {
  const calls = []; const issues = {}; let next = 10;
  const gh = async (token, path, method = 'GET', payload) => {
    assert.equal(token, 'tok'); calls.push({ path, method, payload });
    let m;
    if (method === 'POST' && path === '/repos/o/r/issues') { const number = next++; issues[number] = { number, id: 1000 + number, state: 'open', html_url: `https://github.com/o/r/issues/${number}`, ...payload }; return issues[number]; }
    if (method === 'GET' && (m = path.match(/^\/repos\/o\/r\/issues\/(\d+)$/))) return issues[m[1]];
    if (method === 'PATCH' && (m = path.match(/^\/repos\/o\/r\/issues\/(\d+)$/))) { Object.assign(issues[m[1]], payload); return issues[m[1]]; }
    return {};
  };
  return { gh, calls, issues };
}

// rendering
const plan0 = mkPlan();
const body = renderEpicBody('Ship the thing', plan0, { a: 'merged', b: 'running' }, { tasksUrl: 'https://x/tasks' });
assert.match(body, /Ship the thing/);
assert.match(body, /1\/4 tasks merged/);
assert.match(body, /\*\*Wave 2\*\* \(in parallel\)/);
assert.match(body, /\| `d` Title d \| `b`, `c` \| 3 \| ⏳ pending \|/);
assert.match(body, /\| `a` Title a \| – \| 1 \| ✅ merged \|/);
assert.match(body, /\[live progress\]\(https:\/\/x\/tasks\)/);
ok('epic body: goal, progress, waves, build order, table');
const sub = renderSubIssueBody(plan0[3], 7, plan0);
assert.match(sub, /Part of epic #7 · wave 3/); assert.match(sub, /Depends on: `b`, `c`/); assert.match(sub, /do d/);
ok('sub-issue body');

// create: epic first, then sub-issues in plan order, each linked by numeric id
const f = fakeGh(); const plan = mkPlan();
const res = await createEpicIssue({ gh: f.gh, token: 'tok', repo: 'o/r', title: 'Epic', goal: 'G', plan });
assert.equal(res.epic.number, 10); assert.equal(res.epic.url, 'https://github.com/o/r/issues/10');
assert.deepEqual(Object.keys(res.items), ['a', 'b', 'c', 'd']);
assert.deepEqual(Object.values(res.items).map((i) => i.number), [11, 12, 13, 14]);
const creates = f.calls.filter((c) => c.method === 'POST' && c.path === '/repos/o/r/issues');
assert.deepEqual(creates.map((c) => c.payload.title), ['Epic', 'Title a', 'Title b', 'Title c', 'Title d']);
const links = f.calls.filter((c) => c.path === '/repos/o/r/issues/10/sub_issues');
assert.deepEqual(links.map((c) => c.payload.sub_issue_id), [1011, 1012, 1013, 1014]);
assert.match(f.issues[10].body, /#12/); // numbers appear after creation
ok('epic created first, then sub-issues in plan order linked by numeric id');

// re-run: nothing created twice
const before = f.calls.length;
await syncEpicIssue({ gh: f.gh, token: 'tok', repo: 'o/r', epic: res.epic, goal: 'G', plan, states: {} });
await syncEpicIssue({ gh: f.gh, token: 'tok', repo: 'o/r', epic: res.epic, goal: 'G', plan, states: {} });
assert.equal(f.calls.slice(before).filter((c) => c.method === 'POST').length, 0);
ok('re-running sync creates no duplicates');

// merge closes as completed, once
const states = { a: 'merged', b: 'failed', c: 'running' };
await syncEpicIssue({ gh: f.gh, token: 'tok', repo: 'o/r', epic: res.epic, goal: 'G', plan, states });
assert.deepEqual([f.issues[11].state, f.issues[11].state_reason], ['closed', 'completed']);
assert.deepEqual([f.issues[12].state, f.issues[12].state_reason], ['closed', 'not_planned']);
assert.equal(f.issues[13].state, 'open'); assert.equal(f.issues[14].state, 'open');
assert.match(f.calls.find((c) => c.path.endsWith('/12/comments')).payload.body, /could not finish/);
assert.match(f.issues[10].body, /1\/4 tasks merged/);
const mark = f.calls.length;
await syncEpicIssue({ gh: f.gh, token: 'tok', repo: 'o/r', epic: res.epic, goal: 'G', plan, states });
assert.equal(f.calls.slice(mark).filter((c) => c.method === 'POST' || c.payload?.state).length, 0);
ok('merged closes completed; failed closes not_planned with one comment; closing is idempotent');

// a task added to the plan later gets its sub-issue, linked, in order; dropped closes not_planned
const plan2 = [...plan, P('e', ['d'], 4)];
const r2 = await syncEpicIssue({ gh: f.gh, token: 'tok', repo: 'o/r', epic: res.epic, goal: 'G', plan: plan2, states: { ...states, c: 'dropped', e: 'pending' } });
assert.equal(r2.items.e.number, 15); assert.equal(f.issues[15].title, 'Title e');
assert.equal(f.calls.filter((c) => c.path.endsWith('/10/sub_issues')).length, 5);
assert.equal(f.issues[13].state_reason, 'not_planned');
assert.equal(f.issues[11].state_reason, 'completed');
ok('new plan items get sub-issues; dropped closes not_planned');
