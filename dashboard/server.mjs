// factory dashboard: one calm page for the whole factory, and the single
// sign-in for every *.contentcoach.org preview (nginx asks GET /auth).
// No dependencies, no docker access: it reads a facts file the host writes
// every minute (factory-box status), the e2e reports, and Coolify's API.
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const PORT = Number(process.env.PORT ?? 8080);
const SECRETS = process.env.SECRETS_DIR ?? '/run/factory';
const STATE = process.env.STATE_DIR ?? '/srv/factory/state';
const ARTIFACTS = process.env.ARTIFACTS_DIR ?? '/srv/factory/artifacts';
const COOLIFY = process.env.COOLIFY_API ?? 'http://coolify:8080/api/v1';
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN ?? '.contentcoach.org';
const SELF = process.env.SELF_URL ?? 'https://factory.contentcoach.org';
const SESSION_DAYS = 30;
const PROJECTS = [
  { name: 'contentcoach', prefix: 'cc', app: 'zmyto8r1grwnpihq9xt1fdg3', domain: 'contentcoach.org', repo: 'contentcoach/contentcoach' },
];
const LINKS = {
  coolify: 'https://coolify.contentcoach.org',
  agents: 'https://software.contentcoach.org',
  factoryRepo: 'https://github.com/omardmv/factory',
};

const secret = (name) => readFileSync(`${SECRETS}/${name}`, 'utf8').trim();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeEq = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// ---- session: "<expires>.<hmac>", on the parent domain so previews see it
function sign(exp) { return createHmac('sha256', secret('session-secret')).update(String(exp)).digest('hex'); }
function newSession() { const exp = Date.now() + SESSION_DAYS * 864e5; return `${exp}.${sign(exp)}`; }
function validSession(req) {
  const m = (req.headers.cookie ?? '').match(/(?:^|;\s*)factory_session=([0-9]+)\.([0-9a-f]{64})/);
  return !!m && Number(m[1]) > Date.now() && safeEq(m[2], sign(m[1]));
}
const sessionCookie = (v, maxAge) =>
  `factory_session=${v}; Domain=${COOKIE_DOMAIN}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
// only send people back to our own hosts
const safeNext = (n) => { try { const u = new URL(n); return u.protocol === 'https:' && (u.hostname === COOKIE_DOMAIN.slice(1) || u.hostname.endsWith(COOKIE_DOMAIN)) ? u.href : SELF; } catch { return SELF; } };

// ---- data
async function coolify(path, init = {}) {
  const r = await fetch(`${COOLIFY}${path}`, { ...init, headers: { authorization: `Bearer ${secret('coolify-token')}`, 'content-type': 'application/json', ...(init.headers ?? {}) }, signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`coolify ${path}: ${r.status}`);
  return r.json();
}
function readJson(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }
function e2eFor(prefix, pr) {
  const dir = `${ARTIFACTS}/${prefix}/pr-${pr}/latest`;
  const rep = readJson(`${dir}/report.json`);
  if (!rep?.run) return null;
  const s = rep.run.summary ?? {};
  return { passed: s.passed ?? 0, failed: s.failed ?? 0, at: rep.run.finishedAt };
}
async function previews(project) {
  let deployments = [];
  try { deployments = (await coolify(`/deployments/applications/${project.app}?take=100`)).deployments ?? []; } catch {}
  let live = [];
  try { live = (await coolify(`/applications/${project.app}/previews`)).map((p) => Number(p.pull_request_id)); } catch {}
  const byPr = new Map();
  for (const d of deployments) {
    const pr = Number(d.pull_request_id);
    if (!pr || byPr.has(pr)) continue; // newest first
    byPr.set(pr, d);
  }
  return [...byPr.entries()].map(([pr, d]) => ({
    pr, live: live.includes(pr), status: d.status, commit: (d.commit ?? '').slice(0, 7),
    message: (d.commit_message ?? '').split('\n')[0], at: d.finished_at ?? d.created_at,
    e2e: e2eFor(project.prefix, pr),
    url: `https://pr${pr}.${project.domain}`,
  })).sort((a, b) => (b.live - a.live) || (b.pr - a.pr));
}

// ---- pages
const css = `
body{font:15px/1.5 -apple-system,system-ui,sans-serif;margin:0;background:#fafaf8;color:#1f1f1d}
main{max-width:980px;margin:0 auto;padding:32px 20px 60px}
h1{font-size:22px;font-weight:500;margin:0} h2{font-size:15px;font-weight:500;margin:36px 0 10px;color:#5f5e5a}
.big{font-size:40px;font-weight:500;margin:18px 0 2px} .muted{color:#888780;font-size:13px}
.card{background:#fff;border:1px solid #e6e4dc;border-radius:12px;padding:14px 16px;margin:8px 0}
.row{display:flex;gap:14px;align-items:center;flex-wrap:wrap} .grow{flex:1;min-width:220px}
.pill{font-size:12px;padding:2px 9px;border-radius:99px;background:#e1f5ee;color:#085041;white-space:nowrap}
.bad{background:#fcebeb;color:#791f1f} .warn{background:#faeeda;color:#633806} .off{background:#f1efe8;color:#5f5e5a}
a{color:#185fa5;text-decoration:none} a:hover{text-decoration:underline}
.links a{margin-right:12px;font-size:13px}
button{font:inherit;font-size:13px;padding:4px 12px;border-radius:8px;border:1px solid #d3d1c7;background:#fff;cursor:pointer}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px}
.tile{background:#fff;border:1px solid #e6e4dc;border-radius:12px;padding:10px 14px}
.tile b{display:block;font-weight:500;font-size:13px;color:#5f5e5a} header{display:flex;justify-content:space-between;align-items:baseline}
input{font:inherit;padding:8px 10px;border:1px solid #d3d1c7;border-radius:8px;width:260px}`;
const page = (title, body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${css}</style><main>${body}</main>`;
const pill = (text, kind = '') => `<span class="pill ${kind}">${esc(text)}</span>`;
const ago = (t) => { if (!t) return ''; const m = Math.round((Date.now() - new Date(t)) / 60000); return m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };

async function dashboard() {
  const facts = readJson(`${STATE}/status.json`) ?? {};
  const all = [];
  for (const p of PROJECTS) for (const v of await previews(p)) all.push({ ...v, project: p });
  const live = all.filter((v) => v.live);
  const services = facts.services ?? {};
  const unhealthy = [
    ...Object.entries(services).filter(([, s]) => !['active', 'running', 'healthy'].includes(s)).map(([k]) => k),
    ...(facts.runners ?? []).filter((r) => r.active !== 'active').map((r) => r.name),
  ];
  const stale = !facts.at || Date.now() - new Date(facts.at) > 5 * 60000;
  const headline = unhealthy.length || stale ? `${unhealthy.length + (stale ? 1 : 0)} thing${unhealthy.length + stale === 1 ? '' : 's'} need a look` : 'All healthy';

  const rows = all.slice(0, 20).map((v) => {
    const st = v.status === 'finished' ? pill(v.live ? 'running' : 'closed', v.live ? '' : 'off')
      : v.status === 'failed' ? pill('deploy failed', 'bad') : pill(v.status, 'warn');
    const e2e = v.e2e ? pill(`e2e ${v.e2e.passed} passed${v.e2e.failed ? `, ${v.e2e.failed} failed` : ''}`, v.e2e.failed ? 'bad' : '') : '';
    return `<div class="card"><div class="row"><div class="grow"><b>PR #${v.pr}</b> <span class="muted">${esc(v.project.name)} · ${esc(v.commit)} · ${esc(ago(v.at))}</span><div class="muted">${esc(v.message)}</div></div>${st} ${e2e}</div>
      <div class="row links" style="margin-top:6px">${v.live ? `<a href="${v.url}/app/">open</a><a href="${v.url}/_factory/login">sign in</a><a href="${v.url}/_factory/">videos</a>` : ''}<a href="https://github.com/${v.project.repo}/pull/${v.pr}">pull request</a><a href="${LINKS.coolify}">coolify</a>
      ${v.live ? `<form method="post" action="/redeploy" style="display:inline"><input type="hidden" name="pr" value="${v.pr}"><input type="hidden" name="app" value="${v.project.app}"><button>Redeploy</button></form>` : ''}</div></div>`;
  }).join('') || '<div class="card muted">No previews yet. Every pull request into dev gets one.</div>';

  const tile = (label, value, ok = true) => `<div class="tile"><b>${esc(label)}</b>${ok ? esc(value) : `<span class="pill bad">${esc(value)}</span>`}</div>`;
  const okWord = (s) => ['active', 'running', 'healthy'].includes(s);
  const tiles = [
    tile('Snapshot', (facts.snapshots ?? []).map((s) => s.note.replace(/^snapshot of /, '')).join(' · ') || 'none yet'),
    tile('Runners', `${(facts.runners ?? []).filter((r) => r.active === 'active').length} of ${(facts.runners ?? []).length} online`, (facts.runners ?? []).every((r) => r.active === 'active')),
    ...Object.entries(services).map(([k, s]) => tile(k.replace(/_/g, ' '), s, okWord(s))),
    tile('Disk', `${facts.disk_used_pct ?? '?'}% used`, (facts.disk_used_pct ?? 0) < 85),
    tile('Memory free', `${facts.mem_available_gb ?? '?'} GB`),
    tile('gVisor', facts.gvisor || 'not installed'),
    tile('Factory version', facts.factory_commit ?? '?'),
  ].join('');

  return page('Factory', `
  <header><h1>Factory</h1><span class="muted">${stale ? 'host facts are stale' : `updated ${esc(ago(facts.at))}`} · <a href="/logout">sign out</a></span></header>
  <div class="big">${live.length} preview${live.length === 1 ? '' : 's'} running</div>
  <div class="muted">${esc(headline)}${unhealthy.length ? `: ${esc(unhealthy.join(', '))}` : ''}</div>
  <h2>Pull requests</h2>${rows}
  <h2>Agents</h2><div class="card row"><div class="grow">${facts.agent_sandboxes_running ?? 0} agent sandbox${facts.agent_sandboxes_running === 1 ? '' : 'es'} running on this server</div>
    <a href="${LINKS.agents}">Open-Inspect</a> <a href="https://claude.ai/code">Claude cloud sessions</a></div>
  <h2>Factory health</h2><div class="grid">${tiles}</div>
  <h2>Places</h2><div class="card links"><a href="${LINKS.coolify}">Coolify</a><a href="${LINKS.agents}">Open-Inspect</a><a href="${LINKS.factoryRepo}">factory repo</a><a href="https://github.com/contentcoach/contentcoach/pulls">ContentCoach PRs</a></div>`);
}

const loginPage = (next, error = '') => page('Factory · sign in', `<h1>Factory</h1><p class="muted">Sign in once: it covers this page, every preview and Coolify's front door for ${SESSION_DAYS} days.</p>
  <form method="post" action="/login" class="card"><input type="hidden" name="next" value="${esc(next)}"><input type="password" name="password" placeholder="factory password" autofocus> <button>Sign in</button>
  ${error ? `<p class="pill bad">${esc(error)}</p>` : ''}</form>`);

async function readForm(req) {
  let body = ''; for await (const c of req) { body += c; if (body.length > 10000) break; }
  return Object.fromEntries(new URLSearchParams(body));
}
const fromUs = (req) => (req.headers.origin ?? '') === SELF;

createServer(async (req, res) => {
  const url = new URL(req.url, SELF);
  const send = (code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers }); res.end(body); };
  try {
    if (url.pathname === '/auth') return send(validSession(req) ? 204 : 401, '');
    if (url.pathname === '/health') return send(200, 'ok');
    if (url.pathname === '/login' && req.method === 'GET') return send(200, loginPage(url.searchParams.get('next') ?? SELF));
    if (url.pathname === '/login' && req.method === 'POST') {
      const f = await readForm(req);
      if (!fromUs(req) || !safeEq(String(f.password ?? ''), secret('password'))) return send(401, loginPage(f.next ?? SELF, 'Wrong password.'));
      return send(303, '', { location: safeNext(f.next ?? SELF), 'set-cookie': sessionCookie(newSession(), SESSION_DAYS * 86400) });
    }
    if (url.pathname === '/logout') return send(303, '', { location: '/login', 'set-cookie': sessionCookie('', 0) });
    if (!validSession(req)) return send(303, '', { location: `/login?next=${encodeURIComponent(SELF + url.pathname)}` });
    if (url.pathname === '/redeploy' && req.method === 'POST') {
      const f = await readForm(req);
      if (!fromUs(req) || !/^\d+$/.test(f.pr ?? '') || !PROJECTS.some((p) => p.app === f.app)) return send(400, 'bad request');
      await coolify(`/deploy?uuid=${f.app}&pr=${f.pr}`, { method: 'POST' });
      return send(303, '', { location: '/' });
    }
    if (url.pathname === '/') return send(200, await dashboard());
    return send(404, 'not found');
  } catch (e) {
    console.error(JSON.stringify({ event: 'error', path: url.pathname, error: e.message }));
    return send(500, page('Factory', `<h1>Factory</h1><div class="card"><span class="pill bad">error</span> ${esc(e.message)}</div>`));
  }
}).listen(PORT, () => console.log(JSON.stringify({ event: 'listening', port: PORT })));
