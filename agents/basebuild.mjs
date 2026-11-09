// Prebuilt-base hook: a project whose repo has an ensure-base script (it rebuilds and pushes a deps base image when
// the deps changed) gets it run by the factory on the box, after a merge into the deploy branch and on a periodic tick.
// Pure decisions plus a runner with every effect injected, tested without GitHub, git or docker: `node agents/test-basebuild.mjs`.
// It never blocks a merge: callers start it detached and a failure is only logged and said.

const DEFAULT_SCRIPT = 'scripts/ensure-base.sh';
const SAFE_USER = /^[a-z_][a-z0-9_-]*$/;

// projects.json "baseBuild": { "branch": "staging", "checkout": "/srv/factory/shop-base-src", "script"?, "user"?, "timeoutMin"?, "retryMin"? }
// -> a validated config, or null when the project has none or it is unusable (never throws).
export function baseBuildConfig(p) {
  const b = p?.baseBuild;
  if (!b || typeof b !== 'object') return null;
  const script = b.script ?? DEFAULT_SCRIPT;
  const bad = (s) => typeof s !== 'string' || !s || s.startsWith('/') || s.split('/').includes('..') || !/^[\w./-]+$/.test(s);
  if (bad(b.branch) || b.branch.startsWith('-') || bad(script) || typeof b.checkout !== 'string' || !b.checkout.startsWith('/') || b.checkout.split('/').includes('..') || b.checkout === '/') return null;
  if (b.user != null && !SAFE_USER.test(b.user)) return null;
  const num = (v, d, max) => (Number.isFinite(v) && v > 0 ? Math.min(v, max) : d);
  return { branch: b.branch, checkout: b.checkout.replace(/\/+$/, ''), script, user: b.user ?? null, timeoutMin: num(b.timeoutMin, 30, 120), retryMin: num(b.retryMin, 15, 1440) };
}

// state: { sha, ok, at } of the last run (or {}). Run when the branch has a commit not yet handled, or the last run
// failed and the retry wait has passed. A sha that already succeeded is never rerun: the script itself is idempotent
// but a run is a docker build's worth of load.
// the merge hook fires only for a merge into the branch the base is built from
export const baseBuildApplies = (p, cfg, reason) => !!cfg && (reason !== 'merge' || cfg.branch === p?.autoMerge);

export function baseBuildDecision({ state = {}, sha, now, retryMin = 15 }) {
  if (!sha) return { run: false, why: 'no head sha' };
  if (state.sha !== sha) return { run: true, why: 'new commit' };
  if (state.ok === false && now - Date.parse(state.at) >= retryMin * 60000) return { run: true, why: 'retry after failure' };
  return { run: false, why: state.ok === false ? 'failed, waiting to retry' : 'already done' };
}

const redact = (s, secrets) => secrets.filter(Boolean).reduce((a, x) => a.split(x).join('***'), String(s ?? ''));
const tail = (s, n = 1500) => (s.length > n ? `…${s.slice(-n)}` : s).trim();

// d: { githubToken(repo), gh(token, url), exec(cmd, args, {cwd, env, timeoutMs, user}) -> {status, out}, exists(path), mkdir(path),
//      loadState(name), saveState(name, s), log(event, data), now() }
// Returns { ran, ok, sha, text } (text: the one line for the task chat) or { ran: false, why }.
const inflight = new Map();
export async function runBaseBuild(d, name, p, cfg, { reason = 'tick' } = {}) {
  if (inflight.has(name)) { inflight.get(name).again = true; return { ran: false, why: 'already running' }; }
  const slot = { again: false };
  inflight.set(name, slot);
  try {
    let result = await once(d, name, p, cfg, reason);
    while (slot.again) { // a trigger landed while it ran
      slot.again = false;
      const next = await once(d, name, p, cfg, 'trigger during run');
      if (next.ran) result = next; // else keep the first result: it is what the caller must hear
    }
    return result;
  } finally { inflight.delete(name); }
}

async function once(d, name, p, cfg, reason) {
  let token;
  const fail = (stage, msg, sha) => {
    const text = `[factory] Base image: ${stage} failed for ${cfg.branch}${sha ? ` ${sha.slice(0, 7)}` : ''}: ${redact(msg, [token]).slice(0, 600)}`;
    d.saveState(name, { ...d.loadState(name), sha: sha ?? d.loadState(name).sha, ok: false, at: new Date(d.now()).toISOString() });
    d.log('basebuild.failed', { project: name, stage, error: redact(msg, [token]).slice(0, 600) });
    return { ran: true, ok: false, sha, text };
  };
  let sha;
  try {
    token = await d.githubToken(p.repo);
    sha = (await d.gh(token, `/repos/${p.repo}/branches/${encodeURIComponent(cfg.branch).replace(/%2F/g, '/')}`))?.commit?.sha;
  } catch (e) { d.log('basebuild.failed', { project: name, stage: 'lookup', error: redact(e.message, [token]).slice(0, 300) }); return { ran: false, why: `lookup failed: ${e.message}` }; }
  const dec = baseBuildDecision({ state: d.loadState(name), sha, now: d.now(), retryMin: cfg.retryMin });
  if (!dec.run) return { ran: false, why: dec.why };
  d.log('basebuild.start', { project: name, sha, reason, why: dec.why });
  // fetch the branch with the app token (read from env, never argv or a stored remote) into the factory-owned checkout
  const gitEnv = { ...d.baseEnv(), GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `Authorization: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` };
  const git = (args) => d.exec('git', ['-c', 'safe.directory=*', ...args], { cwd: cfg.checkout, env: gitEnv, timeoutMs: 300000 });
  try {
    if (!d.exists(`${cfg.checkout}/.git`)) { d.mkdir(cfg.checkout); const i = await git(['init', '-q']); if (i.status !== 0) return fail('git init', i.out, sha); }
    const f = await git(['fetch', '-q', '--depth', '1', `https://github.com/${p.repo}.git`, `refs/heads/${cfg.branch}`]);
    if (f.status !== 0) return fail('fetch', f.out, sha);
    // FETCH_HEAD, not the sha read earlier: a merge between the lookup and the fetch moves the tip
    const c = await git(['checkout', '-q', '-f', '--detach', 'FETCH_HEAD']);
    if (c.status !== 0) return fail('checkout', c.out, sha);
    const head = await git(['rev-parse', 'HEAD']);
    if (head.status === 0 && /^[0-9a-f]{40}$/.test(head.out.trim())) sha = head.out.trim();
    if (!d.exists(`${cfg.checkout}/${cfg.script}`)) { d.saveState(name, { sha, ok: true, at: new Date(d.now()).toISOString(), skipped: true }); d.log('basebuild.skipped', { project: name, sha, why: `no ${cfg.script}` }); return { ran: false, why: `no ${cfg.script} on ${cfg.branch}` }; }
    // the script gets no GitHub token and none of the server's secrets
    const env = { ...d.baseEnv(), BASE_BRANCH: cfg.branch, GIT_SHA: sha };
    if (cfg.user) { // the script's user owns the checkout and has its own HOME (docker config)
      const o = await d.exec('chown', ['-R', cfg.user, cfg.checkout], { cwd: cfg.checkout, env: d.baseEnv(), timeoutMs: 60000 });
      if (o.status !== 0) return fail('chown', o.out, sha);
      const pw = await d.exec('getent', ['passwd', cfg.user], { cwd: cfg.checkout, env: d.baseEnv(), timeoutMs: 10000 });
      const home = pw.out.trim().split(':')[5];
      if (pw.status === 0 && home) env.HOME = home;
    }
    const r = await d.exec('bash', [cfg.script], { cwd: cfg.checkout, env, timeoutMs: cfg.timeoutMin * 60000, user: cfg.user });
    const out = redact(r.out, [token]);
    if (r.status !== 0) { const x = fail(`${cfg.script} (exit ${r.status})`, tail(out), sha); return x; }
    d.saveState(name, { sha, ok: true, at: new Date(d.now()).toISOString() });
    d.log('basebuild.done', { project: name, sha, output: tail(out, 800) });
    return { ran: true, ok: true, sha, text: `[factory] Base image: ${cfg.script} ran OK on ${cfg.branch} ${sha.slice(0, 7)}. Last output: ${tail(out, 300) || '(none)'}` };
  } catch (e) { return fail('run', e.message, sha); }
}
