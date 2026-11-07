// Media storage for the PR's evidence report (agents/report.mjs): the factory
// (not the agent) uploads the task's screenshots and videos (workspace/screens,
// workspace/videos) to the repo's `factory-media` branch, never merged
// anywhere. It posts no comment itself: the report does, once, at the end.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';

export const MEDIA_BRANCH = 'factory-media';
const MEDIA_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'webm', 'mp4']);
const MEDIA_MAX_BYTES = 15e6, MEDIA_MAX_FILES = 30;
export function mediaFiles(workspace) {
  const out = [];
  for (const sub of ['screens', 'videos']) {
    const root = `${workspace}/${sub}`;
    if (!existsSync(root)) continue;
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
  return out.sort((a, b) => a.sub.localeCompare(b.sub) || a.rel.localeCompare(b.rel)).slice(0, MEDIA_MAX_FILES);
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
