// The job queue's rules. Pure: server.mjs owns the queue array, the busy set and the side effects.
//
// One task, one job at a time. A task is busy from the moment its job leaves the queue until the
// job's handling has ended (the container, then the PR lookup, the next status, the next job queued),
// not only while a container runs: the container starts after an await, and pump() takes jobs in one
// synchronous loop, so a check on "has a container" let several jobs of one task start together
// (2026-11-08: three agents of one task on one checkout and one PR, load 50 on 12 cores).

// a job from a review stays a review fix whatever it is merged with
const reviewOrigin = (j) => [j.from, j.origin].includes('review');

// Take the jobs that may start now, in queue order: at most one per task, none for a busy task,
// and no more than `max` busy tasks in all. Removes them from `queue` and returns them.
export function takeJobs(queue, busy, max) {
  const taken = [], ids = new Set(busy);
  for (let i = 0; i < queue.length && ids.size < max;) {
    const j = queue[i];
    if (ids.has(j.id)) { i++; continue; }
    queue.splice(i, 1); taken.push(j); ids.add(j.id);
  }
  return taken;
}

// Queue an agent job. When the task's last queued job is an agent job of the same mode, the new
// prompt joins it, so messages sent while the agent works become one next turn, not one turn each.
// A pause is never merged (it has its own turn and status), nor merged into.
export function addAgentJob(queue, job) {
  let last = -1;
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].id === job.id) { last = i; break; }
  const prev = queue[last];
  if (!prev || prev.kind !== 'agent' || prev.mode !== job.mode || prev.from === 'pause' || job.from === 'pause') { queue.push(job); return job; }
  const merged = { ...prev, prompt: `${prev.prompt}\n\n---\n\n${job.prompt}` };
  if (!reviewOrigin(prev) && reviewOrigin(job)) merged.origin = 'review';
  queue[last] = merged;
  return merged;
}
