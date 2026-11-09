// node agents/test-syncwire.mjs
import assert from 'node:assert/strict';
import { verifyUnblocked, retrySyncChecks, findPr } from './syncwire.mjs';

const mk = (tasks, over = {}) => {
  const calls = { says: [], enq: [], logs: [], gh: [] };
  const d = {
    gh: async (_t, url) => { calls.gh.push(url); if (over.gh) return over.gh(url); if (url.includes('/pulls?')) return [{ number: 78 }]; return { number: 78, state: 'open', mergeable: true, mergeable_state: 'clean' }; },
    load: (id) => tasks[id], update: (id, fn) => { fn(tasks[id]); return tasks[id]; },
    say: (...a) => calls.says.push(a), enqueue: (...a) => calls.enq.push(a), log: (n, x) => calls.logs.push([n, x]),
    maxRounds: 1, sleep: async () => {}, waitMs: 0, tries: 2, tasks: () => Object.values(tasks), githubToken: async () => 'tok', ...over.d,
  };
  return { d, calls };
};
const conflicting = (url) => url.includes('/pulls?') ? [{ number: 78 }] : { number: 78, state: 'open', mergeable: false, mergeable_state: 'dirty' };
const unknown = (url) => url.includes('/pulls?') ? [{ number: 78 }] : { number: 78, state: 'open', mergeable: null, mergeable_state: 'unknown' };

// verifyUnblocked: clean -> done
{
  const tasks = { a: { id: 'a', syncVerify: { branch: 'staging' }, syncRechecks: 2 } };
  const { d, calls } = mk(tasks);
  await verifyUnblocked(d, 'a', 'tok', 'o/shop', 'staging');
  assert.equal(tasks.a.syncVerify, undefined); assert.equal(tasks.a.syncRechecks, undefined);
  assert.equal(calls.logs[0][0], 'merge.verified'); assert.equal(calls.says.length, 0);
  console.log('ok - verifyUnblocked: mergeable target PR clears the check');
}
// unknown -> recheck later, no ping
{
  const tasks = { a: { id: 'a' } };
  const { d, calls } = mk(tasks, { gh: unknown });
  await verifyUnblocked(d, 'a', 'tok', 'o/shop', 'staging');
  assert.deepEqual(tasks.a.syncVerify, { branch: 'staging', repo: 'o/shop' }); assert.equal(tasks.a.syncRechecks, 1);
  assert.equal(calls.says.length, 0); assert.equal(calls.gh.filter((u) => u.includes('/pulls?')).length, 2, 'polled while unknown');
  console.log('ok - verifyUnblocked: unknown mergeability is looked at again later, silently');
}
// conflicting -> resync: task working, PR open, merged number remembered, agent queued
{
  const tasks = { a: { id: 'a', status: 'merged', mergeWanted: true, pr: { number: 70, state: 'merged' }, syncVerify: {} } };
  const { d, calls } = mk(tasks, { gh: conflicting });
  await verifyUnblocked(d, 'a', 'tok', 'o/shop', 'staging');
  assert.equal(tasks.a.status, 'working'); assert.equal(tasks.a.pr, null, 'the merged PR is no longer the task PR');
  assert.equal(tasks.a.resyncFrom, 70); assert.equal(tasks.a.syncRounds, 1); assert.equal(tasks.a.syncVerify, undefined);
  assert.equal(calls.enq.length, 1); assert.match(calls.enq[0][1], /agent\/a/); assert.equal(calls.enq[0][3], 'conflict');
  console.log('ok - verifyUnblocked: a conflict starts one follow-up sync and the task is working again');
}
// conflicting after the bound -> surfaced to the person
{
  const tasks = { a: { id: 'a', syncRounds: 1 } };
  const { d, calls } = mk(tasks, { gh: conflicting });
  await verifyUnblocked(d, 'a', 'tok', 'o/shop', 'staging');
  assert.equal(calls.enq.length, 0); assert.equal(calls.says.length, 1); assert.equal(calls.says[0][3].ping, true);
  console.log('ok - verifyUnblocked: after the bound the person is told');
}
// retrySyncChecks: a bad token for one task blocks neither the others nor the caller
{
  const tasks = { a: { id: 'a', syncVerify: { repo: 'o/bad', branch: 'staging' } }, b: { id: 'b', syncVerify: { repo: 'o/shop', branch: 'staging' } }, c: { id: 'c' } };
  const { d, calls } = mk(tasks, { d: { githubToken: async (repo) => { if (repo === 'o/bad') throw new Error('no GitHub App configured for o/bad'); return 'tok'; } } });
  await retrySyncChecks(d); // must not throw
  assert.ok(calls.logs.some(([n, x]) => n === 'merge.verify_failed' && x.task === 'a' && /no GitHub App/.test(x.error)), 'the failure is logged');
  assert.ok(calls.logs.some(([n, x]) => n === 'merge.verified' && x.task === 'b'), 'the next task is still checked');
  assert.equal(tasks.b.syncVerify, undefined);
  console.log('ok - retrySyncChecks: one bad token does not stop the rest');
}
// retrySyncChecks: a failing GitHub read is also contained
{
  const tasks = { a: { id: 'a', syncVerify: { repo: 'o/shop', branch: 'staging' } } };
  const { d, calls } = mk(tasks, { gh: () => { throw new Error('github 502'); } });
  await retrySyncChecks(d);
  assert.equal(calls.logs[0][0], 'merge.verify_failed');
  console.log('ok - retrySyncChecks: a failed lookup is logged, not thrown');
}

// findPr
const pull = (number, o = {}) => ({ number, html_url: `https://gh/${number}`, state: 'open', merged_at: null, head: { sha: `sha${number}` }, ...o });
const pickPr = (prs = []) => prs.find((p) => p.state === 'open') ?? prs[0];
const fp = (routes, over = {}) => {
  const logs = [];
  return { logs, d: { githubToken: async () => 'tok', gh: async (_t, url) => { for (const [re, v] of routes) if (re.test(url)) return typeof v === 'function' ? v(url) : v; return []; }, workspaceBranches: () => [], pickPr, log: (n, x) => logs.push([n, x]), ...over } };
};
const task = { id: 'a', repo: 'o/shop' };
{
  const { d } = fp([[/head=o:agent%2Fa|head=o:agent\/a/, [pull(5)]]]);
  assert.deepEqual(await findPr(d, task), { number: 5, url: 'https://gh/5', state: 'open', head: 'sha5' });
  console.log('ok - findPr: the task branch PR');
}
{ // merged first PR, follow-up open PR from another workspace branch
  const { d, logs } = fp([[/state=all.*head=o:agent\/a/, [pull(5, { state: 'closed', merged_at: 'x' })]], [/state=open&head=o:sync-2/, [pull(9)]]], { workspaceBranches: () => ['sync-2'] });
  const r = await findPr(d, task);
  assert.equal(r.number, 9); assert.equal(r.state, 'open'); assert.equal(logs[0][0], 'pr.followup');
  console.log('ok - findPr: a follow-up PR from another branch wins over the merged first one');
}
{ // no PR on the task branch: any workspace branch
  const { d, logs } = fp([[/state=all&head=o:perf/, [pull(7)]]], { workspaceBranches: () => ['perf'] });
  assert.equal((await findPr(d, task)).number, 7); assert.equal(logs[0][0], 'pr.other_branch');
  console.log('ok - findPr: a PR pushed from another branch is found');
}
{ // resync: only the merged PR exists so far -> no PR (not "merged")
  const { d } = fp([[/head=o:agent\/a/, [pull(5, { state: 'closed', merged_at: 'x' })]]]);
  assert.equal(await findPr(d, { ...task, resyncFrom: 5 }), null, 'the working task is not reported merged');
  assert.equal((await findPr(d, task)).state, 'merged', 'without a resync a merged PR is merged');
  console.log('ok - findPr: during a resync the old merged PR is not reported');
}
{ // resync: the new PR is open on the same branch -> it is found
  const { d } = fp([[/head=o:agent\/a/, [pull(12), pull(5, { state: 'closed', merged_at: 'x' })]]]);
  assert.equal((await findPr(d, { ...task, resyncFrom: 5 })).number, 12);
  console.log('ok - findPr: the new sync PR replaces the merged one');
}
{ // lookup failure -> null, logged
  const { d, logs } = fp([], { githubToken: async () => { throw new Error('boom'); } });
  assert.equal(await findPr(d, task), null); assert.equal(logs[0][0], 'pr.lookup_failed');
  console.log('ok - findPr: a failed lookup is null and logged');
}
{ // settleResync: cleared once the new PR is the task's PR
  const { settleResync } = await import('./syncwire.mjs');
  assert.equal(settleResync({ pr: null, resyncFrom: 5 }).resyncFrom, 5, 'no new PR yet: kept');
  assert.equal(settleResync({ pr: { number: 5 }, resyncFrom: 5 }).resyncFrom, 5, 'still the merged one: kept');
  assert.equal(settleResync({ pr: { number: 12 }, resyncFrom: 5 }).resyncFrom, undefined, 'new PR found: cleared');
  console.log('ok - settleResync: the marker goes once the new PR is found');
}
