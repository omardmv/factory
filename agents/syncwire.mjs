// The server's wiring around a merged sync PR, with its effects injected so it is tested without GitHub, disk or
// containers: `node agents/test-syncwire.mjs`. server.mjs builds these once with the real gh/load/update/say/enqueue.
import { syncCheck, syncFollowUp } from './merge.mjs';

// d: { gh(token, url), load(id), update(id, fn), say(id, who, text, opts), enqueue(id, prompt, mode, kind), log(name, data),
//      maxRounds, sleep(ms), tries?, waitMs? }
// After a sync merge: the open PRs from the branch just merged into (staging -> main) must now be mergeable.
export async function verifyUnblocked(d, id, token, repo, branch) {
  const owner = repo.split('/')[0];
  let r;
  for (let i = 0; i < (d.tries ?? 6); i++) { // GitHub computes mergeability lazily
    const list = await d.gh(token, `/repos/${repo}/pulls?state=open&head=${owner}:${branch}&per_page=20`);
    r = syncCheck(await Promise.all(list.map((x) => d.gh(token, `/repos/${repo}/pulls/${x.number}`))));
    if (r.ok || r.conflicting.length) break;
    await d.sleep(d.waitMs ?? 5000);
  }
  const cur = d.load(id);
  const f = syncFollowUp(r, cur.syncRounds ?? 0, d.maxRounds, cur.syncRechecks ?? 0);
  if (f.action === 'done') { d.update(id, (x) => { delete x.syncVerify; delete x.syncRechecks; }); d.log('merge.verified', { task: id, branch }); return; }
  if (f.action === 'recheck') { d.update(id, (x) => { x.syncVerify = { branch, repo }; x.syncRechecks = f.tries; }); d.log('merge.verify_later', { task: id, branch, tries: f.tries }); return; } // retryMerges looks again
  d.update(id, (x) => { delete x.syncVerify; });
  if (f.action === 'resync') {
    // main moved again (or the sync missed a conflict): sync again, automatically, once.
    // resyncFrom: the merged PR's number, so a lookup that still finds it does not mark the working task merged again
    d.update(id, (x) => { x.syncRounds = f.round; x.status = 'working'; x.mergeWanted = false; x.resyncFrom = x.pr?.number; x.pr = null; });
    d.say(id, 'factory', `[factory] Merged, but ${f.prs.map((n) => `#${n}`).join(', ')} from ${branch} still conflicts. Starting a follow-up sync (round ${f.round} of ${d.maxRounds}).`);
    d.enqueue(id, `[factory] Your sync PR merged into ${branch}, but ${f.prs.map((n) => `#${n}`).join(', ')} still conflicts with its base (the base moved, or the first sync missed it). Work on your own branch \`agent/${id}\` (reset it to \`origin/${branch}\`; the old head is already merged, so a plain push works, no force): merge the base in with a real merge (\`git merge origin/<base>\`, resolving every conflict), put "sync" in the PR title, push \`agent/${id}\` and open a new PR into ${branch}. Never rebase, squash or force-push, and never hand the merge to the person: the factory merges it with a merge commit.`, 'bypassPermissions', 'conflict');
    d.log('merge.resync', { task: id, branch, ...r, round: f.round });
    return;
  }
  d.say(id, 'factory', `[factory] Merged into ${branch}, but ${f.why}. This one needs you.`, { ping: true });
  d.log('merge.verify_conflict', { task: id, branch, ...r });
}

// A sync merge whose target PR GitHub could not judge yet: look again on the poll (no ping until it stays unknown).
// One task's failure (a bad GitHub token, a failed lookup) is logged and never stops the others, nor the merges after it.
// d also has: { tasks(), githubToken(repo) }
export async function retrySyncChecks(d) {
  for (const t of d.tasks().filter((x) => x.syncVerify)) {
    try {
      const token = await d.githubToken(t.syncVerify.repo);
      await verifyUnblocked(d, t.id, token, t.syncVerify.repo, t.syncVerify.branch);
    } catch (e) { d.log('merge.verify_failed', { task: t.id, error: e.message }); }
  }
}

// The new PR is the task's PR now: the resync marker has done its job. Mutates and returns the task.
export function settleResync(task) {
  if (task.resyncFrom != null && task.pr && task.pr.number !== task.resyncFrom) delete task.resyncFrom;
  return task;
}

// The PR lookup. d: { githubToken(repo), gh(token, url), workspaceBranches(task), pickPr(list), log }
export async function findPr(d, task) {
  try {
    const owner = task.repo.split('/')[0];
    const token = await d.githubToken(task.repo);
    let p = d.pickPr(await d.gh(token, `/repos/${task.repo}/pulls?state=all&sort=created&direction=desc&head=${owner}:agent/${task.id}`));
    // the first PR merged: a follow-up (sync) PR from another branch of the workspace is the one in play
    if (p?.merged_at) for (const b of d.workspaceBranches(task)) { const o = d.pickPr(await d.gh(token, `/repos/${task.repo}/pulls?state=open&head=${owner}:${encodeURIComponent(b)}`)); if (o) { p = o; d.log('pr.followup', { task: task.id, branch: b, pr: o.number }); break; } }
    // an agent that pushed its PR from another branch (it happened: perf/lazy-screens): look at every
    // branch in its workspace, so the PR is still reviewed and reaches the founder instead of being orphaned
    if (!p) for (const b of d.workspaceBranches(task)) { p = (await d.gh(token, `/repos/${task.repo}/pulls?state=all&head=${owner}:${encodeURIComponent(b)}`))[0]; if (p) { d.log('pr.other_branch', { task: task.id, branch: b, pr: p.number }); break; } }
    // a resyncing task (see verifyUnblocked) has not opened its new PR yet: GitHub still only knows the merged one, and
    // reporting it would show the working task as merged (epic progress, loops). No PR yet is the truth.
    if (p && task.resyncFrom != null && p.number === task.resyncFrom && p.merged_at) return null;
    return p ? { number: p.number, url: p.html_url, state: p.merged_at ? 'merged' : p.state, head: p.head.sha } : null;
  } catch (e) { d.log('pr.lookup_failed', { task: task.id, error: e.message }); return null; }
}
