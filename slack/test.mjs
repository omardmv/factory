// End-to-end test of the Slack bot against a fake Slack Web API and a fake
// factory-agents API (both local HTTP servers). `node slack/test.mjs`
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const listen = (handler) => new Promise((r) => { const s = createServer(handler).listen(0, '127.0.0.1', () => r(s)); });
const raw = async (req) => { const ch = []; for await (const c of req) ch.push(c); return Buffer.concat(ch); };
const body = async (req) => { const b = (await raw(req)).toString(); if (!b) return {}; return /x-www-form-urlencoded/.test(req.headers['content-type'] ?? '') ? Object.fromEntries(new URLSearchParams(b)) : JSON.parse(b); };

// ---- fake Slack
const calls = []; const channels = { C_GENERAL: { id: 'C_GENERAL', name: 'general' } }; let n = 0;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 7)]);
const fileAuth = [], uploads = {}, epicDecisionCalls = [], approveCalls = []; let noFilesWrite = false;
const slackSrv = await listen(async (req, res) => {
  // Slack's private file links: the image with the bot token; its sign-in page without files:read
  if (req.url.startsWith('/upload/')) { uploads[req.url.slice(8)] = await raw(req); res.writeHead(200); return res.end('OK'); }
  if (req.url.startsWith('/files/')) { fileAuth.push(req.headers.authorization); if (req.url === '/files/ok.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); } res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>sign in</html>'); }
  const method = req.url.slice(1), p = await body(req); calls.push({ method, p, auth: req.headers.authorization });
  let out = { ok: true };
  if (method === 'conversations.create') { if (Object.values(channels).some((c) => c.name === p.name)) out = { ok: false, error: 'name_taken' }; else { const id = `C${++n}`; channels[id] = { id, name: p.name }; out = { ok: true, channel: channels[id] }; } }
  if (method === 'conversations.info') out = { ok: true, channel: channels[p.channel] };
  if (method === 'chat.postMessage') out = { ok: true, ts: `${++n}.0` };
  if (method === 'files.getUploadURLExternal') { const id = `F${++n}`; out = noFilesWrite ? { ok: false, error: 'missing_scope' } : { ok: true, file_id: id, upload_url: `http://127.0.0.1:${slackSrv.address().port}/upload/${id}` }; }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
});
// ---- fake factory-agents
const tasks = {}, media = {}, projLoops = {}, loopsSet = []; let notices = []; let tid = 0; const classifyCalls = []; const sentAttachments = [];
const mk = (project, text, extra = {}) => { const id = `2611${String(++tid).padStart(2, '0')}-abc${tid}`; tasks[id] = { id, project, title: text.split('\n')[0], kind: 'change', phase: 'brief', status: 'briefing', messages: [{ from: 'you', text }], ...extra }; return tasks[id]; };
const agentsSrv = await listen(async (req, res) => {
  const send = (o, c = 200) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.headers.authorization !== 'Bearer agents-secret') return send({ error: 'auth' }, 401);
  const u = new URL(req.url, 'http://x'), p = await body(req);
  if (p.attachments?.length) sentAttachments.push({ path: u.pathname, text: p.text, attachments: p.attachments });
  const mm = u.pathname.match(/^\/tasks\/([\w-]+)\/media(?:\/(screens|videos)\/(.+))?$/);
  if (mm && !mm[2]) return send((media[mm[1]] ?? []).map(({ data, ...f }) => f));
  if (mm) { const f = (media[mm[1]] ?? []).find((x) => x.sub === mm[2] && x.rel === decodeURIComponent(mm[3])); res.writeHead(f ? 200 : 404); return res.end(f?.data ?? ''); }
  if (u.pathname === '/projects') return send([{ name: 'factory', repo: 'o/factory', base: 'main', loops: projLoops.factory ?? null }, { name: 'shop', repo: 'o/shop', base: 'staging', loops: projLoops.shop ?? null }]);
  const pl = u.pathname.match(/^\/projects\/([\w-]+)\/loops$/);
  if (pl && req.method === 'POST') { loopsSet.push({ name: pl[1], loops: p.loops }); projLoops[pl[1]] = p.loops; return send({ name: pl[1], loops: p.loops }); }
  if (u.pathname === '/notices' && req.method === 'GET') return send(notices);
  if (u.pathname === '/notices/ack' && req.method === 'POST') { notices = notices.filter((x) => !(p.ids ?? []).includes(x.id)); return send({ ok: true }); }
  if (u.pathname === '/classify') {
    classifyCalls.push(p.text);
    const named = { type: /\bepic\b/i.test(p.text) ? 'epic' : /fix|fails|broken/i.test(p.text) ? 'fix' : 'feature', title: p.text.split('\n')[0].replace(/^\w+:\s*/, '').split(/\s+/).slice(0, 3).join(' ') };
    return send({ ...(/mini app/i.test(p.text) ? { project: 'shop', why: 'Mini App feature' } : /slack bot/i.test(p.text) ? { project: 'factory', why: 'the Slack bot' } : { project: null, why: 'could be either' }), ...named });
  }
  if (u.pathname === '/programs' && req.method === 'POST') return send(mk(p.project, p.goal, { kind: 'program', phase: 'talk', status: 'queued', ...(p.title ? { title: p.title } : {}) }), 201);
  if (u.pathname === '/digest') return send({ ready: [], decisions: [], waiting: [], moving: [], finished: [], merged: [], stopped: [], costUsd: 0 });
  if (u.pathname === '/batches' && req.method === 'POST') return send({ batch: 'b1', tasks: p.items.map((x) => mk(p.project, x.text, { phase: 'run', ...(x.type ? { type: x.type } : {}), ...(x.title ? { title: x.title } : {}) })) }, 201);
  if (u.pathname === '/tasks' && req.method === 'GET') return send(Object.values(tasks).map(({ messages, ...t }) => t));
  if (u.pathname === '/tasks' && req.method === 'POST') return send(mk(p.project, p.text, { ...(p.kind ? { kind: p.kind } : {}), ...(p.type ? { type: p.type } : {}), ...(p.title ? { title: p.title } : {}) }), 201);
  const ap = u.pathname.match(/^\/tasks\/([\w-]+)\/approve$/);
  if (ap && req.method === 'POST') { approveCalls.push({ id: ap[1], ...p }); return p.sha === 'stale' ? send({ error: 'the PR changed since you were asked' }, 409) : send(tasks[ap[1]]); }
  const dm2 = u.pathname.match(/^\/tasks\/([\w-]+)\/decisions$/);
  if (dm2 && req.method === 'POST') { epicDecisionCalls.push({ id: dm2[1], ...p }); return send(tasks[dm2[1]]); }
  const m = u.pathname.match(/^\/tasks\/([\w-]+)(?:\/(messages|stop|pause))?$/);
  if (m && !m[2]) return send(tasks[m[1]]);
  if (m?.[2] === 'messages') { tasks[m[1]].messages.push({ from: 'you', text: p.text }); if (/^go$/i.test(p.text)) tasks[m[1]].phase = 'run'; return send(tasks[m[1]]); }
  if (m?.[2] === 'stop') { tasks[m[1]].status = 'stopped'; return send(tasks[m[1]]); }
  send({ error: 'not found' }, 404);
});

// ---- the bot, pointed at the fakes; one task exists before it starts
const old = mk('shop', 'old task from before Slack'); old.messages.push({ from: 'agent', text: 'old reply' });
const dir = mkdtempSync(`${tmpdir()}/slackbot-`);
for (const [f, v] of Object.entries({ 'slack-bot-token': 'xoxb-test', 'slack-app-token': 'xapp-test', 'agents-token': 'agents-secret' })) writeFileSync(`${dir}/${f}`, v);
Object.assign(process.env, { SECRETS_DIR: dir, BOT_STATE: `${dir}/state.json`, SLACK_API: `http://127.0.0.1:${slackSrv.address().port}`, AGENTS_API: `http://127.0.0.1:${agentsSrv.address().port}`, FACTS_FILE: `${dir}/none.json`, SLACK_NOTIFY: 'all' }); // the older steps below check every message; the notify steps switch it off
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
let shopTask;
await step('a channel the owner creates: join, its first message is the task (project from the name)', async () => {
  channels.C_NEW = { id: 'C_NEW', name: 'shop-login-redirect' };
  await bot.onChannelCreated({ type: 'channel_created', channel: { id: 'C_NEW', name: 'shop-login-redirect', creator: 'U_ME' } });
  assert.ok(calls.some((c) => c.method === 'conversations.join' && c.p.channel === 'C_NEW'));
  const i = calls.length;
  await bot.onMessage({ type: 'message', channel: 'C_NEW', channel_type: 'channel', user: 'U_ME', text: 'fix the login redirect on phones', ts: '2.0' });
  shopTask = Object.values(tasks).find((t) => t.messages[0].text === 'fix the login redirect on phones');
  assert.equal(shopTask.project, 'shop'); assert.equal(bot.state.channelTask.C_NEW, shopTask.id);
  assert.match(posted(i, 'C_NEW')[0].p.text, /started \(shop\)/);
});
await step('a channel someone else created is not joined; a non-task channel never starts a task', async () => {
  const before = Object.keys(tasks).length, i = calls.length;
  await bot.onChannelCreated({ type: 'channel_created', channel: { id: 'C_OTHER', name: 'random', creator: 'U_X' } });
  await bot.onMessage({ type: 'message', channel: 'C_GENERAL', channel_type: 'channel', user: 'U_ME', text: 'lunch?', ts: '2.1' });
  assert.equal(Object.keys(tasks).length, before); assert.equal(since(i).length, 0);
});
await step('a brief lands in the task channel with a Go button', async () => {
  Object.assign(shopTask, { status: 'waiting for you' }); shopTask.messages.push({ from: 'agent', text: '**Playbook: bug.**\n## Plan\n- reproduce\n- fix' });
  const i = calls.length; await bot.pushUpdates();
  const m = posted(i, 'C_NEW'); assert.equal(m.length, 1);
  assert.match(m[0].p.text, /\*Brief: Go, or reply/); assert.match(m[0].p.text, /\*Playbook: bug\.\*/); assert.match(m[0].p.text, /• reproduce/);
  assert.equal(m[0].p.blocks.at(-1).elements[0].action_id, 'go');
  const j = calls.length; await bot.pushUpdates(); assert.equal(posted(j).length, 0, 'nothing twice');
});
await step('Go sends "go" to the task and removes the button', async () => {
  await bot.onAction({ type: 'block_actions', user: { id: 'U_ME' }, actions: [{ action_id: 'go', value: shopTask.id }], channel: { id: 'C_NEW' }, message: { ts: '9.0', text: 't', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 't' } }, { type: 'actions' }] } });
  assert.equal(shopTask.messages.at(-1).text, 'go'); assert.equal(shopTask.phase, 'run');
  const u = calls.at(-1); assert.equal(u.method, 'chat.update'); assert.ok(!u.p.blocks.some((b) => b.type === 'actions'));
  const before = shopTask.messages.length;
  await bot.onAction({ type: 'block_actions', user: { id: 'U_X' }, actions: [{ action_id: 'go', value: shopTask.id }] });
  assert.equal(shopTask.messages.length, before, 'only the owner');
});
await step('an epic in talk phase gets Plan it (not Go); pressing it sends "plan"; Go stays for brief', async () => {
  const e = mk('shop', 'epic: redo onboarding', { kind: 'program', phase: 'talk', status: 'waiting for you' }); e.messages.push({ from: 'agent', text: 'Options: A or B. Trade-offs...' });
  const i = calls.length; await bot.pushUpdates();
  const ch = bot.state.taskChannel[e.id]; const m = posted(i, ch); assert.equal(m.length, 1);
  assert.match(m[0].p.text, /Epic discussion: talk it through, then Plan it/);
  assert.deepEqual(m[0].p.blocks.at(-1).elements.map((b) => b.action_id), ['plan']); assert.equal(m[0].p.blocks.at(-1).elements[0].text.text, 'Plan it');
  assert.ok(!bot.render(e, { from: 'agent', text: 'x' }).go);
  await bot.onAction({ type: 'block_actions', user: { id: 'U_ME' }, actions: [{ action_id: 'plan', value: e.id }], channel: { id: ch }, message: { ts: '9.1', text: 't', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 't' } }, { type: 'actions' }] } });
  assert.equal(e.messages.at(-1).text, 'plan');
  const u = calls.at(-1); assert.equal(u.method, 'chat.update'); assert.ok(!u.p.blocks.some((b) => b.type === 'actions')); assert.match(JSON.stringify(u.p.blocks), /Plan it/);
  const before = e.messages.length;
  await bot.onAction({ type: 'block_actions', user: { id: 'U_X' }, actions: [{ action_id: 'plan', value: e.id }] });
  assert.equal(e.messages.length, before, 'only the owner');
  const b = bot.render({ id: 'y', kind: 'program', phase: 'brief' }, { from: 'agent', text: 'plan' }); assert.ok(b.go); assert.ok(!b.plan); assert.match(b.text, /Epic plan: Go/);
  delete tasks[e.id];
});
await step('anything the owner writes in the channel goes to the task', async () => {
  await bot.onMessage({ type: 'message', channel: 'C_NEW', channel_type: 'channel', user: 'U_ME', text: 'also check Safari', ts: '3.0' });
  assert.equal(shopTask.messages.at(-1).text, 'also check Safari'); assert.equal(calls.at(-1).method, 'reactions.add');
  await bot.onMessage({ type: 'message', channel: 'C_NEW', channel_type: 'channel', user: 'U_ME', text: 'edited', subtype: 'message_changed', ts: '3.1' });
  await bot.onMessage({ type: 'message', channel: 'C_NEW', channel_type: 'channel', bot_id: 'B1', text: 'bot echo', ts: '3.2' });
  assert.equal(shopTask.messages.at(-1).text, 'also check Safari');
});
let fTask;
await step('a DM "factory: …" starts a task in a new channel and invites the owner', async () => {
  await bot.onMessage({ type: 'message', channel: 'D1', channel_type: 'im', user: 'U_ME', text: 'factory: add a /health page to the dashboard', ts: '4.0' });
  fTask = Object.values(tasks).find((t) => t.messages[0].text.startsWith('add a /health'));
  assert.equal(fTask.project, 'factory');
  const c = calls.find((x) => x.method === 'conversations.create' && x.p.name === 'feature-add-a-health');
  assert.ok(c, 'channel feature-add-a-health (type, then the main thing)'); assert.ok(c.p.name.length <= 80); assert.match(c.p.name, /^[a-z0-9-]+$/);
  const ch = bot.state.taskChannel[fTask.id];
  assert.ok(calls.some((x) => x.method === 'conversations.invite' && x.p.channel === ch && x.p.users === 'U_ME'));
  assert.match(calls.filter((x) => x.method === 'chat.postMessage' && x.p.channel === 'D1').at(-1).p.text, new RegExp(`<#${ch}>`));
});
await step('a DM naming no project: a clear one is guessed and said so; shop: skips the guess', async () => {
  const n = classifyCalls.length;
  await bot.onMessage({ type: 'message', channel: 'D1', channel_type: 'im', user: 'U_ME', text: 'Feature: users edit their profile in the Mini App', ts: '4.1' });
  const t = Object.values(tasks).find((x) => x.messages[0].text.startsWith('Feature: users edit their profile'));
  assert.equal(t.project, 'shop'); assert.equal(classifyCalls.length, n + 1);
  assert.match(posted(0, bot.state.taskChannel[t.id]).at(-1).p.text, /started \(shop, guessed from your message: Mini App feature/);
  await bot.onMessage({ type: 'message', channel: 'D1', channel_type: 'im', user: 'U_ME', text: 'shop: Profile editing\nusers edit bio', ts: '4.2' });
  const t2 = Object.values(tasks).find((x) => x.messages[0].text.startsWith('Profile editing'));
  assert.equal(t2.project, 'shop'); assert.doesNotMatch(posted(0, bot.state.taskChannel[t2.id]).at(-1).p.text, /guessed/, 'a named project is not guessed');
  assert.equal(calls.filter((c) => c.method === 'conversations.create').at(-1).p.name, 'feature-profile-editing');
});
await step('unsure: the bot asks with one button per project, and the pick starts it', async () => {
  const before = Object.keys(tasks).length, i = calls.length;
  await bot.onMessage({ type: 'message', channel: 'D1', channel_type: 'im', user: 'U_ME', text: 'fix the login bug', ts: '4.3' });
  assert.equal(Object.keys(tasks).length, before, 'nothing starts before the pick');
  const ask = since(i).find((c) => c.method === 'chat.postMessage' && /Which project/.test(c.p.text));
  assert.ok(ask); assert.equal(ask.p.channel, 'D1');
  const buttons = ask.p.blocks.at(-1).elements; assert.deepEqual(buttons.map((b) => b.text.text).sort(), ['Factory', 'Shop']);
  const shopBtn = buttons.find((b) => b.text.text === 'Shop');
  await bot.onAction({ type: 'block_actions', user: { id: 'U_X' }, actions: [{ action_id: shopBtn.action_id, value: shopBtn.value }] });
  assert.equal(Object.keys(tasks).length, before, 'only the owner picks');
  await bot.onAction({ type: 'block_actions', user: { id: 'U_ME' }, actions: [{ action_id: shopBtn.action_id, value: shopBtn.value }], channel: { id: 'D1' }, message: { ts: '5.0', text: 'q' } });
  const t = Object.values(tasks).find((x) => x.messages[0].text === 'fix the login bug'); assert.equal(t.project, 'shop');
  assert.equal(calls.filter((c) => c.method === 'chat.update').at(-1).p.blocks[0].type, 'context', 'buttons replaced');
  await bot.onAction({ type: 'block_actions', user: { id: 'U_ME' }, actions: [{ action_id: shopBtn.action_id, value: shopBtn.value }] });
  assert.equal(Object.values(tasks).filter((x) => x.messages[0].text === 'fix the login bug').length, 1, 'a second press does nothing');
});
await step('an unnamed new channel: unsure asks in that channel, and the task lives there', async () => {
  channels.C_IDEA = { id: 'C_IDEA', name: 'ideas' };
  await bot.onChannelCreated({ type: 'channel_created', channel: { id: 'C_IDEA', name: 'ideas', creator: 'U_ME' } });
  const i = calls.length;
  await bot.onMessage({ type: 'message', channel: 'C_IDEA', channel_type: 'channel', user: 'U_ME', text: 'better onboarding', ts: '6.0' });
  const ask = since(i).find((c) => c.method === 'chat.postMessage' && /Which project/.test(c.p.text)); assert.equal(ask.p.channel, 'C_IDEA');
  const f = ask.p.blocks.at(-1).elements.find((b) => b.text.text === 'Factory');
  await bot.onAction({ type: 'block_actions', user: { id: 'U_ME' }, actions: [{ action_id: f.action_id, value: f.value }], channel: { id: 'C_IDEA' }, message: { ts: '6.1', text: 'q' } });
  const t = Object.values(tasks).find((x) => x.messages[0].text === 'better onboarding');
  assert.equal(t.project, 'factory'); assert.equal(bot.state.channelTask.C_IDEA, t.id, 'the task stays in the founder\'s channel');
});
await step('a task from elsewhere (issue intake) gets its own channel on its first message', async () => {
  const t = mk('shop', 'Issue #12: export fails', { phase: 'run', status: 'working' }); t.messages.push({ from: 'agent', text: 'Playbook: bug. Reproducing.' });
  const i = calls.length; await bot.pushUpdates();
  assert.ok(since(i).some((c) => c.method === 'conversations.create' && c.p.name === 'task-issue-12-export-fails'));
  assert.equal(posted(i, bot.state.taskChannel[t.id]).length, 1);
});
await step('a bare "stop" in a task channel is a command, not an answer', async () => {
  const t = Object.values(tasks).find((x) => x.messages[0].text === 'better onboarding'); const n = t.messages.length;
  await bot.onMessage({ type: 'message', channel: 'C_IDEA', channel_type: 'channel', user: 'U_ME', text: 'stop', ts: '7.0' });
  assert.equal(t.status, 'stopped'); assert.equal(t.messages.length, n, 'not sent to the agent');
});
await step('decision needed, QA and review render with their labels', async () => {
  const r1 = bot.render({ id: 'x', kind: 'change', phase: 'run', status: 'decision needed' }, { from: 'agent', text: 'DECISION NEEDED\n1. A\n2. B' });
  assert.match(r1.text, /Decision needed/); assert.ok(!r1.go);
  const ping = bot.render({ id: 'x' }, { from: 'factory', ping: true, text: '[factory] STUCK: this task has been working for 35 min. Why: no activity.' });
  assert.match(ping.text, /Stuck[\s\S]*working for 35 min[\s\S]*no activity/);
  assert.match(bot.render({ id: 'x', status: 'decision needed', waitingOn: 'your answer to: purple or teal?' }, { from: 'agent', text: 'DECISION NEEDED\nx' }).text, /Waiting on: your answer to: purple or teal\?/);
  assert.match(bot.render({ id: 'x', pr: { url: 'https://g/1', number: 1 } }, { from: 'review', text: 'Fine.\nVERDICT: PASS' }).text, /Review passed[\s\S]*<https:\/\/g\/1\|PR #1>/);
  assert.match(bot.render({ id: 'x' }, { from: 'qa', text: 'Broken.\nQA VERDICT: FAIL' }).text, /QA found failures/);
  assert.equal(bot.mrkdwn('a <b> & [x](https://y)'), 'a &lt;b&gt; &amp; <https://y|x>');
});
await step('/factory commands: tasks anywhere, stop only in a task channel, nobody else', async () => {
  assert.match((await bot.onCommand({ user_id: 'U_ME', channel_id: 'D1', text: 'tasks' })).text, new RegExp(shopTask.id));
  assert.match((await bot.onCommand({ user_id: 'U_ME', channel_id: 'D1', text: 'stop' })).text, /task's channel/);
  assert.match((await bot.onCommand({ user_id: 'U_X', channel_id: bot.state.taskChannel[fTask.id], text: 'stop' })).text, /Not paired/);
  assert.match((await bot.onCommand({ user_id: 'U_ME', channel_id: bot.state.taskChannel[fTask.id], text: 'stop' })).text, /stopped/);
  assert.equal(fTask.status, 'stopped');
});
await step('merged PR or stopped task: the channel is archived, once', async () => {
  shopTask.pr = { state: 'merged', number: 7, url: 'https://g/7' }; shopTask.status = 'merged';
  const i = calls.length; await bot.pushUpdates();
  const arch = since(i).filter((c) => c.method === 'conversations.archive').map((c) => c.p.channel).sort();
  assert.deepEqual(arch, ['C_NEW', 'C_IDEA', bot.state.taskChannel[fTask.id]].sort(), 'merged, stopped by command, stopped by /factory');
  assert.ok(posted(i, 'C_NEW').some((c) => /PR #7 merged: archiving/.test(c.p.text)));
  const j = calls.length; await bot.pushUpdates(); assert.equal(since(j).filter((c) => c.method !== 'conversations.create').filter((c) => c.method === 'conversations.archive').length, 0);
});
await step('an epic gets its own epic- channel: plan once, topic M/T merged + issue, wave message once, archived when done', async () => {
  const k1 = mk('shop', 'epic child one', { phase: 'run', status: 'working' }), k2 = mk('shop', 'epic child two', { phase: 'run', status: 'working' });
  k1.messages.push({ from: 'agent', text: 'child one working' });
  const e = mk('shop', 'epic: redo billing', { kind: 'program', phase: 'run', status: 'running · 0/2 merged', children: [k1.id, k2.id], wavesAnnounced: [], epicIssue: { number: 9, url: 'https://g/issues/9' },
    plan: [{ key: 'a', title: 'Model', wave: 1, deps: [], taskId: k1.id }, { key: 'b', title: 'UI', wave: 2, deps: ['a'], taskId: k2.id }] });
  e.messages.push({ from: 'agent', text: 'plan' }, { from: 'factory', text: '[factory] plan approved: 2 tasks in 2 waves.' });
  const i = calls.length; await bot.pushUpdates();
  const ch = bot.state.taskChannel[e.id];
  const made = since(i).find((c) => c.method === 'conversations.create' && c.p.name === 'epic-redo-billing'); assert.ok(made, 'epic- channel'); assert.match(made.p.name, /^[a-z0-9-]+$/);
  const summary = posted(i, ch).filter((c) => /Plan approved: 2 tasks in 2 waves/.test(c.p.text)); assert.equal(summary.length, 1);
  assert.match(summary[0].p.text, /\*Wave 1\*\n• Model[\s\S]*\*Wave 2\*\n• UI/);
  const topics = (from) => since(from).filter((c) => c.method === 'conversations.setTopic' && c.p.channel === ch);
  assert.match(topics(i).at(-1).p.topic, /^0\/2 merged · https:\/\/g\/issues\/9/);
  assert.notEqual(bot.state.taskChannel[k1.id], ch, 'children keep their own channels');
  // wave 1 merges: one wave line, topic refreshed, nothing repeated
  k1.pr = { state: 'merged', number: 5, url: 'https://g/5' }; k1.status = 'merged'; e.wavesAnnounced = ['a'];
  e.messages.push({ from: 'factory', text: '[factory] wave 1 of 2 is merged: Model (https://g/5). Next: UI.' });
  const j = calls.length; await bot.pushUpdates();
  assert.equal(posted(j, ch).filter((c) => /wave 1 of 2 is merged/.test(c.p.text)).length, 1);
  assert.equal(posted(j, ch).filter((c) => /Plan approved/.test(c.p.text)).length, 0, 'plan summary once');
  assert.match(topics(j).at(-1).p.topic, /^1\/2 merged · https:\/\/g\/issues\/9/);
  const l = calls.length; await bot.pushUpdates();
  assert.equal(posted(l, ch).length, 0); assert.equal(topics(l).length, 0, 'topic only on change');
  assert.equal(since(j).filter((c) => c.method === 'conversations.archive' && c.p.channel === ch).length, 0, 'not archived while running');
  // done
  k2.pr = { state: 'merged', number: 6, url: 'https://g/6' }; k2.status = 'merged'; e.status = 'done'; e.messages.push({ from: 'agent', text: 'PROGRAM DONE: all landed' });
  const m = calls.length; await bot.pushUpdates();
  assert.match(topics(m).at(-1).p.topic, /^2\/2 merged/);
  assert.deepEqual(since(m).filter((c) => c.method === 'conversations.archive').map((c) => c.p.channel), [ch], 'the epic channel, once');
  assert.equal(bot.state.archived[e.id], true);
});
await step('projects from channel names', () => {
  assert.equal(bot.projectOfChannel('factory-x'), 'factory'); assert.equal(bot.projectOfChannel('shop_x'), 'shop'); assert.equal(bot.projectOfChannel('cc-x'), null);
  assert.equal(bot.projectOfChannel('ideas'), null);
  assert.equal(bot.projectOfChannel('factoryish'), null); assert.equal(bot.projectOfChannel('shopa'), null);
  assert.equal(bot.projectOfChannel('shop-voice-bug'), 'shop');
});
const fileUrl = (f) => `http://127.0.0.1:${slackSrv.address().port}/files/${f}`;
await step('an image sent in a task channel reaches the agent, fetched with the bot token', async () => {
  const before = sentAttachments.length;
  await bot.onMessage({ type: 'message', subtype: 'file_share', channel: 'C_NEW', channel_type: 'channel', user: 'U_ME', text: '', ts: '9.0', files: [{ id: 'F1', name: 'button.png', mimetype: 'image/png', url_private_download: fileUrl('ok.png') }, { id: 'F2', name: 'notes.pdf', mimetype: 'application/pdf', url_private_download: fileUrl('x.pdf') }] });
  const sent = sentAttachments.slice(before);
  assert.equal(sent.length, 1); assert.equal(sent[0].path, `/tasks/${shopTask.id}/messages`);
  assert.deepEqual(sent[0].attachments.map((a) => a.name), ['button.png'], 'only images are sent');
  assert.deepEqual(Buffer.from(sent[0].attachments[0].data, 'base64'), PNG);
  assert.equal(fileAuth.at(-1), 'Bearer xoxb-test');
});
await step('an image Slack will not hand over (no files:read): the person is told, nothing empty is sent', async () => {
  const before = sentAttachments.length, msgs = tasks[shopTask.id].messages.length, i = calls.length;
  await bot.onMessage({ type: 'message', subtype: 'file_share', channel: 'C_NEW', channel_type: 'channel', user: 'U_ME', text: '', ts: '9.1', files: [{ id: 'F3', name: 'shot.png', mimetype: 'image/png', url_private_download: fileUrl('locked.png') }] });
  assert.equal(sentAttachments.length, before); assert.equal(tasks[shopTask.id].messages.length, msgs);
  assert.match(posted(i, 'C_NEW')[0].p.text, /couldn't read your image[\s\S]*files:read/);
});
await step('a new task from a DM carries its image', async () => {
  const before = sentAttachments.length;
  await bot.onMessage({ type: 'message', subtype: 'file_share', channel: 'D1', channel_type: 'im', user: 'U_ME', text: 'factory: the gallery cuts this off', ts: '9.2', files: [{ id: 'F4', name: 'gallery.png', mimetype: 'image/png', url_private_download: fileUrl('ok.png') }] });
  const sent = sentAttachments.slice(before);
  assert.equal(sent.length, 1); assert.equal(sent[0].path, '/tasks'); assert.equal(sent[0].text, 'the gallery cuts this off');
});
const mediaTask = mk('shop', 'make the buttons red', { status: 'working' });
await step("after the agent's turn, its new screenshots and videos go up under its message, once", async () => {
  media[mediaTask.id] = [{ sub: 'screens', rel: 'edit/01-red.png', mtime: 1, video: false, data: PNG }, { sub: 'videos', rel: 'save.webm', mtime: 1, video: true, data: Buffer.from('webm-bytes') }];
  mediaTask.messages.push({ from: 'agent', text: 'Done: the button is red now.' });
  const i = calls.length;
  await bot.pushUpdates();
  const done = since(i).filter((c) => c.method === 'files.completeUploadExternal');
  assert.equal(done.length, 1); assert.equal(done[0].p.channel_id, bot.state.taskChannel[mediaTask.id]); assert.ok(done[0].p.channel_id);
  assert.match(done[0].p.initial_comment, /What the agent saw: 1 screenshot, 1 video/);
  const ids = JSON.parse(done[0].p.files).map((f) => f.id);
  assert.deepEqual(uploads[ids[0]], PNG); assert.equal(uploads[ids[1]].toString(), 'webm-bytes');
  const asked = since(i).filter((c) => c.method === 'files.getUploadURLExternal').map((c) => c.p.filename);
  assert.deepEqual(asked, ['01-red.png', 'save.mp4'], 'videos go to Slack as mp4 (it does not play webm)');
  // nothing new: nothing posted again, even after another message
  mediaTask.messages.push({ from: 'agent', text: 'Still red.' });
  const j = calls.length; await bot.pushUpdates();
  assert.equal(since(j).filter((c) => c.method.startsWith('files.')).length, 0);
});
await step('without files:write: one DM saying which permission, and the media waits until it is granted', async () => {
  media[mediaTask.id].push({ sub: 'screens', rel: 'dark.png', mtime: 2, video: false, data: PNG });
  noFilesWrite = true; mediaTask.messages.push({ from: 'agent', text: 'Dark mode too.' });
  let i = calls.length; await bot.pushUpdates();
  assert.match(posted(i, 'D1').map((c) => c.p.text).join('\n'), /files:write/);
  mediaTask.messages.push({ from: 'agent', text: 'again' }); i = calls.length; await bot.pushUpdates();
  assert.equal(posted(i, 'D1').filter((c) => /files:write/.test(c.p.text)).length, 0, 'said once');
  noFilesWrite = false; mediaTask.messages.push({ from: 'agent', text: 'and again' }); i = calls.length; await bot.pushUpdates();
  const done = since(i).filter((c) => c.method === 'files.completeUploadExternal');
  assert.equal(done.length, 1); assert.match(done[0].p.initial_comment, /1 screenshot\b/);
});
await step('a message asking for an epic starts an epic, not a task, in a channel named for it', async () => {
  const i = calls.length;
  await bot.onMessage({ type: 'message', channel: 'D1', channel_type: 'im', user: 'U_ME', text: 'shop: we want an epic for the design system', ts: '10.0' });
  const e = Object.values(tasks).find((t) => t.kind === 'program' && /design system/.test(t.messages[0].text));
  assert.ok(e, 'started as an epic'); assert.equal(e.project, 'shop');
  assert.ok(since(i).some((c) => c.method === 'conversations.create' && /^epic-/.test(c.p.name)));
});
await step('when the PR opens, a channel the bot made is renamed pr-<N>-<type>-<title>; the founder\'s own channel keeps its name', async () => {
  const t = mk('shop', 'add a health check', { phase: 'run', status: 'working', type: 'feature', title: 'health check' }); t.messages.push({ from: 'agent', text: 'Working.' });
  await bot.pushUpdates();
  assert.equal(bot.state.ownChannel[t.id], 'feature-health-check');
  t.pr = { number: 61, state: 'open' }; t.messages.push({ from: 'agent', text: 'PR is up.' });
  let i = calls.length; await bot.pushUpdates();
  const r = since(i).filter((c) => c.method === 'conversations.rename');
  assert.equal(r.length, 1); assert.equal(r[0].p.name, 'pr-61-feature-health-check'); assert.equal(r[0].p.channel, bot.state.taskChannel[t.id]);
  i = calls.length; await bot.pushUpdates();
  assert.equal(since(i).filter((c) => c.method === 'conversations.rename').length, 0, 'renamed once');
  const own = Object.values(tasks).find((x) => x.messages[0].text === 'better onboarding');
  own.pr = { number: 62, state: 'open' }; own.messages.push({ from: 'agent', text: 'PR' });
  i = calls.length; await bot.pushUpdates();
  assert.equal(since(i).filter((c) => c.method === 'conversations.rename').length, 0, "the founder's channel is not renamed");
});
await step('a loops reminder comes as a panel: a dropdown per loop, Recommended and All off', async () => {
  notices = [{ id: 'loops-shop-1', project: 'shop', text: 'shop has no improvement loops set.' }];
  const i = calls.length; await bot.pushNotices();
  const m = posted(i, 'D1').at(-1);
  assert.match(m.p.text, /Improvement loops for shop: not set yet/);
  const selects = m.p.blocks.filter((b) => b.accessory?.type === 'static_select');
  assert.deepEqual(selects.map((b) => b.accessory.action_id), ['loops_kind_security', 'loops_kind_performance', 'loops_kind_cleanup', 'loops_kind_docs']);
  assert.ok(selects.every((b) => b.accessory.initial_option.value.endsWith('|off')));
  assert.ok(m.p.blocks.some((b) => b.type === 'actions' && b.elements.some((e) => e.action_id === 'loops_preset_recommended')));
  assert.equal(notices.length, 0, 'acknowledged');
});
await step('a choice saves at once and the panel updates; Recommended sets all four; All off is a no', async () => {
  const msg = { channel: { id: 'D1' }, message: { ts: '77.0' }, user: { id: 'U_ME' } };
  await bot.onAction({ ...msg, actions: [{ action_id: 'loops_kind_security', selected_option: { value: 'shop|security|weekly' } }] });
  assert.deepEqual(loopsSet.at(-1), { name: 'shop', loops: { security: 'weekly' } });
  await bot.onAction({ ...msg, actions: [{ action_id: 'loops_kind_docs', selected_option: { value: 'shop|docs|monthly' } }] });
  assert.deepEqual(loopsSet.at(-1).loops, { security: 'weekly', docs: 'monthly' }, 'the other loops are kept');
  const up = calls.filter((c) => c.method === 'chat.update').at(-1);
  assert.equal(up.p.ts, '77.0'); assert.match(up.p.text, /Security weekly · Docs monthly/);
  await bot.onAction({ ...msg, actions: [{ action_id: 'loops_preset_recommended', value: 'shop|recommended' }] });
  assert.deepEqual(loopsSet.at(-1).loops, { security: 'weekly', performance: 'weekly', cleanup: 'biweekly', docs: 'monthly' });
  await bot.onAction({ ...msg, actions: [{ action_id: 'loops_preset_off', value: 'shop|off' }] });
  assert.equal(loopsSet.at(-1).loops, false);
  const n = loopsSet.length;
  await bot.onAction({ ...msg, user: { id: 'U_X' }, actions: [{ action_id: 'loops_preset_off', value: 'shop|off' }] });
  await bot.onAction({ ...msg, actions: [{ action_id: 'loops_preset_off', value: 'nope|off' }] });
  assert.equal(loopsSet.length, n, 'strangers and unknown projects change nothing');
});
await step('/factory loops shows the panels (one project, or all)', async () => {
  let i = calls.length;
  let r = await bot.onCommand({ user_id: 'U_ME', channel_id: 'C_GENERAL', text: 'loops shop' });
  assert.match(r.text, /Loops for shop/); assert.equal(posted(i, 'C_GENERAL').length, 1);
  i = calls.length; r = await bot.onCommand({ user_id: 'U_ME', channel_id: 'C_GENERAL', text: 'loops' });
  assert.equal(posted(i, 'C_GENERAL').length, 2);
  r = await bot.onCommand({ user_id: 'U_ME', channel_id: 'C_GENERAL', text: 'loops nope' });
  assert.match(r.text, /No project "nope"/);
});
await step('a factory message is shown whole: a stall names its stuck tasks on the lines after the first', async () => {
  const r = bot.render({ id: 'e1' }, { from: 'factory', text: '[factory] the epic is stuck: 0/17 merged, nothing can move.\n- Write the design doc: stuck (decision needed · https://g/pr/28)\n- Research: chat list: stuck (decision needed · https://g/pr/27)' });
  assert.match(r.text, /nothing can move/); assert.match(r.text, /Write the design doc: stuck/); assert.match(r.text, /Research: chat list: stuck/);
});
await step('"Decided for you" comes with a button per other option; pressing one tells the task, or starts a follow-up once merged', async () => {
  const t = mk('shop', 'add the icon set', { phase: 'run', status: 'working', type: 'feature', title: 'icon set' });
  t.decisions = [{ id: 'd1', question: 'Default icon size 24 or 20?', chosen: '24', options: ['24', '20', '16'] }];
  t.messages.push({ from: 'factory', text: '[factory] 📌 Decided for you (reversible): Default icon size 24 or 20?\nTaken: 24\nOther options: 20 · 16', decided: t.decisions[0] });
  let i = calls.length; await bot.pushUpdates();
  const m = posted(i, bot.state.taskChannel[t.id]).find((c) => /Decided for you/.test(c.p.text));
  const btns = m.p.blocks.find((b) => b.type === 'actions').elements;
  assert.deepEqual(btns.map((b) => b.text.text), ['Use: 20', 'Use: 16'], 'no button for what was taken');
  const press = (n, ts) => bot.onAction({ user: { id: 'U_ME' }, channel: { id: bot.state.taskChannel[t.id] }, message: { ts, text: m.p.text, blocks: m.p.blocks }, actions: [{ action_id: `decide_${n}`, value: btns[n].value }] });
  await press(0, '90.0');
  assert.match(t.messages.at(-1).text, /Change of decision from the founder: "Default icon size 24 or 20\?": use "20" instead of "24"/);
  assert.match(calls.filter((c) => c.method === 'chat.update').at(-1).p.blocks.at(-1).elements[0].text, /Changed to: 20/);
  t.status = 'merged'; t.pr = { number: 9, state: 'merged' };
  const before = Object.keys(tasks).length; await press(1, '90.1');
  const f = Object.values(tasks).at(-1);
  assert.equal(Object.keys(tasks).length, before + 1); assert.match(f.messages[0].text, /Follow-up to task .*PR #9, merged.*use "16" instead of "24"/);
});
await step('an epic decision comes with buttons; pressing one changes it for the whole epic', async () => {
  const e = mk('shop', 'epic: chats', { kind: 'program', phase: 'run', status: 'running · 0/3 merged', plan: [], children: [] });
  e.epicDecisions = [{ key: 'read-state', question: 'Does opening a chat mark it read?', options: ['Opening marks it read', 'Only an explicit action'], default: 'Opening marks it read', chosen: 'Opening marks it read', by: 'default' }];
  e.messages.push({ from: 'factory', text: '[factory] 📌 Epic decision (default taken, work goes on): Does opening a chat mark it read?\nTaken: Opening marks it read', epicDecided: { key: 'read-state', question: e.epicDecisions[0].question, options: e.epicDecisions[0].options, chosen: 'Opening marks it read' } });
  const i = calls.length; await bot.pushUpdates();
  const m = since(i).find((c) => c.method === 'chat.postMessage' && /Epic decision/.test(c.p.text));
  const btn = m.p.blocks.find((b) => b.type === 'actions').elements;
  assert.deepEqual(btn.map((b) => [b.action_id, b.text.text]), [['edecide_0', 'Use: Only an explicit action']]);
  await bot.onAction({ user: { id: 'U_ME' }, channel: { id: m.p.channel }, message: { ts: '91.0', text: m.p.text, blocks: m.p.blocks }, actions: [{ action_id: 'edecide_0', value: btn[0].value }] });
  assert.deepEqual(epicDecisionCalls.at(-1), { id: e.id, key: 'read-state', option: 'Only an explicit action' });
  assert.match(calls.filter((c) => c.method === 'chat.update').at(-1).p.blocks.at(-1).elements[0].text, /Changed to: Only an explicit action \(for every task of the epic\)/);
});
await step('ready for your check: an Approve & merge button; pressing it approves the head shown; a stale head is refused', async () => {
  const t = mk('shop', 'crop screen', { phase: 'run', status: 'ready for you', type: 'feature', title: 'crop screen', pr: { number: 12, state: 'open', url: 'https://g/pr/12' } });
  t.messages.push({ from: 'factory', text: '[factory] ✅ Ready for your check: PR #12 passed review and the checks at abc1234.', approve: { sha: 'abc1234def', pr: 12 } });
  const i = calls.length; await bot.pushUpdates();
  const m = since(i).find((c) => c.method === 'chat.postMessage' && /Ready for your check/.test(c.p.text));
  const b = m.p.blocks.find((x) => x.type === 'actions').elements[0];
  assert.deepEqual([b.text.text, b.action_id, b.style, b.value], ['Approve & merge', 'approve', 'primary', `${t.id}|abc1234def`]);
  const press = (value, ts) => bot.onAction({ user: { id: 'U_ME' }, channel: { id: m.p.channel }, message: { ts, text: m.p.text, blocks: m.p.blocks }, actions: [{ action_id: 'approve', value }] });
  await press(b.value, '92.0');
  assert.deepEqual(approveCalls.at(-1), { id: t.id, sha: 'abc1234def' });
  assert.match(calls.filter((c) => c.method === 'chat.update').at(-1).p.blocks.at(-1).elements[0].text, /Approved by you at `abc1234`: merging/);
  await press(`${t.id}|stale`, '92.1');
  assert.match(calls.filter((c) => c.method === 'chat.update').at(-1).p.blocks.at(-1).elements[0].text, /Not approved: the PR changed/);
});
await step('notify: by default only what needs your answer is posted; the rest stays on the dashboard', async () => {
  delete process.env.SLACK_NOTIFY;
  const t = mk('shop', 'quiet task', { phase: 'run', status: 'running', title: 'quiet task' });
  await bot.pushUpdates(); // the task's channel exists, nothing posted yet
  let i = calls.length;
  t.messages.push({ from: 'agent', text: 'I changed the parser.' }, { from: 'review', text: 'VERDICT: PASS\nlooks good' }, { from: 'qa', text: 'QA VERDICT: PASS\nfine' },
    { from: 'factory', text: '[factory] 📌 Decision taken: x', decided: { id: 'd1', question: 'q', options: ['a', 'b'], chosen: 'a' } });
  await bot.pushUpdates(); assert.equal(posted(i).length, 0, 'progress, review, QA and decided notes are silent');
  i = calls.length; await bot.pushUpdates(); assert.equal(posted(i).length, 0, 'and not sent later either');
  i = calls.length; t.messages.push({ from: 'agent', text: 'DECISION NEEDED\nWhich DB?' });
  await bot.pushUpdates(); assert.equal(posted(i).length, 1); assert.match(posted(i)[0].p.text, /Decision needed/);
  i = calls.length; t.messages.push({ from: 'factory', text: '[factory] STUCK: nothing moves', ping: true });
  await bot.pushUpdates(); assert.equal(posted(i).length, 1); assert.match(posted(i)[0].p.text, /Stuck/);
  i = calls.length; t.messages.push({ from: 'factory', text: '[factory] ✅ Ready for your check', approve: { sha: 'abc', pr: 1 } });
  await bot.pushUpdates(); assert.equal(posted(i).length, 1);
  const b = mk('shop', 'briefed', { phase: 'brief', status: 'waiting for you', title: 'briefed' });
  b.messages.push({ from: 'agent', text: 'Playbook: feature. Plan...' });
  i = calls.length; await bot.pushUpdates();
  const m = posted(i).find((c) => /Brief/.test(c.p.text)); assert.ok(m, 'a brief awaiting Go is posted'); assert.ok(m.p.blocks.some((x) => x.type === 'actions'));
});
await step('notify: SLACK_NOTIFY=all posts everything again', async () => {
  process.env.SLACK_NOTIFY = 'all';
  const t = mk('shop', 'chatty task', { phase: 'run', status: 'running', title: 'chatty task' });
  await bot.pushUpdates();
  const i = calls.length; t.messages.push({ from: 'agent', text: 'progress' }, { from: 'review', text: 'VERDICT: PASS\nok' });
  await bot.pushUpdates(); assert.equal(posted(i).length, 2);
});
await step('notify: a brief saved while the task is still briefing is not lost', async () => {
  delete process.env.SLACK_NOTIFY;
  const b = mk('shop', 'racy', { phase: 'brief', status: 'briefing', title: 'racy' });
  await bot.pushUpdates();
  b.messages.push({ from: 'agent', text: 'Playbook: feature. The brief.' });
  let i = calls.length; await bot.pushUpdates(); assert.equal(posted(i).length, 0, 'not yet waiting for you');
  b.status = 'waiting for you';
  i = calls.length; await bot.pushUpdates(); assert.equal(posted(i).length, 1); assert.match(posted(i)[0].p.text, /Brief/);
});
await step('notify: the morning digest and "Queue done" are off by default and on with SLACK_NOTIFY=all', async () => {
  const noon = Date.parse('2026-11-12T07:00:00Z');
  const q = mk('shop', 'queued', { phase: 'run', status: 'ready for you', title: 'queued' });
  bot.state.batches.bq = { ids: [q.id], project: 'shop', reported: false };
  delete process.env.SLACK_NOTIFY; bot.state.lastDigest = '2026-11-11';
  let i = calls.length; await bot.morning(noon); await bot.pushUpdates();
  assert.equal(posted(i).length, 0, 'no digest, no queue summary'); assert.equal(bot.state.batches.bq.reported, true, 'the batch is closed silently');
  bot.state.batches.bq2 = { ids: [q.id], project: 'shop', reported: false };
  process.env.SLACK_NOTIFY = 'all'; bot.state.lastDigest = '2026-11-11';
  i = calls.length; await bot.morning(noon); await bot.pushUpdates();
  assert.ok(posted(i).some((c) => /Factory, last 24 hours/.test(c.p.text))); assert.ok(posted(i).some((c) => /Queue done/.test(c.p.text)));
});
await step('notify: a task parked on your call (round limit) is posted; the same note on a running task is not', async () => {
  delete process.env.SLACK_NOTIFY;
  const t = mk('shop', 'limit', { phase: 'run', status: 'working', title: 'limit' });
  await bot.pushUpdates();
  let i = calls.length; t.messages.push({ from: 'factory', text: '[factory] some note' }); await bot.pushUpdates(); assert.equal(posted(i).length, 0);
  t.status = 'waiting for you'; t.waitingOn = 'your call: QA failures are still open at the round limit';
  i = calls.length; t.messages.push({ from: 'factory', text: '[factory] round limit (3) reached with QA failures open: stopped. A person decides what next.' });
  await bot.pushUpdates(); assert.equal(posted(i).length, 1); assert.match(posted(i)[0].p.text, /round limit/);
});
await step('notify: a task parked on your call by an agent turn posts once, whoever spoke last', async () => {
  delete process.env.SLACK_NOTIFY;
  const t = mk('shop', 'nopr', { phase: 'run', status: 'working', title: 'nopr' });
  await bot.pushUpdates();
  let i = calls.length; t.messages.push({ from: 'agent', text: 'I stopped without a PR.' }); await bot.pushUpdates(); assert.equal(posted(i).length, 0);
  t.status = 'waiting for you'; t.waitingOn = 'your call: the agent ended 2 turns without opening a PR';
  i = calls.length; await bot.pushUpdates(); assert.equal(posted(i).length, 1); assert.match(posted(i)[0].p.text, /Waiting for you[\s\S]*without opening a PR/);
  i = calls.length; await bot.pushUpdates(); assert.equal(posted(i).length, 0, 'once');
});
console.log(`all ${ok} passed`);
slackSrv.close(); agentsSrv.close(); process.exit(0);
