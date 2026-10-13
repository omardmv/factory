// factory-agents: one task = one conversation with Claude Code, run headless in
// a locked-down container. Brief (read-only, asks once) -> Run (no questions,
// pushes agent/<task>, opens a PR) -> Review ([factory] reports drive it until
// green). Loopback + one bridge address only; every call needs the API token.
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
const PROJECTS = JSON.parse(readFileSync(new URL('./projects.json', import.meta.url), 'utf8'));

const RULES = `You are a factory agent working unattended. No person is watching.
Follow the repository's factory-rules skill if it has one (.claude/skills/factory-rules). In any case:
- Never block on the human. Decide reversible things yourself and log each non-obvious decision in the PR under "Decisions".
- Stop only for an irreversible action, a real product call no experiment can settle, or a genuine dead end, with a written reason.
- Messages starting with [factory] are automated reports about your PR's preview and e2e: act on them, never ask about them.
- Never merge. Never touch production. Never print secrets.`;

const log = (event, f = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...f }));
const secret = (n) => readFileSync(`${SECRETS}/${n}`, 'utf8').trim();
mkdirSync(`${HOME}/tasks`, { recursive: true });

// ---------- tasks on disk: tasks/<id>/task.json + messages.jsonl ----------
const dir = (id) => `${HOME}/tasks/${id}`;
const load = (id) => JSON.parse(readFileSync(`${dir(id)}/task.json`, 'utf8'));
const save = (t) => { t.updatedAt = new Date().toISOString(); writeFileSync(`${dir(t.id)}/task.json`, JSON.stringify(t, null, 1)); };
const say = (id, from, text, extra = {}) => appendFileSync(`${dir(id)}/messages.jsonl`, JSON.stringify({ at: new Date().toISOString(), from, text, ...extra }) + '\n');
const messages = (id) => existsSync(`${dir(id)}/messages.jsonl`) ? readFileSync(`${dir(id)}/messages.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const allTasks = () => readdirSync(`${HOME}/tasks`).filter((d) => existsSync(`${dir(d)}/task.json`)).map(load).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

// ---------- GitHub App: a one-hour installation token per run ----------
async function githubToken(repo) {
  const app = Object.values(PROJECTS).find((p) => p.repo === repo)?.githubApp;
  if (!app) throw new Error(`no GitHub App configured for ${repo}`);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 540, iss: app.id })}`;
  const jwt = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(secret(app.key), 'base64url')}`;
  const gh = async (url, method = 'GET', token = jwt) => {
    const r = await fetch(`https://api.github.com${url}`, { method, headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'factory-agents' } });
    if (!r.ok) throw new Error(`github ${url}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };
  const inst = await gh(`/repos/${repo}/installation`);
  const [owner, name] = repo.split('/');
  return (await gh(`/app/installations/${inst.id}/access_tokens`, 'POST')).token + `|${owner}|${name}`;
}
async function findPr(task) {
  try {
    const [token] = (await githubToken(task.repo)).split('|');
    const owner = task.repo.split('/')[0];
    const r = await fetch(`https://api.github.com/repos/${task.repo}/pulls?state=all&head=${owner}:agent/${task.id}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'factory-agents' } });
    const prs = await r.json();
    return Array.isArray(prs) && prs[0] ? { number: prs[0].number, url: prs[0].html_url, state: prs[0].merged_at ? 'merged' : prs[0].state } : null;
  } catch (e) { log('pr.lookup_failed', { task: task.id, error: e.message }); return null; }
}

// ---------- one Claude Code run in a container ----------
const running = new Map();   // task id -> child process (docker run client)
const containers = new Map(); // task id -> container name
const queue = [];
function enqueue(id, prompt, mode) { queue.push({ id, prompt, mode }); pump(); }
function pump() {
  while (running.size < MAX_PARALLEL && queue.length) {
    const job = queue.shift();
    if (running.has(job.id)) { queue.push(job); break; }
    run(job).catch((e) => { log('run.crashed', { task: job.id, error: e.message }); say(job.id, 'factory', `[factory] the agent could not start: ${e.message}`); });
  }
}
async function run({ id, prompt, mode }) {
  const t = load(id);
  t.status = mode === 'plan' ? 'briefing' : 'working'; save(t);
  const [ghToken] = (await githubToken(t.repo)).split('|');
  // the image runs as `agent` (uid 1001): it owns its workspace and Claude state
  for (const d of ['workspace', 'claude']) { mkdirSync(`${dir(id)}/${d}`, { recursive: true }); chownSync(`${dir(id)}/${d}`, 1001, 1001); }
  const name = `fa-${id}-${Date.now().toString(36)}`;
  const args = ['run', '--rm', '--name', name, '--network', NETWORK,
    '--cpus', '4', '--memory', '8g', '--pids-limit', '2048', '--shm-size', '1g',
    '--security-opt', 'no-new-privileges:true', '--cap-drop', 'NET_RAW', '--cap-drop', 'MKNOD', '--cap-drop', 'SYS_CHROOT', '--cap-drop', 'AUDIT_WRITE', '--cap-drop', 'SETFCAP',
    '-v', `${dir(id)}/workspace:/workspace`, '-v', `${dir(id)}/claude:/home/agent/.claude`,
    '-e', 'TASK_ID', '-e', 'REPO', '-e', 'BASE', '-e', 'GH_TOKEN', '-e', 'CLAUDE_CODE_OAUTH_TOKEN'];
  if (RUNTIME) args.push('--runtime', RUNTIME);
  args.push(IMAGE, 'claude', '-p', prompt, '--output-format', 'stream-json', '--verbose', '--max-turns', '300',
    '--permission-mode', mode, '--disallowedTools', 'AskUserQuestion', '--append-system-prompt', RULES);
  if (t.sessionId) args.push('--resume', t.sessionId);
  const env = { ...process.env, TASK_ID: id, REPO: t.repo, BASE: t.base, GH_TOKEN: ghToken, CLAUDE_CODE_OAUTH_TOKEN: secret('claude-token') };
  const child = spawn('docker', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  running.set(id, child); containers.set(id, name);
  log('run.start', { task: id, mode, container: name });
  let buf = '', last = '', stderr = '';
  child.stdout.on('data', (c) => {
    buf += c; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.session_id && !t.sessionId) { t.sessionId = ev.session_id; save(t); }
      if (ev.type === 'assistant') {
        for (const part of ev.message?.content ?? []) {
          if (part.type === 'text' && part.text.trim()) { last = part.text.trim(); }
          if (part.type === 'tool_use') appendFileSync(`${dir(id)}/activity.log`, `${new Date().toISOString()} ${part.name} ${JSON.stringify(part.input).slice(0, 300)}\n`);
        }
      }
      if (ev.type === 'result') { last = (ev.result ?? last).trim(); t.costUsd = (t.costUsd ?? 0) + (ev.total_cost_usd ?? 0); }
    }
  });
  child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-2000); });
  await new Promise((r) => child.on('close', r));
  running.delete(id); containers.delete(id);
  const done = load(id); done.sessionId = t.sessionId; done.costUsd = t.costUsd;
  if (last) say(id, 'agent', last);
  else say(id, 'factory', `[factory] the agent stopped without a reply. ${stderr.trim().slice(-400)}`);
  done.pr = (await findPr(done)) ?? done.pr ?? null;
  done.status = mode === 'plan' ? 'waiting for you' : done.pr ? 'waiting for checks' : 'waiting for you';
  save(done);
  log('run.end', { task: id, mode, pr: done.pr?.number ?? null });
  pump();
}

// ---------- the conversation ----------
function createTask(project, text, auto) {
  const p = PROJECTS[project]; if (!p) throw new Error(`unknown project ${project}`);
  const id = `${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${randomBytes(3).toString('hex')}`;
  mkdirSync(dir(id), { recursive: true });
  const t = { id, project, repo: p.repo, base: p.base, title: text.split('\n')[0].slice(0, 90), phase: auto ? 'run' : 'brief', status: 'queued', factoryRounds: 0, createdAt: new Date().toISOString() };
  save(t); say(id, 'you', text);
  if (auto) enqueue(id, runPrompt(t, text, 'Pre-approved: no brief, start now.'), 'bypassPermissions');
  else enqueue(id, `TASK ${id} in ${p.repo} (base ${p.base}).\n\n${text}\n\nThis is the BRIEF. Read the code you need (and .claude/skills/factory-rules, .agents/skills/verify-contentcoach if present). Reply with ONE message: the questions you genuinely need answered (or "no questions"), your plan in a few lines, and the definition of done as checks anyone can run. Do not change any file.`, 'plan');
  return t;
}
const runPrompt = (t, task, reply) => `${reply}\n\nNow RUN task ${t.id}: ${task}\nYou are on branch agent/${t.id} in /workspace/repo (base ${t.base}). Work until your definition of done is met. Commit, push the branch, and open a PR into ${t.base} with \`gh pr create\` (title: the task in one line; body: Done / Decisions / Attention). Every push builds a preview and runs e2e; the results arrive here as [factory] messages. Do not ask questions.`;
function post(id, from, text) {
  const t = load(id); say(id, from, text);
  if (from === 'factory') {
    if (t.phase !== 'run') return t;
    if (t.factoryRounds >= MAX_FACTORY_ROUNDS) { say(id, 'factory', `[factory] round limit (${MAX_FACTORY_ROUNDS}) reached: stopped. A person decides what next.`); t.status = 'waiting for you'; save(t); return t; }
    if (text.includes('✅')) { t.status = 'review'; save(t); }
    t.factoryRounds += 1; save(t);
    enqueue(id, text, 'bypassPermissions');
    return t;
  }
  if (t.phase === 'brief') { t.phase = 'run'; save(t); enqueue(id, runPrompt(t, messages(id)[0].text, `The person answered your brief: ${text}`), 'bypassPermissions'); }
  else enqueue(id, text, 'bypassPermissions');
  return t;
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
    const m = url.pathname.match(/^\/tasks(?:\/([\w-]+))?(?:\/(messages|stop))?$/);
    if (!m) return send(404, { error: 'not found' });
    const [, id, sub] = m;
    if (!id && req.method === 'GET') return send(200, allTasks().map((t) => ({ ...t, running: running.has(t.id) })));
    if (!id && req.method === 'POST') { const b = await body(req); return send(201, createTask(b.project, String(b.text ?? '').trim(), !!b.auto)); }
    if (!existsSync(`${dir(id)}/task.json`)) return send(404, { error: 'no such task' });
    if (!sub && req.method === 'GET') return send(200, { ...load(id), running: running.has(id), messages: messages(id) });
    if (sub === 'messages' && req.method === 'POST') { const b = await body(req); return send(200, post(id, b.from === 'factory' ? 'factory' : 'you', String(b.text ?? '').trim())); }
    if (sub === 'stop' && req.method === 'POST') { if (containers.has(id)) spawn('docker', ['kill', containers.get(id)], { stdio: 'ignore' }); running.get(id)?.kill('SIGTERM'); const t = load(id); t.status = 'stopped'; save(t); say(id, 'factory', '[factory] stopped by you.'); return send(200, t); }
    return send(405, { error: 'method not allowed' });
  } catch (e) { log('http.error', { error: e.message }); return send(400, { error: e.message }); }
};
for (const a of BIND) createServer(handler).listen(PORT, a, () => log('listening', { address: a, port: PORT, image: IMAGE, network: NETWORK, runtime: RUNTIME || 'runc' }));
