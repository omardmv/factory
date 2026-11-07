// Draining on SIGTERM: stop starting jobs, let running turns finish, exit when none is left or the timeout hits.
// The decisions are pure; server.mjs wires them to the process.
export const DRAIN_TIMEOUT_MS = 30 * 60 * 1000;

// What to do at this moment of a drain. `running`: ids of the turns still running.
//  exit (nothing running) | wait | timeout (cutOff: the ids to cut off)
export function drainDecision({ running, startedAt, now, timeoutMs = DRAIN_TIMEOUT_MS }) {
  if (running.length === 0) return { action: 'exit', cutOff: [] };
  if (now - startedAt >= timeoutMs) return { action: 'timeout', cutOff: [...running] };
  return { action: 'wait', cutOff: [], waitedMin: Math.floor((now - startedAt) / 60000) };
}

// The drain.json body: which turns the timeout cut off
export function drainRecord({ cutOff, at, timeoutMs = DRAIN_TIMEOUT_MS }) {
  return { at: new Date(at).toISOString(), timeoutMin: Math.round(timeoutMs / 60000), cutOff: cutOff.map((c) => (typeof c === 'string' ? { id: c } : c)) };
}

// At startup: the drain.json (or null) says what to tell the person and which tasks to re-queue.
// A cut-off task still carries its job, so the existing pickup path re-queues it (told it was interrupted).
export function startupPlan(record, tasksById) {
  const cut = (record?.cutOff ?? []).filter((c) => c?.id);
  const requeue = cut.map((c) => c.id).filter((id) => tasksById[id]?.job && !['stopped', 'paused'].includes(tasksById[id].status));
  const notices = cut.map((c) => ({
    id: c.id,
    text: `[factory] A factory restart cut off this task's ${c.kind ?? 'turn'} after the ${record.timeoutMin}-minute drain limit (${record.at}). ${requeue.includes(c.id) ? 'It is queued again and carries on from its saved session.' : 'It was stopped or paused, so it stays so.'}`,
  }));
  return { requeue, notices };
}

// The drain as a small state machine with injected effects, so it runs under a fake clock.
// deps: running() -> ids, killAll(ids), writeRecord(rec), exit(), now(), log()
export function createDrain(deps, timeoutMs = DRAIN_TIMEOUT_MS) {
  let startedAt = null;
  const api = {
    get draining() { return startedAt !== null; },
    start() { if (startedAt === null) { startedAt = deps.now(); deps.log?.('drain.start', { running: deps.running() }); } api.tick(); },
    tick() {
      if (startedAt === null) return null;
      const d = drainDecision({ running: deps.running(), startedAt, now: deps.now(), timeoutMs });
      if (d.action === 'wait') return d;
      if (d.action === 'timeout') { deps.writeRecord(drainRecord({ cutOff: deps.describe ? d.cutOff.map(deps.describe) : d.cutOff, at: deps.now(), timeoutMs })); deps.killAll(d.cutOff); }
      deps.log?.('drain.exit', { cutOff: d.cutOff });
      deps.exit();
      return d;
    },
  };
  return api;
}
