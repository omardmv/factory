// Improvement loops, pure decisions: `node agents/test-loops.mjs`.
// A project switches loops on in agents/projects.json: `loops: { security: "weekly", docs: "monthly" }`.
//  - unset (no `loops` key): nothing runs; the person gets a reminder in Slack, at most once a week
//  - off (`loops: false`, `{}`, or every kind "off"): the person said no; nothing runs, no reminder
//  - on: a kind is due when its cadence has passed since it last started. A cadence of
//    true / "on" means weekly. Cap: one open loop task (so one open loop PR) per project;
//    a due loop waits while one is open. At most one loop starts per tick: the most overdue.
// server.mjs wires this to the task queue; nothing a loop makes merges outside the normal pipeline.

export const KINDS = ['performance', 'security', 'cleanup', 'docs'];
const DAY = 86400000;
export const CADENCE_MS = { daily: DAY, weekly: 7 * DAY, biweekly: 14 * DAY, monthly: 30 * DAY };
export const DEFAULT_CADENCE = 'weekly';
export const REMINDER_EVERY_MS = 7 * DAY;
// a loop task in one of these is no longer open (its PR merged or was given up on)
export const CLOSED = ['merged', 'stopped', 'done'];

const ms = (iso) => { const v = Date.parse(iso ?? ''); return Number.isFinite(v) ? v : 0; };

// -> { mode: 'unset' | 'off' | 'on', kinds: { kind: cadenceMs } }
export function loopsConfig(project) {
  const l = project?.loops;
  if (l === undefined || l === null) return { mode: 'unset', kinds: {} };
  if (typeof l !== 'object') return { mode: 'off', kinds: {} };
  const kinds = {};
  for (const k of KINDS) {
    let c = l[k];
    if (c === true || c === 'on') c = DEFAULT_CADENCE;
    if (typeof c === 'string' && CADENCE_MS[c]) kinds[k] = CADENCE_MS[c];
  }
  return { mode: Object.keys(kinds).length ? 'on' : 'off', kinds };
}

// a loops setting from outside (Slack buttons, the API): only known kinds and cadences.
// false / 'off' / every kind off -> false (the person said no); otherwise { kind: cadence }
export function normalizeLoops(input) {
  if (input === false || input === 'off' || input === null) return false;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('loops must be false or { kind: cadence }');
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (!KINDS.includes(k)) throw new Error(`unknown loop "${k}": one of ${KINDS.join(', ')}`);
    if (v === false || v === 'off' || v === null) continue;
    const c = v === true || v === 'on' ? DEFAULT_CADENCE : v;
    if (typeof c !== 'string' || !CADENCE_MS[c]) throw new Error(`unknown cadence "${v}" for ${k}: one of ${Object.keys(CADENCE_MS).join(', ')} or off`);
    out[k] = c;
  }
  return Object.keys(out).length ? out : false;
}
export const RECOMMENDED_LOOPS = { security: 'weekly', performance: 'weekly', cleanup: 'biweekly', docs: 'monthly' };

// state: { lastStarted: { kind: iso }, lastReminder: iso }; a kind never run is due at once
export function dueKinds(config, state, now) {
  return Object.entries(config.kinds)
    .map(([kind, every]) => ({ kind, overdue: now - (ms(state?.lastStarted?.[kind]) + every) }))
    .filter((d) => d.overdue >= 0 || !state?.lastStarted?.[d.kind])
    .sort((a, b) => b.overdue - a.overdue)
    .map((d) => d.kind);
}

// a PR merged or closed by hand frees the cap too, whatever the task's own status says
export const PR_CLOSED = ['merged', 'closed'];
export const isOpenLoop = (t) => !!t.loop && !CLOSED.includes(t.status) && !PR_CLOSED.includes(t.pr?.state);
export const openLoopTasks = (tasks, project) => tasks.filter((t) => t.project === project && isOpenLoop(t));

// project: its projects.json entry; state: its loop state; openLoops: its open loop tasks
// -> { action: 'start', kind } | { action: 'wait', why: 'cap' | 'not due' | 'off' } | { action: 'remind', text } | { action: 'none' }
export function loopDecision({ name, project, state, openLoops = [], now }) {
  const c = loopsConfig(project);
  if (c.mode === 'off') return { action: 'wait', why: 'off' };
  if (c.mode === 'unset') {
    if (now - ms(state?.lastReminder) < REMINDER_EVERY_MS) return { action: 'none' };
    return { action: 'remind', text: reminderText(name) };
  }
  const due = dueKinds(c, state, now);
  if (!due.length) return { action: 'wait', why: 'not due' };
  if (openLoops.length) return { action: 'wait', why: 'cap', due, open: openLoops.map((t) => t.id) };
  return { action: 'start', kind: due[0], due };
}

export const reminderText = (name) => `🔁 ${name} has no improvement loops set. Loops propose a PR on a schedule (performance, security, cleanup, docs), reviewed like any other. To switch them on, add \`"loops": { "security": "weekly", "docs": "weekly" }\` to ${name} in projects.json; to say no, set \`"loops": false\`. I will remind you once a week until it is set.`;

const ASK = {
  performance: 'Find one measurable performance problem (slow page, query, build or test step): measure it first, fix it, and show the before and after numbers.',
  security: 'Look for one real security weakness (dependencies with known advisories, secrets in the repo, unsafe input handling, over-broad permissions). Fix the most important one you can prove.',
  cleanup: 'Find one piece of tech debt (dead code, duplication, a stale flag or dependency) and remove it with no behaviour change; show the tests before and after.',
  docs: 'Find where the docs say something the code no longer does (README, setup steps, config, API) and correct them. Quote the code that proves each change.',
};
export const loopTaskText = (kind, name) => `IMPROVEMENT LOOP (${kind}) for ${name}. ${ASK[kind]}\nMake ONE small, proven change as a normal PR with a definition of done; it goes through review and QA like any task. If you find nothing worth a PR, say so with the evidence you looked at, open no PR and end your turn: the task then finishes as done. Anything bigger than one small PR: describe it in the PR body as a follow-up question for the person instead of doing it.`;

// the state after a decision was carried out
export function afterStart(state, kind, now) {
  return { ...state, lastStarted: { ...state?.lastStarted, [kind]: new Date(now).toISOString() } };
}
export const afterRemind = (state, now) => ({ ...state, lastReminder: new Date(now).toISOString() });
