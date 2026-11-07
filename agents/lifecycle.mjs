// What happens to a task after an agent turn. Pure: the facts come in, a status
// comes out. Tested by `node agents/test-lifecycle.mjs`.
//
// in: { task, mode, from, origin, head, decision, unasked, hasChecks, hasQa }
//   decision: the reply carries a DECISION NEEDED block
//   unasked:  the reply asked the person something in plain text (agents/unasked.mjs)
//   head:     head sha of the open PR, or null
export function nextStatusAfterAgentTurn({ task: t, mode, from, origin, head, decision = false, unasked = false, hasChecks = false, hasQa = false }) {
  if (from === 'pause') return 'paused';
  const needsDecision = decision || unasked;
  if (t.kind === 'report') return needsDecision ? 'decision needed' : mode === 'plan' ? 'waiting for you' : 'done';
  if (mode === 'plan') return 'waiting for you';
  if (needsDecision) return 'decision needed'; // before any panel run: the person answers first
  if (!head) return 'waiting for you';
  // an answer to review findings goes back to the panel even with no new commit:
  // the finding may have asked for evidence (a run, a PR comment), not code.
  // Bounded: every CHANGES verdict counts toward MAX_FACTORY_ROUNDS.
  if (head === t.reviewedSha && t.verdict !== 'PASS' && [from, origin].includes('review')) return 'reviewing';
  if (head === t.reviewedSha) return t.verdict === 'PASS' ? 'ready for you' : 'waiting for you'; // nothing new since the review
  // green: the QA tester first (once per head; a head the agent kept after a
  // QA FAIL goes on to the panel, which sees the report and judges the dispute)
  if (!hasChecks || (t.greenSha && head.startsWith(t.greenSha))) return hasQa && head !== t.qaTestedSha ? 'testing' : 'reviewing';
  return 'waiting for checks';
}
