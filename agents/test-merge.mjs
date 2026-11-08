// node agents/test-merge.mjs
import assert from 'node:assert/strict';
import { mergeDecision, requiredChecks, approvalGate, approveCheck } from './merge.mjs';
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
  console.log('ok approval: asked once per reviewed head, merges only the head the founder approved, a new head asks again');
}
console.log(`all ${cases.length} passed`);
