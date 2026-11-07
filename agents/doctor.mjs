// The stuck doctor: when a task gives up (a "your call: …" park: a round
// limit, nudges used up) or the watchdog escalates a frozen task, one model
// call reads the task's history and posts the cause and the fix for the person.
// It diagnoses only; it never acts. Pure functions, tested on their own:
// `node agents/test-doctor.mjs`.

export const CATEGORIES = {
  'missing-permission': 'missing permission',
  'needs-decision': 'needs your decision',
  'environment': 'environment or tooling',
  'agent-loop': 'agent going in circles',
  'review-dispute': 'review disagreement',
  'unclear-task': 'unclear task',
  'factory-bug': 'factory bug',
  'external': 'outside service',
  'other': 'other',
};
const WHO = ['person', 'agent', 'factory'];

// the stall this task is in, as a key, or null when nothing needs a diagnosis.
// Same key = same stall: diagnosed once.
export function stallKey(t) {
  if (!t || t.kind === 'program') return null; // an epic stalls on a task, and that task is diagnosed
  if (['stopped', 'merged', 'done'].includes(t.status) || t.pr?.state === 'merged') return null;
  const gaveUp = t.status === 'waiting for you' && /^your call\b/i.test(t.waitingOn ?? '');
  const escalated = !!t.watchEscalatedAt;
  if (!gaveUp && !escalated) return null;
  return [t.status, t.waitingOn ?? '', t.factoryRounds ?? 0, t.watchEscalatedAt ?? ''].join('|');
}
export const needsDoctor = (t) => { const k = stallKey(t); return k && k !== t.doctorKey ? k : null; };

const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n)}\n…(cut)` : s; };

// messages: [{ from, at, text }] oldest first; decisions: the decision log's text
export function doctorPrompt(t, messages, decisions = '') {
  const first = messages.find((m) => m.from === 'you')?.text ?? t.title ?? '';
  const recent = messages.slice(-14).map((m) => `--- ${m.from} (${m.at ?? ''})\n${clip(m.text, 1500)}`).join('\n');
  return `You are the factory's stuck doctor. The factory runs coding agents on tasks: brief, run, QA, a review panel, auto-merge. This task has stopped moving and now waits for the person. Find out WHY from its history, and what would get it moving. You only diagnose: the person reads your answer on a phone.

TASK ${t.id} (${t.project}, ${t.kind ?? 'change'}): ${clip(first, 3000)}

STATE: status "${t.status}"; waiting on: "${t.waitingOn ?? '-'}"; failed rounds ${t.factoryRounds ?? 0}; PR ${t.pr?.number ? `#${t.pr.number} (${t.pr.state ?? 'open'})` : 'none'}; last review verdict ${t.verdict ?? '-'}; QA ${t.qaVerdict ?? '-'}${t.watchEscalatedAt ? `; the watchdog saw it frozen in "${t.watchState ?? t.status}"` : ''}.

DECISION LOG (the agent's own notes, newest last):
${clip(String(decisions).split('\n').slice(-25).join('\n'), 3000) || '(none)'}

LAST MESSAGES (agent, review, qa, factory, you):
${recent}

Look for the root cause, not the symptom: the same finding repeated round after round, something the agent says it cannot do (a permission, a tool, a missing secret or service), a disagreement between agent and reviewers, a question the person never answered, a factory step that misread a turn. Be concrete and short. Answer with ONE line of JSON and nothing else:
{"category": "<one of: ${Object.keys(CATEGORIES).join(', ')}>", "cause": "<one sentence: why it is stuck>", "evidence": ["<at most 3 short facts from the history, with who said them>"], "fix": "<one or two sentences: what gets it moving>", "who": "<person | agent | factory: who has to act>", "reply": "<a message the person can send to the task to unblock it, or empty if the fix is not a reply>"}`;
}

export function parseDiagnosis(text) {
  const m = /\{[\s\S]*\}/.exec(String(text ?? ''));
  let j; try { j = JSON.parse(m?.[0] ?? ''); } catch { return null; }
  const cause = String(j?.cause ?? '').trim(), fix = String(j?.fix ?? '').trim();
  if (!cause || !fix) return null;
  return {
    category: CATEGORIES[j.category] ? j.category : 'other',
    cause: cause.slice(0, 400), fix: fix.slice(0, 600),
    evidence: (Array.isArray(j.evidence) ? j.evidence : []).map((e) => String(e).trim()).filter(Boolean).slice(0, 3).map((e) => e.slice(0, 300)),
    who: WHO.includes(j.who) ? j.who : 'person',
    reply: String(j.reply ?? '').trim().slice(0, 600),
  };
}

const WHO_LINE = { person: 'you', agent: 'the agent', factory: 'the factory (a bug to fix in it)' };
export function doctorMessage(d) {
  if (!d) return '[factory] 🩺 Stuck doctor: I could not work out why this task is stuck from its history. Read the last messages above, or reply with what you want next.';
  return [
    `[factory] 🩺 Stuck doctor (${CATEGORIES[d.category]})`,
    `**Why it's stuck:** ${d.cause}`,
    ...(d.evidence.length ? ['**Evidence:**', ...d.evidence.map((e) => `- ${e}`)] : []),
    `**What fixes it** (${WHO_LINE[d.who]}): ${d.fix}`,
    ...(d.reply ? [`**To unblock, reply:** ${d.reply}`] : []),
  ].join('\n');
}
