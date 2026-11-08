// factory-agents: one task = one conversation with Claude Code, run headless in
// a locked-down container. Kinds of task:
//  - change: Brief (read-only, asks once) -> Run (playbook + decision log, no
//    questions, pushes agent/<task>, opens a PR) -> Checks ([factory] reports
//    drive it to green) -> QA (projects with "qa": a fresh tester with no code
//    tests the task on the preview like a user: FAIL = back to the agent) ->
//    Review (a fresh reviewer that did not write the code: PASS = ready for
//    you, CHANGES = back to the agent)
//  - report: triage a bug report (classify, dedupe, reproduce twice, file or
//    update the issue, label it); ready-for-agent issues then become changes
//  - program (epic): a coordinator plans every task with what it depends on; you approve
//    the plan once; each task starts as soon as what it depends on has merged
// Tasks also arrive by themselves (issues labelled ready-for-agent or
// needs-triage) and in batches. The queue and running jobs survive a restart.
// Loopback + one bridge address only; every call needs the API token.
import { createServer } from 'node:http';
import { tailLines, lastJsonLine } from './tail.mjs';
import { mergeDecision } from './merge.mjs';
import { watchdogDecision, statusClock, jobStarted } from './watchdog.mjs';
import { needsDoctor, doctorPrompt, parseDiagnosis, doctorMessage } from './doctor.mjs';
import { checkUnasked, decisionMessage, waitingOnLine, decidedMessage, expandNumberAnswer, hasDecisionBlock } from './unasked.mjs';
import { parkReason, verdictOf, qaVerdictOf, afterAgentRun, crashRetryPrompt, noPrNudgePrompt, afterCoordinator as coordinatorNext, pickupJob, afterQa, panelVerdict, afterReview, afterFactoryReport, researchHandoff, STUCK_STATUSES } from './lifecycle.mjs';
import { parsePlan, mergePlan, progress, announcements, PLAN_RULES, talkReply, isGoCommand } from './plan.mjs';
import { openEpicIssue, refsLine, copyIssueFields, saveIssueFields, syncEpicIfChanged as syncEpicIssue, droppedWithIssues } from './epic-issue.mjs';
import { publishMedia, upsertComment, mediaFiles } from './media.mjs';
import { REPORT_MARK, buildReport, mappingFrom, reportSummary, openFindings } from './report.mjs';
import { withAttachments, MAX_BODY_BYTES } from './attachments.mjs';
import { createDrain, startupPlan } from './drain.mjs';
import { evidenceSection } from './evidence.mjs';
import { loopDecision, openLoopTasks, isOpenLoop, loopTaskText, afterStart, afterRemind, normalizeLoops } from './loops.mjs';
import { createMcp } from './mcp.mjs';
import { launchArgs } from './launch.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { createSign, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, chownSync, cpSync, statSync, unlinkSync, renameSync } from 'node:fs';

const HOME = process.env.AGENTS_DIR ?? '/srv/factory/agents';
const SECRETS = process.env.AGENTS_SECRETS ?? '/opt/factory/agents';
const IMAGE = process.env.AGENT_IMAGE ?? 'factory-agent:latest';
const NETWORK = process.env.AGENT_NETWORK ?? 'factory-agents';
const DASHBOARD = process.env.DASHBOARD_URL ?? 'https://factory.contentcoach.org';
const RUNTIME = process.env.AGENT_RUNTIME ?? '';           // e.g. runsc
const CLASSIFY_MODEL = process.env.CLASSIFY_MODEL ?? 'haiku';
const PORT = Number(process.env.PORT ?? 19300);
const BIND = (process.env.BIND_ADDRESSES ?? '127.0.0.1').split(',').map((s) => s.trim()).filter(Boolean);
const MAX_PARALLEL = Number(process.env.MAX_PARALLEL ?? 5);
const MAX_FACTORY_ROUNDS = Number(process.env.MAX_FACTORY_ROUNDS ?? 6);
const MAX_CRASH_RETRIES = Number(process.env.MAX_CRASH_RETRIES ?? 2);
// the review panel: fresh sessions, each its own model and angle; every one must pass
const REVIEW_PANEL = (process.env.REVIEW_PANEL ?? 'opus:correctness,sonnet:evidence').split(',').map((x) => { const [model, focus] = x.trim().split(':'); return { model, focus }; });
const FOCUS = {
  correctness: { name: 'Correctness', ask: 'Your angle is correctness: does it do everything the task asked and nothing unrelated; bugs (edge cases, errors, security, data loss, races); does it break something next to the change.' },
  evidence: { name: 'Evidence', ask: 'Your angle is evidence: is every item of the definition of done backed by evidence; is new behaviour covered by a test that would fail without the change; do the decision log\'s claims hold up against their evidence; was any verification claimed without proof; does it follow the repository\'s own rules.' },
};
// the QA tester: a fresh session with no code and no GitHub token that tests the
// task (as the person gave it) on the PR's preview, like a user, with a video per check
const QA_MODEL = process.env.QA_MODEL ?? 'sonnet';
const PREVIEW_PASSWORD_FILE = process.env.PREVIEW_PASSWORD_FILE ?? '/opt/factory/preview-password';
const ARTIFACTS = process.env.ARTIFACTS_DIR ?? '/srv/factory/artifacts';
const INTAKE_LABEL = process.env.INTAKE_LABEL ?? 'ready-for-agent';
const TRIAGE_LABEL = process.env.TRIAGE_LABEL ?? 'needs-triage';
const POLL_EVERY_S = Number(process.env.INTAKE_EVERY_S ?? 120);
// the projects this factory serves: box config, not part of the repo (see projects.example.json)
const PROJECTS_FILE = process.env.PROJECTS_FILE ?? `${SECRETS}/projects.json`;
const PROJECTS = JSON.parse(readFileSync(PROJECTS_FILE, 'utf8'));
// the factory's brain (brain/ in this repo): role prompts, playbooks,
// knowledge and skills. Read on every run, so a merged brain change applies to
// the next run without a restart. Knowledge and skills are mounted read-only
// into every container.
const BRAIN = process.env.FACTORY_BRAIN ?? new URL('../brain', import.meta.url).pathname;
const brain = (f) => readFileSync(`${BRAIN}/${f}`, 'utf8').trim();
const BRAIN_NOTE = `Factory knowledge (read-only): /factory/brain/knowledge, start with index.md and read what bears on your task. Factory-wide skills are installed as skills. The repository's own rules and skills win over the factory's when they disagree.`;
const RULES = () => `${brain('prompts/agent.md')}\n${BRAIN_NOTE}\n\n${brain('prompts/playbooks.md')}`;
const REVIEW_RULES = () => `${brain('prompts/review.md')}\n${BRAIN_NOTE}`;
const RESEARCH_RULES = () => `${brain('prompts/research.md')}\n${BRAIN_NOTE}`;
const QA_RULES = () => `${brain('prompts/qa.md')}\n${BRAIN_NOTE}`;
const BRAIN_PLUGINS = () => { try { return JSON.parse(brain('claude/plugins.json')).plugins.filter((x) => /^[\w-]+$/.test(x)).join(','); } catch { return ''; } };
const PROJECTS_DIR = process.env.PROJECTS_DIR ?? '/opt/factory/projects'; // per-project image + knowledge folders live on the box, not in the repo
const BRAIN_MOUNTS = () => [`${BRAIN}/knowledge:/factory/brain/knowledge:ro`, `${BRAIN}/skills:/home/agent/.claude/skills:ro`];

const log = (event, f = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...f }));
const secret = (n) => readFileSync(`${SECRETS}/${n}`, 'utf8').trim();
mkdirSync(`${HOME}/tasks`, { recursive: true });

// ---------- tasks on disk: tasks/<id>/task.json + messages.jsonl ----------
const dir = (id) => `${HOME}/tasks/${id}`;
const load = (id) => JSON.parse(readFileSync(`${dir(id)}/task.json`, 'utf8'));
// save also keeps two things true for every task: when its status last changed (the watchdog's clock; the
// nudge marks restart with it) and that a parked task always says what the person is waited on for.
const save = (t) => {
  const now = new Date().toISOString();
  statusClock(t, now);
  const why = parkReason(t);
  if (why) t.waitingOn = why; else delete t.waitingOn;
  t.updatedAt = now; writeFileSync(`${dir(t.id)}/task.json`, JSON.stringify(t, null, 1));
};
const update = (id, f) => { const t = load(id); f(t); save(t); return t; };
const say = (id, from, text, extra = {}) => appendFileSync(`${dir(id)}/messages.jsonl`, JSON.stringify({ at: new Date().toISOString(), from, text, ...extra }) + '\n');
const messages = (id) => existsSync(`${dir(id)}/messages.jsonl`) ? readFileSync(`${dir(id)}/messages.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
// the last few things the agent did (tool calls), newest last
function activity(id, n = 8) {
  return tailLines(`${dir(id)}/activity.log`, n).map((l) => {
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
// one GitHub App for every project (the "factory" app, owned by omardmv,
// installed on each project's repository). Every token is limited to the
// task's one repository and to this list, unless a project lists its own.
// Workflows, secrets, settings and administration are never in it.
// workflows: write lets agents change CI (.github/workflows); the founder approved it on 2026-11-08 (gates.md)
const TOKEN_PERMISSIONS = { contents: 'write', pull_requests: 'write', issues: 'write', workflows: 'write', checks: 'read', statuses: 'read', actions: 'read', metadata: 'read' };
async function githubToken(repo) {
  const app = Object.values(PROJECTS).find((p) => p.repo === repo)?.githubApp;
  if (!app) throw new Error(`no GitHub App configured for ${repo}`);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 540, iss: app.id })}`;
  const jwt = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(secret(app.key), 'base64url')}`;
  const inst = await gh(jwt, `/repos/${repo}/installation`);
  return (await gh(jwt, `/app/installations/${inst.id}/access_tokens`, 'POST', { repositories: [repo.split('/')[1]], permissions: app.permissions ?? TOKEN_PERMISSIONS })).token;
}
// the PR's comments (oldest first; the last pages hold the newest), for the panels' evidence section
async function prComments(token, repo, pr) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const r = await gh(token, `/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`);
    all.push(...r);
    if (r.length < 100) break;
  }
  return all;
}
const evidenceFor = async (token, t, msgs, kinds) => evidenceSection(await prComments(token, t.repo, t.pr.number).catch((e) => { log('evidence.comments_failed', { task: t.id, error: e.message }); return []; }), msgs, { kinds, mapping: mappingFrom(msgs), files: mediaFiles(`${dir(t.id)}/workspace`) });
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
// projects whose green PRs are also tested by the independent QA tester before review
const hasQa = (t) => hasChecks(t) && PROJECTS[t.project]?.qa === true && t.kind === 'change';

// ---------- the queue: persisted, so a restart (every deploy) loses nothing ----------
const DRAIN_FILE = `${HOME}/drain.json`;
const DRAIN_TIMEOUT_MS = Number(process.env.DRAIN_TIMEOUT_S ?? 1800) * 1000;
// jobs from start to the end of their handling (running only covers the container, not what follows: the PR lookup,
// the next status, queueing the review). A drain waits for these, not just for containers.
const inflight = new Map(); // job seq -> task id
const drain = createDrain({
  running: () => [...new Set([...running.keys(), ...inflight.values()])],
  now: Date.now,
  describe: (id) => ({ id, kind: (() => { try { return load(id).job?.kind; } catch { return undefined; } })() }),
  // docker kill, not the client's death: the turn must be cut off for sure before node exits
  killAll: (ids) => { const names = ids.map((i) => containers.get(i)).filter(Boolean); if (names.length) spawnSync('docker', ['kill', ...names], { stdio: 'ignore' }); },
  writeRecord: (r) => writeFileSync(DRAIN_FILE, JSON.stringify(r, null, 1)),
  exit: () => process.exit(0),
  log,
}, DRAIN_TIMEOUT_MS);
process.on('SIGTERM', () => drain.start());
process.on('SIGINT', () => drain.start());
setInterval(() => drain.tick(), 2000);
const running = new Map();   // task id -> child process (docker run client)
const containers = new Map(); // task id -> container name
const QUEUE_FILE = `${HOME}/queue.json`;
const queue = readJson(QUEUE_FILE, []); // { id, kind: 'agent' | 'qa' | 'review', prompt?, mode?, from? }
const saveQueue = () => writeFileSync(QUEUE_FILE, JSON.stringify(queue));
function enqueue(id, prompt, mode, from, origin) { queue.push({ id, kind: 'agent', prompt, mode, from, ...(origin ? { origin } : {}) }); saveQueue(); pump(); }
function enqueueReview(id, from) { if (!queue.some((j) => j.id === id && j.kind === 'review')) queue.push({ id, kind: 'review', ...(from ? { from } : {}) }); saveQueue(); pump(); }
function enqueueQa(id) { return enqueueQaFrom(id); }
function enqueueQaFrom(id, from) { if (!queue.some((j) => j.id === id && j.kind === 'qa')) queue.push({ id, kind: 'qa', ...(from ? { from } : {}) }); saveQueue(); pump(); }
const JOB_NAME = { agent: 'agent', qa: 'QA tester', review: 'reviewer' };
function dropQueued(id) { for (let i = queue.length - 1; i >= 0; i--) if (queue[i].id === id) queue.splice(i, 1); saveQueue(); }
function pump() {
  if (drain.draining) return; // a deploy is waiting for the running turns: nothing new starts
  while (running.size < MAX_PARALLEL && queue.length) {
    const i = queue.findIndex((j) => !running.has(j.id));
    if (i < 0) break;
    const [job] = queue.splice(i, 1); saveQueue();
    job.seq = randomBytes(4).toString('hex');
    update(job.id, (t) => { t.job = job; jobStarted(t, job); });
    // forget the job once it ended, unless the next job of this task already took its place
    const forget = (t) => { if (t.job?.seq === job.seq) delete t.job; };
    inflight.set(job.seq, job.id);
    (job.kind === 'review' ? review(job) : job.kind === 'qa' ? qa(job) : agentRun(job)).then((res) => { if (res !== 'keep-job') update(job.id, forget); }).catch((e) => {
      running.delete(job.id); containers.delete(job.id);
      log('run.crashed', { task: job.id, kind: job.kind, error: e.message });
      say(job.id, 'factory', `[factory] the ${JOB_NAME[job.kind] ?? job.kind} could not run: ${e.message}`);
      update(job.id, (t) => { forget(t); t.status = 'waiting for you'; t.waitingOn = `your call: the ${JOB_NAME[job.kind] ?? job.kind} could not run (${String(e.message).replace(/\s+/g, ' ').slice(0, 120)})`; });
      pump();
    }).finally(() => inflight.delete(job.seq));
  }
}
// session pickup: a job that was running when the factory stopped runs again,
// told it was interrupted (or from scratch when it never got a session)
function pickup() {
  for (const t of allTasks()) {
    if (!t.job || running.has(t.id) || queue.some((j) => j.id === t.id)) continue;
    if (pickupJob(t).drop) { update(t.id, (x) => { delete x.job; }); continue; }
    const j = t.job, p = pickupJob(t);
    queue.push(p.job);
    log('pickup', { task: t.id, kind: j.kind, from: j.from });
  }
  saveQueue(); pump();
}

// docker run ... claude -p; resolves with the last text the model wrote
// workspace: the task folder mounted at /workspace; repo: false = no checkout
// (the image clones only when REPO is set); env/mounts/extra: more for the
// container and for claude (the QA tester's browser)
async function container(id, { prompt, mode, claudeDir, ghToken, system, model, disallowed, resume, workspace = 'workspace', repo = true, env: more = {}, mounts = [], extra = [] }) {
  for (const d of [workspace, claudeDir]) { mkdirSync(`${dir(id)}/${d}`, { recursive: true }); chownSync(`${dir(id)}/${d}`, 1001, 1001); }
  const t = load(id);
  const name = `fa-${id}-${Date.now().toString(36)}`;
  const launch = launchArgs({ project: t.project, projects: PROJECTS, defaultImage: IMAGE, projectsDir: PROJECTS_DIR, exists: existsSync });
  const args = ['run', '--rm', '--name', name, '--network', NETWORK,
    '--cpus', '4', '--memory', '8g', '--pids-limit', '2048', '--shm-size', '1g',
    '--security-opt', 'no-new-privileges:true', '--cap-drop', 'NET_RAW', '--cap-drop', 'MKNOD', '--cap-drop', 'SYS_CHROOT', '--cap-drop', 'AUDIT_WRITE', '--cap-drop', 'SETFCAP',
    '-v', `${dir(id)}/${workspace}:/workspace`, '-v', `${dir(id)}/${claudeDir}:/home/agent/.claude`,
    ...[...BRAIN_MOUNTS(), ...launch.mounts, ...mounts].flatMap((m) => ['-v', m]),
    '-e', 'TASK_ID', '-e', 'REPO', '-e', 'BASE', '-e', 'GH_TOKEN', '-e', 'CLAUDE_CODE_OAUTH_TOKEN', '-e', 'FACTORY_PLUGINS', '-e', 'GIT_NAME', '-e', 'GIT_EMAIL', ...Object.keys(more).flatMap((k) => ['-e', k])];
  if (RUNTIME) args.push('--runtime', RUNTIME);
  args.push(launch.image, 'claude', '-p', prompt, '--output-format', 'stream-json', '--verbose', '--max-turns', '300',
    '--permission-mode', mode, '--disallowedTools', ...disallowed, '--append-system-prompt', system, ...extra);
  if (model) args.push('--model', model);
  if (resume) args.push('--resume', resume);
  const env = { ...process.env, ...more, TASK_ID: id, REPO: repo ? t.repo : '', BASE: t.base, GH_TOKEN: ghToken, CLAUDE_CODE_OAUTH_TOKEN: secret('claude-token'), FACTORY_PLUGINS: BRAIN_PLUGINS(), GIT_NAME: PROJECTS[t.project]?.githubApp?.bot?.name ?? '', GIT_EMAIL: PROJECTS[t.project]?.githubApp?.bot?.email ?? '' };
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
  const [code, signal] = await new Promise((r) => child.on('close', (c, s) => r([c, s])));
  running.delete(id); containers.delete(id);
  update(id, (x) => { x.costUsd = (x.costUsd ?? 0) + cost; });
  // killed while the factory stops: the turn did not finish, whatever text it left
  const cutOff = drain.draining && (code !== 0 || !!signal);
  return { last, stderr, sessionId, code, signal, cutOff };
}

const UNASKED_TIMEOUT_MS = 60000;
// auto-go: briefs and epic plans start by themselves; only a DECISION NEEDED (a real architecture,
// design-taste, money or security call) stops for the person. A project opts out with "autoGo": false.
const AUTO_GO = process.env.AUTO_GO !== '0';
const autoGo = (t) => AUTO_GO && PROJECTS[t.project]?.autoGo !== false;
const AUTO_GO_RULE = 'The founder runs the factory on auto-go: nobody approves this step, the work starts right after your reply. Classify every question before asking: a fact you can find out by running or reading something, find out; a reversible product, design, architecture or engineering call, take the option you would recommend, say it as an assumption and log it in the decision log (the factory shows the founder your pick with one-press alternatives); stop for the person (end with a DECISION NEEDED block) only for something irreversible or that only they can do (rotate or provide a secret, grant a permission, create an account, spend money, deploy to production, delete data, message users), or a choice with no sensible default.';
const MAX_NO_PR_NUDGES = Number(process.env.MAX_NO_PR_NUDGES ?? 2);
const MAX_AUTO_DECIDED = Number(process.env.MAX_AUTO_DECIDED ?? 3);
async function agentRun({ id, prompt, mode, from, origin }) {
  const t = update(id, (x) => { if (x.status !== 'pausing') x.status = mode === 'plan' ? (x.kind === 'program' ? 'planning' : 'briefing') : 'working'; });
  const r = await container(id, { prompt, mode, claudeDir: 'claude', ghToken: await githubToken(t.repo), system: t.type === 'research' ? RESEARCH_RULES() : RULES(), disallowed: ['AskUserQuestion'], resume: t.sessionId });
  if (r.last) say(id, t.kind === 'program' ? 'coordinator' : 'agent', r.last);
  else say(id, 'factory', `[factory] the agent stopped without a reply. ${r.stderr.trim().slice(-400)}`);
  // a plain-text question to the person (no DECISION NEEDED block): one cheap check per turn, fails open.
  // Run before the task is loaded and while it still holds its running slot, so a Stop/Pause
  // pressed meanwhile is not overwritten and no second turn of this task starts. Not in plan
  // mode (a plan awaiting approval already waits for the person).
  let asked = { asks: false };
  if (from !== 'pause' && mode !== 'plan' && r.last && !['stopped', 'pausing'].includes(load(id).status)) {
    const hold = { kill() {} }; running.set(id, hold);
    try { asked = await checkUnasked(r.last, { ask: (p) => oneShot(p, UNASKED_TIMEOUT_MS), timeoutMs: UNASKED_TIMEOUT_MS, log, autoGo: autoGo(t), classifyBlocks: autoGo(t) }); }
    finally { if (running.get(id) === hold) running.delete(id); }
  }
  const done = load(id);
  if (r.sessionId && !done.sessionId) done.sessionId = r.sessionId;
  // cut off by a stop: the job stays on the task, so the next start picks it up again ("you were interrupted")
  if (r.cutOff) { save(done); log('run.cutoff', { task: id, code: r.code, signal: r.signal }); return 'keep-job'; }
  // never block on the founder (design 5g): on auto-go a fact is found out and a reversible call is taken
  // with the agent's own pick, posted as "📌 Decided for you"; only a blocking question stops. Bounded per task.
  if (autoGo(done) && asked.asks && asked.kind !== 'blocking' && (done.autoDecided ?? 0) < MAX_AUTO_DECIDED) {
    done.autoDecided = (done.autoDecided ?? 0) + 1;
    const keep = [from, origin].includes('review') ? 'review' : (origin ?? from);
    if (asked.kind === 'reversible') {
      const d = { id: randomBytes(3).toString('hex'), at: new Date().toISOString(), question: asked.question, chosen: asked.chosen, options: asked.options };
      done.decisions = [...(done.decisions ?? []), d]; save(done);
      say(id, 'factory', decidedMessage(asked), { decided: d });
      log('decided.default', { task: id, question: asked.question.slice(0, 120), chosen: asked.chosen.slice(0, 80) });
      enqueue(id, `[factory] Auto-go: "${asked.question}" is a reversible call, so it is yours: go with your own pick, "${asked.chosen}". Log it in the decision log as an assumption the founder may change, then carry on until your definition of done is met. If you were already done, make sure the PR says this choice under "Decisions" and finish.`, mode, 'decided', keep);
    } else {
      save(done);
      say(id, 'factory', `[factory] 🔎 "${asked.question}" is a fact the agent can find out itself: sent back to check it and carry on.`);
      log('decided.fact', { task: id, question: asked.question.slice(0, 120) });
      enqueue(id, `[factory] "${asked.question}" can be answered by running or reading something, so don't ask: find out (a throwaway probe is fine), decide from what you see, log it in the decision log, and carry on until your definition of done is met.`, mode, 'decided', keep);
    }
    return pump();
  }
  const out = await afterAgentRun({ task: done, from, origin, mode, reply: r.last, unasked: asked.asks, maxCrashRetries: MAX_CRASH_RETRIES, maxNoPrNudges: MAX_NO_PR_NUDGES, autoGo: autoGo(done) }, { findPr, hasChecks, hasQa });
  if (out.type === 'stopped') { save(done); return pump(); }
  // pause: one more turn to leave a checkpoint, then rest
  if (out.type === 'checkpoint') {
    save(done);
    enqueue(id, '[factory] PAUSE requested by the person. Stop the current work: commit what you have as a work-in-progress commit on your branch and push it (no PR changes), add a decision-log row, and reply with a short resume note: what is done, what is next, anything half-finished.', 'bypassPermissions', 'pause');
    return pump();
  }
  // the process died without a reply: carry on by itself, bounded, instead of parking it on the person
  if (out.type === 'retry') {
    done.crashRetries = out.retry; save(done);
    log('run.crashed', { task: id, retry: out.retry, code: r.code ?? null });
    enqueue(id, crashRetryPrompt(out.retry, MAX_CRASH_RETRIES), mode, out.from);
    return pump();
  }
  // a run turn ended with no PR and no question: carry on by itself (bounded) instead of parking it on the person
  if (out.type === 'nudge') {
    done.noPrNudges = out.nudge; save(done);
    log('run.nudged', { task: id, nudge: out.nudge });
    enqueue(id, noPrNudgePrompt(out.nudge, MAX_NO_PR_NUDGES), mode, out.from);
    return pump();
  }
  if (out.resetCrash) done.crashRetries = 0;
  if (out.resetNoPr) done.noPrNudges = 0;
  // the person's answer to a decision carries the turn's origin, so a review-fix round still returns to the panel
  if (out.decision || asked.asks) done.askedFrom = [from, origin].includes('review') ? 'review' : (origin ?? from);
  if (asked.asks) done.lastOptions = asked.options; // so a reply of "2" can be expanded to the option
  if (asked.asks && !hasDecisionBlock(r.last)) {
    say(id, 'agent', decisionMessage(asked), { unasked: true });
    done.waitingOn = waitingOnLine(asked);
    log('unasked.caught', { task: id, question: asked.question });
  } else done.waitingOn = out.waitingOn;
  if (out.type === 'coordinator') { save(done); return afterCoordinator(done, mode, from, r.last, out.decision); }
  if (out.pr !== undefined && done.kind === 'change') done.pr = out.pr;
  // auto-go: a brief with no question for the person starts the run at once
  if (out.status === 'waiting for you' && mode === 'plan' && done.kind === 'change' && done.phase === 'brief' && !out.decision && !asked.asks && autoGo(done)) {
    done.phase = 'run'; done.status = 'queued'; delete done.waitingOn; save(done);
    say(id, 'factory', '[factory] ▶️ auto-go: the brief is accepted and the run starts now. Reply here to change course.');
    log('autogo.brief', { task: id });
    enqueue(id, runPrompt(done, messages(id)[0].text, `Your brief is accepted (auto-go). Where you listed questions, decide them yourself and log each choice in the decision log. ${AUTO_GO_RULE}`), 'bypassPermissions', 'person');
    return pump();
  }
  const next = out.status;
  done.status = next; save(done);
  log('run.end', { task: id, kind: done.kind, mode, from, pr: done.pr?.number ?? null, status: next });
  if (next === 'testing') enqueueQa(id);
  if (next === 'reviewing') enqueueReview(id);
  pump();
}

// the QA tester: a fresh session (own Claude state and workspace, no checkout,
// no GitHub token, no edit tools) gets only the task as the person gave it and
// the preview, tests it like a user with a video per check, and says
// PASS / FAIL / NOT APPLICABLE. FAIL goes back to the agent as a failed round;
// PASS and NOT APPLICABLE go on to the review panel. Videos and the report are
// published next to the e2e gallery: https://<preview>/_factory/qa/<round>-<sha>/
const projectPrefix = (project) => /^PREFIX=(\w+)/m.exec(readFileSync(new URL(`../projects/${project}/project.sh`, import.meta.url), 'utf8'))?.[1] ?? null;
function publishQa(t, ws, run, text) {
  try {
    const prefix = projectPrefix(t.project);
    const root = `${ARTIFACTS}/${prefix}/pr-${t.pr.number}`;
    if (!prefix || !existsSync(root)) return null;
    const src = `${dir(t.id)}/${ws}/qa/.e2e/videos`, dest = `${root}/qa/${run}`;
    mkdirSync(dest, { recursive: true });
    const videos = existsSync(src) ? readdirSync(src, { recursive: true }).filter((f) => /\.(webm|mp4)$/.test(f)) : [];
    for (const v of videos) cpSync(`${src}/${v}`, `${dest}/${v.replaceAll('/', '-')}`);
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    writeFileSync(`${dest}/index.html`, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>QA · PR ${t.pr.number} · ${esc(run)}</title>
<style>body{font:15px/1.5 system-ui;margin:1rem auto;max-width:900px;padding:0 1rem}pre{white-space:pre-wrap;background:#f6f6f6;padding:1rem}video{width:100%;margin:.25rem 0 1rem}</style>
<h1>Independent QA · PR #${t.pr.number} · ${esc(run)}</h1><pre>${esc(text)}</pre>
${videos.map((v) => `<h3>${esc(v)}</h3><video src="${esc(v.replaceAll('/', '-'))}#t=1" controls preload="metadata" playsinline></video>`).join('\n') || '<p>no videos</p>'}`);
    // the e2e job (user factory) deletes this folder when the PR closes
    const { uid, gid } = statSync(root);
    for (const p of [`${root}/qa`, dest, ...readdirSync(dest).map((f) => `${dest}/${f}`)]) chownSync(p, uid, gid);
    return `${t.previewHost}/_factory/qa/${run}/`;
  } catch (e) { log('qa.publish_failed', { task: t.id, error: e.message }); return null; }
}
async function qa({ id }) {
  const t = update(id, (x) => { x.status = 'testing'; });
  if (!t.previewHost) {
    say(id, 'factory', '[factory] no preview URL is known for this PR, so the QA tester could not run: on to the review panel.');
    update(id, (x) => { x.status = 'reviewing'; });
    return enqueueReview(id);
  }
  const token = await githubToken(t.repo);
  const pr = await gh(token, `/repos/${t.repo}/pulls/${t.pr.number}`);
  const head = pr.head.sha;
  const n = (t.qaRounds ?? 0) + 1, run = `${n}-${head.slice(0, 7)}`;
  const ws = `qa/${n}/workspace`;
  // the person's images, at the same /workspace/attachments paths the task text names
  if (existsSync(`${dir(id)}/workspace/attachments`)) cpSync(`${dir(id)}/workspace/attachments`, `${dir(id)}/${ws}/attachments`, { recursive: true });
  // the previews' basic-auth password, for the container's user only
  const secrets = `${dir(id)}/qa/${n}/secrets`;
  mkdirSync(secrets, { recursive: true });
  writeFileSync(`${secrets}/preview-password`, readFileSync(PREVIEW_PASSWORD_FILE, 'utf8'), { mode: 0o400 });
  chownSync(`${secrets}/preview-password`, 1001, 1001);
  const task = messages(id)[0]?.text ?? t.title;
  const evidence = await evidenceFor(token, t, messages(id));
  const prompt = `QA of factory task ${id}: PR #${pr.number} in ${t.repo} at ${head.slice(0, 7)}, QA round ${n}.

THE TASK, as the person gave it (all you know about the change):
${task}
${evidence}
THE PREVIEW of this change: ${t.previewHost}/app/
Sign in: navigate to ${t.previewHost}/_factory/login; it signs you in as the test account and lands in the app.

1. Write down the acceptance criteria first: what a user must be able to see or do once this task is done, each checkable on the preview, including the obvious neighbours (the thing the task names, everywhere a user would expect it). At most 8. If nothing in the task is visible to a user of the web app (backend only, refactor, infrastructure, docs, the Telegram bot), say so and end with "QA VERDICT: NOT APPLICABLE".
2. Open the browser: mcp__e2e__open_session (no arguments), then sign in.
3. For each criterion: start_recording with name c<k>-<two-word-slug>, do it as a user would, stop_recording, and judge PASS, FAIL or UNTESTABLE (only for what the offline preview cannot show, such as a real model's answer: say why). Screenshot what proves it.
4. close_session, then reply.`;
  const r = await container(id, {
    prompt, mode: 'bypassPermissions', claudeDir: `qa-claude/${n}`, workspace: ws, repo: false, ghToken: '', system: QA_RULES(), model: QA_MODEL,
    disallowed: ['AskUserQuestion', 'Edit', 'Write', 'NotebookEdit', 'WebSearch'],
    env: { QA_PREVIEW_URL: `${t.previewHost}/app/` }, mounts: [`${secrets}/preview-password:/run/factory/preview-password:ro`],
    extra: ['--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: { e2e: { command: 'qa-mcp', args: [] } } })],
  });
  const text = r.last || `no answer. ${r.stderr.trim().slice(-300)}`;
  const verdict = qaVerdictOf(text);
  const link = publishQa(load(id), ws, run, text);
  const report = `${text.replace(/^\s*QA VERDICT:.*$/gim, '').trim()}${link ? `\n\nVideos: ${link}` : ''}\n\nQA VERDICT: ${verdict ?? 'INCONCLUSIVE'}`;
  say(id, 'qa', report);
  gh(token, `/repos/${t.repo}/issues/${pr.number}/comments`, 'POST', { body: `**Independent QA, round ${n}** at \`${head.slice(0, 7)}\` (fresh session on ${QA_MODEL}: no code, only the task and the preview)\n\n${report}`.slice(0, 60000) })
    .catch((e) => log('qa.comment_failed', { task: id, error: e.message }));
  const x = load(id);
  x.qaRounds = n; x.qaTestedSha = head; x.qaVerdict = verdict;
  const o = afterQa({ task: x, verdict, maxRounds: MAX_FACTORY_ROUNDS });
  if (o.action === 'stopped') { save(x); return pump(); }
  x.status = o.status; x.waitingOn = o.waitingOn;
  if (o.action === 'paused') { save(x); return pump(); }
  if (o.action === 'review') { save(x); enqueueReview(id); }
  else if (o.action === 'fix') {
    x.factoryRounds = o.factoryRounds; save(x);
    enqueue(id, `[qa] An independent QA tester (no code, only the task and your preview) tested PR #${pr.number} at ${head.slice(0, 7)} and found failures:\n\n${report}\n\nReproduce each failure on the preview or locally, fix the cause, and turn each failed check into an e2e test that fails without your fix; push. If you are sure the tester misread the task, push nothing for that point and say why in the PR under "Decisions": the review panel will read both sides.`, 'bypassPermissions', 'qa');
  } else { save(x); say(id, 'factory', o.say); if (verdict === 'FAIL') publishReport(id, 'stopped').catch((e) => log('report.failed', { task: id, error: e.message })); }
  log('qa.end', { task: id, round: n, verdict, videos: link });
  pump();
}

// the review panel: fresh sessions (own Claude state, no resume, no GitHub
// token, no edit tools), one per model and angle, judge the PR head; the PR
// passes only when every reviewer passes it
async function review({ id }) {
  const t = update(id, (x) => { x.status = 'reviewing'; });
  const token = await githubToken(t.repo);
  const pr = await gh(token, `/repos/${t.repo}/pulls/${t.pr.number}`);
  const msgs = messages(id);
  const brief = t.auto ? null : msgs.find((m) => m.from === 'agent')?.text;
  const n = (t.reviews ?? 0) + 1;
  const evidence = await evidenceFor(token, t, msgs, ['review']);
  const qaReport = t.qaTestedSha === pr.head.sha ? msgs.filter((m) => m.from === 'qa').at(-1)?.text : null;
  const base = `Review PR #${pr.number} of ${t.repo} (factory task ${id}, branch agent/${id} into ${t.base}). This is review round ${n}.

THE TASK, as the person gave it:
${msgs[0]?.text ?? t.title}
${brief ? `\nTHE AGENT'S BRIEF (its plan and definition of done):\n${brief}\n` : ''}
THE PR: ${pr.title}
${(pr.body ?? '').slice(0, 20000)}
${evidence}${qaReport ? `\nTHE INDEPENDENT QA TESTER'S REPORT on this head (it tested the preview as a user, without the code):\n${qaReport.slice(0, 8000)}\nIf it says FAIL and the agent kept the code anyway, judge from the task and the code who is right; a real failure blocks the merge.\n` : ''}
The checkout in /workspace/repo is at the PR head (${pr.head.sha.slice(0, 7)}). See the change with \`git diff origin/${t.base}...HEAD\` and \`git log origin/${t.base}..HEAD\`; read the surrounding code and the repository's own rules (AGENTS.md, CLAUDE.md, .claude/skills, .agents/skills). The agent's decision log is /workspace/decisions.tsv (it may be missing).
Other reviewers look at this PR from other angles at the same time; stay on yours, but report anything that would block a merge.`;
  const results = [];
  for (const [i, member] of REVIEW_PANEL.entries()) {
    const focus = FOCUS[member.focus] ?? { name: member.focus, ask: `Your angle: ${member.focus}.` };
    const r = await container(id, { prompt: `${base}\n${focus.ask}\nReply with your findings, then the verdict line.`, mode: 'bypassPermissions', claudeDir: `review-claude/${n}-${i + 1}`, ghToken: '', system: REVIEW_RULES(), model: member.model, disallowed: ['AskUserQuestion', 'Edit', 'Write', 'NotebookEdit'] });
    results.push({ ...member, name: focus.name, verdict: verdictOf(r.last), text: r.last || `no answer. ${r.stderr.trim().slice(-300)}` });
    if (['stopped', 'pausing'].includes(load(id).status)) break;
  }
  const verdict = panelVerdict(results.map((r) => r.verdict), REVIEW_PANEL.length);
  // one message: each reviewer's conclusion and must-fix, all notes at the end
  const parts = results.map((r) => { const [main, notes = ''] = r.text.replace(/^\s*VERDICT:.*$/gim, '').trim().split(/^#{1,6}\s*Notes\b.*$/im); return { r, main: main.trim(), notes: notes.trim() }; });
  const notes = parts.filter((p) => p.notes).map((p) => p.notes).join('\n');
  const combined = `${parts.map(({ r, main }) => `**${r.name} (${r.model}): ${r.verdict ?? 'no verdict'}**\n${main}`).join('\n\n')}${notes ? `\n\n## Notes\n${notes}` : ''}\n\nVERDICT: ${verdict ?? 'INCONCLUSIVE'}`;
  say(id, 'review', combined);
  gh(token, `/repos/${t.repo}/issues/${pr.number}/comments`, 'POST', { body: `**Review panel, round ${n}** at \`${pr.head.sha.slice(0, 7)}\` (fresh read-only sessions: ${results.map((r) => `${r.name.toLowerCase()} on ${r.model}`).join(', ')})\n\n${results.map((r) => `### ${r.name} (${r.model}): ${r.verdict ?? 'no verdict'}\n\n${r.text}`).join('\n\n').slice(0, 60000)}` })
    .catch((e) => log('review.comment_failed', { task: id, error: e.message }));
  const x = load(id);
  x.reviews = n; x.reviewedSha = pr.head.sha; x.verdict = verdict;
  const o = afterReview({ task: x, verdict, headSha: pr.head.sha, autoMerge: PROJECTS[x.project]?.autoMerge, maxRounds: MAX_FACTORY_ROUNDS });
  if (o.action === 'stopped') { save(x); return pump(); }
  x.status = o.status; x.waitingOn = o.waitingOn;
  if (o.action === 'paused') { save(x); return pump(); }
  if (o.action === 'pass') {
    x.mergeWanted = o.mergeWanted; x.mergeTries = 0; save(x);
    if (o.disputed) say(id, 'factory', '[factory] the review panel passed a head the QA tester failed (the agent disputes the finding): not merged automatically. Read both and decide.');
    publishReport(id, 'ready').catch((e) => log('report.failed', { task: id, error: e.message }));
    if (x.mergeWanted) autoMerge(id).catch((e) => log('merge.failed', { task: id, error: e.message }));
  } else if (o.action === 'fix') {
    x.factoryRounds = o.factoryRounds; save(x);
    enqueue(id, `[review] The review panel read your PR at ${pr.head.sha.slice(0, 7)} and asks for changes:\n\n${combined}`, 'bypassPermissions', 'review');
  } else { save(x); say(id, 'factory', o.say); if (verdict === 'CHANGES') publishReport(id, 'stopped').catch((e) => log('report.failed', { task: id, error: e.message })); }
  log('review.end', { task: id, round: n, verdict, panel: results.map((r) => `${r.model}:${r.verdict}`) });
  pump();
}

// ---------- auto-merge: only the reviewed head, only into the configured branch ----------
// projects.json "autoMerge": the one branch this project may merge into by
// itself (e.g. a project whose staging deploys from `dev`: dev, never main). GitHub's sha lock refuses
// the merge if anything was pushed after the review; branch protection (dev's
// required checks) still applies. Refused merges retry on the next polls,
// then go back to the person.
const MERGE_TRIES = 10;
const MAX_CONFLICT_ROUNDS = Number(process.env.MAX_CONFLICT_ROUNDS ?? 3);
const MAX_CHECK_ROUNDS = Number(process.env.MAX_CHECK_ROUNDS ?? 3);
const REQUIRED_CHECKS_WAIT_MIN = Number(process.env.REQUIRED_CHECKS_WAIT_MIN ?? 45);
async function autoMerge(id) {
  const t = load(id), p = PROJECTS[t.project];
  if (!p?.autoMerge || t.kind !== 'change' || t.verdict !== 'PASS' || !t.pr || t.status !== 'ready for you') return;
  if (t.qaVerdict === 'FAIL' && t.qaTestedSha === t.reviewedSha) return;
  const token = await githubToken(t.repo);
  const pr = await gh(token, `/repos/${t.repo}/pulls/${t.pr.number}`);
  const giveUp = (why) => { update(id, (x) => { x.mergeWanted = false; }); say(id, 'factory', `[factory] not merged automatically: ${why}. It's ready for you.`); log('merge.refused', { task: id, why }); };
  // the project's required checks (box config "requiredChecks"), enforced here: GitHub can't on a free private repo
  let checks = null;
  if (p.requiredChecks?.length && pr.head?.sha) {
    const sha = pr.head.sha;
    const cr = await gh(token, `/repos/${t.repo}/commits/${sha}/check-runs?per_page=100`);
    const st = await gh(token, `/repos/${t.repo}/commits/${sha}/status`);
    const runs = [...(cr.check_runs ?? []).map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion, started_at: r.started_at, url: r.html_url })),
      ...(st.statuses ?? []).map((x) => ({ name: x.context, status: x.state === 'pending' ? 'in_progress' : 'completed', conclusion: x.state === 'pending' ? null : x.state === 'success' ? 'success' : 'failure', started_at: x.updated_at, url: x.target_url }))];
    const since = t.checksWait?.sha === sha ? t.checksWait.at : (update(id, (x) => { x.checksWait = { sha, at: new Date().toISOString() }; }), new Date().toISOString());
    checks = { required: p.requiredChecks, runs, waitedMin: (Date.now() - Date.parse(since)) / 60000, maxWaitMin: REQUIRED_CHECKS_WAIT_MIN, rounds: t.checkRounds ?? 0, maxRounds: MAX_CHECK_ROUNDS };
  }
  const d = mergeDecision(pr, t, p.autoMerge, t.conflictRounds ?? 0, MAX_CONFLICT_ROUNDS, checks);
  if (d.action === 'already-merged') { update(id, (x) => { x.pr = { ...x.pr, state: 'merged' }; x.status = 'merged'; x.mergeWanted = false; }); return; }
  if (d.action === 'give-up') return giveUp(d.why);
  if (d.action === 'wait') { log('merge.wait', { task: id, why: d.why ?? 'GitHub is still computing mergeability' }); return; } // the next poll retries
  if (d.action === 'fix-checks') {
    // a required check failed on the approved head: back to its agent (then checks and review run again)
    const list = d.failed.map((f) => `${f.name} (${f.conclusion}${f.url ? `: ${f.url}` : ''})`).join(', ');
    update(id, (x) => { x.checkRounds = d.round; x.mergeWanted = false; x.status = 'working'; });
    log('merge.checks-failed', { task: id, pr: pr.number, round: d.round, failed: d.failed.map((f) => f.name) });
    say(id, 'factory', `[factory] PR #${pr.number} was approved, but required check${d.failed.length > 1 ? 's' : ''} failed: ${list} (round ${d.round} of ${MAX_CHECK_ROUNDS}). Sent back to the agent.`);
    enqueue(id, `[factory] Your PR #${pr.number} was approved, but the project's required check${d.failed.length > 1 ? 's' : ''} failed on its head: ${list}. Read the failing run's log (\`gh run view --log-failed\` or the link), reproduce it locally, fix the cause (not the test, unless the test is wrong, and then say why in the decision log), push, and note the fix in the PR. It will be reviewed again.`, 'bypassPermissions', 'checks');
    return;
  }
  if (d.action === 'resolve') {
    // another PR landed first and this one no longer merges cleanly: back to its
    // agent to bring the branch up to date (then checks and review run again)
    update(id, (x) => { x.conflictRounds = d.round; x.mergeWanted = false; x.status = 'working'; });
    log('merge.conflict', { task: id, pr: pr.number, round: d.round });
    say(id, 'factory', `[factory] PR #${pr.number} no longer merges into ${p.autoMerge}: something merged there first conflicts with it (round ${d.round} of ${MAX_CONFLICT_ROUNDS}). Sent back to the agent to resolve.`);
    enqueue(id, `[factory] Your PR #${pr.number} was approved, but it no longer merges into ${p.autoMerge}: another change landed there first and conflicts with yours. Bring your branch up to date: \`git fetch origin && git merge origin/${p.autoMerge}\`, resolve every conflict keeping both changes' intent (read what landed: \`git log -p HEAD..origin/${p.autoMerge}\`), re-run your tests and the checks your definition of done names, and push. Log the resolution in the decision log and add a "Merge" note to the PR. Do not rebase or force-push. It will be reviewed again.`, 'bypassPermissions', 'conflict');
    return;
  }
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

// ---------- the final evidence report, on the PR (agents/report.mjs) ----------
// One comment, edited in place: when the PR is ready (review PASS) or the round limit stops the loop.
async function publishReport(id, outcome) {
  const t = load(id);
  if (!t.pr || t.pr.state !== 'open') return;
  const token = await githubToken(t.repo);
  const pr = await gh(token, `/repos/${t.repo}/pulls/${t.pr.number}`);
  const msgs = messages(id);
  const m = await publishMedia({ gh, token, repo: t.repo, pr: t.pr.number, taskId: t.id, workspace: `${dir(id)}/workspace`, done: t.mediaPublished ?? {} });
  const last = (from) => msgs.findLast((x) => x.from === from)?.text;
  const checks = t.lastChecks ?? (t.greenSha ? { state: 'green', sha: t.greenSha } : null);
  const body = buildReport({ taskId: t.id, repo: t.repo, pr: t.pr.number, head: pr.head.sha, outcome, title: t.title, mapping: mappingFrom(msgs), items: m.items, checks,
    taskText: msgs.find((x) => x.from === 'you')?.text, findings: outcome === 'stopped' ? openFindings(load(id), pr.head.sha, last) : {}, dashboard: DASHBOARD });
  const c = await upsertComment({ gh, token, repo: t.repo, pr: t.pr.number, mark: REPORT_MARK, body });
  update(id, (x) => { x.mediaPublished = m.done; x.reportComment = c.html_url; });
  say(id, 'factory', reportSummary({ outcome, pr: t.pr.number, prUrl: pr.html_url, reportUrl: c.html_url, mapping: mappingFrom(msgs), items: m.items }));
  log('report.published', { task: id, pr: t.pr.number, outcome, files: m.files, comment: c.html_url });
}

// ---------- epics (programs) ----------
// A coordinator plans every task of a big goal with what it depends on (one PR
// each, agents/plan.mjs); you approve the plan once ("go"). Each task starts as
// soon as everything it depends on has merged, so unrelated work runs in
// parallel and waves are only the result. The coordinator never writes code;
// you can reply at any time to revise what has not started.
// the planning prompt: sent when the person says "plan" at the end of the discussion
const planningPrompt = (note) => `${note}
Now write the plan. Frame it with the "large" playbook: the definition of done for the whole epic, scope, risks, shaped by the discussion so far. Reply to the person in plain words: the framing, then the waves the dependencies make (wave 1: what starts at once; wave 2: what each waits for; ...) as short lists, then the risks. ${PLAN_RULES}
Do not change any file.`;
function createProgram(project, goal, attachments, extra = {}) {
  const p = PROJECTS[project]; if (!p) throw new Error(`unknown project ${project}`);
  if (!goal && !attachments?.length) throw new Error('empty goal');
  const id = newId(); mkdirSync(dir(id), { recursive: true });
  goal = withAttachments(goal, `${dir(id)}/workspace`, attachments);
  const t = { id, project, repo: p.repo, base: p.base, kind: 'program', title: goal.split('\n')[0].slice(0, 90), phase: autoGo({ project }) ? 'brief' : 'talk', status: 'queued', children: [], plan: [], factoryRounds: 0, createdAt: new Date().toISOString(), type: 'epic', ...extra };
  save(t); say(id, 'you', goal);
  enqueue(id, `EPIC ${id} in ${p.repo} (base ${p.base}). You are its coordinator: you plan and track; you never write code. Agents do each piece as its own task and PR (each with its own tests and an independent review); approved PRs merge into ${p.autoMerge ?? p.base}${p.autoMerge ? ' by themselves' : ' when the person merges them'}.

GOAL:
${goal}

${autoGo(t) ? planningPrompt(`There is no discussion first: plan now. ${AUTO_GO_RULE}`) : `This is a DISCUSSION first. Read the code you need, then talk it through with the person: propose options and their trade-offs, say what you recommend, and ask the questions that change the answer. Do NOT write a \`\`\`plan block and do not lay out the full task plan yet: the person will tell you when to plan (they write "plan"). Keep replies short and in plain words.
Do not change any file.`}`, 'plan', 'start');
  return t;
}
// where one planned task stands (agents/plan.mjs progress())
function itemState(i) {
  if (!i.taskId || !existsSync(`${dir(i.taskId)}/task.json`)) return 'pending';
  const k = load(i.taskId);
  if (k.pr?.state === 'merged' || k.status === 'merged') return 'merged';
  if (k.pr?.state === 'closed' || k.status === 'stopped') return 'failed';
  if (running.has(k.id) || queue.some((j) => j.id === k.id)) return 'running';
  if (STUCK_STATUSES.includes(k.status) || (k.status === 'ready for you' && !k.mergeWanted)) return 'stuck';
  return 'running';
}
// the epic as the factory sees it now, for the coordinator: every task's state, what a stuck one waits on, its last words
function epicStatus(t) {
  const g = progress(t.plan, itemState);
  const blockedOn = Object.fromEntries(g.blocked.map((b) => [b.item.key, b.on]));
  return [`${g.merged}/${g.total} merged${g.stalled ? '; nothing can move' : ''}.`, ...[...t.plan].sort((a, b) => a.wave - b.wave).map((i) => {
    const k = i.taskId && existsSync(`${dir(i.taskId)}/task.json`) ? load(i.taskId) : null;
    const st = g.state[i.key];
    const parts = [`- ${i.key} (wave ${i.wave}): ${st}`];
    if (k) parts.push(`task ${k.id} "${k.status}"`);
    if (k?.pr) parts.push(`PR #${k.pr.number} ${k.pr.state ?? ''}`.trim());
    if (k?.waitingOn) parts.push(`waiting on: ${k.waitingOn}`);
    if (st === 'pending') parts.push(blockedOn[i.key] ? `blocked by ${blockedOn[i.key].join(', ')}` : `waits for ${i.deps.join(', ') || 'nothing'}`);
    let line = parts.join(' · ');
    if (k && ['stuck', 'failed'].includes(st)) { const last = messages(k.id).filter((m) => m.from !== 'you').at(-1); if (last) line += `\n    last from ${last.from}: ${last.text.replace(/\s+/g, ' ').slice(0, 500)}`; }
    return line;
  })].join('\n');
}
function startReady(t) {
  const g = progress(t.plan, itemState);
  if (!g.ready.length) return g;
  const goal = messages(t.id)[0]?.text ?? t.title;
  const byKey = Object.fromEntries(t.plan.map((i) => [i.key, i]));
  for (const i of g.ready) {
    const built = i.deps.map((d) => { const k = byKey[d].taskId ? load(byKey[d].taskId) : null; return `- ${byKey[d].title}${k?.pr ? ` (PR #${k.pr.number}, merged)` : ''}`; }).join('\n');
    const rk = i.researchKey && byKey[i.researchKey]?.taskId ? load(byKey[i.researchKey].taskId) : null;
    const handoff = i.researchKey ? `${researchHandoff({ doc: i.researchDoc, pr: rk?.pr, repo: t.repo })}\n\n` : '';
    const kid = createTask(t.project, `Part of epic ${t.id}, task "${i.key}" (wave ${i.wave}). The epic's goal, for context only (do just your task):\n${goal.slice(0, 2000)}\n\n${built ? `It builds on, already merged into ${t.base}:\n${built}\n\n` : ''}${handoff}YOUR TASK:\n${i.task}${refsLine(i, t.repo)}`, true, { parent: t.id, batch: t.id, title: i.title, ...(i.type ? { type: i.type } : {}) });
    i.taskId = kid.id;
  }
  update(t.id, (x) => { copyIssueFields(t.plan, x.plan ?? []); x.plan = t.plan; x.children = [...new Set([...(x.children ?? []), ...t.plan.filter((i) => i.taskId).map((i) => i.taskId)])]; });
  say(t.id, 'factory', `[factory] started ${g.ready.length}: ${g.ready.map((i) => `${i.title} (wave ${i.wave})`).join('; ')}. Everything each one depends on has merged.`);
  log('epic.start', { task: t.id, started: g.ready.map((i) => i.key) });
  return progress(t.plan, itemState);
}
const openingEpic = new Set(); // programs whose epic issue is being opened: no task starts before it is done
function approvePlan(t, text) {
  const r = parsePlan(text);
  if (r.error) { say(t.id, 'factory', `[factory] the plan can't start: ${r.error}. Asked the coordinator to fix it.`); enqueue(t.id, `[factory] Your plan block is invalid: ${r.error}. Send the corrected plan. ${PLAN_RULES}`, 'plan', 'person'); return; }
  t.plan = r.tasks; t.phase = 'run'; t.status = 'running'; t.stallNotice = null; save(t);
  const w = Math.max(...t.plan.map((i) => i.wave));
  say(t.id, 'factory', `[factory] plan approved: ${t.plan.length} tasks in ${w} wave${w === 1 ? '' : 's'}. Each starts as soon as what it depends on has merged.`);
  openingEpic.add(t.id);
  openEpicIssue({ gh, getToken: () => githubToken(t.repo), repo: t.repo, task: t, goal: messages(t.id)[0]?.text ?? t.title, onEpic: (e) => update(t.id, (x) => { x.epicIssue = e; }) })
    .then((res) => {
      if (res.message) say(t.id, 'factory', res.message);
      if (res.error) log('epic.issue.failed', { task: t.id, error: res.error });
      update(t.id, (x) => { if (t.epicIssue) x.epicIssue = t.epicIssue; copyIssueFields(x.plan ?? [], t.plan); });
    })
    .catch((e) => log('epic.issue.failed', { task: t.id, error: e.message }))
    .finally(() => {
      openingEpic.delete(t.id);
      try { if (!['stopped', 'paused', 'pausing', 'done'].includes(load(t.id).status)) { startReady(load(t.id)); pump(); } }
      catch (e) { log('epic.start.failed', { task: t.id, error: e.message }); }
    });
}
// Keeps the GitHub epic in step with the plan; only talks to GitHub when the
// states changed (hash on the task). Soft: a failure is logged, retried next pass.
const syncingEpic = new Set();
async function syncEpic(id, done = false) {
  if (syncingEpic.has(id) || openingEpic.has(id)) return;
  syncingEpic.add(id);
  try {
    const t = load(id);
    if (!t.epicIssue?.number || !Array.isArray(t.plan)) return;
    const states = Object.fromEntries(t.plan.map((i) => [i.key, itemState(i)]));
    if (!done && t.epicClosed && t.plan.every((i) => states[i.key] === 'merged')) done = true; // chat after PROGRAM DONE with no new work: stay closed
    const sent = new Set((t.epicDropped ?? []).map((p) => p.key)); // what this pass will close
    const r = await syncEpicIssue({ gh, getToken: () => githubToken(t.repo), repo: t.repo, task: t, states, goal: messages(id)[0]?.text ?? t.title, tasksUrl: `${DASHBOARD}/?task=${id}`, done });
    // saved either way: sub-issues opened before a failure must not be opened twice.
    // Only the dropped keys sent to GitHub are cleared, and only on success; a revision saved meanwhile keeps its own.
    update(id, (x) => { saveIssueFields(x.plan ?? [], t.plan); for (const k of ['epicSyncHash', 'epicClosed']) x[k] = t[k]; if (!r.error) x.epicDropped = (x.epicDropped ?? []).filter((p) => !sent.has(p.key)); });
    if (r.error) log('epic.sync.failed', { task: id, error: r.error }); else if (r.changed) log('epic.synced', { task: id });
  } catch (e) { log('epic.sync.failed', { task: id, error: e.message }); }
  finally { syncingEpic.delete(id); }
}
function afterCoordinator(t, mode, from, last, decision) {
  const o = coordinatorNext({ phase: t.phase, reply: last, decision });
  // auto-go: a valid plan with no question for the person starts at once
  if (o.status !== 'running' && t.phase === 'brief' && !decision && autoGo(t) && /```plan/.test(last ?? '')) {
    log('autogo.plan', { task: t.id });
    say(t.id, 'factory', '[factory] ▶️ auto-go: the plan starts now. Reply here to change it; tasks that started keep going.');
    approvePlan(t, last); return pump();
  }
  if (o.status !== 'running') { t.status = o.status; t.waitingOn = o.waitingOn; save(t); if (o.closeEpic) syncEpic(t.id, true); return pump(); }
  if (o.revise) { // a revision while it runs: what has started keeps going
    const r = parsePlan(last), m = r.error ? r : mergePlan(t.plan, r.tasks);
    if (m.error) say(t.id, 'factory', `[factory] the revised plan was not applied: ${m.error}. The current plan keeps going.`);
    else { t.epicDropped = [...(t.epicDropped ?? []), ...droppedWithIssues(t.plan, m.items)]; t.plan = m.items; t.stallNotice = null; t.finalCheck = false; say(t.id, 'factory', `[factory] plan revised: ${t.plan.length} tasks; started ones keep going.`); }
  }
  t.status = 'running'; save(t);
  if (!openingEpic.has(t.id)) { startReady(t); syncEpic(t.id); }
  pump();
}
// say once: a task merged (one line), a wave fully merged (what was built, what starts next).
// What was said is kept on the epic (mergedAnnounced, wavesAnnounced), so a restart repeats nothing.
function announceProgress(t) {
  const g = progress(t.plan, itemState);
  const link = (i) => { const k = i.taskId ? load(i.taskId) : null; return `${i.title}${k?.pr ? ` (${k.pr.url ?? `PR #${k.pr.number}`})` : ''}`; };
  const cur = load(t.id); // fresh from disk: what an overlapping poll just said counts too
  const r = announcements(t.plan, g, { merged: cur.mergedAnnounced, waves: cur.wavesAnnounced }, link);
  if (!r.lines.length) return;
  // remember first, then say: a crash in between loses a message rather than repeating one
  update(t.id, (x) => { x.mergedAnnounced = r.said.merged; x.wavesAnnounced = r.said.waves; });
  for (const l of r.lines) say(t.id, 'factory', l);
}
async function watchPrograms() {
  // a finished epic whose issue is still open: the close is retried until it works
  for (const t of allTasks().filter((x) => x.kind === 'program' && x.status === 'done' && x.epicIssue?.number && !x.epicClosed)) await syncEpic(t.id, true);
  for (const t of allTasks().filter((x) => x.kind === 'program' && x.phase === 'run' && Array.isArray(x.plan) && x.plan.length && !['done', 'stopped', 'decision needed'].includes(x.status))) {
    if (running.has(t.id) || queue.some((j) => j.id === t.id)) continue;
    for (const i of t.plan.filter((i) => i.taskId)) { // PR states can change on GitHub (merged, closed by hand)
      const k = load(i.taskId);
      if (k.pr?.state !== 'merged') { const pr = await findPr(k); if (pr && pr.state !== k.pr?.state) { k.pr = pr; if (pr.state === 'merged') k.status = 'merged'; save(k); } }
    }
    if (openingEpic.has(t.id)) continue;
    announceProgress(t);
    const g = startReady(t);
    await syncEpic(t.id);
    const status = g.done ? 'verifying' : g.stalled ? 'waiting for you' : `running · ${g.merged}/${g.total} merged`;
    if (t.status !== status) update(t.id, (x) => { x.status = status; x.waitingOn = g.stalled ? 'your help: no task of the epic can move (see the factory message above for which are stuck)' : undefined; });
    if (g.done && !t.finalCheck) {
      update(t.id, (x) => { x.finalCheck = true; });
      enqueue(t.id, `[factory] Every task of the epic has merged (${g.total}). Check what actually landed on ${t.base} (fetch it) against the epic's definition of done. If it is met, verify it and reply with a line "PROGRAM DONE" and the evidence. If something is missing, add the missing tasks: send the whole plan again (keep every key) with the new tasks. Do not change any file.`, 'plan', 'next-phase');
    } else if (g.stalled) {
      const key = JSON.stringify(Object.entries(g.state).sort());
      if (t.stallNotice !== key) {
        update(t.id, (x) => { x.stallNotice = key; });
        const line = (i) => { const k = i.taskId ? load(i.taskId) : null; return `- ${i.title}: ${g.state[i.key]}${k ? ` (${k.status}${k.pr ? ` · ${k.pr.url}` : ''})` : ''}`; };
        const stuck = t.plan.filter((i) => ['failed', 'stuck'].includes(g.state[i.key]));
        say(t.id, 'factory', `[factory] the epic is stuck: ${g.merged}/${g.total} merged, nothing can move.\n${stuck.map(line).join('\n')}\nBlocked behind them: ${g.blocked.map((b) => b.item.title).join(', ') || 'nothing'}.\nAnswer the stuck task in its own channel, or reply here to change the plan.`);
      }
    }
  }
}

// ---------- the conversation ----------
const newId = () => `${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${randomBytes(3).toString('hex')}`;
function createTask(project, text, auto, { attachments, ...extra } = {}) {
  const p = PROJECTS[project]; if (!p) throw new Error(`unknown project ${project}`);
  if (!text && !attachments?.length) throw new Error('empty task');
  const id = newId();
  mkdirSync(dir(id), { recursive: true });
  text = withAttachments(text, `${dir(id)}/workspace`, attachments).trim();
  const t = { id, project, repo: p.repo, base: p.base, kind: 'change', title: text.split('\n')[0].slice(0, 90), phase: auto ? 'run' : 'brief', auto, status: 'queued', factoryRounds: 0, createdAt: new Date().toISOString(), ...extra };
  save(t); say(id, 'you', text);
  if (t.kind === 'report') enqueue(id, reportPrompt(t, text), 'bypassPermissions', 'start');
  else if (auto && t.type === 'research') enqueue(id, researchPrompt(t, text), 'bypassPermissions', 'start');
  else if (auto) enqueue(id, runPrompt(t, text, 'Pre-approved: no brief, start now. First pick your playbook and write your definition of done as checks anyone can run; it goes in the PR description under "Done".'), 'bypassPermissions', 'start');
  else enqueue(id, `TASK ${id} in ${p.repo} (base ${p.base}).\n\n${text}\n\n${prTitleLine(t)}\n\nThis is the BRIEF. Read the code you need (and the repository's own rules: AGENTS.md, CLAUDE.md, .claude/skills, .agents/skills, if present). Reply with ONE message: your playbook, ${autoGo(t) ? 'your assumptions' : 'the questions you genuinely need answered (or "no questions")'}, your plan in a few lines, and the definition of done as checks anyone can run. Do not change any file.${autoGo(t) ? `\n\n${AUTO_GO_RULE}` : ''}`, 'plan', 'start');
  return t;
}
const runPrompt = (t, task, reply) => `${reply}\n\nNow RUN task ${t.id}: ${task}\n${prTitleLine(t)}\nYou are on branch agent/${t.id} in /workspace/repo (base ${t.base}). Work until your definition of done is met. Commit, push the branch, and open a PR into ${t.base} with \`gh pr create\` (title: the task in one line; body: Done / Decisions / Attention). ${hasChecks(t) ? 'Every push builds a preview and runs e2e; the results arrive here as [factory] messages. ' : ''}When it is done, an independent reviewer reads the PR; its findings arrive as [review] messages. Do not ask questions.`;
// a research task: the researcher writes docs/research/<slug>.md and opens a docs-only PR for discussion
const researchSlug = (text) => /Write (docs\/research\/[\w.-]+\.md)/.exec(text)?.[1] ?? `docs/research/${researchSlugOf(text)}.md`;
const researchSlugOf = (text) => (text.match(/Part of epic \S+, task "([\w-]+)"/)?.[1] ?? 'topic').replace(/-research$/, '');
const researchPrompt = (t, text) => `RESEARCH task ${t.id}: ${text}\n\nWrite ${researchSlug(text)} following your rules. ${prTitleLine(t)}\nYou are on branch agent/${t.id} in /workspace/repo (base ${t.base}). Commit only that file, push, and open a PR into ${t.base} with \`gh pr create\` (body: what the document answers, the recommendation, the open questions; no code in this PR).`;
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
  const t = load(id);
  if (from === 'you' && t.lastOptions?.length) { const x = expandNumberAnswer(text, t.lastOptions); if (x !== text) { text = x; delete t.lastOptions; save(t); } }
  say(id, from, text);
  if (from === 'factory') {
    const o = afterFactoryReport({ task: t, text, maxRounds: MAX_FACTORY_ROUNDS });
    if (o.action === 'ignore') return t;
    t.lastChecks = { state: o.green ? 'green' : 'red', sha: /\(`([0-9a-f]{7,40})`\)/.exec(text)?.[1] };
    if (o.action === 'limit') { say(id, 'factory', o.say); t.status = o.status; t.waitingOn = o.waitingOn; save(t); if (t.pr) publishReport(id, 'stopped').catch((e) => log('report.failed', { task: id, error: e.message })); return t; }
    if (o.green) { t.greenSha = o.greenSha; t.previewHost = o.previewHost; }
    else t.factoryRounds = o.factoryRounds;
    save(t);
    enqueue(id, text, 'bypassPermissions', o.green ? 'green' : 'factory');
    return t;
  }
  if (t.kind === 'program') {
    if (t.phase === 'talk') {
      talkReply(t, text, messages(id), { say, save, enqueue, planningPrompt, continuePrompt: (x) => `The person replied: ${x}\n\nContinue the discussion: answer, give options and trade-offs, ask what you still need. Still no \`\`\`plan block: the person will write "plan" when ready.` });
      return load(id);
    }
    if (t.phase === 'brief' && isGoCommand(text)) {
      const last = messages(id).filter((m) => m.from === 'coordinator').at(-1)?.text;
      if (/```plan/.test(last ?? '')) { approvePlan(t, last); return load(id); }
    }
    enqueue(id, `The person replied: ${text}\n\n${t.phase === 'run' && t.plan?.length ? `LIVE STATUS OF THE EPIC (from the factory, right now; this is the truth, use it, do not guess):\n${epicStatus(t)}\n\n` : ''}${t.phase === 'brief' ? `Revise the plan accordingly. ${PLAN_RULES}` : `Act on it. To change the plan, send the whole plan again: keep the keys of tasks that have started (they keep going whatever you write); tasks not started yet are replaced. ${PLAN_RULES} If the person only asked something, just answer, no plan block.`}`, 'plan', t.phase === 'brief' ? 'person' : 'next-phase');
    return t;
  }
  if (t.phase === 'brief') { t.phase = 'run'; save(t); enqueue(id, runPrompt(t, messages(id)[0].text, `The person answered your brief: ${text}`), 'bypassPermissions', 'person'); }
  else { const o = t.askedFrom; if (o) { delete t.askedFrom; save(t); } enqueue(id, text, 'bypassPermissions', 'person', o); }
  return t;
}

// ---------- which project is a message about? ----------
// A small one-shot Claude call (no repository, no tools) reads the person's
// words against each project's "about" and names one project, or says unsure.
// Callers ask the person whenever it is unsure or fails.
// one-shot haiku call in a throwaway container (no repo, no tools): the model's text
async function oneShot(prompt, timeoutMs = 90000, model = CLASSIFY_MODEL) {
  const args = ['run', '--rm', '--network', NETWORK, '--memory', '1g', '--cpus', '1', '--security-opt', 'no-new-privileges:true', '-e', 'CLAUDE_CODE_OAUTH_TOKEN',
    ...(RUNTIME ? ['--runtime', RUNTIME] : []), IMAGE, 'claude', '-p', prompt, '--model', model, '--max-turns', '1', '--output-format', 'json', '--disallowedTools', 'Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task'];
  const out = await new Promise((resolve) => {
    const child = spawn('docker', args, { env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: secret('claude-token') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = ''; child.stdout.on('data', (c) => { buf += c; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', () => { clearTimeout(timer); resolve(buf); });
  });
  try { return JSON.parse(out).result ?? ''; } catch { throw new Error('the one-shot call gave no answer'); }
}
// the factory's naming standard: a type and a few words. Channels are
// <type>-<title> (pr-<N>-<type>-<title> once the PR opens); PR titles are
// conventional commits, <prefix>(<scope>): <summary>
export const TASK_TYPES = ['feature', 'fix', 'hotfix', 'refactor', 'perf', 'design', 'test', 'docs', 'ci', 'chore', 'research', 'epic'];
const PR_PREFIX = { feature: 'feat', design: 'feat', research: 'docs' };
const cleanType = (x) => (TASK_TYPES.includes(String(x ?? '').toLowerCase()) ? String(x).toLowerCase() : undefined);
const cleanTitle = (x) => { const s = String(x ?? '').replace(/[\r\n`*_#<>]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60); return s || undefined; };
const named = (b) => Object.fromEntries(Object.entries({ type: cleanType(b.type), title: cleanTitle(b.title) }).filter(([, v]) => v));
const prTitleLine = (t) => `PR title: \`${PR_PREFIX[t.type] ?? t.type ?? '<type>'}(<scope>): <what changes, under 70 chars>\` (conventional commits${t.type ? `; this task is a ${t.type}` : ': feat, fix, hotfix, refactor, perf, test, docs, ci or chore'}; scope is the area, e.g. profile).`;

async function classify(text) {
  const names = Object.keys(PROJECTS);
  const prompt = `Projects:\n${names.map((n) => `- ${n}: ${PROJECTS[n].about ?? PROJECTS[n].repo}`).join('\n')}\n\nMessage from the founder:\n"""\n${text.slice(0, 4000)}\n"""\n\nWhich project is this message about, what kind of work is it, and what is it in a few words? Answer with ONE line of JSON and nothing else: {"project": "<one of: ${names.join(', ')}>" or null if it could fit more than one or none, "why": "<at most 12 words>", "type": "<one of: ${TASK_TYPES.join(', ')}>", "title": "<3 to 6 plain words naming the main thing, e.g. profile crop screen>"}. Pick a project only when the message clearly points to it. type is epic only when the message asks for a large multi-part effort or says epic; hotfix only for something broken in production that needs fixing now.`;
  let result = ''; try { result = await oneShot(prompt); } catch { return { project: null, why: 'classifier gave no answer' }; }
  const j = /\{[^{}]*\}/.exec(result); let ans = {}; try { ans = JSON.parse(j?.[0] ?? '{}'); } catch {}
  const project = names.includes(ans.project) ? ans.project : null;
  log('classify', { project, why: ans.why });
  return { project, why: String(ans.why ?? '').slice(0, 200), ...named(ans) };
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
    waiting: by(['waiting for you', 'waiting for merges', 'research review']).map(brief),
    moving: recent.filter((t) => running.has(t.id) || ['queued', 'working', 'briefing', 'planning', 'testing', 'reviewing', 'waiting for checks'].includes(t.status) || /^running|^verifying/.test(t.status)).map(brief),
    finished: by(['done']).map(brief),
    merged: recent.filter((t) => t.pr?.state === 'merged').map(brief),
    stopped: by(['stopped', 'paused']).map(brief),
    costUsd: recent.reduce((s, t) => s + (t.costUsd ?? 0), 0),
  };
}

// ---------- http ----------
const authOk = (req) => { const h = req.headers.authorization ?? ''; const want = `Bearer ${secret('api-token')}`; return h.length === want.length && timingSafeEqual(Buffer.from(h), Buffer.from(want)); };
async function body(req) { let b = ''; for await (const c of req) { b += c; if (b.length > MAX_BODY_BYTES) throw new Error('body too large'); } return b ? JSON.parse(b) : {}; }
const mcp = createMcp({ token: () => secret('api-token'), listTasks: allTasks, getTask: (id) => existsSync(`${dir(id)}/task.json`) ? load(id) : null, isRunning: (id) => running.has(id), messages, projects: () => Object.entries(PROJECTS).map(([name, p]) => ({ name, ...p })), startTask: (p, text, auto) => createTask(p, text, auto), startEpic: (p, goal) => createProgram(p, goal), reply: (id, text) => post(id, 'you', text), audit: (a) => log('mcp.call', a) });
const handler = async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/health') return send(200, { ok: true, running: running.size, queued: queue.length });
    if (url.pathname === '/mcp') return mcp(req, res);
    if (!authOk(req)) return send(401, { error: 'unauthorized' });
    if (url.pathname === '/digest' && req.method === 'GET') return send(200, await digest(Number(url.searchParams.get('hours') ?? 24)));
    // names and repos only: never the GitHub App ids or key files
    if (url.pathname === '/projects' && req.method === 'GET') return send(200, Object.entries(PROJECTS).map(([name, p]) => ({ name, about: p.about ?? '', repo: p.repo, base: p.base, autoMerge: p.autoMerge ?? null, loops: p.loops ?? null })));
    // the one setting the person may change from Slack: a project's improvement loops (validated; saved with a backup; live at once)
    const lm = url.pathname.match(/^\/projects\/([\w-]+)\/loops$/);
    if (lm && req.method === 'POST') { const b = await body(req); return send(200, setLoops(lm[1], b.loops)); }
    if (url.pathname === '/notices' && req.method === 'GET') return send(200, readJson(LOOPS_FILE, {}).notices ?? []);
    if (url.pathname === '/notices/ack' && req.method === 'POST') { const b = await body(req); const f = readJson(LOOPS_FILE, {}); f.notices = (f.notices ?? []).filter((n) => !(b.ids ?? []).includes(n.id)); writeFileSync(LOOPS_FILE, JSON.stringify(f, null, 1)); return send(200, { ok: true }); }
    if (url.pathname === '/classify' && req.method === 'POST') { const b = await body(req); return send(200, await classify(String(b.text ?? ''))); }
    if (url.pathname === '/programs' && req.method === 'POST') { const b = await body(req); return send(201, createProgram(b.project, String(b.goal ?? '').trim(), b.attachments, named(b))); }
    // a batch: independent tasks, each run without a brief to a reviewed PR
    if (url.pathname === '/batches' && req.method === 'POST') {
      const b = await body(req);
      // an item is its text, or { text, type, title } (the Slack bot names each one)
      const items = (Array.isArray(b.items) ? b.items : []).map((x) => (typeof x === 'object' && x ? { text: String(x.text ?? '').trim(), ...named(x) } : { text: String(x).trim() })).filter((x) => x.text);
      if (!items.length) return send(400, { error: 'no items' });
      if (items.length > 20) return send(400, { error: 'at most 20 items in a batch' });
      const batch = `b${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${randomBytes(2).toString('hex')}`;
      return send(201, { batch, tasks: items.map(({ text, ...nm }) => createTask(b.project, text, true, { batch, ...nm })) });
    }
    // a task's screenshots and videos (workspace/screens, workspace/videos), for the
    // Slack bot to post: the list, or one file. Only files mediaFiles lists are
    // served (no symlinks, no paths outside the two folders).
    const mm = url.pathname.match(/^\/tasks\/([\w-]+)\/media(?:\/(screens|videos)\/(.+))?$/);
    if (mm && req.method === 'GET') {
      const [, mid, msub, mrel] = mm, files = mediaFiles(`${dir(mid)}/workspace`);
      if (!msub) return send(200, files.map((f) => ({ sub: f.sub, rel: f.rel, mtime: f.mtime, video: f.video, bytes: statSync(f.path).size })));
      const f = files.find((x) => x.sub === msub && x.rel === decodeURIComponent(mrel));
      if (!f) return send(404, { error: 'no such file' });
      const buf = readFileSync(f.path);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buf.length }); return res.end(buf);
    }
    const m = url.pathname.match(/^\/tasks(?:\/([\w-]+))?(?:\/(messages|stop|pause))?$/);
    if (!m) return send(404, { error: 'not found' });
    const [, id, sub] = m;
    if (!id && req.method === 'GET') return send(200, allTasks().map((t) => ({ ...t, running: running.has(t.id), lastActivity: running.has(t.id) ? activity(t.id, 1)[0] ?? null : null, lastAgent: lastJsonLine(`${dir(t.id)}/messages.jsonl`, (m) => ['agent', 'coordinator'].includes(m.from))?.text ?? '' })));
    if (!id && req.method === 'POST') {
      const b = await body(req); const text = String(b.text ?? '').trim();
      if (b.kind === 'report') return send(201, createTask(b.project, text, true, { kind: 'report', title: `bug: ${text.split('\n')[0] || 'see the attached image'}`.slice(0, 90), attachments: b.attachments }));
      return send(201, createTask(b.project, text, !!b.auto, { attachments: b.attachments, ...named(b) }));
    }
    if (!existsSync(`${dir(id)}/task.json`)) return send(404, { error: 'no such task' });
    if (!sub && req.method === 'GET') return send(200, { ...load(id), running: running.has(id), messages: messages(id), activity: activity(id), decisions: decisions(id) });
    if (sub === 'messages' && req.method === 'POST') { const b = await body(req); const from = b.from === 'factory' ? 'factory' : 'you'; return send(200, post(id, from, from === 'you' ? withAttachments(String(b.text ?? '').trim(), `${dir(id)}/workspace`, b.attachments).trim() : String(b.text ?? '').trim())); }
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
      } else { update(id, (x) => { x.status = 'paused'; x.waitingOn = 'your reply to resume the task'; }); say(id, 'factory', '[factory] paused. Reply to resume.'); }
      return send(200, load(id));
    }
    return send(405, { error: 'method not allowed' });
  } catch (e) { log('http.error', { error: e.message }); return send(400, { error: e.message }); }
};
for (const a of BIND) createServer(handler).listen(PORT, a, () => log('listening', { address: a, port: PORT, image: IMAGE, network: NETWORK, runtime: RUNTIME || 'runc', reviewPanel: REVIEW_PANEL.map((r) => `${r.model}:${r.focus}`), autoMerge: Object.fromEntries(Object.entries(PROJECTS).map(([k, v]) => [k, v.autoMerge ?? null])), labels: [INTAKE_LABEL, TRIAGE_LABEL] }));
// ---------- drain (decisions in drain.mjs): SIGTERM = finish the running turns, then exit ----------
// startup: containers left by a node that died without draining are orphans (their client is gone, nothing reads
// their output): kill them; their tasks still carry a job, so pickup() below runs them again.
{
  const ps = spawnSync('docker', ['ps', '-q', '--filter', 'name=^fa-'], { encoding: 'utf8' });
  const orphans = (ps.stdout ?? '').split('\n').filter(Boolean);
  if (orphans.length) { spawnSync('docker', ['kill', ...orphans], { stdio: 'ignore' }); log('orphans.killed', { containers: orphans }); }
  const rec = readJson(DRAIN_FILE, null);
  if (rec) {
    const plan = startupPlan(rec, Object.fromEntries(allTasks().map((t) => [t.id, t])));
    for (const n of plan.notices) if (existsSync(dir(n.id))) say(n.id, 'factory', n.text, { ping: true });
    log('drain.recovered', { cutOff: rec.cutOff.map((c) => c.id), requeue: plan.requeue });
    unlinkSync(DRAIN_FILE);
  }
}
pickup();
// ---------- the stuck doctor (decisions in doctor.mjs): a task that gave up, or that the watchdog
// escalated, gets one diagnosis from its history: cause, evidence, fix, who acts. Diagnosis only.
const DOCTOR_MODEL = process.env.DOCTOR_MODEL ?? 'sonnet';
let doctoring = null;
async function doctorSweep() {
  if (doctoring || drain.draining) return;
  const t = allTasks().find((x) => needsDoctor(x));
  if (!t) return;
  const key = needsDoctor(t);
  update(t.id, (x) => { x.doctorKey = key; }); // marked first: a failed diagnosis is not retried in a loop
  doctoring = t.id;
  try {
    const rows = decisions(t.id).map((r) => Object.values(r).join('\t')).join('\n');
    const out = await oneShot(doctorPrompt(t, messages(t.id), rows), 180000, DOCTOR_MODEL);
    const d = parseDiagnosis(out);
    say(t.id, 'factory', doctorMessage(d), { ping: true, doctor: true });
    log('doctor.done', { task: t.id, category: d?.category ?? null, who: d?.who ?? null });
  } catch (e) { log('doctor.failed', { task: t.id, error: e.message }); }
  finally { doctoring = null; }
}

// ---------- improvement loops (decisions in loops.mjs): due loops start a normal task; reminders wait for the Slack bot ----------
function setLoops(name, input) {
  if (!Object.hasOwn(PROJECTS, name)) throw new Error(`unknown project ${name}`);
  const loops = normalizeLoops(input);
  const disk = JSON.parse(readFileSync(PROJECTS_FILE, 'utf8'));
  if (!Object.hasOwn(disk, name)) throw new Error(`${name} is not in ${PROJECTS_FILE}`);
  writeFileSync(`${PROJECTS_FILE}.bak`, JSON.stringify(disk, null, 2));
  disk[name].loops = loops;
  writeFileSync(`${PROJECTS_FILE}.tmp`, JSON.stringify(disk, null, 2)); renameSync(`${PROJECTS_FILE}.tmp`, PROJECTS_FILE);
  PROJECTS[name].loops = loops; // live without a restart
  const f = readJson(LOOPS_FILE, {}); if (f.notices?.length) { f.notices = f.notices.filter((n) => n.project !== name); writeFileSync(LOOPS_FILE, JSON.stringify(f, null, 2)); }
  log('loops.set', { project: name, loops });
  return { name, loops };
}
const LOOPS_FILE = `${HOME}/loops.json`; // { state: { <project>: { lastStarted, lastReminder } }, notices: [{ id, project, text, at }] }
async function loopsTick(now = Date.now()) {
  const file = readJson(LOOPS_FILE, {}); file.state ??= {}; file.notices ??= [];
  // a loop PR merged or closed by hand frees the cap: refresh the PR state of open loop tasks
  for (const t of allTasks().filter((x) => isOpenLoop(x) && x.pr)) {
    const pr = await findPr(t);
    if (pr && pr.state !== t.pr.state) update(t.id, (x) => { x.pr = pr; if (pr.state === 'merged') x.status = 'merged'; });
  }
  const tasks = allTasks();
  for (const [name, project] of Object.entries(PROJECTS)) {
    const st = file.state[name] ?? {};
    const d = loopDecision({ name, project, state: st, openLoops: openLoopTasks(tasks, name), now });
    if (d.action === 'remind') {
      file.notices.push({ id: `loops-${name}-${now}`, project: name, text: d.text, at: new Date(now).toISOString() });
      file.state[name] = afterRemind(st, now); log('loops.remind', { project: name });
    } else if (d.action === 'start') {
      file.state[name] = afterStart(st, d.kind, now); // marked first: a failed start is not retried every tick
      writeFileSync(LOOPS_FILE, JSON.stringify(file, null, 1));
      const t = createTask(name, loopTaskText(d.kind, name), true, { loop: d.kind, title: `loop(${d.kind}): ${name}` });
      log('loops.start', { project: name, kind: d.kind, task: t.id });
    }
  }
  writeFileSync(LOOPS_FILE, JSON.stringify(file, null, 1));
}
const poll = () => drain.draining ? Promise.resolve() : intake().catch((e) => log('intake.failed', { error: e.message }))
  .then(() => retryMerges()).catch((e) => log('merge.failed', { error: e.message }))
  .then(() => watchPrograms()).catch((e) => log('programs.failed', { error: e.message }))
  .then(() => loopsTick()).catch((e) => log('loops.failed', { error: e.message }))
  .then(() => { doctorSweep(); }); // in the background: a diagnosis takes a minute, the poll does not wait
// ---------- the stall watchdog: one nudge, then a ping (decision in watchdog.mjs) ----------
const WATCHDOG_EVERY_S = Number(process.env.WATCHDOG_EVERY_S ?? 60);
const NUDGE_PROMPT = '[factory] Nudge: the factory saw no progress on this task for a while. Check `git status`, your decision log, your PR and its checks, then carry on with what you were doing. If you are blocked, say exactly on what.';
function watchdog(now = Date.now()) {
  if (drain.draining) return;
  for (const t of allTasks()) {
    const act = `${dir(t.id)}/activity.log`;
    const d = watchdogDecision(t, { now, running: running.has(t.id), anyRunning: running.size > 0, inQueue: queue.some((j) => j.id === t.id), slotsFull: running.size >= MAX_PARALLEL, lastActivityAt: existsSync(act) ? statSync(act).mtime.toISOString() : undefined });
    if (d.action === 'none') continue;
    log(`watchdog.${d.action}`, { task: t.id, state: d.state, idleMin: d.idleMin });
    if (d.action === 'escalate') {
      update(t.id, (x) => { x.watchEscalatedAt = new Date(now).toISOString(); });
      say(t.id, 'factory', d.text, { ping: true });
      continue;
    }
    update(t.id, (x) => { x.watchNudgedAt = new Date(now).toISOString(); x.watchState = d.state; });
    say(t.id, 'factory', d.text);
    if (running.has(t.id) || queue.some((j) => j.id === t.id)) continue; // a live job is the nudge's target already; the grace period tells whether it moves
    if (d.state === 'queued') pump();
    else if (d.state === 'reviewing') enqueueReview(t.id, 'nudge');
    else if (d.state === 'testing') enqueueQaFrom(t.id, 'nudge');
    else enqueue(t.id, NUDGE_PROMPT, d.state === 'planning' || d.state === 'briefing' ? 'plan' : 'bypassPermissions', 'nudge', t.job?.origin ?? t.job?.from); // keeps a review fix a review fix
  }
}
setInterval(() => { try { watchdog(); } catch (e) { log('watchdog.failed', { error: e.message }); } }, WATCHDOG_EVERY_S * 1000);

setTimeout(poll, 15000);
setInterval(poll, POLL_EVERY_S * 1000);
