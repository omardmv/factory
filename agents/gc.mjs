// Housekeeping decisions, pure and tested on their own: `node agents/test-gc.mjs`.
// server.mjs wires the task-folder sweep, the preview sweep and the disk alert;
// `factory-box gc` (nightly, cron) wires the docker prune and uses the CLI at the bottom.

const H = 3600 * 1000;
export const FINISHED_GRACE_H = 6;      // merged/done: heavy folders go this long after the last change
export const STOPPED_GRACE_H = 7 * 24;  // stopped: a person may still resume it, so it keeps its checkout a week
// rebuilt on demand and never read once a task is over; the dashboard needs the rest
// (task.json, messages.jsonl, activity.log, claude/, workspace/{screens,videos,attachments,decisions.tsv})
export const HEAVY = ['workspace/venv', 'workspace/.venv', 'workspace/repo', 'workspace/pgdata', 'workspace/node_modules', 'review-claude'];

const isMerged = (t) => t.status === 'merged' || t.pr?.state === 'merged';

// should this task's heavy folders be deleted now? busy: running, queued or building a preview
export function taskCleanup(t, { now, busy = false }) {
  if (busy) return { clean: false, why: 'busy' };
  if (t.previewPr) return { clean: false, why: 'preview still up' };
  const age = t.updatedAt ? (now - Date.parse(t.updatedAt)) / H : NaN;
  if (Number.isNaN(age)) return { clean: false, why: 'no timestamp' };
  if (t.status === 'stopped' && !isMerged(t)) return age >= STOPPED_GRACE_H ? { clean: true, why: 'stopped a week ago' } : { clean: false, why: 'stopped recently' };
  const finished = t.status === 'merged' || t.status === 'done' || isMerged(t);
  if (!finished) return { clean: false, why: 'not finished' };
  return age >= FINISHED_GRACE_H ? { clean: true, why: 'finished' } : { clean: false, why: 'finished recently' };
}

// a preview must come down when its task ended or its PR merged/closed
export const previewIsDead = (t) => !!t.previewPr && (['merged', 'stopped', 'done'].includes(t.status) || ['merged', 'closed'].includes(t.pr?.state));
// a task that is paused or otherwise not final but has a preview: its stored PR state may be stale, ask GitHub
export const previewNeedsPrCheck = (t) => !!t.previewPr && !!t.pr?.number && !previewIsDead(t);

// disk alert: fires once when usage reaches the threshold, again after repeatH while it stays there,
// re-arms once usage drops `hysteresis` points below. state: { alertedAt?: ms }
export function diskAlert(pct, state, now, { threshold = 85, hysteresis = 5, repeatH = 24 } = {}) {
  if (!Number.isFinite(pct)) return { alert: false, state };
  if (pct < threshold - hysteresis) return { alert: false, state: {} };
  if (pct < threshold) return { alert: false, state };
  if (state.alertedAt && now - state.alertedAt < repeatH * H) return { alert: false, state };
  return { alert: true, state: { alertedAt: now } };
}
export const diskAlertText = (pct, threshold = 85) => `⚠️ The factory box disk is ${pct}% full (alert at ${threshold}%). The nightly \`factory-box gc\` cleans task folders, old staging images, build cache and orphan volumes; if it stays high, look at what grew (\`docker system df\`, /srv/factory/agents/tasks).`;

// Coolify names its images <24 chars of a-z0-9> or <uuid>_<service>; the factory's own and other tenants' stay out
const COOLIFY_REPO = /^[a-z0-9]{24}(_[a-z0-9-]+)?$/;
// images: [{ id, repo, tag, created }] (created: ISO or ms). Keep the `keep` newest per repo, and any image in use
// (inUse: set of image ids). Returns the "repo:tag" refs to remove.
export function imagesToRemove(images, inUse = new Set(), keep = 5) {
  const by = new Map();
  for (const i of images) {
    if (!COOLIFY_REPO.test(i.repo ?? '') || !i.tag || i.tag === '<none>' || i.tag === 'latest') continue;
    if (!by.has(i.repo)) by.set(i.repo, []);
    by.get(i.repo).push(i);
  }
  const out = [];
  for (const list of by.values()) {
    list.sort((a, b) => (+b.created || Date.parse(b.created)) - (+a.created || Date.parse(a.created)));
    const keptIds = new Set(list.slice(0, keep).map((i) => i.id));
    for (const i of list.slice(keep)) if (!inUse.has(i.id) && !keptIds.has(i.id)) out.push(`${i.repo}:${i.tag}`);
  }
  return out;
}

// only anonymous volumes (a 64-hex name) that nothing uses; named volumes (media, databases) are never listed
export const anonymousVolumes = (names) => names.filter((n) => /^[0-9a-f]{64}$/.test(n));

// `docker images` CreatedAt ("2026-11-12 10:00:00 +0500 +05") as ms; ISO passes through
export const parseCreated = (c) => Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d{4}/.test(c) ? c.slice(0, 19).replace(' ', 'T') + c.slice(20, 25) : c);

// CLI for factory-box: `node gc.mjs images <keep> <inUseIdsFile>` (stdin: `docker images` as lines "id|repo|tag|created")
//                       `node gc.mjs volumes` (stdin: volume names)
if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync } = await import('node:fs');
  const lines = readFileSync(0, 'utf8').split('\n').filter(Boolean);
  if (process.argv[2] === 'images') {
    const inUse = new Set(readFileSync(process.argv[4], 'utf8').split('\n').filter(Boolean));
    const imgs = lines.map((l) => { const [id, repo, tag, created] = l.split('|'); return { id, repo, tag, created: parseCreated(created) }; });
    console.log(imagesToRemove(imgs, inUse, Number(process.argv[3] ?? 5)).join('\n'));
  } else if (process.argv[2] === 'volumes') console.log(anonymousVolumes(lines).join('\n'));
  else { console.error('usage: gc.mjs images <keep> <inUseFile> | volumes'); process.exit(2); }
}
