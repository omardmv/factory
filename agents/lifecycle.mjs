// What happens to a task after each run, QA verdict, review verdict and report
// from the checks. Pure (the few lookups are injected), so every branch is
// tested on its own: `node agents/test-lifecycle.mjs`. server.mjs keeps only the
// side effects (save, say, enqueue, publish).

export const verdictOf = (text) => /VERDICT:\s*(PASS|CHANGES)/i.exec(text ?? '')?.[1]?.toUpperCase() ?? null;
export const qaVerdictOf = (text) => /QA VERDICT:\s*(PASS|FAIL|NOT APPLICABLE)/i.exec(text ?? '')?.[1]?.toUpperCase() ?? null;
export const isDecision = (text) => /^\s*DECISION NEEDED\b/m.test(text ?? '');

// a job that came back from a review, or was restarted while answering one, is a review fix
const reviewOrigin = (from, origin) => [from, origin].includes('review');

// After an agent turn. `task` is the task as saved after the turn. Returns:
//  { type: 'stopped' }                         the person stopped it
//  { type: 'checkpoint' }                      pause asked: one more turn to leave a note
//  { type: 'retry', retry, from }              the turn died without a reply: carry on (bounded)
//  { type: 'coordinator', decision, resetCrash } an epic's coordinator replied
//  { type: 'status', status, pr, resetCrash }  the next status (pr: what was found, change tasks only)
// deps: findPr(task) -> pr | null, hasChecks(task), hasQa(task)
export async function afterAgentRun({ task, from, origin, mode, reply, unasked = false, maxCrashRetries = 2 }, deps) {
  if (task.status === 'stopped') return { type: 'stopped' };
  if (task.status === 'pausing' && from !== 'pause') return { type: 'checkpoint' };
  const crashes = task.crashRetries ?? 0;
  if (!reply && from !== 'pause' && crashes < maxCrashRetries) {
    return { type: 'retry', retry: crashes + 1, from: reviewOrigin(from, origin) ? 'review' : from };
  }
  const resetCrash = !!reply;
  // unasked: the reply asked the person something in plain text (agents/unasked.mjs); same as a DECISION NEEDED block
  const decision = isDecision(reply) || unasked;
  if (from === 'pause') return { type: 'status', status: 'paused', pr: task.pr ?? null, resetCrash };
  if (task.kind === 'report') return { type: 'status', status: decision ? 'decision needed' : mode === 'plan' ? 'waiting for you' : 'done', pr: task.pr ?? null, resetCrash, decision };
  if (task.kind === 'program') return { type: 'coordinator', decision, resetCrash };
  const pr = (await deps.findPr(task)) ?? task.pr ?? null;
  const head = pr?.state === 'open' ? pr.head : null;
  const t = { ...task, pr };
  let status;
  if (mode === 'plan') status = 'waiting for you';
  else if (decision) status = 'decision needed';
  else if (!head) status = 'waiting for you';
  // an answer to review findings goes back to the panel even with no new commit:
  // the finding may have asked for evidence (a run, a PR comment), not code.
  // Bounded: every CHANGES verdict counts toward the round limit.
  else if (head === task.reviewedSha && task.verdict !== 'PASS' && reviewOrigin(from, origin)) status = 'reviewing';
  else if (head === task.reviewedSha) status = task.verdict === 'PASS' ? 'ready for you' : 'waiting for you'; // nothing new since the review
  // green: the QA tester first (once per head; a head the agent kept after a
  // QA FAIL goes on to the panel, which sees the report and judges the dispute)
  else if (!deps.hasChecks(t) || (task.greenSha && head.startsWith(task.greenSha))) status = deps.hasQa(t) && head !== task.qaTestedSha ? 'testing' : 'reviewing';
  else status = 'waiting for checks';
  return { type: 'status', status, pr, resetCrash, decision };
}

// the prompt of the carry-on turn after a death without a reply
export const crashRetryPrompt = (retry, max) => `[factory] Your last turn was cut off: the process exited without a reply (retry ${retry} of ${max}). If you were stopping processes by name pattern, that killed you: your own process matches; kill by PID or port instead. Check \`git status\`, your decision log and your PR, then carry on with what you were doing.`;

// A coordinator's reply: its next status, and whether a revised plan is in it.
export function afterCoordinator({ phase, reply, decision }) {
  if (decision) return { status: 'decision needed' };
  if (/^\s*PROGRAM DONE\b/m.test(reply ?? '')) return { status: 'done', closeEpic: true };
  if (phase === 'talk') return { status: 'waiting for you' }; // discussion: never a plan, the person says "plan"
  if (phase === 'brief') return { status: 'waiting for you' }; // the plan waits for "go"
  return { status: 'running', revise: /```plan/.test(reply ?? '') }; // a revision while it runs
}

// A job found on disk after a restart. { drop } | { job }: the job to run again.
// A review or QA job runs again as it was. An agent job with a session carries
// on, told it was interrupted, and keeps the origin of the job it was doing
// (a review fix stays a review fix, through any number of restarts).
export function pickupJob(task) {
  const j = task.job;
  if (['stopped', 'paused'].includes(task.status)) return { drop: true };
  if (j.kind === 'review' || j.kind === 'qa') return { job: j };
  if (task.sessionId && j.from !== 'pause') {
    return { job: { ...j, prompt: '[factory] You were interrupted: the factory restarted. Check `git status`, your decision log and your PR, then carry on with the task from where you were.', from: 'pickup', origin: j.from === 'pickup' ? j.origin : (j.origin ?? j.from) } };
  }
  return { job: j };
}

// What a finished QA run leads to. `task` has qaVerdict/qaRounds already set.
//  stopped | paused | review | fix | wait
export function afterQa({ task, verdict, maxRounds }) {
  if (task.status === 'stopped') return { action: 'stopped' };
  if (task.status === 'pausing') return { action: 'paused', status: 'paused' };
  if (verdict === 'PASS' || verdict === 'NOT APPLICABLE') return { action: 'review', status: 'reviewing' };
  if (verdict === 'FAIL' && task.factoryRounds < maxRounds) return { action: 'fix', status: 'working', factoryRounds: task.factoryRounds + 1 };
  return { action: 'wait', status: 'waiting for you', say: verdict === 'FAIL' ? `[factory] round limit (${maxRounds}) reached with QA failures open: stopped. A person decides what next.` : '[factory] the QA tester gave no clear verdict: a person decides.' };
}

// The panel passes only when every reviewer passes; any CHANGES is CHANGES.
export function panelVerdict(verdicts, panelSize) {
  return verdicts.length === panelSize && verdicts.every((v) => v === 'PASS') ? 'PASS'
    : verdicts.some((v) => v === 'CHANGES') ? 'CHANGES' : null;
}

// What a finished review leads to. `task` has verdict/reviewedSha already set.
//  stopped | paused | pass | fix | wait. autoMerge: the project's merge branch, or falsy.
export function afterReview({ task, verdict, headSha, autoMerge, maxRounds }) {
  if (task.status === 'stopped') return { action: 'stopped' };
  if (task.status === 'pausing') return { action: 'paused', status: 'paused' };
  // a head the QA tester failed and the agent kept never merges by itself: the person settles the dispute
  const disputed = task.qaVerdict === 'FAIL' && task.qaTestedSha === headSha;
  if (verdict === 'PASS') return { action: 'pass', status: 'ready for you', mergeWanted: !!autoMerge && !disputed, disputed };
  if (verdict === 'CHANGES' && task.factoryRounds < maxRounds) return { action: 'fix', status: 'working', factoryRounds: task.factoryRounds + 1 };
  return { action: 'wait', status: 'waiting for you', say: verdict === 'CHANGES' ? `[factory] round limit (${maxRounds}) reached with review findings open: stopped. A person decides what next.` : '[factory] the review panel gave no clear verdict: a person decides.' };
}

// A [factory] report from the checks (preview/e2e). Only a red report counts
// toward the round limit; green never does.
//  ignore | limit | run { green, greenSha, previewHost, factoryRounds }
export function afterFactoryReport({ task, text, maxRounds }) {
  if (task.phase !== 'run' || ['stopped', 'paused', 'pausing', 'merged'].includes(task.status) || task.kind !== 'change') return { action: 'ignore' };
  const greenSha = text.includes('✅') ? /\(`([0-9a-f]{7,40})`\)/.exec(text)?.[1] : undefined;
  if (!greenSha && task.factoryRounds >= maxRounds) return { action: 'limit', status: 'waiting for you', say: `[factory] round limit (${maxRounds} failed rounds) reached: stopped. A person decides what next.` };
  if (greenSha) return { action: 'run', green: true, greenSha, previewHost: /preview ready at (https:\/\/[^\s/]+)/.exec(text)?.[1] ?? task.previewHost };
  return { action: 'run', green: false, factoryRounds: task.factoryRounds + 1 };
}
