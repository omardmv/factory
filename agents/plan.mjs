// An epic's plan: every task with what it depends on. Pure functions, tested
// on their own: `node agents/test-plan.mjs`.
//
// The coordinator writes the plan as a fenced block:
//   ```plan
//   {"tasks": [{"key": "flag", "title": "Hide Royale behind a flag", "task": "...", "depends_on": []},
//              {"key": "night-counter", "title": "...", "task": "...", "depends_on": ["flag"]}]}
//   ```
// A task starts as soon as every task it depends on has merged. Waves are only
// the result: wave 1 has no dependencies, wave n depends on waves before it.

export const MAX_PLAN_TASKS = 40;
const KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;

// What the coordinator is told when it writes or revises a plan.
export const PLAN_TYPES = ['feature', 'fix', 'hotfix', 'refactor', 'perf', 'design', 'test', 'docs', 'ci', 'chore', 'research'];
export const PLAN_RULES = `The plan lists EVERY task of the epic. Each task is one PR an agent can finish and prove on its own (its own tests, its own review): say what to change, where, and how done is checked, in a few sentences, self-contained (the agent sees only the epic's goal and its own task). Give each task a short key (lowercase letters, digits, dashes) and "depends_on": the keys of the tasks that must be MERGED before it can start, and only real dependencies (code it builds on, a flag it needs, a file it would conflict on): everything else runs in parallel, so do not chain tasks just to order them. Add "research": true to a task that touches a new dependency, a data model or a public interface, or whose approach is unclear: a researcher agent first writes docs/research/<key>.md and opens it as a PR for the person to discuss, and the task starts only after that PR is merged (the factory adds that research task and the dependency; do not list it yourself). "research": false, or the words "no research" in the task, skips it. Tasks that edit the same files (agents/server.mjs, agents/plan.mjs, the Slack bot, ...) must depend on each other (directly or through a chain) or be merged into one task: two parallel tasks on the same file conflict. Give each task a "files" list of the files it edits; a plan where two tasks share a file and neither depends on the other is refused. At most ${MAX_PLAN_TASKS} tasks; split the epic if it needs more.
End your reply with the whole plan as a fenced block exactly like:
\`\`\`plan
{"tasks": [{"key": "flag", "type": "feature", "title": "3 to 6 words naming the main thing", "task": "what to do, where, how done is checked", "depends_on": [], "research": false, "files": ["agents/plan.mjs"]}, {"key": "next-thing", "type": "refactor", "title": "...", "task": "...", "depends_on": ["flag"], "files": ["agents/plan.mjs", "agents/server.mjs"]}]}
\`\`\`
The type is one of: feature, fix, hotfix, refactor, perf, design, test, docs, ci, chore, research.`;

// Research step. A task is researched first when the coordinator marks it
// ("research": true) or, with no mark, when its text matches the rule: it touches a
// new dependency, a data model or a public interface, or the approach is unclear.
// A "no research" phrase in the task text, or "research": false, skips it.
// The researcher task (key `<key>-research`) writes docs/research/<key>.md and opens it as
// a docs-only PR for discussion; the implementation depends on it, so it starts only
// when that PR is merged, and is given the document and the person's comments.
export const NO_RESEARCH = /\bno[\s-]+research\b/i;
const RESEARCH_RULE = /\b(?:new|add(?:s|ed|ing)?|introduc\w*)\s+(?:a\s+|an\s+|the\s+)?(?:npm\s+|python\s+|third[- ]party\s+)?(?:dependenc|librar|package|service|database)\w*|\bdata[\s-]model\b|\bschema\b|\bmigrat\w+|\bpublic\s+(?:api|interface)\b|\b(?:api|url)\s+shape\b|\bapproach\s+is\s+unclear\b|\bunclear\s+(?:approach|how)\b|\bnot\s+sure\s+how\b/i;
export const researchDoc = (key) => `docs/research/${key}.md`;
// `listed`: the task's `<key>-research` is in the plan too (a revision that sends it back keeps the link)
export function needsResearch(t, listed = false) {
  if (t.type === 'research') return false; // a research task is never researched
  const text = `${t.title ?? ''}\n${t.task ?? ''}`;
  if (NO_RESEARCH.test(text) || t.research === false) return false;
  return listed || t.research === true || RESEARCH_RULE.test(text);
}
// Adds the research task before each task that needs one and makes the task depend on it. Pure.
export function addResearch(tasks) {
  const byKey = new Map(tasks.map((t) => [t.key, t])), keys = new Set(byKey.keys()), out = [];
  for (const t of tasks) {
    const { research: _r, ...bare } = t, rest = _r === false ? { ...bare, research: false } : bare; // an explicit false is kept: a revision must see it
    const rk = `${t.key}-research`.slice(0, 40), listed = byKey.get(rk);
    if (!needsResearch(t, listed?.type === 'research')) { out.push(rest); continue; }
    const link = { ...rest, deps: [...new Set([...t.deps, rk])], researchKey: rk, researchDoc: researchDoc(t.key) };
    if (listed?.type === 'research') { out.push(link); continue; } // the coordinator sent the research task back (a revision): reuse it
    if (keys.has(rk)) return { error: `task "${t.key}" needs research but the key "${rk}" is taken` };
    keys.add(rk);
    out.push({ key: rk, type: 'research', title: `Research: ${t.title}`.slice(0, 90), task: `Research for the task "${t.key}" (${t.title}). Write ${researchDoc(t.key)}: what the task asks, the options with trade-offs and sources, your recommendation, the risks, and how done is checked. Open it as a docs-only PR (no code) for the person to discuss.\n\nThe task to research:\n${t.task}`, deps: [...t.deps], researchFor: t.key });
    out.push(link);
  }
  // an explicit research task keeps its link to the task it serves
  return { tasks: out.map((t) => (t.type === 'research' && !t.researchFor && t.key.endsWith('-research') && keys.has(t.key.slice(0, -9)) ? { ...t, researchFor: t.key.slice(0, -9) } : t)) };
}

export function parsePlan(text) {
  // fences only count on a line of their own: a task's text may mention "```plan"
  // or "```" (JSON strings cannot hold a raw line break, so they never look like one)
  const opens = [...String(text ?? '').matchAll(/(?:^|\n)```plan[ \t]*\n/g)];
  if (!opens.length) return { error: 'no ```plan block' };
  const from = opens.at(-1).index + opens.at(-1)[0].length, rest = text.slice(from);
  const close = /\n```[ \t]*(?:\n|$)/.exec(rest), body = close ? rest.slice(0, close.index) : null;
  if (body === null) return { error: 'the ```plan block is not closed' };
  let j; try { j = JSON.parse(body); } catch (e) { return { error: `the plan block is not JSON: ${e.message}` }; }
  const tasks = Array.isArray(j?.tasks) ? j.tasks : null;
  if (!tasks?.length) return { error: 'the plan has no tasks' };
  if (tasks.length > MAX_PLAN_TASKS) return { error: `the plan has ${tasks.length} tasks; at most ${MAX_PLAN_TASKS}` };
  const out = [], seen = new Set();
  for (const [i, t] of tasks.entries()) {
    const key = String(t?.key ?? '').trim();
    if (!KEY.test(key)) return { error: `task ${i + 1}: key "${key}" must be lowercase letters, digits and dashes` };
    if (seen.has(key)) return { error: `task key "${key}" is used twice` };
    seen.add(key);
    const task = String(t?.task ?? '').trim();
    if (!task) return { error: `task "${key}" has no task text` };
    const deps = Array.isArray(t?.depends_on) ? t.depends_on.map(String) : [];
    const files = Array.isArray(t?.files) ? [...new Set(t.files.map((f) => String(f).trim().replace(/^\.\//, '')).filter(Boolean))] : [];
    const type = PLAN_TYPES.includes(String(t?.type ?? '').toLowerCase()) ? String(t.type).toLowerCase() : null;
    out.push({ key, title: String(t?.title ?? task.split('\n')[0]).trim().slice(0, 90), task, deps: [...new Set(deps)], ...(files.length ? { files } : {}), ...(type ? { type } : {}), ...(typeof t?.research === 'boolean' ? { research: t.research } : {}) });
  }
  const withR = addResearch(out);
  if (withR.error) return withR;
  out.splice(0, out.length, ...withR.tasks); seen.clear(); out.forEach((t) => seen.add(t.key));
  for (const t of out) for (const d of t.deps) {
    if (d === t.key) return { error: `task "${t.key}" depends on itself` };
    if (!seen.has(d)) return { error: `task "${t.key}" depends on "${d}", which is not in the plan` };
  }
  const w = waves(out);
  if (w.error) return w;
  const clash = fileOverlap(out);
  if (clash) return { error: clash };
  return { tasks: out.map((t) => ({ ...t, wave: w.wave[t.key] })) };
}

// wave of each task = 1 + the latest wave among its dependencies; a cycle is an error
export function waves(tasks) {
  const by = new Map(tasks.map((t) => [t.key, t])), wave = {}, state = {};
  const visit = (k, path) => {
    if (state[k] === 'done') return wave[k];
    if (state[k] === 'visiting') throw new Error(`a dependency cycle: ${[...path, k].join(' → ')}`);
    state[k] = 'visiting';
    const deps = by.get(k)?.deps ?? [];
    wave[k] = 1 + Math.max(0, ...deps.map((d) => visit(d, [...path, k])));
    state[k] = 'done';
    return wave[k];
  };
  try { for (const t of tasks) visit(t.key, []); } catch (e) { return { error: e.message }; }
  return { wave };
}

// Two tasks that declare the same file, with no dependency between them (direct or
// through a chain) in either direction, would run in parallel and conflict: a reason, or null.
export function fileOverlap(tasks) {
  const by = new Map(tasks.map((t) => [t.key, t]));
  const reaches = (from, to, seen = new Set()) => from.deps.some((d) => d === to || (!seen.has(d) && seen.add(d) && by.has(d) && reaches(by.get(d), to, seen)));
  for (const [i, a] of tasks.entries()) for (const b of tasks.slice(i + 1)) {
    const shared = (a.files ?? []).find((f) => (b.files ?? []).includes(f));
    if (shared && !reaches(a, b.key) && !reaches(b, a.key)) return `tasks "${a.key}" and "${b.key}" both edit ${shared} and neither depends on the other: make one depend on the other, or merge them into one task`;
  }
  return null;
}

// A new plan from the coordinator replaces what has not started; what has
// started (has a task id) keeps going, under its key, whatever the new plan says.
export function mergePlan(current, next) {
  const started = new Map(current.filter((i) => i.taskId).map((i) => [i.key, i]));
  const old = new Map(current.map((i) => [i.key, i]));
  // a kept key keeps its GitHub sub-issue (issue/issueId/linked) so a revision never opens a second one
  const gh = (k) => { const o = old.get(k); return o?.issue ? { issue: o.issue, issueId: o.issueId, ...(o.linked === undefined ? {} : { linked: o.linked }) } : {}; };
  // a started task keeps its research link even when the revision leaves the mark out
  next = next.map((t) => { const o = old.get(t.key); return o?.researchKey && !t.researchKey && (started.has(o.researchKey) || next.some((x) => x.key === o.researchKey)) && t.research !== false && !NO_RESEARCH.test(`${t.title}\n${t.task}`) ? { ...t, deps: [...new Set([...t.deps, o.researchKey])], researchKey: o.researchKey, researchDoc: o.researchDoc } : t; });
  let merged = next.map((t) => ({ ...t, ...gh(t.key), ...(started.has(t.key) ? { taskId: started.get(t.key).taskId } : {}) }));
  // research is never added to a task that has started (a revision may now match the rule): drop the new research task and the link
  const skip = new Set(merged.filter((t) => t.type === 'research' && !t.taskId && started.has(t.researchFor) && !old.get(t.researchFor)?.researchKey).map((t) => t.key));
  if (skip.size) merged = merged.filter((t) => !skip.has(t.key)).map((t) => (t.researchKey && skip.has(t.researchKey) ? (({ researchKey, researchDoc, ...r }) => ({ ...r, deps: t.deps.filter((d) => d !== researchKey) }))(t) : t));
  for (const [k, i] of started) if (!next.some((t) => t.key === k)) merged.push(i); // dropped from the plan but already running
  const w = waves(merged);
  if (w.error) return { error: w.error };
  return { items: merged.map((i) => ({ ...i, wave: w.wave[i.key] })) };
}

// every task `key` depends on, directly or through others
export function ancestors(items, key) {
  const by = new Map(items.map((i) => [i.key, i])), seen = new Set(), stack = [...(by.get(key)?.deps ?? [])];
  while (stack.length) { const k = stack.pop(); if (seen.has(k)) continue; seen.add(k); stack.push(...(by.get(k)?.deps ?? [])); }
  return [...seen];
}

// stateOf(item) → 'pending' (not started) | 'running' | 'merged' | 'failed'
//   (closed without merging, stopped) | 'stuck' (waiting on the person: decision,
//   round limit, refused merge)
export function progress(items, stateOf) {
  const st = Object.fromEntries(items.map((i) => [i.key, stateOf(i)]));
  // blocked carries down the chain: C waits on B, B waits on a failed A → C is blocked too
  const isBlocked = new Set();
  for (let changed = true; changed;) {
    changed = false;
    for (const i of items) if (st[i.key] === 'pending' && !isBlocked.has(i.key) && i.deps.some((d) => ['failed', 'stuck'].includes(st[d]) || isBlocked.has(d))) { isBlocked.add(i.key); changed = true; }
  }
  const ready = [], blocked = [], waiting = [];
  for (const i of items) {
    if (st[i.key] !== 'pending') continue;
    if (isBlocked.has(i.key)) blocked.push({ item: i, on: i.deps.filter((d) => ['failed', 'stuck'].includes(st[d]) || isBlocked.has(d)) });
    else if (ancestors(items, i.key).every((d) => st[d] === 'merged')) ready.push(i); // the whole chain, not only direct deps: a link that merged early must not let what follows it skip ahead
    else waiting.push(i);
  }
  const count = (s) => items.filter((i) => st[i.key] === s).length;
  const moving = count('running') + ready.length + waiting.length;
  return { state: st, ready, blocked, waiting, merged: count('merged'), total: items.length,
    done: count('merged') === items.length, stalled: moving === 0 && count('merged') < items.length };
}

// Per wave: is every item merged, and how many. `state` is the map progress()
// returns (key → state) or the same function progress() takes. Items dropped
// from a revised plan but kept because they run (mergePlan) count in the wave
// they now sit in. Waves are listed in order; a wave with no items is not listed.
export function wavesReport(items, state) {
  const stateOf = typeof state === 'function' ? state : (i) => state?.[i.key];
  const by = new Map();
  for (const i of items) { if (!by.has(i.wave)) by.set(i.wave, []); by.get(i.wave).push(i); }
  return [...by.keys()].sort((a, b) => a - b).map((wave) => {
    const list = by.get(wave), merged = list.filter((i) => stateOf(i) === 'merged').length;
    return { wave, items: list, merged, total: list.length, complete: merged === list.length };
  });
}

// What to say now, given what was said before. `said` = { merged: [task keys], waves: [wave ids] }
// (a wave id is its task keys, sorted and joined, so a revised plan that renumbers
// waves does not hide or repeat one). `g` = progress(items, …); `linkOf(item)` → text.
// Returns { lines, said } with the new lists to remember. Pure.
export const waveId = (w) => w.items.map((i) => i.key).sort().join('+');
export function announcements(items, g, said, linkOf) {
  const merged = said?.merged ?? [], waves = said?.waves ?? [], lines = [];
  const newly = items.filter((i) => g.state[i.key] === 'merged' && !merged.includes(i.key));
  for (const i of newly) lines.push(`[factory] merged: ${linkOf(i)}. ${g.merged}/${g.total} tasks merged.`);
  const reports = wavesReport(items, g.state), fresh = reports.filter((w) => w.complete && !waves.includes(waveId(w)));
  for (const w of fresh) {
    const later = reports.some((r) => r.wave > w.wave);
    const next = later ? items.filter((i) => i.wave > w.wave && (g.state[i.key] === 'running' || (g.state[i.key] === 'pending' && i.deps.every((d) => g.state[d] === 'merged')))).map((i) => i.title).join('; ') || 'nothing yet: the rest waits on unfinished tasks' : 'nothing, that was the last wave';
    lines.push(`[factory] wave ${w.wave} done: ${w.items.map(linkOf).join('; ')}. ${g.merged}/${g.total} merged; next: ${next}.`);
  }
  return { lines, said: { merged: [...merged, ...newly.map((i) => i.key)], waves: [...waves, ...fresh.map(waveId)] } };
}

// A message that tells the coordinator to stop talking and write the plan:
// "plan", "plan it", "plan:" or "make the plan" at the start, then end of message or ":" / "!" / ".".
// Not "go" (that approves a plan) and not "Plan B looks better".
export const isPlanCommand = (text) => /^\s*(?:make\s+(?:the|a)\s+plan|plan(?:\s+it)?)(?:\s+(?:please|now))?\s*(?:[:!.]|$)/i.test(String(text ?? ''));
// approval of a plan in `brief`
export const isGoCommand = (text) => /^\s*(go|ok|okay|yes|approved?|start|lgtm)\b/i.test(String(text ?? ''));
// In `talk` only a bare "go" is special (there is nothing to approve); "yes, the server" is an answer.
export const isBareGo = (text) => /^\s*go\s*[!.]*\s*$/i.test(String(text ?? ''));
export const talkAction = (text) => isPlanCommand(text) ? 'plan' : isBareGo(text) ? 'go' : 'talk';

// The reply handler for an epic in `talk`; deps are injected so it can be tested.
// t: the program; thread: [{from, text}]; d: { say, save, enqueue, planningPrompt, continuePrompt }
export function talkReply(t, text, thread, d) {
  const act = talkAction(text);
  if (act === 'go') { d.say(t.id, 'factory', '[factory] there is no plan yet, so there is nothing to approve. Keep talking, or write "plan" when you want the coordinator to write it.'); return act; }
  if (act === 'plan') {
    const past = thread.filter((m) => m.from === 'you' || m.from === 'coordinator').map((m) => `${m.from === 'you' ? 'PERSON' : 'YOU'}: ${m.text}`).join('\n\n').slice(-12000);
    t.phase = 'brief'; d.save(t);
    d.enqueue(t.id, d.planningPrompt(`The person asked you to plan: ${text}\n\nTHE DISCUSSION SO FAR:\n${past}`), 'plan', 'person');
    return act;
  }
  d.enqueue(t.id, d.continuePrompt(text), 'plan', 'person');
  return act;
}
