// node agents/test-merge.mjs
import assert from 'node:assert/strict';
import { mergeDecision } from './merge.mjs';
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
console.log(`all ${cases.length} passed`);
