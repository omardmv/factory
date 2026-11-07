// End-to-end test of the Slack bot against a fake Slack Web API and a fake
// factory-agents API (both local HTTP servers). `node slack/test.mjs`
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const listen = (handler) => new Promise((r) => { const s = createServer(handler).listen(0, '127.0.0.1', () => r(s)); });
const body = async (req) => { let b = ''; for await (const c of req) b += c; return b ? JSON.parse(b) : {}; };

// ---- fake Slack
const calls = []; const channels = { C_GENERAL: { id: 'C_GENERAL', name: 'general' } }; let n = 0;
const slackSrv = await listen(async (req, res) => {
  const method = req.url.slice(1), p = await body(req); calls.push({ method, p, auth: req.headers.authorization });
  let out = { ok: true };
  if (method === 'conversations.create') { if (Object.values(channels).some((c) => c.name === p.name)) out = { ok: false, error: 'name_taken' }; else { const id = `C${++n}`; channels[id] = { id, name: p.name }; out = { ok: true, channel: channels[id] }; } }
  if (method === 'conversations.info') out = { ok: true, channel: channels[p.channel] };
  if (method === 'chat.postMessage') out = { ok: true, ts: `${++n}.0` };
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
});
// ---- fake factory-agents
const tasks = {}; let tid = 0;
const mk = (project, text, extra = {}) => { const id = `2611${String(++tid).padStart(2, '0')}-abc${tid}`; tasks[id] = { id, project, title: text.split('\n')[0], kind: 'change', phase: 'brief', status: 'briefing', messages: [{ from: 'you', text }], ...extra }; return tasks[id]; };
const agentsSrv = await listen(async (req, res) => {
  const send = (o, c = 200) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.headers.authorization !== 'Bearer agents-secret') return send({ error: 'auth' }, 401);
  const u = new URL(req.url, 'http://x'), p = await body(req);
  if (u.pathname === '/tasks' && req.method === 'GET') return send(Object.values(tasks).map(({ messages, ...t }) => t));
  if (u.pathname === '/tasks' && req.method === 'POST') return send(mk(p.project, p.text, p.kind ? { kind: p.kind } : {}), 201);
  const m = u.pathname.match(/^\/tasks\/([\w-]+)(?:\/(messages|stop|pause))?$/);
  if (m && !m[2]) return send(tasks[m[1]]);
  if (m?.[2] === 'messages') { tasks[m[1]].messages.push({ from: 'you', text: p.text }); if (/^go$/i.test(p.text)) tasks[m[1]].phase = 'run'; return send(tasks[m[1]]); }
  if (m?.[2] === 'stop') { tasks[m[1]].status = 'stopped'; return send(tasks[m[1]]); }
  send({ error: 'not found' }, 404);
});

// ---- the bot, pointed at the fakes; one task exists before it starts
const old = mk('contentcoach', 'old task from before Slack'); old.messages.push({ from: 'agent', text: 'old reply' });
const dir = mkdtempSync(`${tmpdir()}/slackbot-`);
for (const [f, v] of Object.entries({ 'slack-bot-token': 'xoxb-test', 'slack-app-token': 'xapp-test', 'agents-token': 'agents-secret' })) writeFileSync(`${dir}/${f}`, v);
Object.assign(process.env, { SECRETS_DIR: dir, BOT_STATE: `${dir}/state.json`, SLACK_API: `http://127.0.0.1:${slackSrv.address().port}`, AGENTS_API: `http://127.0.0.1:${agentsSrv.address().port}`, FACTS_FILE: `${dir}/none.json` });
const bot = await import('./bot.mjs');
const since = (i) => calls.slice(i);
const posted = (i, ch) => since(i).filter((c) => c.method === 'chat.postMessage' && (!ch || c.p.channel === ch));
let ok = 0; const step = async (name, f) => { await f(); ok++; console.log(`ok ${ok} - ${name}`); };

await step('first run marks existing tasks as history', async () => {
  await bot.prime(); await bot.pushUpdates();
  assert.equal(bot.state.skip[old.id], true);
  assert.equal(calls.filter((c) => c.method === 'conversations.create').length, 0);
});
await step('strangers and wrong codes get silence', async () => {
  const i = calls.length;
  await bot.onMessage({ type: 'message', channel: 'D1', channel_type: 'im', user: 'U_X', text: 'pair 00000000', ts: '1.0' });
  await bot.onMessage({ type: 'message', channel: 'C_GENERAL', channel_type: 'channel', user: 'U_X', text: 'hello', ts: '1.1' });
  assert.equal(since(i).length, 0); assert.equal(bot.state.owner, undefined);
});
await step('pairing by DM sets the owner', async () => {
  await bot.onMessage({ type: 'message', channel: 'D1', channel_type: 'im', user: 'U_ME', text: `pair ${bot.state.pairing}`, ts: '1.2' });
  assert.equal(bot.state.owner, 'U_ME'); assert.equal(bot.state.dm, 'D1');
  assert.match(calls.at(-1).p.text, /Paired/); assert.equal(calls.at(-1).auth, 'Bearer xoxb-test');
});
let ccTask;
await step('a channel the owner creates: join, its first message is the task (project from the name)', async () => {
  channels.C_NEW = { id: 'C_NEW', name: 'cc-login-redirect' };
  await bot.onChannelCreated({ type: 'channel_created', channel: { id: 'C_NEW', name: 'cc-login-redirect', creator: 'U_ME' } });
  assert.ok(calls.some((c) => c.method === 'conversations.join' && c.p.channel === 'C_NEW'));
  const i = calls.length;
  await bot.onMessage({ type: 'message', channel: 'C_NEW', channel_type: 'channel', user: 'U_ME', text: 'fix the login redirect on phones', ts: '2.0' });
  ccTask = Object.values(tasks).find((t) => t.title === 'fix the login redirect on phones');
  assert.equal(ccTask.project, 'contentcoach'); assert.equal(bot.state.channelTask.C_NEW, ccTask.id);
  assert.match(posted(i, 'C_NEW')[0].p.text, /started \(contentcoach\)/);
});
await step('a channel someone else created is not joined; a non-task channel never starts a task', async () => {
  const before = Object.keys(tasks).length, i = calls.length;
  await bot.onChannelCreated({ type: 'channel_created', channel: { id: 'C_OTHER', name: 'random', creator: 'U_X' } });
  await bot.onMessage({ type: 'message', channel: 'C_GENERAL', channel_type: 'channel', user: 'U_ME', text: 'lunch?', ts: '2.1' });
  assert.equal(Object.keys(tasks).length, before); assert.equal(since(i).length, 0);
});
await step('a brief lands in the task channel with a Go button', async () => {
  Object.assign(ccTask, { status: 'waiting for you' }); ccTask.messages.push({ from: 'agent', text: '**Playbook: bug.**\n## Plan\n- reproduce\n- fix' });
  const i = calls.length; await bot.pushUpdates();
  const m = posted(i, 'C_NEW'); assert.equal(m.length, 1);
  assert.match(m[0].p.text, /\*Brief: Go, or reply/); assert.match(m[0].p.text, /\*Playbook: bug\.\*/); assert.match(m[0].p.text, /• reproduce/);
  assert.equal(m[0].p.blocks.at(-1).elements[0].action_id, 'go');
  const j = calls.length; await bot.pushUpdates(); assert.equal(posted(j).length, 0, 'nothing twice');
});
await step('Go sends "go" to the task and removes the button', async () => {
  await bot.onAction({ type: 'block_actions', user: { id: 'U_ME' }, actions: [{ action_id: 'go', value: ccTask.id }], channel: { id: 'C_NEW' }, message: { ts: '9.0', text: 't', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 't' } }, { type: 'actions' }] } });
  assert.equal(ccTask.messages.at(-1).text, 'go'); assert.equal(ccTask.phase, 'run');
  const u = calls.at(-1); assert.equal(u.method, 'chat.update'); assert.ok(!u.p.blocks.some((b) => b.type === 'actions'));
  const before = ccTask.messages.length;
  await bot.onAction({ type: 'block_actions', user: { id: 'U_X' }, actions: [{ action_id: 'go', value: ccTask.id }] });
  assert.equal(ccTask.messages.length, before, 'only the owner');
});
await step('anything the owner writes in the channel goes to the task', async () => {
  await bot.onMessage({ type: 'message', channel: 'C_NEW', channel_type: 'channel', user: 'U_ME', text: 'also check Safari', ts: '3.0' });
  assert.equal(ccTask.messages.at(-1).text, 'also check Safari'); assert.equal(calls.at(-1).method, 'reactions.add');
  await bot.onMessage({ type: 'message', channel: 'C_NEW', channel_type: 'channel', user: 'U_ME', text: 'edited', subtype: 'message_changed', ts: '3.1' });
  await bot.onMessage({ type: 'message', channel: 'C_NEW', channel_type: 'channel', bot_id: 'B1', text: 'bot echo', ts: '3.2' });
  assert.equal(ccTask.messages.at(-1).text, 'also check Safari');
});
let fTask;
await step('a DM "factory: …" starts a task in a new channel and invites the owner', async () => {
  await bot.onMessage({ type: 'message', channel: 'D1', channel_type: 'im', user: 'U_ME', text: 'factory: add a /health page to the dashboard', ts: '4.0' });
  fTask = Object.values(tasks).find((t) => t.title.startsWith('add a /health'));
  assert.equal(fTask.project, 'factory');
  const c = calls.find((x) => x.method === 'conversations.create' && x.p.name.startsWith('factory-add-a-health'));
  assert.ok(c, 'channel factory-add-a-health-…'); assert.ok(c.p.name.length <= 80); assert.match(c.p.name, /^[a-z0-9-]+$/);
  const ch = bot.state.taskChannel[fTask.id];
  assert.ok(calls.some((x) => x.method === 'conversations.invite' && x.p.channel === ch && x.p.users === 'U_ME'));
  assert.match(calls.filter((x) => x.method === 'chat.postMessage' && x.p.channel === 'D1').at(-1).p.text, new RegExp(`<#${ch}>`));
});
await step('a task from elsewhere (issue intake) gets its own channel on its first message', async () => {
  const t = mk('contentcoach', 'Issue #12: export fails', { phase: 'run', status: 'working' }); t.messages.push({ from: 'agent', text: 'Playbook: bug. Reproducing.' });
  const i = calls.length; await bot.pushUpdates();
  assert.ok(since(i).some((c) => c.method === 'conversations.create' && c.p.name.startsWith('cc-issue-12-export-fails')));
  assert.equal(posted(i, bot.state.taskChannel[t.id]).length, 1);
});
await step('decision needed, QA and review render with their labels', async () => {
  const r1 = bot.render({ id: 'x', kind: 'change', phase: 'run', status: 'decision needed' }, { from: 'agent', text: 'DECISION NEEDED\n1. A\n2. B' });
  assert.match(r1.text, /Decision needed/); assert.ok(!r1.go);
  assert.match(bot.render({ id: 'x', pr: { url: 'https://g/1', number: 1 } }, { from: 'review', text: 'Fine.\nVERDICT: PASS' }).text, /Review passed[\s\S]*<https:\/\/g\/1\|PR #1>/);
  assert.match(bot.render({ id: 'x' }, { from: 'qa', text: 'Broken.\nQA VERDICT: FAIL' }).text, /QA found failures/);
  assert.equal(bot.mrkdwn('a <b> & [x](https://y)'), 'a &lt;b&gt; &amp; <https://y|x>');
});
await step('/factory commands: tasks anywhere, stop only in a task channel, nobody else', async () => {
  assert.match((await bot.onCommand({ user_id: 'U_ME', channel_id: 'D1', text: 'tasks' })).text, new RegExp(ccTask.id));
  assert.match((await bot.onCommand({ user_id: 'U_ME', channel_id: 'D1', text: 'stop' })).text, /task's channel/);
  assert.match((await bot.onCommand({ user_id: 'U_X', channel_id: bot.state.taskChannel[fTask.id], text: 'stop' })).text, /Not paired/);
  assert.match((await bot.onCommand({ user_id: 'U_ME', channel_id: bot.state.taskChannel[fTask.id], text: 'stop' })).text, /stopped/);
  assert.equal(fTask.status, 'stopped');
});
await step('merged PR or stopped task: the channel is archived, once', async () => {
  ccTask.pr = { state: 'merged', number: 7, url: 'https://g/7' }; ccTask.status = 'merged';
  const i = calls.length; await bot.pushUpdates();
  const arch = since(i).filter((c) => c.method === 'conversations.archive').map((c) => c.p.channel).sort();
  assert.deepEqual(arch, ['C_NEW', bot.state.taskChannel[fTask.id]].sort());
  assert.ok(posted(i, 'C_NEW').some((c) => /PR #7 merged: archiving/.test(c.p.text)));
  const j = calls.length; await bot.pushUpdates(); assert.equal(since(j).filter((c) => c.method !== 'conversations.create').filter((c) => c.method === 'conversations.archive').length, 0);
});
await step('projects from channel names', () => {
  assert.equal(bot.projectOfChannel('factory-x'), 'factory'); assert.equal(bot.projectOfChannel('cc_x'), 'contentcoach');
  assert.equal(bot.projectOfChannel('contentcoach-y'), 'contentcoach'); assert.equal(bot.projectOfChannel('ideas'), 'contentcoach');
  assert.equal(bot.projectOfChannel('factoryish'), 'contentcoach');
});
console.log(`all ${ok} passed`);
slackSrv.close(); agentsSrv.close(); process.exit(0);
