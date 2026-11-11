// What is worth a Slack notification: only what waits for the person's answer.
// Pure, so `node slack/test.mjs` covers it without Slack. SLACK_NOTIFY=all brings back every message.
export const notifyAll = (env = process.env) => String(env.SLACK_NOTIFY ?? '').toLowerCase() === 'all';
export const isBriefLike = (t) => (t.kind === 'program' && t.phase === 'brief') || (t.kind === 'change' && t.phase === 'brief' && t.status === 'waiting for you');
// true when message m of task t needs the person to answer or press a button:
// a DECISION NEEDED block, a brief or epic plan awaiting Go, an epic discussion, an approval request, a stuck escalation
export function needsAnswer(t, m) {
  if (m.from === 'review' || m.from === 'qa') return false;
  // a factory note while the task is parked on "your call" (a round limit, a run that could not finish) is a question too
  const parked = ['waiting for you', 'decision needed'].includes(t.status) && /^your call\b/i.test(t.waitingOn ?? '');
  if (m.from === 'factory') return !!(m.ping || m.approve?.sha || /^\s*DECISION NEEDED\b/m.test(m.text ?? '') || (parked && !m.decided && !m.epicDecided));
  if (/^\s*DECISION NEEDED\b/m.test(m.text ?? '')) return true;
  return isBriefLike(t) || (t.kind === 'program' && t.phase === 'talk');
}
