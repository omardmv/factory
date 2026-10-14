// factory-agents: one task = one conversation with Claude Code, run headless in
// a locked-down container. Kinds of task:
//  - change: Brief (read-only, asks once) -> Run (playbook + decision log, no
//    questions, pushes agent/<task>, opens a PR) -> Checks ([factory] reports
//    drive it to green) -> Review (a fresh reviewer that did not write the code:
//    PASS = ready for you, CHANGES = back to the agent)
//  - report: triage a bug report (classify, dedupe, reproduce twice, file or
//    update the issue, label it); ready-for-agent issues then become changes
//  - program: a coordinator plans phases of independent changes; you approve
//    the plan once; each phase runs as a batch, the next is planned when you
//    have merged the last
// Tasks also arrive by themselves (issues labelled ready-for-agent or
// needs-triage) and in batches. The queue and running jobs survive a restart.
// Loopback + one bridge address only; every call needs the API token.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createSign, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, chownSync } from 'node:fs';

const HOME = process.env.AGENTS_DIR ?? '/srv/factory/agents';
const SECRETS = process.env.AGENTS_SECRETS ?? '/opt/factory/agents';
const IMAGE = process.env.AGENT_IMAGE ?? 'factory-agent:latest';
const NETWORK = process.env.AGENT_NETWORK ?? 'oi-sandboxes';
const RUNTIME = process.env.AGENT_RUNTIME ?? '';           // e.g. runsc
const PORT = Number(process.env.PORT ?? 19300);
const BIND = (process.env.BIND_ADDRESSES ?? '127.0.0.1').split(',').map((s) => s.trim()).filter(Boolean);
const MAX_PARALLEL = Number(process.env.MAX_PARALLEL ?? 3);
const MAX_FACTORY_ROUNDS = Number(process.env.MAX_FACTORY_ROUNDS ?? 6);
// the review panel: fresh sessions, each its own model and angle; every one must pass
const REVIEW_PANEL = (process.env.REVIEW_PANEL ?? 'opus:correctness,sonnet:evidence').split(',').map((x) => { const [model, focus] = x.trim().split(':'); return { model, focus }; });
const FOCUS = {
  correctness: { name: 'Correctness', ask: 'Your angle is correctness: does it do everything the task asked and nothing unrelated; bugs (edge cases, errors, security, data loss, races); does it break something next to the change.' },
  evidence: { name: 'Evidence', ask: 'Your angle is evidence: is every item of the definition of done backed by evidence; is new behaviour covered by a test that would fail without the change; do the decision log\'s claims hold up against their evidence; was any verification claimed without proof; does it follow the repository\'s own rules.' },
};
const INTAKE_LABEL = process.env.INTAKE_LABEL ?? 'ready-for-agent';
const TRIAGE_LABEL = process.env.TRIAGE_LABEL ?? 'needs-triage';
const POLL_EVERY_S = Number(process.env.INTAKE_EVERY_S ?? 120);
const PROJECTS = JSON.parse(readFileSync(new URL('./projects.json', import.meta.url), 'utf8'));
const PLAYBOOKS = readFileSync(new URL('./playbooks.md', import.meta.url), 'utf8');

const RULES = `You are a factory agent working unattended. No person is watching.
Follow the repository's factory-rules skill if it has one (.claude/skills/factory-rules). In any case:
- Never block on the human. Decide reversible things yourself and log each non-obvious decision (decision log + the PR's "Decisions").
- Pause for the person only for a decision that is expensive to undo later: architecture (data model, a new service or dependency, a public API or URL shape), money, security, or a real product or taste call no experiment can settle. Then end your reply with a block whose first line is exactly "DECISION NEEDED", followed by the options, the trade-off of each, and your recommendation. Everything else you decide yourself.
- Also stop (with a written reason, no DECISION NEEDED) before an irreversible action or at a genuine dead end after real attempts.
- Messages starting with [factory] are automated reports about your PR's preview and e2e, or about the factory itself: act on them, never ask about them.
- Messages starting with [review] come from an independent reviewer who read your PR: fix what is right and push; for what you reject, say why in the PR under "Decisions".
- Never merge. Never touch production. Never print secrets.

${PLAYBOOKS}`;

const REVIEW_RULES = `You are an independent code reviewer in the factory. You did not write this change and you owe its author nothing: find what is wrong before a person spends time on it.
- Never change, create or delete a file, never commit, never switch branches. You have no GitHub credentials; work from the checkout.
- Report only real problems (wrong behaviour, missing parts of the task, bugs, security, data loss, a missing or toothless test, breaking the repository's own rules, a decision-log claim the evidence does not back). No style nits.
- Write for someone reading on a phone, under 250 words: first one or two plain sentences saying what you concluded; then, only if something blocks, a "## Must fix" section with one bullet per finding (file:line, the problem, the fix; two lines at most); then at most three non-blocking remarks under "## Notes". No list of what you checked.
- End with exactly one line: "VERDICT: PASS" (nothing blocks a merge) or "VERDICT: CHANGES" (at least one finding must be fixed first).`;

const log = (event, f = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...f }));
const secret = (n) => readFileSync(`${SECRETS}/${n}`, 'utf8').trim();
mkdirSync(`${HOME}/tasks`, { recursive: true });

// ---------- tasks on disk: tasks/<id>/task.json + messages.jsonl ----------
const dir = (id) => `${HOME}/tasks/${id}`;
const load = (id) => JSON.parse(readFileSync(`${dir(id)}/task.json`, 'utf8'));
const save = (t) => { t.updatedAt = new Date().toISOString(); writeFileSync(`${dir(t.id)}/task.json`, JSON.stringify(t, null, 1)); };
const update = (id, f) => { const t = load(id); f(t); save(t); return t; };
const say = (id, from, text, extra = {}) => appendFileSync(`${dir(id)}/messages.jsonl`, JSON.stringify({ at: new Date().toISOString(), from, text, ...extra }) + '\n');
const messages = (id) => existsSync(`${dir(id)}/messages.jsonl`) ? readFileSync(`${dir(id)}/messages.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
// the last few things the agent did (tool calls), newest last
function activity(id, n = 8) {
  const f = `${dir(id)}/activity.log`;
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').trim().split('\n').slice(-n).map((l) => {
    const [at, tool, ...rest] = l.split(' ');
    let detail = rest.join(' ');
    try { const i = JSON.parse(detail); detail = i.description ?? i.command ?? i.file_path ?? i.pattern ?? i.url ?? detail; } catch {}
    return { at, tool, detail: String(detail).slice(0, 140) };
  });
}
// the agent's decision log (show-me-your-work), rows as objects
function decisions(id) {
  const f = `${dir(id)}/workspace/decisions.tsv`;
  if (!existsSync(f)) return [];
  const [head, ...rows] = readFileSync(f, 'utf8').trim().split('\n');
  const cols = head.split('\t');
  return rows.filter(Boolean).map((r) => Object.fromEntries(r.split('\t').map((v, i) => [cols[i] ?? `c${i}`, v])));
}
const allTasks = () => readdirSync(`${HOME}/tasks`).filter((d) => existsSync(`${dir(d)}/task.json`)).map(load).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
const readJson = (f, dflt) => existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : dflt;

// ---------- GitHub App: a one-hour installation token per run ----------
async function githubToken(repo) {
  const app = Object.values(PROJECTS).find((p) => p.repo === repo)?.githubApp;
  if (!app) throw new Error(`no GitHub App configured for ${repo}`);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 540, iss: app.id })}`;
  const jwt = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(secret(app.key), 'base64url')}`;
  const inst = await gh(jwt, `/repos/${repo}/installation`);
  return (await gh(jwt, `/app/installations/${inst.id}/access_tokens`, 'POST')).token;
}
async function gh(token, url, method = 'GET', payload) {
  const r = await fetch(`https://api.github.com${url}`, { method, headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'factory-agents', ...(payload ? { 'content-type': 'application/json' } : {}) }, body: payload ? JSON.stringify(payload) : undefined });
  if (!r.ok) throw new Error(`github ${url}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
async function findPr(task) {
  try {
    const owner = task.repo.split('/')[0];
    const prs = await gh(await githubToken(task.repo), `/repos/${task.repo}/pulls?state=all&head=${owner}:agent/${task.id}`);
    const p = prs[0];
    return p ? { number: p.number, url: p.html_url, state: p.merged_at ? 'merged' : p.state, head: p.head.sha } : null;
  } catch (e) { log('pr.lookup_failed', { task: task.id, error: e.message }); return null; }
}
// projects whose PRs get a preview + e2e report back ([factory] ✅/❌); the rest are reviewed as soon as the PR exists
const hasChecks = (t) => PROJECTS[t.project]?.checks === 'preview';

// ---------- the queue: persisted, so a restart (every deploy) loses nothing ----------
const running = new Map();   // task id -> child process (docker run client)
const containers = new Map(); // task id -> container name
const QUEUE_FILE = `${HOME}/queue.json`;
const queue = readJson(QUEUE_FILE, []); // { id, kind: 'agent' | 'review', prompt?, mode?, from? }
const saveQueue = () => writeFileSync(QUEUE_FILE, JSON.stringify(queue));
function enqueue(id, prompt, mode, from) { queue.push({ id, kind: 'agent', prompt, mode, from }); saveQueue(); pump(); }
function enqueueReview(id) { if (!queue.some((j) => j.id === id && j.kind === 'review')) queue.push({ id, kind: 'review' }); saveQueue(); pump(); }
function dropQueued(id) { for (let i = queue.length - 1; i >= 0; i--) if (queue[i].id === id) queue.splice(i, 1); saveQueue(); }
function pump() {
  while (running.size < MAX_PARALLEL && queue.length) {
    const i = queue.findIndex((j) => !running.has(j.id));
    if (i < 0) break;
    const [job] = queue.splice(i, 1); saveQueue();
    job.seq = randomBytes(4).toString('hex');
    update(job.id, (t) => { t.job = job; });
    // forget the job once it ended, unless the next job of this task already took its place
    const forget = (t) => { if (t.job?.seq === job.seq) delete t.job; };
    (job.kind === 'review' ? review(job) : agentRun(job)).then(() => update(job.id, forget)).catch((e) => {
      running.delete(job.id); containers.delete(job.id);
      log('run.crashed', { task: job.id, kind: job.kind, error: e.message });
      say(job.id, 'factory', `[factory] the ${job.kind === 'review' ? 'reviewer' : 'agent'} could not run: ${e.message}`);
      update(job.id, (t) => { forget(t); t.status = 'waiting for you'; });
      pump();
    });
  }
}
// session pickup: a job that was running when the factory stopped runs again,
// told it was interrupted (or from scratch when it never got a session)
function pickup() {
  for (const t of allTasks()) {
    if (!t.job || running.has(t.id) || queue.some((j) => j.id === t.id)) continue;
    if (['stopped', 'paused'].includes(t.status)) { update(t.id, (x) => { delete x.job; }); continue; }
    const j = t.job;
    if (j.kind === 'review') queue.push(j);
    else if (t.sessionId && j.from !== 'pause') queue.push({ ...j, prompt: '[factory] You were interrupted: the factory restarted. Check `git status`, your decision log and your PR, then carry on with the task from where you were.', from: 'pickup' });
    else queue.push(j);
    log('pickup', { task: t.id, kind: j.kind, from: j.from });
  }
  saveQueue(); pump();
}

// docker run ... claude -p; resolves with the last text the model wrote
async function container(id, { prompt, mode, claudeDir, ghToken, system, model, disallowed, resume }) {
  for (const d of ['workspace', claudeDir]) { mkdirSync(`${dir(id)}/${d}`, { recursive: true }); chownSync(`${dir(id)}/${d}`, 1001, 1001); }
  const t = load(id);
  const name = `fa-${id}-${Date.now().toString(36)}`;
  const args = ['run', '--rm', '--name', name, '--network', NETWORK,
    '--cpus', '4', '--memory', '8g', '--pids-limit', '2048', '--shm-size', '1g',
    '--security-opt', 'no-new-privileges:true', '--cap-drop', 'NET_RAW', '--cap-drop', 'MKNOD', '--cap-drop', 'SYS_CHROOT', '--cap-drop', 'AUDIT_WRITE', '--cap-drop', 'SETFCAP',
    '-v', `${dir(id)}/workspace:/workspace`, '-v', `${dir(id)}/${claudeDir}:/home/agent/.claude`,
    '-e', 'TASK_ID', '-e', 'REPO', '-e', 'BASE', '-e', 'GH_TOKEN', '-e', 'CLAUDE_CODE_OAUTH_TOKEN'];
  if (RUNTIME) args.push('--runtime', RUNTIME);
  args.push(IMAGE, 'claude', '-p', prompt, '--output-format', 'stream-json', '--verbose', '--max-turns', '300',
    '--permission-mode', mode, '--disallowedTools', ...disallowed, '--append-system-prompt', system);
  if (model) args.push('--model', model);
  if (resume) args.push('--resume', resume);
  const env = { ...process.env, TASK_ID: id, REPO: t.repo, BASE: t.base, GH_TOKEN: ghToken, CLAUDE_CODE_OAUTH_TOKEN: secret('claude-token') };
  const child = spawn('docker', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  running.set(id, child); containers.set(id, name);
  log('run.start', { task: id, mode, claudeDir, container: name });
  let buf = '', last = '', stderr = '', sessionId = null, cost = 0;
  child.stdout.on('data', (c) => {
    buf += c; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.session_id && !sessionId) {
        sessionId = ev.session_id;
        // the agent's own session is saved at once, so a restart mid-run can resume it
        if (claudeDir === 'claude') update(id, (x) => { x.sessionId ??= sessionId; });
      }
      if (ev.type === 'assistant') {
        for (const part of ev.message?.content ?? []) {
          if (part.type === 'text' && part.text.trim()) { last = part.text.trim(); }
          if (part.type === 'tool_use') appendFileSync(`${dir(id)}/activity.log`, `${new Date().toISOString()} ${part.name} ${JSON.stringify(part.input).slice(0, 300)}\n`);
        }
      }
      if (ev.type === 'result') { last = (ev.result ?? last).trim(); cost += ev.total_cost_usd ?? 0; }
    }
  });
  child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-2000); });
  await new Promise((r) => child.on('close', r));
  running.delete(id); containers.delete(id);
  update(id, (x) => { x.costUsd = (x.costUsd ?? 0) + cost; });
  return { last, stderr, sessionId };
}

async function agentRun({ id, prompt, mode, from }) {
  const t = update(id, (x) => { if (x.status !== 'pausing') x.status = mode === 'plan' ? (x.kind === 'program' ? 'planning' : 'briefing') : 'working'; });
  const r = await container(id, { prompt, mode, claudeDir: 'claude', ghToken: await githubToken(t.repo), system: RULES, disallowed: ['AskUserQuestion'], resume: t.sessionId });
  if (r.last) say(id, t.kind === 'program' ? 'coordinator' : 'agent', r.last);
  else say(id, 'factory', `[factory] the agent stopped without a reply. ${r.stderr.trim().slice(-400)}`);
  const done = load(id);
  if (r.sessionId && !done.sessionId) done.sessionId = r.sessionId;
  if (done.status === 'stopped') { save(done); return pump(); }
  // pause: one more turn to leave a checkpoint, then rest
  if (done.status === 'pausing' && from !== 'pause') {
    save(done);
    enqueue(id, '[factory] PAUSE requested by the person. Stop the current work: commit what you have as a work-in-progress commit on your branch and push it (no PR changes), add a decision-log row, and reply with a short resume note: what is done, what is next, anything half-finished.', 'bypassPermissions', 'pause');
    return pump();
  }
  const decision = /^\s*DECISION NEEDED\b/m.test(r.last);
  let next;
  if (from === 'pause') next = 'paused';
  else if (done.kind === 'report') next = decision ? 'decision needed' : mode === 'plan' ? 'waiting for you' : 'done';
  else if (done.kind === 'program') { save(done); return afterCoordinator(done, mode, from, r.last, decision); }
  else {
    done.pr = (await findPr(done)) ?? done.pr ?? null;
    const head = done.pr?.state === 'open' ? done.pr.head : null;
    if (mode === 'plan') next = 'waiting for you';
    else if (decision) next = 'decision needed';
    else if (!head) next = 'waiting for you';
    else if (head === done.reviewedSha) next = done.verdict === 'PASS' ? 'ready for you' : 'waiting for you'; // nothing new since the review
    else if (!hasChecks(done) || (done.greenSha && head.startsWith(done.greenSha))) next = 'reviewing';
    else next = 'waiting for checks';
  }
  done.status = next; save(done);
  log('run.end', { task: id, kind: done.kind, mode, from, pr: done.pr?.number ?? null, status: next });
  if (next === 'reviewing') enqueueReview(id);
  pump();
}

// the review panel: fresh sessions (own Claude state, no resume, no GitHub
// token, no edit tools), one per model and angle, judge the PR head; the PR
// passes only when every reviewer passes it
const verdictOf = (text) => /VERDICT:\s*(PASS|CHANGES)/i.exec(text ?? '')?.[1]?.toUpperCase() ?? null;
async function review({ id }) {
  const t = update(id, (x) => { x.status = 'reviewing'; });
  const token = await githubToken(t.repo);
  const pr = await gh(token, `/repos/${t.repo}/pulls/${t.pr.number}`);
  const msgs = messages(id);
  const brief = t.auto ? null : msgs.find((m) => m.from === 'agent')?.text;
  const n = (t.reviews ?? 0) + 1;
  const base = `Review PR #${pr.number} of ${t.repo} (factory task ${id}, branch agent/${id} into ${t.base}). This is review round ${n}.

THE TASK, as the person gave it:
${msgs[0]?.text ?? t.title}
${brief ? `\nTHE AGENT'S BRIEF (its plan and definition of done):\n${brief}\n` : ''}
THE PR: ${pr.title}
${(pr.body ?? '').slice(0, 20000)}

The checkout in /workspace/repo is at the PR head (${pr.head.sha.slice(0, 7)}). See the change with \`git diff origin/${t.base}...HEAD\` and \`git log origin/${t.base}..HEAD\`; read the surrounding code and the repository's own rules (AGENTS.md, CLAUDE.md, .claude/skills, .agents/skills). The agent's decision log is /workspace/decisions.tsv (it may be missing).
Other reviewers look at this PR from other angles at the same time; stay on yours, but report anything that would block a merge.`;
  const results = [];
  for (const [i, member] of REVIEW_PANEL.entries()) {
    const focus = FOCUS[member.focus] ?? { name: member.focus, ask: `Your angle: ${member.focus}.` };
    const r = await container(id, { prompt: `${base}\n${focus.ask}\nReply with your findings, then the verdict line.`, mode: 'bypassPermissions', claudeDir: `review-claude/${n}-${i + 1}`, ghToken: '', system: REVIEW_RULES, model: member.model, disallowed: ['AskUserQuestion', 'Edit', 'Write', 'NotebookEdit'] });
    results.push({ ...member, name: focus.name, verdict: verdictOf(r.last), text: r.last || `no answer. ${r.stderr.trim().slice(-300)}` });
    if (['stopped', 'pausing'].includes(load(id).status)) break;
  }
  const verdict = results.length === REVIEW_PANEL.length && results.every((r) => r.verdict === 'PASS') ? 'PASS'
    : results.some((r) => r.verdict === 'CHANGES') ? 'CHANGES' : null;
  // one message: each reviewer's conclusion and must-fix, all notes at the end
  const parts = results.map((r) => { const [main, notes = ''] = r.text.replace(/^\s*VERDICT:.*$/gim, '').trim().split(/^#{1,6}\s*Notes\b.*$/im); return { r, main: main.trim(), notes: notes.trim() }; });
  const notes = parts.filter((p) => p.notes).map((p) => p.notes).join('\n');
  const combined = `${parts.map(({ r, main }) => `**${r.name} (${r.model}): ${r.verdict ?? 'no verdict'}**\n${main}`).join('\n\n')}${notes ? `\n\n## Notes\n${notes}` : ''}\n\nVERDICT: ${verdict ?? 'INCONCLUSIVE'}`;
  say(id, 'review', combined);
  gh(token, `/repos/${t.repo}/issues/${pr.number}/comments`, 'POST', { body: `**Review panel, round ${n}** at \`${pr.head.sha.slice(0, 7)}\` (fresh read-only sessions: ${results.map((r) => `${r.name.toLowerCase()} on ${r.model}`).join(', ')})\n\n${results.map((r) => `### ${r.name} (${r.model}): ${r.verdict ?? 'no verdict'}\n\n${r.text}`).join('\n\n').slice(0, 60000)}` })
    .catch((e) => log('review.comment_failed', { task: id, error: e.message }));
  const x = load(id);
  x.reviews = n; x.reviewedSha = pr.head.sha; x.verdict = verdict;
  if (x.status === 'stopped') { save(x); return pump(); }
  if (x.status === 'pausing') { x.status = 'paused'; save(x); return pump(); }
  if (verdict === 'PASS') {
    x.status = 'ready for you'; x.mergeWanted = !!PROJECTS[x.project]?.autoMerge; x.mergeTries = 0; save(x);
    if (x.mergeWanted) autoMerge(id).catch((e) => log('merge.failed', { task: id, error: e.message }));
  } else if (verdict === 'CHANGES' && x.factoryRounds < MAX_FACTORY_ROUNDS) {
    x.factoryRounds += 1; x.status = 'working'; save(x);
    enqueue(id, `[review] The review panel read your PR at ${pr.head.sha.slice(0, 7)} and asks for changes:\n\n${combined}`, 'bypassPermissions', 'review');
  } else {
    x.status = 'waiting for you'; save(x);
    if (verdict === 'CHANGES') say(id, 'factory', `[factory] round limit (${MAX_FACTORY_ROUNDS}) reached with review findings open: stopped. A person decides what next.`);
    else say(id, 'factory', '[factory] the review panel gave no clear verdict: a person decides.');
  }
  log('review.end', { task: id, round: n, verdict, panel: results.map((r) => `${r.model}:${r.verdict}`) });
  pump();
}

// ---------- auto-merge: only the reviewed head, only into the configured branch ----------
// projects.json "autoMerge": the one branch this project may merge into by
// itself (contentcoach: dev = staging; never main). GitHub's sha lock refuses
// the merge if anything was pushed after the review; branch protection (dev's
// required checks) still applies. Refused merges retry on the next polls,
// then go back to the person.
const MERGE_TRIES = 10;
async function autoMerge(id) {
  const t = load(id), p = PROJECTS[t.project];
  if (!p?.autoMerge || t.kind !== 'change' || t.verdict !== 'PASS' || !t.pr || t.status !== 'ready for you') return;
  const token = await githubToken(t.repo);
  const pr = await gh(token, `/repos/${t.repo}/pulls/${t.pr.number}`);
  const giveUp = (why) => { update(id, (x) => { x.mergeWanted = false; }); say(id, 'factory', `[factory] not merged automatically: ${why}. It's ready for you.`); log('merge.refused', { task: id, why }); };
  if (pr.merged_at) { update(id, (x) => { x.pr = { ...x.pr, state: 'merged' }; x.status = 'merged'; x.mergeWanted = false; }); return; }
  if (pr.state !== 'open') return giveUp('the PR is closed');
  if (pr.base.ref !== p.autoMerge) return giveUp(`it targets ${pr.base.ref}; this project only merges into ${p.autoMerge} by itself`);
  if (pr.head.sha !== t.reviewedSha) return giveUp(`its head moved to ${pr.head.sha.slice(0, 7)} after the review of ${t.reviewedSha.slice(0, 7)}`);
  try {
    await gh(token, `/repos/${t.repo}/pulls/${pr.number}/merge`, 'PUT', { sha: t.reviewedSha, merge_method: p.mergeMethod ?? 'merge', commit_title: `${pr.title} (#${pr.number})` });
  } catch (e) {
    const x = update(id, (x) => { x.mergeTries = (x.mergeTries ?? 0) + 1; });
    log('merge.retry', { task: id, tries: x.mergeTries, error: e.message });
    if (x.mergeTries >= MERGE_TRIES) giveUp(`GitHub refused ${MERGE_TRIES} times (${e.message.slice(0, 200)})`);
    return;
  }
  update(id, (x) => { x.pr = { ...x.pr, state: 'merged' }; x.status = 'merged'; x.mergeWanted = false; });
  say(id, 'factory', `[factory] 🚀 merged into ${p.autoMerge} (PR #${pr.number}, reviewed head ${t.reviewedSha.slice(0, 7)}). ${p.autoMerge === 'dev' ? 'Staging deploys it now; production still waits for your sign-off.' : 'The server pulls it within 5 minutes.'}`);
  log('merge.done', { task: id, pr: pr.number, into: p.autoMerge });
}
const retryMerges = async () => { for (const t of allTasks().filter((x) => x.mergeWanted && x.status === 'ready for you')) await autoMerge(t.id).catch((e) => log('merge.failed', { task: t.id, error: e.message })); };

// ---------- programs: a coordinator plans phases, agents do the pieces, you merge ----------
const phaseBlock = (text) => { const m = /```phase\s*([\s\S]*?)```/.exec(text ?? ''); if (!m) return null; try { const j = JSON.parse(m[1]); return Array.isArray(j.tasks) && j.tasks.length ? j : null; } catch { return null; } };
function createProgram(project, goal) {
  const p = PROJECTS[project]; if (!p) throw new Error(`unknown project ${project}`);
  if (!goal) throw new Error('empty goal');
  const id = newId(); mkdirSync(dir(id), { recursive: true });
  const t = { id, project, repo: p.repo, base: p.base, kind: 'program', title: goal.split('\n')[0].slice(0, 90), phase: 'brief', status: 'queued', children: [], programPhase: 0, factoryRounds: 0, createdAt: new Date().toISOString() };
  save(t); say(id, 'you', goal);
  enqueue(id, `PROGRAM ${id} in ${p.repo} (base ${p.base}). You are its coordinator: you plan and track; you never write code. Agents do each piece as its own task and PR (each gets its own preview, tests and an independent review), and a person merges.

GOAL:
${goal}

Frame it with the "large" playbook: the definition of done for the whole program, scope, risks. Then the phases. A phase is a set of tasks that are independent of each other (they run in parallel and can merge in any order); a later phase may depend on earlier phases being merged. Each task is one PR an agent can finish and prove on its own: say what to change, where, and how done is checked, in a few sentences. At most 5 tasks per phase. Plan the first phase in detail; the later phases one line each.
Reply to the person in plain words (framing, then the phases), then the first phase as a fenced block exactly like:
\`\`\`phase
{"phase": 1, "tasks": ["...", "..."]}
\`\`\`
Read the code you need. Do not change any file.`, 'plan', 'start');
  return t;
}
function launchPhase(t, block) {
  const n = block.phase ?? t.programPhase + 1;
  const goal = messages(t.id)[0]?.text ?? t.title;
  const kids = block.tasks.slice(0, 5).map((text) => createTask(t.project, `Part of program ${t.id}, phase ${n}. The program's goal, for context only (do just your part):\n${goal.slice(0, 2000)}\n\nYOUR TASK:\n${text}`, true, { parent: t.id, batch: t.id, title: String(text).split('\n')[0].slice(0, 90) }));
  update(t.id, (x) => { x.phase = 'run'; x.programPhase = n; x.children = [...(x.children ?? []), ...kids.map((k) => k.id)]; x.phaseChildren = kids.map((k) => k.id); x.status = `running phase ${n}`; x.mergeNoticeFor = null; });
  say(t.id, 'factory', `[factory] phase ${n} started: ${kids.length} task${kids.length === 1 ? '' : 's'}. Each runs to a reviewed PR; the next phase is planned when you have merged these.`);
  log('program.phase', { task: t.id, phase: n, children: kids.map((k) => k.id) });
}
function afterCoordinator(t, mode, from, last, decision) {
  if (decision) { t.status = 'decision needed'; save(t); return pump(); }
  if (/^\s*PROGRAM DONE\b/m.test(last)) { t.status = 'done'; save(t); return pump(); }
  if (t.phase === 'brief') { t.status = 'waiting for you'; save(t); return pump(); } // the plan waits for "go"
  const block = phaseBlock(last);
  if (block) launchPhase(t, block);
  else { t.status = 'waiting for you'; save(t); say(t.id, 'factory', '[factory] the coordinator gave no phase block: reply to tell it what to do next.'); }
  pump();
}
const SETTLED = ['ready for you', 'decision needed', 'waiting for you', 'stopped', 'paused', 'done', 'merged'];
async function watchPrograms() {
  for (const t of allTasks().filter((x) => x.kind === 'program' && x.phase === 'run' && /^running phase|^waiting for merges/.test(x.status))) {
    if (running.has(t.id) || queue.some((j) => j.id === t.id)) continue;
    const kids = [];
    for (const id of t.phaseChildren ?? []) {
      const k = load(id);
      if (k.pr && k.pr.state !== 'merged') { const pr = await findPr(k); if (pr) { k.pr = pr; save(k); } }
      kids.push(k);
    }
    const finished = (k) => k.pr?.state === 'merged' || k.pr?.state === 'closed' || k.status === 'stopped';
    if (kids.every(finished)) {
      const lines = kids.map((k) => `- ${k.title}: ${k.pr ? `PR #${k.pr.number} ${k.pr.state}` : `no PR (${k.status})`}${k.verdict ? `, review ${k.verdict}` : ''}`).join('\n');
      update(t.id, (x) => { x.status = 'planning'; });
      enqueue(t.id, `[factory] Phase ${t.programPhase} is finished:\n${lines}\n\nCheck what actually landed on ${t.base} (fetch it). Then either plan the next phase (update the plan with what you learned) and end with the \`\`\`phase block, or, if the program's definition of done is met, verify it and reply with a line "PROGRAM DONE" and the evidence. Do not change any file.`, 'plan', 'next-phase');
    } else if (kids.every((k) => finished(k) || (!running.has(k.id) && SETTLED.includes(k.status))) && t.mergeNoticeFor !== t.programPhase) {
      update(t.id, (x) => { x.status = 'waiting for merges'; x.mergeNoticeFor = x.programPhase; });
      const open = kids.filter((k) => !finished(k));
      say(t.id, 'factory', `[factory] phase ${t.programPhase}: nothing is moving. Waiting for you on:\n${open.map((k) => `- ${k.title}: ${k.status}${k.pr ? ` · ${k.pr.url}` : ''}`).join('\n')}`);
    }
  }
}

// ---------- the conversation ----------
const newId = () => `${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${randomBytes(3).toString('hex')}`;
function createTask(project, text, auto, extra = {}) {
  const p = PROJECTS[project]; if (!p) throw new Error(`unknown project ${project}`);
  if (!text) throw new Error('empty task');
  const id = newId();
  mkdirSync(dir(id), { recursive: true });
  const t = { id, project, repo: p.repo, base: p.base, kind: 'change', title: text.split('\n')[0].slice(0, 90), phase: auto ? 'run' : 'brief', auto, status: 'queued', factoryRounds: 0, createdAt: new Date().toISOString(), ...extra };
  save(t); say(id, 'you', text);
  if (t.kind === 'report') enqueue(id, reportPrompt(t, text), 'bypassPermissions', 'start');
  else if (auto) enqueue(id, runPrompt(t, text, 'Pre-approved: no brief, start now. First pick your playbook and write your definition of done as checks anyone can run; it goes in the PR description under "Done".'), 'bypassPermissions', 'start');
  else enqueue(id, `TASK ${id} in ${p.repo} (base ${p.base}).\n\n${text}\n\nThis is the BRIEF. Read the code you need (and .claude/skills/factory-rules, .agents/skills/verify-contentcoach if present). Reply with ONE message: your playbook, the questions you genuinely need answered (or "no questions"), your plan in a few lines, and the definition of done as checks anyone can run. Do not change any file.`, 'plan', 'start');
  return t;
}
const runPrompt = (t, task, reply) => `${reply}\n\nNow RUN task ${t.id}: ${task}\nYou are on branch agent/${t.id} in /workspace/repo (base ${t.base}). Work until your definition of done is met. Commit, push the branch, and open a PR into ${t.base} with \`gh pr create\` (title: the task in one line; body: Done / Decisions / Attention). ${hasChecks(t) ? 'Every push builds a preview and runs e2e; the results arrive here as [factory] messages. ' : ''}When it is done, an independent reviewer reads the PR; its findings arrive as [review] messages. Do not ask questions.`;
const reportPrompt = (t, text) => `TRIAGE task ${t.id} for ${t.repo} (default branch ${t.base}). Use the "bug" playbook's first steps, but do not change code, push, or open a PR in this task.
THE REPORT${t.issue ? `: GitHub issue #${t.issue.number} (${t.issue.url})` : ', from the person (Telegram)'}:
${text}

1. Classify it: bug, performance, feature, question, or other. Restate it in your own words.
2. Duplicates: search open and closed issues (\`gh issue list --state all --search "..."\`) and recent PRs. A confident duplicate: add the new details as a comment on the existing issue, and that is your verdict.
3. Trace the likely owning code (file:line).
4. Bug or performance: reproduce the exact symptom twice with the repository's own tools (its verification skill, e2e runner, scripts, a failing check). Log how and the evidence in your decision log. If you cannot reproduce it, say exactly what you tried.
5. File it: ${t.issue ? `comment your verdict on issue #${t.issue.number} (restatement, evidence, suspected cause), remove its \`${TRIAGE_LABEL}\` label and add exactly one of` : 'open one GitHub issue (restatement, evidence, suspected cause) with exactly one label of'}: \`${INTAKE_LABEL}\` (clear, reproduced or confidently traced, a fix an agent can make and prove), \`ready-for-human\` (needs a person: a product call, access, risk), \`needs-info\` (cannot act without more from the reporter: ask the precise question). A feature or question is ${INTAKE_LABEL} only when it is small and fully specified. Create a missing label with \`gh label create\`.
Write nothing anywhere except that one issue. End with exactly one line: \`TRIAGE: <class> <label> <issue url>\`.`;
function post(id, from, text) {
  const t = load(id); say(id, from, text);
  if (from === 'factory') {
    if (t.phase !== 'run' || ['stopped', 'paused', 'pausing', 'merged'].includes(t.status) || t.kind !== 'change') return t;
    // the round limit stops fix loops: only a red report counts (and review CHANGES); green never does
    const green = text.includes('✅') && /\(`([0-9a-f]{7,40})`\)/.exec(text)?.[1];
    if (!green && t.factoryRounds >= MAX_FACTORY_ROUNDS) { say(id, 'factory', `[factory] round limit (${MAX_FACTORY_ROUNDS} failed rounds) reached: stopped. A person decides what next.`); t.status = 'waiting for you'; save(t); return t; }
    if (green) t.greenSha = green;
    else t.factoryRounds += 1;
    save(t);
    enqueue(id, text, 'bypassPermissions', green ? 'green' : 'factory');
    return t;
  }
  if (t.kind === 'program') {
    if (t.phase === 'brief' && /^\s*(go|ok|okay|yes|approved?|start|lgtm)\b/i.test(text)) {
      const block = phaseBlock(messages(id).filter((m) => m.from === 'coordinator').at(-1)?.text);
      if (block) { launchPhase(t, block); return load(id); }
    }
    enqueue(id, `The person replied: ${text}\n\n${t.phase === 'brief' ? 'Revise the plan accordingly and end with the ```phase block for the first phase.' : 'Act on it: end with the ```phase block for the next phase, or "PROGRAM DONE".'}`, 'plan', t.phase === 'brief' ? 'person' : 'next-phase');
    return t;
  }
  if (t.phase === 'brief') { t.phase = 'run'; save(t); enqueue(id, runPrompt(t, messages(id)[0].text, `The person answered your brief: ${text}`), 'bypassPermissions', 'person'); }
  else enqueue(id, text, 'bypassPermissions', 'person');
  return t;
}

// ---------- intake: labelled issues become tasks by themselves ----------
// ready-for-agent -> a change (no brief); needs-triage -> a report. Issues that
// already carried needs-triage when triage first ran are left alone.
const INTAKE_FILE = `${HOME}/intake.json`, TRIAGE_FILE = `${HOME}/triage.json`;
async function intake() {
  const seen = readJson(INTAKE_FILE, {});
  const triage = readJson(TRIAGE_FILE, { baseline: {}, seen: {} });
  for (const [project, p] of Object.entries(PROJECTS)) {
    try {
      const token = await githubToken(p.repo);
      const list = (label) => gh(token, `/repos/${p.repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=30&sort=created&direction=asc`).then((r) => r.filter((i) => !i.pull_request));
      for (const is of await list(INTAKE_LABEL)) {
        const key = `${p.repo}#${is.number}`;
        if (seen[key]) continue;
        const text = `GitHub issue #${is.number}: ${is.title}\n\n${(is.body ?? '').slice(0, 20000)}\n\n${is.html_url}\nIn the PR description write "Refs #${is.number}" (not "Closes"); a person closes the issue after the merge.`;
        const t = createTask(project, text, true, { issue: { number: is.number, url: is.html_url } });
        seen[key] = t.id; writeFileSync(INTAKE_FILE, JSON.stringify(seen, null, 1));
        log('intake.task', { repo: p.repo, issue: is.number, task: t.id });
        gh(token, `/repos/${p.repo}/issues/${is.number}/comments`, 'POST', { body: `Factory task \`${t.id}\` picked this up (label \`${INTAKE_LABEL}\`). Its PR will say "Refs #${is.number}".` })
          .catch((e) => log('intake.comment_failed', { repo: p.repo, issue: is.number, error: e.message }));
      }
      const waiting = await list(TRIAGE_LABEL);
      if (!triage.baseline[p.repo]) {
        for (const is of waiting) triage.seen[`${p.repo}#${is.number}`] = 'baseline';
        triage.baseline[p.repo] = new Date().toISOString(); writeFileSync(TRIAGE_FILE, JSON.stringify(triage, null, 1));
        log('triage.baseline', { repo: p.repo, skipped: waiting.map((i) => i.number) });
        continue;
      }
      for (const is of waiting) {
        const key = `${p.repo}#${is.number}`;
        if (triage.seen[key]) continue;
        const t = createTask(project, `Bug report, GitHub issue #${is.number}: ${is.title}\n\n${(is.body ?? '').slice(0, 20000)}`, true, { kind: 'report', issue: { number: is.number, url: is.html_url }, title: `triage #${is.number}: ${is.title}`.slice(0, 90) });
        triage.seen[key] = t.id; writeFileSync(TRIAGE_FILE, JSON.stringify(triage, null, 1));
        log('triage.task', { repo: p.repo, issue: is.number, task: t.id });
      }
    } catch (e) { log('intake.failed', { repo: p.repo, error: e.message }); }
  }
}

// ---------- the morning summary ----------
async function digest(hours) {
  const since = Date.now() - hours * 3600e3;
  const recent = allTasks().filter((t) => Date.parse(t.updatedAt) >= since);
  const tokens = {};
  const attention = async (t) => {
    if (!t.pr) return '';
    try {
      tokens[t.repo] ??= await githubToken(t.repo);
      const body = (await gh(tokens[t.repo], `/repos/${t.repo}/pulls/${t.pr.number}`)).body ?? '';
      const m = /^#{1,6}\s*Attention\b[^\n]*\n([\s\S]*?)(?=^#{1,6}\s|$(?![\s\S]))/im.exec(body);
      return (m?.[1] ?? '').split('\n').filter((l) => !/Generated with|Co-Authored-By/i.test(l)).join('\n').trim().slice(0, 500);
    } catch { return ''; }
  };
  const brief = (t) => ({ id: t.id, title: t.title, kind: t.kind, status: t.status, pr: t.pr ?? null, verdict: t.verdict ?? null, reviews: t.reviews ?? 0 });
  const by = (s) => recent.filter((t) => s.includes(t.status));
  return {
    hours,
    ready: await Promise.all(by(['ready for you']).map(async (t) => ({ ...brief(t), attention: await attention(t) }))),
    decisions: by(['decision needed']).map(brief),
    waiting: by(['waiting for you', 'waiting for merges']).map(brief),
    moving: recent.filter((t) => running.has(t.id) || ['queued', 'working', 'briefing', 'planning', 'reviewing', 'waiting for checks'].includes(t.status) || /^running phase/.test(t.status)).map(brief),
    finished: by(['done']).map(brief),
    merged: recent.filter((t) => t.pr?.state === 'merged').map(brief),
    stopped: by(['stopped', 'paused']).map(brief),
    costUsd: recent.reduce((s, t) => s + (t.costUsd ?? 0), 0),
  };
}

// ---------- http ----------
const authOk = (req) => { const h = req.headers.authorization ?? ''; const want = `Bearer ${secret('api-token')}`; return h.length === want.length && timingSafeEqual(Buffer.from(h), Buffer.from(want)); };
async function body(req) { let b = ''; for await (const c of req) { b += c; if (b.length > 200000) throw new Error('body too large'); } return b ? JSON.parse(b) : {}; }
const handler = async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/health') return send(200, { ok: true, running: running.size, queued: queue.length });
    if (!authOk(req)) return send(401, { error: 'unauthorized' });
    if (url.pathname === '/digest' && req.method === 'GET') return send(200, await digest(Number(url.searchParams.get('hours') ?? 24)));
    if (url.pathname === '/programs' && req.method === 'POST') { const b = await body(req); return send(201, createProgram(b.project, String(b.goal ?? '').trim())); }
    // a batch: independent tasks, each run without a brief to a reviewed PR
    if (url.pathname === '/batches' && req.method === 'POST') {
      const b = await body(req);
      const items = (Array.isArray(b.items) ? b.items : []).map((s) => String(s).trim()).filter(Boolean);
      if (!items.length) return send(400, { error: 'no items' });
      if (items.length > 20) return send(400, { error: 'at most 20 items in a batch' });
      const batch = `b${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${randomBytes(2).toString('hex')}`;
      return send(201, { batch, tasks: items.map((text) => createTask(b.project, text, true, { batch })) });
    }
    const m = url.pathname.match(/^\/tasks(?:\/([\w-]+))?(?:\/(messages|stop|pause))?$/);
    if (!m) return send(404, { error: 'not found' });
    const [, id, sub] = m;
    if (!id && req.method === 'GET') return send(200, allTasks().map((t) => ({ ...t, running: running.has(t.id), lastActivity: running.has(t.id) ? activity(t.id, 1)[0] ?? null : null, lastAgent: messages(t.id).filter((m) => ['agent', 'coordinator'].includes(m.from)).at(-1)?.text ?? '' })));
    if (!id && req.method === 'POST') {
      const b = await body(req); const text = String(b.text ?? '').trim();
      if (b.kind === 'report') return send(201, createTask(b.project, text, true, { kind: 'report', title: `bug: ${text.split('\n')[0]}`.slice(0, 90) }));
      return send(201, createTask(b.project, text, !!b.auto));
    }
    if (!existsSync(`${dir(id)}/task.json`)) return send(404, { error: 'no such task' });
    if (!sub && req.method === 'GET') return send(200, { ...load(id), running: running.has(id), messages: messages(id), activity: activity(id), decisions: decisions(id) });
    if (sub === 'messages' && req.method === 'POST') { const b = await body(req); return send(200, post(id, b.from === 'factory' ? 'factory' : 'you', String(b.text ?? '').trim())); }
    if (sub === 'stop' && req.method === 'POST') {
      dropQueued(id);
      if (containers.has(id)) spawn('docker', ['kill', containers.get(id)], { stdio: 'ignore' });
      running.get(id)?.kill('SIGTERM');
      const t = update(id, (x) => { x.status = 'stopped'; }); say(id, 'factory', '[factory] stopped by you.'); return send(200, t);
    }
    if (sub === 'pause' && req.method === 'POST') {
      const t0 = load(id);
      if (['stopped', 'paused', 'pausing', 'done'].includes(t0.status)) return send(200, t0);
      dropQueued(id);
      if (running.has(id)) {
        update(id, (x) => { x.status = 'pausing'; });
        say(id, 'factory', '[factory] pausing: the agent leaves a checkpoint and a resume note. Reply to resume.');
        if (containers.has(id)) spawn('docker', ['kill', containers.get(id)], { stdio: 'ignore' });
        running.get(id)?.kill('SIGTERM');
      } else { update(id, (x) => { x.status = 'paused'; }); say(id, 'factory', '[factory] paused. Reply to resume.'); }
      return send(200, load(id));
    }
    return send(405, { error: 'method not allowed' });
  } catch (e) { log('http.error', { error: e.message }); return send(400, { error: e.message }); }
};
for (const a of BIND) createServer(handler).listen(PORT, a, () => log('listening', { address: a, port: PORT, image: IMAGE, network: NETWORK, runtime: RUNTIME || 'runc', reviewPanel: REVIEW_PANEL.map((r) => `${r.model}:${r.focus}`), autoMerge: Object.fromEntries(Object.entries(PROJECTS).map(([k, v]) => [k, v.autoMerge ?? null])), labels: [INTAKE_LABEL, TRIAGE_LABEL] }));
pickup();
const poll = () => intake().catch((e) => log('intake.failed', { error: e.message }))
  .then(() => retryMerges()).catch((e) => log('merge.failed', { error: e.message }))
  .then(() => watchPrograms()).catch((e) => log('programs.failed', { error: e.message }));
setTimeout(poll, 15000);
setInterval(poll, POLL_EVERY_S * 1000);
