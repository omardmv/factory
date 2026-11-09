// node agents/test-merge.mjs
import assert from 'node:assert/strict';
import { readSyncCommits, syncFollowUp, mergeMethodFor, isSyncPr, syncCheck, mergeDecision, requiredChecks, approvalGate, approveCheck, deployState } from './merge.mjs';
const t = { reviewedSha: 'abc1234def' };
const pr = (o = {}) => ({ state: 'open', merged_at: null, base: { ref: 'staging' }, head: { sha: 'abc1234def' }, mergeable: true, mergeable_state: 'clean', ...o });
const cases = [
  ['clean: merge', pr(), 0, 'merge'],
  ['already merged', pr({ merged_at: '2026-11-08' }), 0, 'already-merged'],
  ['closed: give up', pr({ state: 'closed' }), 0, 'give-up'],
  ['wrong base: give up', pr({ base: { ref: 'main' } }), 0, 'give-up'],
  ['head moved after review: give up', pr({ head: { sha: 'fff0000' } }), 0, 'give-up'],
  ['conflict: back to the agent, round 1', pr({ mergeable: false, mergeable_state: 'dirty' }), 0, 'resolve'],
  ['dirty but mergeable unknown: still a conflict', pr({ mergeable: null, mergeable_state: 'dirty' }), 0, 'resolve'],
  ['conflict after 2 rounds: round 3', pr({ mergeable: false, mergeable_state: 'dirty' }), 2, 'resolve'],
  ['conflict after 3 rounds: give up', pr({ mergeable: false, mergeable_state: 'dirty' }), 3, 'give-up'],
  ['still computing: wait', pr({ mergeable: null, mergeable_state: 'unknown' }), 0, 'wait'],
  ['blocked by checks but mergeable: try (GitHub refuses, retries)', pr({ mergeable_state: 'blocked' }), 0, 'merge'],
];
for (const [name, p, rounds, want] of cases) {
  const d = mergeDecision(p, t, 'staging', rounds, 3);
  assert.equal(d.action, want, name);
  if (want === 'resolve') assert.equal(d.round, rounds + 1, `${name}: round`);
  console.log(`ok - ${name}${d.why ? ` (${d.why})` : ''}`);
}
// required checks, enforced by the factory (a private repo on a free plan has no branch protection)
{
  const run = (name, conclusion, at = '2026-11-08T00:00:00Z', status = 'completed') => ({ name, status, conclusion, started_at: at, url: `https://ci/${name}` });
  const C = (runs, o = {}) => ({ required: ['e2e'], runs, waitedMin: 5, maxWaitMin: 45, rounds: 0, maxRounds: 3, ...o });
  assert.equal(mergeDecision(pr(), t, 'staging', 0, 3, C([run('e2e', 'success'), run('lint', 'failure')])).action, 'merge', 'only required checks count');
  assert.equal(mergeDecision(pr(), t, 'staging', 0, 3, C([run('e2e', 'skipped')])).action, 'merge', 'skipped passes, as on GitHub');
  let d = mergeDecision(pr(), t, 'staging', 0, 3, C([]));
  assert.equal(d.action, 'wait'); assert.match(d.why, /waiting for required check e2e/);
  assert.equal(mergeDecision(pr(), t, 'staging', 0, 3, C([run('e2e', null, undefined, 'in_progress')])).action, 'wait');
  d = mergeDecision(pr(), t, 'staging', 0, 3, C([], { waitedMin: 46 }));
  assert.equal(d.action, 'give-up'); assert.match(d.why, /e2e did not finish on abc1234 within 45 min/);
  d = mergeDecision(pr(), t, 'staging', 0, 3, C([run('e2e', 'failure')]));
  assert.deepEqual(d, { action: 'fix-checks', failed: [{ name: 'e2e', conclusion: 'failure', url: 'https://ci/e2e' }], round: 1 });
  d = mergeDecision(pr(), t, 'staging', 0, 3, C([run('e2e', 'failure')], { rounds: 3 }));
  assert.equal(d.action, 'give-up'); assert.match(d.why, /e2e still fails after 3 rounds/);
  // a re-run counts: the latest run of a name wins
  assert.equal(mergeDecision(pr(), t, 'staging', 0, 3, C([run('e2e', 'failure', '2026-11-08T00:00:00Z'), run('e2e', 'success', '2026-11-08T00:10:00Z')])).action, 'merge');
  // conflicts and a moved head are decided before checks
  assert.equal(mergeDecision(pr({ mergeable: false, mergeable_state: 'dirty' }), t, 'staging', 0, 3, C([run('e2e', 'failure')])).action, 'resolve');
  assert.equal(mergeDecision(pr(), t, 'staging', 0, 3, null).action, 'merge', 'no required checks: as before');
  assert.deepEqual(requiredChecks({ required: ['e2e', 'unit'], runs: [run('e2e', 'success')] }), { passed: ['e2e'], failed: [], pending: ['unit'] });
  console.log('ok required checks: pass merges, running or missing waits (45 min), failure goes back to the agent (3 rounds), latest re-run wins');
}

{
  const ready = { status: 'ready for you', verdict: 'PASS', reviewedSha: 'abc1234def' };
  assert.equal(approvalGate(ready, { autoMerge: 'staging' }).action, 'merge', 'no approval set: merges as before');
  assert.equal(approvalGate(ready, { approval: true }).action, 'ask', 'first time ready: ask the founder');
  assert.equal(approvalGate({ ...ready, approvalAskedSha: 'abc1234def' }, { approval: true }).action, 'wait', 'asked once per head');
  assert.equal(approvalGate({ ...ready, approved: 'abc1234def' }, { approval: true }).action, 'merge', 'approved this head: merge');
  assert.equal(approvalGate({ ...ready, approved: 'old0000', approvalAskedSha: 'old0000' }, { approval: true }).action, 'ask', 'a new head after approval: ask again');
  assert.deepEqual(approveCheck(ready, 'abc1234def'), { ok: true, sha: 'abc1234def' });
  assert.match(approveCheck(ready, 'fff0000aaa').error, /changed since you were asked/);
  assert.match(approveCheck({ ...ready, status: 'working' }, 'abc1234def').error, /not ready/);
  assert.equal(approvalGate(ready, { approval: true, previews: true }).action, 'preview', 'previews: build the preview first');
  assert.equal(approvalGate({ ...ready, previewFor: 'abc1234def' }, { approval: true, previews: true }).action, 'ask', 'preview of this head built (or failed): ask');
  assert.equal(approvalGate({ ...ready, previewFor: 'old0000' }, { approval: true, previews: true }).action, 'preview', 'a new head gets a new preview');
  const red = { status: 'failed', failed: ['main action starts the search'], count: 1 };
  assert.equal(approvalGate(ready, { approval: true }, red).action, 'fix-e2e', 'a red last run goes back to the agent first');
  assert.equal(approvalGate({ ...ready, e2eFixSha: 'abc1234def' }, { approval: true }, red).action, 'ask', 'once per head: then the founder is asked (with a warning)');
  assert.equal(approvalGate(ready, { approval: true }, { status: 'passed', failed: [], count: 0 }).action, 'ask');
  console.log('ok approval: asked once per reviewed head, merges only the head the founder approved, a new head asks again');
}
{
  const at = '2026-11-08T03:55:00Z', t0 = Date.parse(at), min = 60000;
  const d = { sha: '262147cd6c67aa', at, state: 'waiting' };
  assert.equal(deployState(d, { version: '262147cd6c67aa', now: t0 + 9 * min }).state, 'live', 'staging runs the merge commit');
  assert.match(deployState(d, { version: '855e4ee804f6', relation: 'ahead', now: t0 + 30 * min }).say, /^🌐 Live on staging: it runs 855e4ee, which includes this merge \(30 min after it\)/);
  assert.equal(deployState(d, { version: '9a4ee79818b4', relation: 'behind', now: t0 + 20 * min }).state, 'waiting', 'older version, still in time');
  const late = deployState(d, { version: '9a4ee79818b4', relation: 'behind', behindBy: 2, now: t0 + 46 * min });
  assert.equal(late.state, 'late'); assert.match(late.say, /Not live on staging 46 min after the merge: staging still runs 9a4ee79, 2 commits behind/);
  assert.deepEqual(deployState({ ...d, state: 'late' }, { version: '9a4ee79818b4', relation: 'behind', now: t0 + 80 * min }), { state: 'late' }, 'said once');
  assert.match(deployState({ ...d, state: 'late' }, { version: '262147cd6c67aa', now: t0 + 90 * min }).say, /Late, but there/);
  assert.match(deployState(d, { version: null, now: t0 + 50 * min }).say, /did not say which version it runs/);
  console.log('ok deploy check: live when staging runs a version that includes the merge; one late notice after 45 min; then live, late');
}
console.log(`all ${cases.length} passed`);

// sync PRs (another branch merged in, conflict resolution) land with a merge commit, never a squash
{
  const sp = (o = {}) => ({ title: 'feat(x): a thing', base: { ref: 'staging' }, head: { ref: 'agent/1' }, ...o });
  const mc = (message, n = 2) => ({ parents: new Array(n).fill('p'), commit: { message } });
  assert.equal(mergeMethodFor(sp(), [mc('add a', 1)], 'squash'), 'squash', 'an ordinary PR keeps the project method');
  assert.equal(mergeMethodFor(sp(), [], undefined), 'merge', 'default is merge');
  assert.equal(mergeMethodFor(sp(), [mc("Merge branch 'main' into staging")], 'squash'), 'merge', 'main merged in: merge commit');
  assert.equal(mergeMethodFor(sp(), [mc('Sync main into staging (ours)')], 'squash'), 'merge', 'unrecognised merge commit: merge');
  assert.equal(mergeMethodFor(sp(), [mc("Merge remote-tracking branch 'origin/staging' into agent/1")], 'squash'), 'squash', 'base brought into a feature branch: normal PR');
  assert.equal(mergeMethodFor(sp({ title: 'chore: sync main into staging' }), [], 'squash'), 'merge', 'title says sync');
  assert.equal(mergeMethodFor(sp({ title: 'fix: resolve conflicts on PR #78' }), [], 'squash'), 'merge', 'title says resolve conflicts');
  assert.equal(isSyncPr(sp({ head: { ref: 'sync/main-into-staging' } })), true, 'branch name says sync');
  assert.equal(isSyncPr(sp({ title: 'feat: async queue' })), false, 'async is not sync');
  assert.equal(mergeMethodFor(sp({ title: 'fix conflicts on PR #78' }), [], 'squash'), 'merge', 'task wording: fix conflicts');
  assert.equal(mergeMethodFor(sp({ body: 'This is a sync of main into staging' }), [], 'squash'), 'merge', 'body says sync');
  assert.equal(mergeMethodFor(sp(), [mc('Merge pull request #12 from a/b')], 'squash'), 'squash', 'a merged PR is not a sync');
  const n = (number, o) => ({ number, state: 'open', mergeable: true, mergeable_state: 'clean', ...o });
  assert.deepEqual(syncCheck([n(78)]), { ok: true, conflicting: [], unknown: [] });
  assert.deepEqual(syncCheck([n(78, { mergeable: false, mergeable_state: 'dirty' })]).conflicting, [78]);
  assert.deepEqual(syncCheck([n(78, { mergeable: null })]).unknown, [78]);
  assert.equal(syncCheck([]).ok, true);
  console.log('ok - sync PRs merge with a merge commit; target PR checked');
}

{
  assert.equal(syncFollowUp({ ok: true, conflicting: [], unknown: [] }).action, 'done');
  assert.deepEqual(syncFollowUp({ ok: false, conflicting: [78], unknown: [] }, 0, 1), { action: 'resync', round: 1, prs: [78] }, 'still conflicting: sync again');
  assert.equal(syncFollowUp({ ok: false, conflicting: [78], unknown: [] }, 1, 1).action, 'surface', 'after the bound: the person');
  assert.equal(syncFollowUp({ ok: false, conflicting: [], unknown: [78] }, 0, 1).action, 'surface', 'unknown is surfaced, not synced');
  console.log('ok - follow-up sync is bounded');
}

// a failed read of the PR's commits is a retry, never a blind merge; the newest page is read
{
  const pages = [];
  let r = await readSyncCommits(async (p) => { pages.push(p); return [{ parents: [1, 2] }]; }, { commits: 230 });
  assert.deepEqual(pages, [3], 'last page of 230 commits'); assert.equal(r.commits.length, 1);
  pages.length = 0; await readSyncCommits(async (p) => { pages.push(p); return []; }, { commits: 1000 }); assert.deepEqual(pages, [3], 'capped at 250 commits (page 3)');
  pages.length = 0; await readSyncCommits(async (p) => { pages.push(p); return []; }, {}); assert.deepEqual(pages, [1]);
  r = await readSyncCommits(async () => { throw new Error('502'); }, { commits: 3 });
  assert.equal(r.retry, true); assert.equal(r.commits, undefined); assert.match(r.error, /502/);
  console.log('ok - failed commit read retries');
}
{
  // the cap: round 1 resyncs, round 2 (SYNC rounds used) surfaces to the person
  const c = { ok: false, conflicting: [78], unknown: [] };
  assert.equal(syncFollowUp(c, 0, 1).action, 'resync');
  const s2 = syncFollowUp(c, 1, 1); assert.equal(s2.action, 'surface'); assert.match(s2.why, /after 1 follow-up sync/);
  assert.equal(syncFollowUp(c, 2, 1).action, 'surface', 'never loops');
  console.log('ok - follow-up sync capped at 1');
}
