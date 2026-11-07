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
  const m = /```plan\s*([\s\S]*?)```/.exec(text ?? '');
  if (!m) return { error: 'no ```plan block' };
  let j; try { j = JSON.parse(m[1]); } catch (e) { return { error: `the plan block is not JSON: ${e.message}` }; }
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
  const merged = next.map((t) => (started.has(t.key) ? { ...t, taskId: started.get(t.key).taskId } : { ...t }));
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
