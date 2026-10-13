// factory-agents: one task = one conversation with Claude Code, run headless in
// a locked-down container. Brief (read-only, asks once) -> Run (no questions,
// pushes agent/<task>, opens a PR) -> Checks ([factory] reports drive it until
// green) -> Review (a fresh reviewer that did not write the code: PASS = ready
// for you, CHANGES = back to the agent). Tasks also arrive by themselves from
// issues labelled ready-for-agent, and in batches (a queue of independent
// tasks). Loopback + one bridge address only; every call needs the API token.
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
const REVIEW_MODEL = process.env.REVIEW_MODEL ?? 'opus';
const INTAKE_LABEL = process.env.INTAKE_LABEL ?? 'ready-for-agent';
const INTAKE_EVERY_S = Number(process.env.INTAKE_EVERY_S ?? 120);
const PROJECTS = JSON.parse(readFileSync(new URL('./projects.json', import.meta.url), 'utf8'));

const RULES = `You are a factory agent working unattended. No person is watching.
Follow the repository's factory-rules skill if it has one (.claude/skills/factory-rules). In any case:
- Never block on the human. Decide reversible things yourself and log each non-obvious decision in the PR under "Decisions".
- Pause for the person only for a decision that is expensive to undo later: architecture (data model, a new service or dependency, a public API or URL shape), money, security, or a real product or taste call no experiment can settle. Then end your reply with a block whose first line is exactly "DECISION NEEDED", followed by the options, the trade-off of each, and your recommendation. Everything else you decide yourself.
- Also stop (with a written reason, no DECISION NEEDED) before an irreversible action or at a genuine dead end after real attempts.
- Messages starting with [factory] are automated reports about your PR's preview and e2e: act on them, never ask about them.
- Messages starting with [review] come from an independent reviewer who read your PR: fix what is right and push; for what you reject, say why in the PR under "Decisions".
- Never merge. Never touch production. Never print secrets.`;

const REVIEW_RULES = `You are an independent code reviewer in the factory. You did not write this change and you owe its author nothing: find what is wrong before a person spends time on it.
- Never change, create or delete a file, never commit, never switch branches. You have no GitHub credentials; work from the checkout.
- Report only real problems (wrong behaviour, missing parts of the task, bugs, security, data loss, a missing or toothless test, breaking the repository's own rules). No style nits.
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
const allTasks = () => readdirSync(`${HOME}/tasks`).filter((d) => existsSync(`${dir(d)}/task.json`)).map(load).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

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

// ---------- one Claude Code run in a container ----------
const running = new Map();   // task id -> child process (docker run client)
const containers = new Map(); // task id -> container name
const queue = [];            // { id, kind: 'agent' | 'review', prompt?, mode?, from? }
function enqueue(id, prompt, mode, from) { queue.push({ id, kind: 'agent', prompt, mode, from }); pump(); }
function enqueueReview(id) { if (!queue.some((j) => j.id === id && j.kind === 'review')) queue.push({ id, kind: 'review' }); pump(); }
function pump() {
  while (running.size < MAX_PARALLEL && queue.length) {
    const i = queue.findIndex((j) => !running.has(j.id));
    if (i < 0) break;
    const [job] = queue.splice(i, 1);
    (job.kind === 'review' ? review(job) : agentRun(job)).catch((e) => {
      running.delete(job.id); containers.delete(job.id);
      log('run.crashed', { task: job.id, kind: job.kind, error: e.message });
      say(job.id, 'factory', `[factory] the ${job.kind === 'review' ? 'reviewer' : 'agent'} could not run: ${e.message}`);
      update(job.id, (t) => { t.status = 'waiting for you'; });
      pump();
    });
  }
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
      if (ev.session_id) sessionId = ev.session_id;
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
  const t = update(id, (x) => { x.status = mode === 'plan' ? 'briefing' : 'working'; });
  const r = await container(id, { prompt, mode, claudeDir: 'claude', ghToken: await githubToken(t.repo), system: RULES, disallowed: ['AskUserQuestion'], resume: t.sessionId });
  if (r.last) say(id, 'agent', r.last);
  else say(id, 'factory', `[factory] the agent stopped without a reply. ${r.stderr.trim().slice(-400)}`);
  const done = load(id);
  if (r.sessionId && !done.sessionId) done.sessionId = r.sessionId;
  if (done.status === 'stopped') { save(done); return pump(); }
  done.pr = (await findPr(done)) ?? done.pr ?? null;
  const head = done.pr?.state === 'open' ? done.pr.head : null;
  let next = 'waiting for you';
  if (mode === 'plan') next = 'waiting for you';
  else if (/^\s*DECISION NEEDED\b/m.test(r.last)) next = 'decision needed';
  else if (!head) next = 'waiting for you';
  else if (head === done.reviewedSha) next = done.verdict === 'PASS' ? 'ready for you' : 'waiting for you'; // nothing new since the review
  else if (!hasChecks(done) || (done.greenSha && head.startsWith(done.greenSha))) next = 'reviewing';
  else next = 'waiting for checks';
  done.status = next; save(done);
  log('run.end', { task: id, mode, from, pr: done.pr?.number ?? null, status: next });
  if (next === 'reviewing') enqueueReview(id);
  pump();
}

// a fresh session (own Claude state, no resume, no GitHub token, no edit tools) judges the PR
async function review({ id }) {
  const t = update(id, (x) => { x.status = 'reviewing'; });
  const token = await githubToken(t.repo);
  const pr = await gh(token, `/repos/${t.repo}/pulls/${t.pr.number}`);
  const msgs = messages(id);
  const brief = t.auto ? null : msgs.find((m) => m.from === 'agent')?.text;
  const n = (t.reviews ?? 0) + 1;
  const prompt = `Review PR #${pr.number} of ${t.repo} (factory task ${id}, branch agent/${id} into ${t.base}). This is review round ${n}.

THE TASK, as the person gave it:
${msgs[0]?.text ?? t.title}
${brief ? `\nTHE AGENT'S BRIEF (its plan and definition of done):\n${brief}\n` : ''}
THE PR: ${pr.title}
${(pr.body ?? '').slice(0, 20000)}

The checkout in /workspace/repo is at the PR head (${pr.head.sha.slice(0, 7)}). See the change with \`git diff origin/${t.base}...HEAD\` and \`git log origin/${t.base}..HEAD\`; read the surrounding code and the repository's own rules (AGENTS.md, CLAUDE.md, .claude/skills, .agents/skills).
Check: (1) does it do everything the task asked, and nothing unrelated; (2) is every item of the definition of done backed by evidence; (3) bugs: edge cases, errors, security, data loss, races; (4) is new behaviour covered by a test that would fail without the change; (5) does it break the repository's rules.
Reply with your findings (file:line, why it matters, the fix), then the verdict line.`;
  const r = await container(id, { prompt, mode: 'bypassPermissions', claudeDir: `review-claude/${n}`, ghToken: '', system: REVIEW_RULES, model: REVIEW_MODEL, disallowed: ['AskUserQuestion', 'Edit', 'Write', 'NotebookEdit'] });
  const verdict = /VERDICT:\s*(PASS|CHANGES)/i.exec(r.last)?.[1]?.toUpperCase() ?? null;
  say(id, 'review', r.last || `the reviewer gave no answer. ${r.stderr.trim().slice(-400)}`);
  gh(token, `/repos/${t.repo}/issues/${pr.number}/comments`, 'POST', { body: `**Independent review ${n}** (${REVIEW_MODEL}, fresh session, read-only) at \`${pr.head.sha.slice(0, 7)}\`\n\n${(r.last || 'no answer').slice(0, 60000)}` })
    .catch((e) => log('review.comment_failed', { task: id, error: e.message }));
  const x = load(id);
  x.reviews = n; x.reviewedSha = pr.head.sha; x.verdict = verdict;
  if (x.status === 'stopped') { save(x); return pump(); }
  if (verdict === 'PASS') { x.status = 'ready for you'; save(x); }
  else if (verdict === 'CHANGES' && x.factoryRounds < MAX_FACTORY_ROUNDS) {
    x.factoryRounds += 1; x.status = 'working'; save(x);
    enqueue(id, `[review] An independent reviewer read your PR at ${pr.head.sha.slice(0, 7)} and asks for changes:\n\n${r.last}`, 'bypassPermissions', 'review');
  } else {
    x.status = 'waiting for you'; save(x);
    if (verdict === 'CHANGES') say(id, 'factory', `[factory] round limit (${MAX_FACTORY_ROUNDS}) reached with review findings open: stopped. A person decides what next.`);
  }
  log('review.end', { task: id, round: n, verdict });
  pump();
}

// ---------- the conversation ----------
function createTask(project, text, auto, extra = {}) {
  const p = PROJECTS[project]; if (!p) throw new Error(`unknown project ${project}`);
  if (!text) throw new Error('empty task');
  const id = `${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${randomBytes(3).toString('hex')}`;
  mkdirSync(dir(id), { recursive: true });
  const t = { id, project, repo: p.repo, base: p.base, title: text.split('\n')[0].slice(0, 90), phase: auto ? 'run' : 'brief', auto, status: 'queued', factoryRounds: 0, createdAt: new Date().toISOString(), ...extra };
  save(t); say(id, 'you', text);
  if (auto) enqueue(id, runPrompt(t, text, 'Pre-approved: no brief, start now. First write your definition of done as checks anyone can run; it goes in the PR description under "Done".'), 'bypassPermissions', 'start');
  else enqueue(id, `TASK ${id} in ${p.repo} (base ${p.base}).\n\n${text}\n\nThis is the BRIEF. Read the code you need (and .claude/skills/factory-rules, .agents/skills/verify-contentcoach if present). Reply with ONE message: the questions you genuinely need answered (or "no questions"), your plan in a few lines, and the definition of done as checks anyone can run. Do not change any file.`, 'plan', 'start');
  return t;
}
const runPrompt = (t, task, reply) => `${reply}\n\nNow RUN task ${t.id}: ${task}\nYou are on branch agent/${t.id} in /workspace/repo (base ${t.base}). Work until your definition of done is met. Commit, push the branch, and open a PR into ${t.base} with \`gh pr create\` (title: the task in one line; body: Done / Decisions / Attention). ${hasChecks(t) ? 'Every push builds a preview and runs e2e; the results arrive here as [factory] messages. ' : ''}When it is done, an independent reviewer reads the PR; its findings arrive as [review] messages. Do not ask questions.`;
function post(id, from, text) {
  const t = load(id); say(id, from, text);
  if (from === 'factory') {
    if (t.phase !== 'run' || t.status === 'stopped') return t;
    if (t.factoryRounds >= MAX_FACTORY_ROUNDS) { say(id, 'factory', `[factory] round limit (${MAX_FACTORY_ROUNDS}) reached: stopped. A person decides what next.`); t.status = 'waiting for you'; save(t); return t; }
    const green = text.includes('✅') && /\(`([0-9a-f]{7,40})`\)/.exec(text)?.[1];
    if (green) t.greenSha = green;
    t.factoryRounds += 1; save(t);
    enqueue(id, text, 'bypassPermissions', green ? 'green' : 'factory');
    return t;
  }
  if (t.phase === 'brief') { t.phase = 'run'; save(t); enqueue(id, runPrompt(t, messages(id)[0].text, `The person answered your brief: ${text}`), 'bypassPermissions', 'person'); }
  else enqueue(id, text, 'bypassPermissions', 'person');
  return t;
}

// ---------- intake: issues labelled ready-for-agent become tasks by themselves ----------
const INTAKE_FILE = `${HOME}/intake.json`;
async function intake() {
  const seen = existsSync(INTAKE_FILE) ? JSON.parse(readFileSync(INTAKE_FILE, 'utf8')) : {};
  for (const [project, p] of Object.entries(PROJECTS)) {
    try {
      const token = await githubToken(p.repo);
      const issues = await gh(token, `/repos/${p.repo}/issues?state=open&labels=${encodeURIComponent(INTAKE_LABEL)}&per_page=20&sort=created&direction=asc`);
      for (const is of issues) {
        const key = `${p.repo}#${is.number}`;
        if (is.pull_request || seen[key]) continue;
        const text = `GitHub issue #${is.number}: ${is.title}\n\n${(is.body ?? '').slice(0, 20000)}\n\n${is.html_url}\nIn the PR description write "Refs #${is.number}" (not "Closes"); a person closes the issue after the merge.`;
        const t = createTask(project, text, true, { issue: { number: is.number, url: is.html_url } });
        seen[key] = t.id; writeFileSync(INTAKE_FILE, JSON.stringify(seen, null, 1));
        log('intake.task', { repo: p.repo, issue: is.number, task: t.id });
        gh(token, `/repos/${p.repo}/issues/${is.number}/comments`, 'POST', { body: `Factory task \`${t.id}\` picked this up (label \`${INTAKE_LABEL}\`). Its PR will say "Refs #${is.number}".` })
          .catch((e) => log('intake.comment_failed', { repo: p.repo, issue: is.number, error: e.message }));
      }
    } catch (e) { log('intake.failed', { repo: p.repo, error: e.message }); }
  }
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
    // a batch: independent tasks, each run without a brief to a reviewed PR
    if (url.pathname === '/batches' && req.method === 'POST') {
      const b = await body(req);
      const items = (Array.isArray(b.items) ? b.items : []).map((s) => String(s).trim()).filter(Boolean);
      if (!items.length) return send(400, { error: 'no items' });
      if (items.length > 20) return send(400, { error: 'at most 20 items in a batch' });
      const batch = `b${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${randomBytes(2).toString('hex')}`;
      return send(201, { batch, tasks: items.map((text) => createTask(b.project, text, true, { batch })) });
    }
    const m = url.pathname.match(/^\/tasks(?:\/([\w-]+))?(?:\/(messages|stop))?$/);
    if (!m) return send(404, { error: 'not found' });
    const [, id, sub] = m;
    if (!id && req.method === 'GET') return send(200, allTasks().map((t) => ({ ...t, running: running.has(t.id), lastActivity: running.has(t.id) ? activity(t.id, 1)[0] ?? null : null, lastAgent: messages(t.id).filter((m) => m.from === 'agent').at(-1)?.text ?? '' })));
    if (!id && req.method === 'POST') { const b = await body(req); return send(201, createTask(b.project, String(b.text ?? '').trim(), !!b.auto)); }
    if (!existsSync(`${dir(id)}/task.json`)) return send(404, { error: 'no such task' });
    if (!sub && req.method === 'GET') return send(200, { ...load(id), running: running.has(id), messages: messages(id), activity: activity(id) });
    if (sub === 'messages' && req.method === 'POST') { const b = await body(req); return send(200, post(id, b.from === 'factory' ? 'factory' : 'you', String(b.text ?? '').trim())); }
    if (sub === 'stop' && req.method === 'POST') {
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].id === id) queue.splice(i, 1);
      if (containers.has(id)) spawn('docker', ['kill', containers.get(id)], { stdio: 'ignore' });
      running.get(id)?.kill('SIGTERM');
      const t = update(id, (x) => { x.status = 'stopped'; }); say(id, 'factory', '[factory] stopped by you.'); return send(200, t);
    }
    return send(405, { error: 'method not allowed' });
  } catch (e) { log('http.error', { error: e.message }); return send(400, { error: e.message }); }
};
for (const a of BIND) createServer(handler).listen(PORT, a, () => log('listening', { address: a, port: PORT, image: IMAGE, network: NETWORK, runtime: RUNTIME || 'runc', reviewModel: REVIEW_MODEL, intakeLabel: INTAKE_LABEL }));
setTimeout(() => intake().catch((e) => log('intake.failed', { error: e.message })), 15000);
setInterval(() => intake().catch((e) => log('intake.failed', { error: e.message })), INTAKE_EVERY_S * 1000);
