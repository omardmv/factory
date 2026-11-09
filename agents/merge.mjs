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

// How to merge: a PR that brings another branch in (main merged into staging, a conflict resolution) must
// land with a merge commit. A squash drops the other parent, so the PR it was meant to unblock (staging -> main)
// stays CONFLICTING. Everything else uses the project's configured method (default 'merge').
// commits: the PR's commits as GitHub lists them ({ parents: [...], commit: { message } }).
const SYNC_TITLE = /\b(sync(s|ed|ing)?|resolv(e|es|ed|ing)\b.*\bconflicts?|conflicts?\b.*\bresol)/i;
export function isSyncPr(pr, commits = []) {
  if (SYNC_TITLE.test(String(pr.title ?? '')) || SYNC_TITLE.test(String(pr.head?.ref ?? '').replace(/[-_/]+/g, ' '))) return true;
  // a merge commit that is not just "bring the PR's own base up to date" is another branch brought in
  const base = String(pr.base?.ref ?? '');
  return commits.some((c) => {
    if ((c.parents?.length ?? 0) < 2) return false;
    const from = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(String(c.commit?.message ?? ''))?.[1];
    return !from || (from !== base && from !== `origin/${base}`);
  });
}
export function mergeMethodFor(pr, commits = [], configured = 'merge') {
  return isSyncPr(pr, commits) ? 'merge' : configured || 'merge';
}
// After a sync PR lands: the open PRs from the target branch into somewhere else (staging -> main) must now merge cleanly.
// prs: GitHub PRs fetched after the merge. -> { ok, conflicting: [numbers], unknown: [numbers] }
export function syncCheck(prs = []) {
  const open = prs.filter((p) => p.state === 'open');
  const conflicting = open.filter((p) => p.mergeable === false || p.mergeable_state === 'dirty').map((p) => p.number);
  const unknown = open.filter((p) => !conflicting.includes(p.number) && (p.mergeable === null || p.mergeable === undefined)).map((p) => p.number);
  return { ok: !conflicting.length && !unknown.length, conflicting, unknown };
}

// The founder approves each feature before it merges (project config "approval": true).
// -> { action: 'merge' } | { action: 'preview' } (build the reviewed head's preview first) | { action: 'ask' } (post the ready-for-your-check message once per reviewed head) | { action: 'wait' }
// lastRun: the agent's last e2e run in its workspace ({ status, failed }); a failed one goes back to the agent
// once per reviewed head before the founder is asked (then the founder is asked, with a warning)
export function approvalGate(t, project, lastRun = null) {
  if (!project?.approval) return { action: 'merge' };
  if (t.approved && t.approved === t.reviewedSha) return { action: 'merge' };
  if (t.approvalAskedSha === t.reviewedSha) return { action: 'wait' };
  if (lastRun?.status === 'failed' && t.e2eFixSha !== t.reviewedSha) return { action: 'fix-e2e' };
  // a project with previews: build the reviewed head's preview first, then ask (a failed build asks too)
  if (project.previews && t.previewFor !== t.reviewedSha) return { action: 'preview' };
  return { action: 'ask' };
}
// the founder pressed Approve for the head they were shown
export function approveCheck(t, sha) {
  if (t.status !== 'ready for you' || t.verdict !== 'PASS' || !t.reviewedSha) return { error: 'this task is not ready for approval' };
  if (sha && sha !== t.reviewedSha) return { error: `the PR changed since you were asked (${String(sha).slice(0, 7)} -> ${t.reviewedSha.slice(0, 7)}); press Approve on the newest "Ready for your check" message` };
  return { ok: true, sha: t.reviewedSha };
}

// Is a merge live? After the factory merges, the project's staging is asked which commit it runs
// (box config "deployCheck": { "url": ".../version.json", "field": "version", "withinMin": 45 }).
// deploy: { sha, at, state: 'waiting' | 'late' }; version: what staging reports now (or null);
// relation: GitHub's compare of the merge commit with that version ('identical' | 'ahead' | 'behind' | 'diverged' | null)
// -> { state: 'live' | 'waiting' | 'late', say?: string }
export function deployState(deploy, { version, relation, behindBy = null, now, withinMin = 45, base = 'staging' }) {
  const live = !!version && (version === deploy.sha || relation === 'identical' || relation === 'ahead');
  const mins = Math.round((now - Date.parse(deploy.at)) / 60000);
  if (live) return { state: 'live', say: `🌐 Live on ${base}: it runs ${String(version).slice(0, 7)}, which includes this merge (${mins} min after it).${deploy.state === 'late' ? ' Late, but there.' : ''}` };
  if (deploy.state === 'waiting' && mins >= withinMin) {
    const where = version ? `${base} still runs ${String(version).slice(0, 7)}${behindBy ? `, ${behindBy} commit${behindBy === 1 ? '' : 's'} behind this merge` : ''}` : `${base} did not say which version it runs`;
    return { state: 'late', say: `⏳ Not live on ${base} ${mins} min after the merge: ${where}. Its deploy may be slow, queued or failing; the factory keeps checking and says when it lands.` };
  }
  return { state: deploy.state };
}
