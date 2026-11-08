// Media storage for the PR's evidence report (agents/report.mjs): the factory
// (not the agent) uploads the task's screenshots and videos (workspace/screens,
// workspace/videos) to the repo's `factory-media` branch, never merged
// anywhere. It posts no comment itself: the report does, once, at the end.
import { readFileSync, readdirSync, lstatSync, statSync, existsSync } from 'node:fs';

export const MEDIA_BRANCH = 'factory-media';
const MEDIA_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'webm', 'mp4']);
// a cap per kind: 36 screenshots once crowded out every video of a task (a single cap of 30, screenshots first)
const MEDIA_MAX_BYTES = 15e6, MEDIA_MAX = { screens: 40, videos: 20 };
export function mediaFiles(workspace) {
  const out = [];
  for (const sub of ['screens', 'videos']) {
    const root = `${workspace}/${sub}`;
    // the agent owns this folder: a symlink here would list (and publish) files outside the workspace
    let top; try { top = lstatSync(root); } catch { continue; }
    if (!top.isDirectory()) continue;
    const walk = (d, rel, depth) => { for (const f of readdirSync(d, { withFileTypes: true })) {
      if (f.name.startsWith('.') || f.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${f.name}` : f.name;
      if (f.isDirectory()) { if (depth < 3) walk(`${d}/${f.name}`, r, depth + 1); continue; }
      if (!f.isFile() || !MEDIA_EXT.has(f.name.split('.').pop().toLowerCase()) || !/^[\w.@\/-]+$/.test(r)) continue;
      const st = statSync(`${d}/${f.name}`);
      if (st.size > 0 && st.size <= MEDIA_MAX_BYTES) out.push({ sub, rel: r, path: `${d}/${f.name}`, mtime: Math.floor(st.mtimeMs), video: /\.(webm|mp4)$/i.test(f.name) });
    } };
    walk(root, '', 0);
  }
  const sorted = out.sort((a, b) => a.sub.localeCompare(b.sub) || a.rel.localeCompare(b.rel));
  return [...sorted.filter((x) => x.sub === 'videos').slice(0, MEDIA_MAX.videos), ...sorted.filter((x) => x.sub === 'screens').slice(0, MEDIA_MAX.screens)]
    .sort((a, b) => a.sub.localeCompare(b.sub) || a.rel.localeCompare(b.rel));
}

// The agent's last e2e run, as Playwright left it in /workspace/videos: .last-run.json ({ status,
// failedTests }) and, per failed test, an error-context.md naming it. -> { status, failed: [name], at } | null
export function lastE2eRun(workspace) {
  const root = `${workspace}/videos`, f = `${root}/.last-run.json`;
  if (!existsSync(f)) return null;
  let j; try { j = JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
  const status = j?.status === 'passed' ? 'passed' : j?.status === 'failed' ? 'failed' : null;
  if (!status) return null;
  const failed = [];
  if (status === 'failed') for (const d of readdirSync(root, { withFileTypes: true })) {
    const ec = `${root}/${d.name}/error-context.md`;
    if (!d.isDirectory() || !existsSync(ec)) continue;
    const name = /^- Name:\s*(.+)$/m.exec(readFileSync(ec, 'utf8'))?.[1]?.trim();
    failed.push((name ?? d.name).slice(0, 200));
  }
  return { status, failed: failed.slice(0, 10), count: Array.isArray(j.failedTests) ? j.failedTests.length : failed.length, at: new Date(statSync(f).mtimeMs).toISOString() };
}
// gh(token, url, method, payload) → JSON. Uploads what is new; returns the new `done` map and every
// published file as an item (with its commit and path on the media branch), or null if there is no media.
export async function publishMedia({ gh, token, repo, pr, taskId, workspace, done = {} }) {
  const files = mediaFiles(workspace);
  const fresh = files.filter((f) => done[`${f.sub}/${f.rel}`]?.mtime !== f.mtime);
  const R = `/repos/${repo}`, next = { ...done };
  if (fresh.length) {
    let parent = null, baseTree;
    try { const ref = await gh(token, `${R}/git/ref/heads/${MEDIA_BRANCH}`); parent = ref.object.sha; baseTree = (await gh(token, `${R}/git/commits/${parent}`)).tree.sha; } catch { /* first time: an orphan branch */ }
    const tree = [];
    if (!parent) {
      const readme = await gh(token, `${R}/git/blobs`, 'POST', { content: '# factory-media\n\nScreenshots and videos the factory\'s agents took while working on PRs, shown in each PR\'s evidence report comment. Never merged into any branch; safe to delete (old PR comments then lose their images).\n', encoding: 'utf-8' });
      tree.push({ path: 'README.md', mode: '100644', type: 'blob', sha: readme.sha });
    }
    for (const f of fresh) {
      const blob = await gh(token, `${R}/git/blobs`, 'POST', { content: readFileSync(f.path).toString('base64'), encoding: 'base64' });
      tree.push({ path: `${taskId}/${f.sub}/${f.rel}`, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const newTree = await gh(token, `${R}/git/trees`, 'POST', { ...(baseTree ? { base_tree: baseTree } : {}), tree });
    const commit = await gh(token, `${R}/git/commits`, 'POST', { message: `media: task ${taskId} (PR #${pr}), ${fresh.length} file${fresh.length === 1 ? '' : 's'}`, tree: newTree.sha, parents: parent ? [parent] : [] });
    if (parent) await gh(token, `${R}/git/refs/heads/${MEDIA_BRANCH}`, 'PATCH', { sha: commit.sha });
    else await gh(token, `${R}/git/refs`, 'POST', { ref: `refs/heads/${MEDIA_BRANCH}`, sha: commit.sha });
    for (const f of fresh) next[`${f.sub}/${f.rel}`] = { mtime: f.mtime, commit: commit.sha };
  }
  const items = files.filter((f) => next[`${f.sub}/${f.rel}`]).map((f) => ({ ...f, commit: next[`${f.sub}/${f.rel}`].commit, repoPath: `${taskId}/${f.sub}/${f.rel}` }));
  return { done: next, items, files: fresh.length };
}

// the one comment starting with `mark`, edited in place or created
export async function upsertComment({ gh, token, repo, pr, mark, body }) {
  const R = `/repos/${repo}`;
  const comments = await gh(token, `${R}/issues/${pr}/comments?per_page=100`);
  const mine = comments.find((c) => c.body?.startsWith(mark));
  return mine ? gh(token, `${R}/issues/comments/${mine.id}`, 'PATCH', { body }) : gh(token, `${R}/issues/${pr}/comments`, 'POST', { body });
}
