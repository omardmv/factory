// node agents/test-mcp.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createMcp, TOOLS, TASK_FIELDS, PR_FIELDS, PROJECT_FIELDS, MESSAGE_FIELDS } from './mcp.mjs';

let n = 0;
const test = async (name, f) => { await f(); n++; console.log('ok', name); };

const TOKEN = 'tok-' + 'a'.repeat(32);
// every secret-bearing field a real task/project can carry, each with a recognisable canary
const CANARY = 'CANARY_SECRET_9f3';
const secretTask = (id, extra = {}) => ({
  id, project: 'p', repo: 'o/r', base: 'main', kind: 'change', type: 'feature', title: `t ${id}`, status: 'working', phase: 'run', auto: true,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', waitingOn: 'a reply',
  pr: { number: 3, url: 'https://github.com/o/r/pull/3', state: 'open', head: CANARY, token: CANARY },
  sessionId: CANARY, claudeDir: `/x/${CANARY}`, env: { GH_TOKEN: CANARY }, ghToken: CANARY, githubApp: { keyFile: `/s/${CANARY}.pem` },
  'claude-token': CANARY, apiToken: CANARY, secrets: CANARY, reviewedSha: CANARY, ...extra,
});
const state = { tasks: [secretTask('t1'), secretTask('t2', { status: 'done' })], replies: [], started: [] };
const msgs = [
  { at: 'x', from: 'you', text: 'hello', token: CANARY, env: CANARY },
  { at: 'y', from: 'agent', text: `pushed with ghp_${'A'.repeat(36)} and sk-ant-${'b'.repeat(30)} ok`, sessionId: CANARY },
];
const deps = {
  token: () => TOKEN,
  listTasks: () => state.tasks,
  getTask: (id) => state.tasks.find((t) => t.id === id) ?? null,
  isRunning: (id) => id === 't1',
  messages: () => msgs,
  projects: () => [{ name: 'p', about: 'a', repo: 'o/r', base: 'main', githubApp: { appId: 1, keyFile: `/s/${CANARY}.pem` }, autoMerge: true, env: { X: CANARY } }],
  startTask: (p, text, auto) => { const t = secretTask('t3', { project: p, title: text }); state.started.push({ p, text, auto }); return t; },
  startEpic: (p, goal) => { const t = secretTask('e1', { project: p, kind: 'program', title: goal }); state.started.push({ p, goal, epic: true }); return t; },
  reply: (id, text) => state.replies.push({ id, text }),
};

const mcp = createMcp(deps, { limit: 1000 });
const srv = createServer((req, res) => (req.url === '/mcp' ? mcp(req, res) : (res.writeHead(404), res.end())));
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${srv.address().port}/mcp`;
let rid = 0;
const call = (body, auth = `Bearer ${TOKEN}`) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body) });
const rpc = async (method, params) => (await (await call({ jsonrpc: '2.0', id: ++rid, method, params })).json());
const tool = async (name, args) => { const r = await rpc('tools/call', { name, arguments: args }); return { r, text: r.result.content[0].text, json: () => JSON.parse(r.result.content[0].text) }; };

await test('no token: 401', async () => {
  const r = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, null);
  assert.equal(r.status, 401);
});
await test('wrong token: 403, and a prefix/other-length token too', async () => {
  assert.equal((await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'Bearer nope')).status, 403);
  assert.equal((await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, `Bearer ${TOKEN}x`)).status, 403);
  assert.equal((await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, TOKEN)).status, 403);
});
await test('GET is 405 (authenticated), notifications 202', async () => {
  assert.equal((await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 405);
  assert.equal((await call({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
});
await test('initialize and tools/list: six tools, reads marked read-only', async () => {
  const i = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.ok(i.result.capabilities.tools); assert.equal(i.result.serverInfo.name, 'factory');
  const l = await rpc('tools/list');
  assert.deepEqual(l.result.tools.map((t) => t.name).sort(), ['get_task', 'list_projects', 'list_tasks', 'reply_to_task', 'start_epic', 'start_task']);
  const ro = Object.fromEntries(l.result.tools.map((t) => [t.name, t.annotations.readOnlyHint]));
  assert.deepEqual(ro, { list_tasks: true, get_task: true, list_projects: true, start_task: false, start_epic: false, reply_to_task: false });
  for (const t of l.result.tools) assert.equal(t.inputSchema.type, 'object');
});
await test('list_tasks shape: allow-listed fields only, running flag, filters', async () => {
  const { json } = await tool('list_tasks', {});
  const ts = json();
  assert.equal(ts.length, 2);
  for (const t of ts) {
    for (const k of Object.keys(t)) assert.ok([...TASK_FIELDS, 'pr', 'running'].includes(k), `unexpected field ${k}`);
    assert.deepEqual(Object.keys(t.pr).sort(), [...PR_FIELDS].sort());
  }
  assert.equal(ts[0].running, true); assert.equal(ts[1].running, false);
  assert.equal((await tool('list_tasks', { status: 'done' })).json().length, 1);
  assert.equal((await tool('list_tasks', { limit: 1 })).json().length, 1);
});
await test('get_task shape: status, pr, messages with only allowed fields', async () => {
  const t = (await tool('get_task', { id: 't1', messages: 1 })).json();
  assert.equal(t.id, 't1'); assert.equal(t.status, 'working'); assert.equal(t.pr.number, 3);
  assert.equal(t.messages.length, 1);
  for (const m of t.messages) for (const k of Object.keys(m)) assert.ok(MESSAGE_FIELDS.includes(k));
  const all = (await tool('get_task', { id: 't1' })).json();
  assert.deepEqual(all.messages.map((m) => m.from), ['you', 'agent']);
  const bad = await tool('get_task', { id: 'zz' });
  assert.equal(bad.r.result.isError, true);
});
await test('list_projects shape: name, about, repo, base only', async () => {
  const ps = (await tool('list_projects', {})).json();
  assert.deepEqual(ps, [{ name: 'p', about: 'a', repo: 'o/r', base: 'main' }]);
  for (const k of Object.keys(ps[0])) assert.ok(PROJECT_FIELDS.includes(k));
});
await test('start_task, start_epic and reply_to_task act, and return the task shape', async () => {
  const a = (await tool('start_task', { project: 'p', text: 'do it', auto: true })).json();
  assert.equal(a.id, 't3'); assert.deepEqual(state.started[0], { p: 'p', text: 'do it', auto: true });
  assert.equal((await tool('start_task', { project: 'p', text: 'x' })).r.result.isError, undefined);
  assert.equal(state.started[1].auto, false);
  const e = (await tool('start_epic', { project: 'p', goal: 'big' })).json();
  assert.equal(e.kind, 'program'); assert.equal(state.started[2].epic, true);
  assert.deepEqual((await tool('reply_to_task', { id: 't1', text: 'go on' })).json(), { ok: true, id: 't1' });
  assert.deepEqual(state.replies, [{ id: 't1', text: 'go on' }]);
  assert.equal((await tool('reply_to_task', { id: 'zz', text: 'x' })).r.result.isError, true);
  assert.equal((await tool('reply_to_task', { id: 't1', text: ' ' })).r.result.isError, true);
});
await test('unknown tool / method: JSON-RPC errors; malformed body: 400', async () => {
  assert.equal((await rpc('tools/call', { name: 'merge_pr', arguments: {} })).error.code, -32602);
  assert.equal((await rpc('nope')).error.code, -32601);
  const r = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: '{' });
  assert.equal(r.status, 400);
});
await test('NO SECRET can appear in any tool output (every tool, canaries everywhere)', async () => {
  const outputs = [];
  for (const [name, args] of [['list_tasks', {}], ['list_tasks', { limit: 100 }], ['get_task', { id: 't1' }], ['get_task', { id: 't2' }], ['list_projects', {}],
    ['start_task', { project: 'p', text: 'x' }], ['start_epic', { project: 'p', goal: 'x' }], ['reply_to_task', { id: 't1', text: 'x' }]]) outputs.push((await tool(name, args)).text);
  outputs.push(JSON.stringify(await rpc('tools/list')), JSON.stringify(await rpc('initialize', {})));
  const all = outputs.join('\n');
  for (const bad of [CANARY, 'ghp_', 'sk-ant-', 'sessionId', 'claudeDir', 'githubApp', 'keyFile', 'GH_TOKEN', 'claude-token', 'ghToken', 'apiToken', TOKEN, '.pem'])
    assert.ok(!all.includes(bad), `secret-shaped content leaked: ${bad}`);
  assert.ok(all.includes('[redacted]'));
});
await test('allow-lists name no secret-looking field', () => {
  for (const k of [...TASK_FIELDS, ...PR_FIELDS, ...PROJECT_FIELDS, ...MESSAGE_FIELDS]) assert.ok(!/token|key|secret|env|claude|session|password|app/i.test(k), k);
  assert.ok(TOOLS.every((t) => !/merge|stop|pause/.test(t.name)));
});
await test('task ids must match [\\w-]+: path-shaped ids are refused, nothing is read or written', async () => {
  const before = state.replies.length;
  for (const id of ['../../x', 'a/b', '..', 'a b', '']) {
    assert.equal((await tool('get_task', { id })).r.result.isError, true, id);
    assert.equal((await tool('reply_to_task', { id, text: 'x' })).r.result.isError, true, id);
  }
  assert.equal(state.replies.length, before);
});
await test('batches are refused (one POST cannot start many tasks)', async () => {
  const r = await call([{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
  assert.equal(r.status, 400);
});
await test('client handshake: initialize, initialized, tools/list, tools/call list_tasks', async () => {
  const i = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'c', version: '1' } });
  assert.equal(i.result.protocolVersion, '2025-03-26');
  assert.equal((await call({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  assert.ok((await rpc('tools/list')).result.tools.length === 6);
  assert.equal((await tool('list_tasks', {})).json().length, 2);
});
await test('rate limit: 429 past the window limit, resets after', async () => {
  let t = 0;
  const m = createMcp(deps, { limit: 2, windowMs: 1000, now: () => t });
  const s = createServer((req, res) => m(req, res)); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const u = `http://127.0.0.1:${s.address().port}`;
  const go = () => fetch(u, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) }).then((r) => r.status);
  assert.deepEqual([await go(), await go(), await go()], [200, 200, 429]);
  t = 1001; assert.equal(await go(), 200);
  s.close();
});
srv.close();
console.log(`${n} tests passed`);
