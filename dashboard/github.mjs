// Read-only GitHub facts for the overview: merged PRs and deploy runs.
// Uses the contentcoach org's own app (omarfactory) but asks GitHub for a
// token limited to READ permissions, cached for a minute.
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const APP_ID = '5299771';
const REPO = 'contentcoach/contentcoach';
const keyFile = () => `${process.env.SECRETS_DIR ?? '/run/factory'}/github-app.pem`;
let tok = { value: '', exp: 0 };
const cache = new Map();

async function token() {
  if (tok.exp > Date.now() + 60000) return tok.value;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const u = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 540, iss: APP_ID })}`;
  const jwt = `${u}.${createSign('RSA-SHA256').update(u).sign(readFileSync(keyFile()), 'base64url')}`;
  const h = { authorization: `Bearer ${jwt}`, accept: 'application/vnd.github+json', 'user-agent': 'factory-dashboard' };
  const inst = await (await fetch(`https://api.github.com/repos/${REPO}/installation`, { headers: h })).json();
  const r = await (await fetch(`https://api.github.com/app/installations/${inst.id}/access_tokens`, {
    method: 'POST', headers: h,
    body: JSON.stringify({ repositories: ['contentcoach'], permissions: { contents: 'read', pull_requests: 'read', actions: 'read', metadata: 'read' } }),
  })).json();
  tok = { value: r.token, exp: new Date(r.expires_at).getTime() };
  return tok.value;
}
async function gh(path) {
  const hit = cache.get(path);
  if (hit && hit.at > Date.now() - 60000) return hit.data;
  const r = await fetch(`https://api.github.com/repos/${REPO}${path}`, { headers: { authorization: `Bearer ${await token()}`, accept: 'application/vnd.github+json', 'user-agent': 'factory-dashboard' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`github ${path}: ${r.status}`);
  const data = await r.json(); cache.set(path, { at: Date.now(), data }); return data;
}

export async function shipped(days = 7) {
  const since = Date.now() - days * 864e5;
  const prs = await gh('/pulls?state=closed&base=dev&sort=updated&direction=desc&per_page=40');
  return prs.filter((p) => p.merged_at && new Date(p.merged_at) > since)
    .map((p) => ({ number: p.number, title: p.title, url: p.html_url, at: p.merged_at, author: p.user?.login }));
}
export async function deploys() {
  const pick = async (file, env) => {
    try {
      const r = await gh(`/actions/workflows/${file}/runs?per_page=4`);
      return (r.workflow_runs ?? []).map((w) => ({ env, title: w.display_title, status: w.status, conclusion: w.conclusion, at: w.created_at, url: w.html_url, sha: w.head_sha.slice(0, 7) }));
    } catch { return []; }
  };
  const all = [...await pick('deploy-staging.yml', 'staging'), ...await pick('deploy.yml', 'production')];
  return all.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6);
}
export async function openPrs() {
  return (await gh('/pulls?state=open&base=dev&per_page=30')).map((p) => ({ number: p.number, title: p.title, url: p.html_url, branch: p.head.ref, author: p.user?.login, at: p.updated_at }));
}
