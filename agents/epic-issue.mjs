// The epic on GitHub: one epic issue (goal, waves, build order, a table of
// task states) with one sub-issue per planned task, closed when its PR merges.
// Pure functions; gh(token, path, method, payload) → JSON is injected, like
// media.mjs. Tested on its own: `node agents/test-epic-issue.mjs`.
//
// plan = [{key, title, task, deps, wave, issue?, issueId?}]. An item that has
// an `issue` number already has its sub-issue and is never created twice.
// states = {key: 'pending'|'running'|'merged'|'failed'|'stuck'|'dropped'}.

export const EPIC_MARK = '<!-- factory-epic -->';
const ICON = { pending: '⏳ pending', running: '🔨 running', merged: '✅ merged', failed: '❌ failed', stuck: '⚠️ needs the founder', dropped: '🚫 dropped' };
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const stateOf = (states, k) => states?.[k] ?? 'pending';
const ref = (i) => (i.issue ? `#${i.issue}` : `\`${i.key}\``);

export function renderEpicBody(goal, plan, states = {}, { tasksUrl } = {}) {
  const done = plan.filter((i) => stateOf(states, i.key) === 'merged').length;
  const maxWave = Math.max(0, ...plan.map((i) => i.wave ?? 1));
  const waves = [];
  for (let w = 1; w <= maxWave; w++) {
    const its = plan.filter((i) => (i.wave ?? 1) === w);
    if (its.length) waves.push(`**Wave ${w}**${its.length > 1 ? ' (in parallel)' : ''}\n${its.map((i) => `- ${ref(i)} ${i.title ?? i.key}`).join('\n')}`);
  }
  return [EPIC_MARK, `## Goal\n\n${String(goal ?? '').trim()}`,
    `## Progress\n\n${done}/${plan.length} tasks merged`,
    `## Waves\n\n${waves.join('\n\n')}`,
    `## Build order\n\n${plan.map((i, n) => `${n + 1}. ${ref(i)} ${i.title ?? i.key}${i.deps?.length ? ` (after ${i.deps.map((d) => ref(plan.find((p) => p.key === d) ?? { key: d })).join(', ')})` : ''}`).join('\n')}`,
    `## Tasks\n\n| Task | Depends on | Wave | State |\n|---|---|---|---|\n${plan.map((i) => `| ${ref(i)} ${cell(i.title ?? i.key)} | ${i.deps?.length ? i.deps.map((d) => ref(plan.find((p) => p.key === d) ?? { key: d })).join(', ') : '–'} | ${i.wave ?? 1} | ${ICON[stateOf(states, i.key)] ?? cell(stateOf(states, i.key))} |`).join('\n')}`,
    tasksUrl ? `\n<sub>Run by the factory · [live progress](${tasksUrl}). This issue is updated as tasks merge.</sub>` : '\n<sub>Run by the factory. This issue is updated as tasks merge.</sub>'].join('\n\n');
}

export function renderSubIssueBody(item, epicNumber, plan = []) {
  const dep = (k) => { const p = plan.find((x) => x.key === k); return p?.issue ? `#${p.issue}` : `\`${k}\``; };
  return [`Part of epic #${epicNumber} · wave ${item.wave ?? 1}`,
    item.deps?.length ? `Depends on: ${item.deps.map(dep).join(', ')}` : 'Depends on: nothing, can start right away',
    `## Task\n\n${String(item.task ?? item.title ?? '').trim()}`,
    '<sub>Opened by the factory; closed when this task\'s PR merges.</sub>'].join('\n\n');
}

const link = (gh, token, repo, epic, id) => gh(token, `/repos/${repo}/issues/${epic}/sub_issues`, 'POST', { sub_issue_id: id });

// creates sub-issues for items without one, in plan order, and links each
async function openMissing({ gh, token, repo, epic, plan }) {
  const items = {};
  for (const it of plan) {
    if (it.issue) { items[it.key] = { number: it.issue, id: it.issueId }; continue; }
    const made = await gh(token, `/repos/${repo}/issues`, 'POST', { title: it.title ?? it.key, body: renderSubIssueBody(it, epic, plan) });
    it.issue = made.number; it.issueId = made.id;
    items[it.key] = { number: made.number, id: made.id };
    await link(gh, token, repo, epic, made.id);
  }
  return items;
}

export async function createEpicIssue({ gh, token, repo, title, goal, plan }) {
  const made = await gh(token, `/repos/${repo}/issues`, 'POST', { title, body: renderEpicBody(goal, plan, {}) });
  const items = await openMissing({ gh, token, repo, epic: made.number, plan });
  await gh(token, `/repos/${repo}/issues/${made.number}`, 'PATCH', { body: renderEpicBody(goal, plan, {}) }); // now with issue numbers
  return { epic: { number: made.number, url: made.html_url }, items };
}

// epic = {number, goal?}; opts.goal / opts.tasksUrl for the body. Returns {items}.
export async function syncEpicIssue({ gh, token, repo, epic, goal, plan, states = {}, tasksUrl }) {
  const R = `/repos/${repo}`;
  const items = await openMissing({ gh, token, repo, epic: epic.number, plan });
  for (const it of plan) {
    const st = stateOf(states, it.key);
    const want = st === 'merged' ? 'completed' : (st === 'failed' || st === 'dropped') ? 'not_planned' : null;
    if (!want) continue;
    const cur = await gh(token, `${R}/issues/${it.issue}`);
    if (cur.state === 'closed') continue;
    if (want === 'not_planned') await gh(token, `${R}/issues/${it.issue}/comments`, 'POST', { body: st === 'failed' ? 'The factory could not finish this task (its PR was closed or the agent stopped), so it is closed as not planned.' : 'This task was dropped from the epic\'s plan.' });
    await gh(token, `${R}/issues/${it.issue}`, 'PATCH', { state: 'closed', state_reason: want });
  }
  await gh(token, `${R}/issues/${epic.number}`, 'PATCH', { body: renderEpicBody(goal ?? epic.goal, plan, states, { tasksUrl }) });
  return { items };
}
