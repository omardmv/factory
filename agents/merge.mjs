// What to do with an approved PR, from GitHub's view of it. Pure, so it is
// tested on its own: `node agents/test-merge.mjs`.
export function mergeDecision(pr, t, into, conflictRounds = 0, maxConflictRounds = 3) {
  if (pr.merged_at) return { action: 'already-merged' };
  if (pr.state !== 'open') return { action: 'give-up', why: 'the PR is closed' };
  if (pr.base.ref !== into) return { action: 'give-up', why: `it targets ${pr.base.ref}; this project only merges into ${into} by itself` };
  if (pr.head.sha !== t.reviewedSha) return { action: 'give-up', why: `its head moved to ${pr.head.sha.slice(0, 7)} after the review of ${t.reviewedSha.slice(0, 7)}` };
  if (pr.mergeable === false || pr.mergeable_state === 'dirty') return conflictRounds >= maxConflictRounds
    ? { action: 'give-up', why: `it conflicts with ${into} again after ${maxConflictRounds} rounds of resolving` }
    : { action: 'resolve', round: conflictRounds + 1 };
  if (pr.mergeable === null || pr.mergeable === undefined) return { action: 'wait' };
  return { action: 'merge' };
}
