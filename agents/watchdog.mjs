// The stall watchdog's decision, pure: `node agents/test-watchdog.mjs`.
// A task in a state that should be moving, with no sign of life for the limit of
// that state, gets ONE automatic nudge. If it still has not moved after the
// (shorter) grace period it is escalated: a [factory] message on the task plus a
// Slack ping saying exactly what is stuck and why. After that: silence, until
// the task changes state (server.mjs clears the marks when the status changes).
// Silent parking is the bug; silent stalling is the same bug.

// minutes without a sign of life, per state
export const LIMIT_MIN = {
  queued: 5,                // nothing running and still queued: the queue is stuck
  working: 30,              // an agent turn with no tool call for this long
  briefing: 30,
  planning: 30,
  reviewing: 30,            // the panel runs several models
  testing: 40,              // QA drives a browser and records videos
  'waiting for checks': 30, // preview + e2e report back as a [factory] message
};
export const GRACE_MIN = 5; // after the nudge, before the person is told

const WHY = {
  queued: (m) => `it has been queued for ${m} min with nothing running, so the queue should have started it`,
  working: (m) => `the agent has shown no activity for ${m} min`,
  briefing: (m) => `the agent has shown no activity for ${m} min while briefing`,
  planning: (m) => `the coordinator has shown no activity for ${m} min while planning`,
  reviewing: (m) => `the review panel has not reported in ${m} min`,
  testing: (m) => `the QA tester has not reported in ${m} min`,
  'waiting for checks': (m) => `no preview/e2e report has arrived for ${m} min`,
};

const ms = (iso) => { const v = Date.parse(iso ?? ''); return Number.isFinite(v) ? v : 0; };

// task: { status, statusSince, updatedAt, watchNudgedAt, watchEscalatedAt }
// ctx: { now (ms), inQueue (a job of this task waits), slotsFull (every parallel slot is busy), running (this task has a container), anyRunning (any task has), lastActivityAt (iso) }
// -> { action: 'none' } | { action: 'nudge', state, idleMin, text } | { action: 'escalate', state, idleMin, text, ping }
export function watchdogDecision(task, { now, running = false, anyRunning = false, inQueue = false, slotsFull = false, lastActivityAt } = {}, { limits = LIMIT_MIN, graceMin = GRACE_MIN } = {}) {
  const limit = limits[task.status];
  if (!limit || task.watchEscalatedAt) return { action: 'none' };
  // a job waiting in the queue while every slot is busy is waiting its turn, in any state
  if (inQueue && slotsFull && !running) return { action: 'none' };
  // queued while the slots are busy is waiting its turn, not stuck
  if (task.status === 'queued' && (running || anyRunning)) return { action: 'none' };
  const lastSign = Math.max(ms(task.statusSince ?? task.updatedAt), ms(lastActivityAt));
  const idleMin = Math.floor((now - lastSign) / 60000);
  const state = task.status;
  const container = running ? 'its container is running but silent' : 'no container is running';
  if (!task.watchNudgedAt) {
    if (idleMin < limit) return { action: 'none' };
    return { action: 'nudge', state, idleMin, text: `[factory] watchdog: this task has been ${state} for ${idleMin} min without moving (${WHY[state](idleMin)}; ${container}). Nudging it once.` };
  }
  // nudged: moved since (activity after the nudge) restarts the grace clock
  const graceFrom = Math.max(ms(task.watchNudgedAt), lastSign);
  if (now - graceFrom < graceMin * 60000) return { action: 'none' };
  const text = `[factory] STUCK: this task has been ${state} for ${idleMin} min and did not move ${graceMin} min after the automatic nudge. Why: ${WHY[state](idleMin)}; ${container}. Nothing will happen on its own: open the task, then reply to restart it or stop it.`;
  return { action: 'escalate', state, idleMin, text, ping: true };
}

