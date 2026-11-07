// Remote MCP server (streamable HTTP, stateless JSON replies) mounted by server.mjs at /mcp.
// Everything it knows comes through injected deps; output passes an allow-list in code, so a task's
// secret-bearing fields (tokens, env, claude state, GitHub App key paths) can never be listed.
// Adds no powers beyond the HTTP API: no merge, no stop, no gate changes.
import { timingSafeEqual } from 'node:crypto';

export const PROTOCOL = '2025-03-26';
export const TASK_FIELDS = ['id', 'project', 'repo', 'base', 'kind', 'type', 'title', 'status', 'phase', 'waitingOn', 'auto', 'createdAt', 'updatedAt', 'children'];
export const PR_FIELDS = ['number', 'url', 'state'];
export const PROJECT_FIELDS = ['name', 'about', 'repo', 'base'];
export const MESSAGE_FIELDS = ['at', 'from', 'text'];
export const MAX_TEXT = 8000;

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));
// a last line of defence on free text: token-shaped strings are masked
const SECRET_RE = /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{32,}|xox[abp]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)|Bearer\s+[A-Za-z0-9._~+/=-]{20,})/g;
export const scrub = (s) => String(s ?? '').replace(SECRET_RE, '[redacted]');
export const publicTask = (t) => {
  const o = pick(t, TASK_FIELDS);
  if (t.pr) o.pr = pick(t.pr, PR_FIELDS);
  if (t.running !== undefined) o.running = !!t.running;
  if (o.title) o.title = scrub(o.title);
  if (o.waitingOn) o.waitingOn = scrub(o.waitingOn);
  return o;
};
export const publicProject = (p) => pick(p, PROJECT_FIELDS);
export const publicMessage = (m) => ({ ...pick(m, MESSAGE_FIELDS), text: scrub(m.text).slice(0, MAX_TEXT) });

const str = (d) => ({ type: 'string', description: d });
export const TOOLS = [
  { name: 'list_tasks', description: 'List factory tasks (newest first) with status. Read-only.', readOnly: true,
    inputSchema: { type: 'object', properties: { status: str('only this status'), project: str('only this project'), limit: { type: 'number', description: 'default 30, max 100' } } } },
  { name: 'get_task', description: "Read one task's status, PR and messages. Read-only.", readOnly: true,
    inputSchema: { type: 'object', properties: { id: str('task id'), messages: { type: 'number', description: 'last N messages, default 20, max 100' } }, required: ['id'] } },
  { name: 'list_projects', description: 'List the projects tasks can be started in. Read-only.', readOnly: true, inputSchema: { type: 'object', properties: {} } },
  { name: 'start_task', description: 'Start a task in a project. Without auto it begins with a brief for the person to approve.',
    inputSchema: { type: 'object', properties: { project: str('project name'), text: str('what to do'), auto: { type: 'boolean', description: 'run without a brief' } }, required: ['project', 'text'] } },
  { name: 'start_epic', description: 'Start an epic (program): a goal the coordinator splits into tasks.',
    inputSchema: { type: 'object', properties: { project: str('project name'), goal: str('the goal') }, required: ['project', 'goal'] } },
  { name: 'reply_to_task', description: 'Post a reply to a task, as the person.',
    inputSchema: { type: 'object', properties: { id: str('task id'), text: str('the reply') }, required: ['id', 'text'] } },
];

const clamp = (n, d, max) => Math.max(1, Math.min(max, Number.isFinite(Number(n)) && n != null ? Number(n) : d));
const needStr = (v, name) => { if (typeof v !== 'string' || !v.trim()) throw new Error(`${name} is required`); return v.trim(); };

export async function callTool(name, a = {}, deps) {
  switch (name) {
    case 'list_tasks': {
      let ts = deps.listTasks();
      if (a.status) ts = ts.filter((t) => t.status === a.status);
      if (a.project) ts = ts.filter((t) => t.project === a.project);
      return ts.slice(0, clamp(a.limit, 30, 100)).map((t) => publicTask({ ...t, running: deps.isRunning?.(t.id) }));
    }
    case 'get_task': {
      const id = needStr(a.id, 'id'); const t = deps.getTask(id);
      if (!t) throw new Error('no such task');
      return { ...publicTask({ ...t, running: deps.isRunning?.(id) }), messages: deps.messages(id).slice(-clamp(a.messages, 20, 100)).map(publicMessage) };
    }
    case 'list_projects': return deps.projects().map(publicProject);
    case 'start_task': return publicTask(deps.startTask(needStr(a.project, 'project'), needStr(a.text, 'text'), !!a.auto));
    case 'start_epic': return publicTask(deps.startEpic(needStr(a.project, 'project'), needStr(a.goal, 'goal')));
    case 'reply_to_task': {
      const id = needStr(a.id, 'id'); if (!deps.getTask(id)) throw new Error('no such task');
      deps.reply(id, needStr(a.text, 'text')); return { ok: true, id };
    }
    default: throw new Error(`unknown tool ${name}`);
  }
}

// one JSON-RPC message in, one response (or null for a notification) out
export async function rpc(msg, deps) {
  const { id, method, params } = msg ?? {};
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  if (typeof method !== 'string') return err(-32600, 'invalid request');
  if (id === undefined) return null;
  if (method === 'initialize') return ok({ protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'factory', version: '1' } });
  if (method === 'ping') return ok({});
  if (method === 'tools/list') return ok({ tools: TOOLS.map(({ readOnly, ...t }) => ({ ...t, annotations: { readOnlyHint: !!readOnly } })) });
  if (method === 'tools/call') {
    if (!TOOLS.some((t) => t.name === params?.name)) return err(-32602, `unknown tool ${params?.name}`);
    try {
      const out = await callTool(params.name, params.arguments ?? {}, deps);
      return ok({ content: [{ type: 'text', text: JSON.stringify(out) }] });
    } catch (e) { return ok({ isError: true, content: [{ type: 'text', text: scrub(e.message) }] }); }
  }
  return err(-32601, `method not found: ${method}`);
}

export const bearerOk = (header, token) => {
  const want = `Bearer ${token}`; const h = String(header ?? '');
  return h.length === want.length && timingSafeEqual(Buffer.from(h), Buffer.from(want));
};

// the HTTP side: no header 401, wrong token 403, per-process rate limit 429
export function createMcp(deps, { limit = 120, windowMs = 60000, now = Date.now, maxBody = 256 * 1024 } = {}) {
  let start = 0, count = 0;
  return async function handle(req, res) {
    const send = (code, obj, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
    if (!req.headers.authorization) return send(401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
    if (!bearerOk(req.headers.authorization, deps.token())) return send(403, { error: 'forbidden' });
    const t = now(); if (t - start >= windowMs) { start = t; count = 0; }
    if (++count > limit) return send(429, { error: 'rate limited' }, { 'retry-after': '60' });
    if (req.method !== 'POST') return send(405, { error: 'POST only' }, { allow: 'POST' });
    let msg;
    try {
      let b = ''; for await (const c of req) { b += c; if (b.length > maxBody) throw new Error('too large'); }
      msg = JSON.parse(b);
    } catch { return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
    const batch = Array.isArray(msg);
    const outs = (await Promise.all((batch ? msg : [msg]).map(async (m) => {
      const r = await rpc(m, deps);
      if (m?.method === 'tools/call') deps.audit?.({ tool: m.params?.name, ok: !r?.result?.isError });
      return r;
    }))).filter(Boolean);
    if (!outs.length) return send(202);
    return send(200, batch ? outs : outs[0]);
  };
}
