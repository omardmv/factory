// What to do with an approved PR, from GitHub's view of it. Pure, so it is
// tested on its own: `node agents/test-merge.mjs`.
// checks (optional): the project's required checks, enforced by the factory itself
// (a private repo on a free plan has no branch protection):
//   { required: ['e2e'], runs: [{ name, status, conclusion, started_at, url }], waitedMin, maxWaitMin, rounds, maxRounds }
// runs are the check runs and commit statuses on the PR head.
const PASSED = ['success', 'neutral', 'skipped'];
export function requiredChecks({ required = [], runs = [] } = {}) {
  const latest = new Map();
  for (const r of runs) { const k = String(r.name ?? ''); const o = latest.get(k); if (!o || String(r.started_at ?? '') >= String(o.started_at ?? '')) latest.set(k, r); }
  const out = { passed: [], failed: [], pending: [] };
  for (const name of required) {
    const r = latest.get(name);
    if (!r || r.status !== 'completed') out.pending.push(name);
    else if (PASSED.includes(r.conclusion)) out.passed.push(name);
    else out.failed.push({ name, conclusion: r.conclusion ?? 'failure', url: r.url ?? null });
  }
  return out;
}
export function mergeDecision(pr, t, into, conflictRounds = 0, maxConflictRounds = 3, checks = null) {
  if (pr.merged_at) return { action: 'already-merged' };
  if (pr.state !== 'open') return { action: 'give-up', why: 'the PR is closed' };
  if (pr.base.ref !== into) return { action: 'give-up', why: `it targets ${pr.base.ref}; this project only merges into ${into} by itself` };
  if (pr.head.sha !== t.reviewedSha) return { action: 'give-up', why: `its head moved to ${pr.head.sha.slice(0, 7)} after the review of ${t.reviewedSha.slice(0, 7)}` };
  if (pr.mergeable === false || pr.mergeable_state === 'dirty') return conflictRounds >= maxConflictRounds
    ? { action: 'give-up', why: `it conflicts with ${into} again after ${maxConflictRounds} rounds of resolving` }
    : { action: 'resolve', round: conflictRounds + 1 };
  if (pr.mergeable === null || pr.mergeable === undefined) return { action: 'wait' };
  if (checks?.required?.length) {
    const c = requiredChecks(checks);
    if (c.failed.length) return (checks.rounds ?? 0) >= (checks.maxRounds ?? 3)
      ? { action: 'give-up', why: `required check${c.failed.length > 1 ? 's' : ''} ${c.failed.map((f) => f.name).join(', ')} still fail${c.failed.length > 1 ? '' : 's'} after ${checks.maxRounds ?? 3} rounds of fixing` }
      : { action: 'fix-checks', failed: c.failed, round: (checks.rounds ?? 0) + 1 };
    if (c.pending.length) return (checks.waitedMin ?? 0) >= (checks.maxWaitMin ?? 45)
      ? { action: 'give-up', why: `required check${c.pending.length > 1 ? 's' : ''} ${c.pending.join(', ')} did not finish on ${pr.head.sha.slice(0, 7)} within ${checks.maxWaitMin ?? 45} min` }
      : { action: 'wait', why: `waiting for required check${c.pending.length > 1 ? 's' : ''} ${c.pending.join(', ')}` };
  }
  return { action: 'merge' };
}
