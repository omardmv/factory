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
    out.push({ key, title: String(t?.title ?? task.split('\n')[0]).trim().slice(0, 90), task, deps: [...new Set(deps)] });
  }
  for (const t of out) for (const d of t.deps) {
    if (d === t.key) return { error: `task "${t.key}" depends on itself` };
    if (!seen.has(d)) return { error: `task "${t.key}" depends on "${d}", which is not in the plan` };
  }
  const w = waves(out);
  if (w.error) return w;
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

// A new plan from the coordinator replaces what has not started; what has
// started (has a task id) keeps going, under its key, whatever the new plan says.
export function mergePlan(current, next) {
  const started = new Map(current.filter((i) => i.taskId).map((i) => [i.key, i]));
  const old = new Map(current.map((i) => [i.key, i]));
  // a kept key keeps its GitHub sub-issue (issue/issueId/linked) so a revision never opens a second one
  const gh = (k) => { const o = old.get(k); return o?.issue ? { issue: o.issue, issueId: o.issueId, ...(o.linked === undefined ? {} : { linked: o.linked }) } : {}; };
  const merged = next.map((t) => ({ ...t, ...gh(t.key), ...(started.has(t.key) ? { taskId: started.get(t.key).taskId } : {}) }));
  for (const [k, i] of started) if (!next.some((t) => t.key === k)) merged.push(i); // dropped from the plan but already running
  const w = waves(merged);
  if (w.error) return { error: w.error };
  return { items: merged.map((i) => ({ ...i, wave: w.wave[i.key] })) };
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
    else if (i.deps.every((d) => st[d] === 'merged')) ready.push(i);
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
