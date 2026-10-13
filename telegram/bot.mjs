// @omarfactory_bot: the factory on your phone. Long-polls Telegram (no public
// endpoint), answers only its paired owner, and talks to factory-agents.
//  - a plain message starts a task ("factory: ..." for the factory repo;
//    ContentCoach by default); the brief comes back here
//  - replying to a task's message continues that task ("go", answers)
//  - new agent / [factory] messages are pushed to you
//  - "queue:" + one task per line starts a batch: every item runs without a
//    brief to a reviewed PR; one summary arrives when the whole batch settled
//  - ❓ marks a decision only you can make: reply with your choice
//  - /tasks, /status
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const SECRETS = process.env.SECRETS_DIR ?? '/run/factory';
const STATE_FILE = process.env.BOT_STATE ?? '/data/state.json';
const AGENTS = process.env.AGENTS_API ?? 'http://172.24.0.1:19300';
const FACTS = process.env.FACTS_FILE ?? '/srv/factory/state/status.json';
const DASHBOARD = 'https://factory.contentcoach.org';
const secret = (n) => readFileSync(`${SECRETS}/${n}`, 'utf8').trim();
const TG = `https://api.telegram.org/bot${secret('telegram-token')}`;
const log = (event, f = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...f }));

// state: owner, pairing code, offset, which messages of each task were sent,
// and which Telegram message belongs to which task
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
state.sent ??= {}; state.msgTask ??= {}; state.offset ??= 0; state.batches ??= {};
if (!state.owner && !state.pairing) { state.pairing = randomBytes(4).toString('hex'); }
const persist = () => writeFileSync(STATE_FILE, JSON.stringify(state));
persist();
if (!state.owner) log('pairing', { code: state.pairing, hint: 'send /start <code> to the bot' });

async function tg(method, payload) {
  const r = await fetch(`${TG}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(65000) });
  const j = await r.json(); if (!j.ok) throw new Error(`${method}: ${j.description}`); return j.result;
}
async function agents(path, init = {}) {
  const r = await fetch(`${AGENTS}${path}`, { ...init, headers: { authorization: `Bearer ${secret('agents-token')}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error ?? r.status); return j;
}
// ---- formatting for a phone: Telegram HTML instead of raw Markdown, short
// messages, the full text one tap away on the dashboard
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const short = (s, n = 60) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
// cut at a line break, so a code span or a tag is never cut in half
function clip(s, n) {
  if (s.length <= n) return { text: s, cut: false };
  const at = s.lastIndexOf('\n', n);
  return { text: s.slice(0, at > n / 2 ? at : n).trimEnd(), cut: true };
}
function html(md) {
  const blocks = [];
  let h = md.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, c) => `\u0000${blocks.push(c.trimEnd()) - 1}\u0000`);
  h = esc(h)
    .replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1<i>$2</i>')
    .replace(/^(\s*)[-*]\s+/gm, (_, sp) => `${sp}• `)
    .replace(/\n{3,}/g, '\n\n');
  return h.replace(/\u0000(\d+)\u0000/g, (_, i) => `<pre>${esc(blocks[i])}</pre>`);
}
const taskLink = (id) => `${DASHBOARD}/?task=${id}`;
async function sendHtml(text, taskId) {
  let m;
  try { m = await tg('sendMessage', { chat_id: state.owner, text, parse_mode: 'HTML', disable_web_page_preview: true }); }
  catch (e) { log('html.rejected', { error: e.message }); return send(text.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'), taskId); }
  if (taskId) state.msgTask[m.message_id] = taskId;
  persist();
}
// one task message, ready to send
function render(t, m) {
  const head = (icon, label) => `${icon} <b>${esc(label)}</b>\n${esc(short(t.title))} · <code>${t.id}</code>`;
  const links = [t.pr ? `<a href="${t.pr.url}">PR #${t.pr.number}</a>` : '', `<a href="${taskLink(t.id)}">full conversation</a>`].filter(Boolean).join(' · ');
  if (m.from === 'review') {
    const verdict = /VERDICT:\s*(PASS|CHANGES)/i.exec(m.text)?.[1]?.toUpperCase();
    // the phone gets the conclusion and what must be fixed; notes stay on the PR
    const [main, notes = ''] = m.text.replace(/^\s*VERDICT:.*$/gim, '').trim().split(/^#{1,6}\s*Notes\b.*$/im);
    const n = (notes.match(/^\s*[-*]\s/gm) ?? []).length;
    const body = clip(main.trim() + (n ? `\n\n_${n} non-blocking note${n === 1 ? '' : 's'} on the PR._` : ''), 900);
    const label = verdict === 'PASS' ? 'Review passed: ready for you to merge' : verdict === 'CHANGES' ? 'Reviewer asked for changes: the agent is on it' : 'Review finished without a verdict';
    return `${head(verdict === 'PASS' ? '✅' : verdict === 'CHANGES' ? '🔁' : '⚠️', label)}\n\n${html(body.text)}${body.cut ? '\n…' : ''}\n\n${links}`;
  }
  if (m.from === 'factory') {
    const text = m.text.replace(/^\[factory\]\s*/, '');
    return `🏭 ${html(clip(text.split('\n')[0], 400).text)}\n${esc(short(t.title))} · <code>${t.id}</code>`;
  }
  const decision = /^\s*DECISION NEEDED\b/m.test(m.text);
  const body = clip(m.text, decision ? 2500 : 1200);
  const label = decision ? 'Decision needed' : t.phase === 'brief' && t.status !== 'working' ? 'Brief: reply "go" or answer' : 'Agent';
  return `${head(decision ? '❓' : '🤖', label)}\n\n${html(body.text)}${body.cut ? '\n…' : ''}\n\n${links}${decision ? '\n\n<i>Reply to this message with your choice.</i>' : ''}`;
}
async function send(text, taskId) {
  for (let i = 0; i < text.length; i += 3800) {
    const m = await tg('sendMessage', { chat_id: state.owner, text: text.slice(i, i + 3800), disable_web_page_preview: true });
    if (taskId) { state.msgTask[m.message_id] = taskId; }
  }
  persist();
}

// ---- incoming
async function onMessage(msg) {
  const text = (msg.text ?? '').trim();
  if (!state.owner) {
    const code = text.replace(/^\/start\s*/, '');
    if (state.pairing && code.length === state.pairing.length && timingSafeEqual(Buffer.from(code), Buffer.from(state.pairing))) {
      state.owner = msg.from.id; delete state.pairing; persist();
      log('paired', { owner: msg.from.id });
      return send('Paired. Send me a task, e.g.\n"contentcoach: make the schedule sheet Save button sticky on phones"\nReply to my messages to continue a task. /tasks · /status');
    }
    return; // silent to strangers
  }
  if (msg.from.id !== state.owner) return;
  if (text === '/status') return send(statusLine());
  if (text === '/tasks' || text === '/start') {
    const tasks = (await agents('/tasks')).filter((t) => !['done', 'stopped'].includes(t.status)).slice(0, 10);
    return send(tasks.length ? tasks.map((t) => `#${t.id} · ${t.status}${t.pr ? ` · PR ${t.pr.url}` : ''}\n${t.title}`).join('\n\n') : 'No active tasks.');
  }
  const q = text.match(/^\/?queue(?:\s+(contentcoach|factory))?\s*(?::|(?=\n)|$)/i);
  if (q) {
    const project = (q[1] ?? 'contentcoach').toLowerCase();
    const items = text.slice(q[0].length).split('\n').map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean);
    if (!items.length) return send('A queue is one task per line:\nqueue:\n- make the Save button sticky on phones\n- fix the login redirect\n("queue factory:" for the factory repo)');
    const b = await agents('/batches', { method: 'POST', body: JSON.stringify({ project, items }) });
    state.batches[b.batch] = { ids: b.tasks.map((t) => t.id), project, reported: false };
    for (const t of b.tasks) state.sent[t.id] = 1;
    persist();
    return sendHtml(`📦 <b>Queue started: ${b.tasks.length} tasks</b> (${project})\nEach one runs to a reviewed PR. One summary comes when all are done.\n\n${b.tasks.map((t) => `• ${esc(short(t.title, 70))}`).join('\n')}`);
  }
  const replyTo = msg.reply_to_message?.message_id;
  const taskId = replyTo && state.msgTask[replyTo];
  if (taskId) {
    await agents(`/tasks/${taskId}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
    return send(`#${taskId}: got it, continuing.`, taskId);
  }
  const m = text.match(/^(contentcoach|factory)\s*:\s*/i);
  const project = m ? m[1].toLowerCase() : 'contentcoach';
  const task = await agents('/tasks', { method: 'POST', body: JSON.stringify({ project, text: m ? text.slice(m[0].length) : text }) });
  state.sent[task.id] = 1; // the person's own message is #0
  persist();
  return send(`#${task.id} started (${project}). The brief comes next; reply to it with "go" or your answers.`, task.id);
}

function statusLine() {
  try {
    const f = JSON.parse(readFileSync(FACTS, 'utf8'));
    const bad = [...Object.entries(f.services ?? {}).filter(([, s]) => !['active', 'running', 'healthy'].includes(s)).map(([k]) => k), ...(f.runners ?? []).filter((r) => r.active !== 'active').map((r) => r.name)];
    return `${bad.length ? `⚠️ needs a look: ${bad.join(', ')}` : '✅ factory healthy'} · disk ${f.disk_used_pct}% · ${f.agent_sandboxes_running ?? 0} OI sandboxes\n${DASHBOARD}`;
  } catch { return `factory facts unavailable · ${DASHBOARD}`; }
}

// ---- outgoing: push what's new in each task
async function pushUpdates() {
  if (!state.owner) return;
  for (const t of await agents('/tasks')) {
    const full = await agents(`/tasks/${t.id}`);
    const from = state.sent[t.id] ?? 0;
    const fresh = full.messages.slice(from).filter((m) => m.from !== 'you');
    for (const m of fresh) await sendHtml(render(full, m), t.id);
    state.sent[t.id] = full.messages.length; persist();
  }
  await batchSummaries();
}

// a batch is settled when no task in it is still moving
const SETTLED = ['ready for you', 'decision needed', 'waiting for you', 'stopped', 'done'];
async function batchSummaries() {
  const open = Object.entries(state.batches).filter(([, b]) => !b.reported);
  if (!open.length) return;
  const tasks = await agents('/tasks');
  for (const [id, b] of open) {
    const mine = tasks.filter((t) => b.ids.includes(t.id));
    if (mine.length < b.ids.length || mine.some((t) => t.running || !(SETTLED.includes(t.status) || t.pr?.state === 'merged'))) continue;
    const line = (t) => `${t.status === 'ready for you' ? '✅' : t.status === 'decision needed' ? '❓' : t.status === 'stopped' ? '⏹' : '⚠️'} ${esc(short(t.title, 50))}\n      ${t.pr ? `<a href="${t.pr.url}">PR #${t.pr.number}</a> · ` : ''}<a href="${taskLink(t.id)}">${t.status}</a>`;
    const ready = mine.filter((t) => t.status === 'ready for you').length;
    await sendHtml(`📦 <b>Queue done: ${ready} of ${mine.length} ready to merge</b>\n\n${mine.map(line).join('\n\n')}`);
    b.reported = true; persist();
  }
}

async function poll() {
  try {
    const updates = await tg('getUpdates', { offset: state.offset, timeout: 50, allowed_updates: ['message'] });
    for (const u of updates) {
      state.offset = u.update_id + 1; persist();
      if (u.message) await onMessage(u.message).catch((e) => { log('message.error', { error: e.message }); if (state.owner) send(`Something went wrong: ${e.message}`).catch(() => {}); });
    }
  } catch (e) { log('poll.error', { error: e.message }); await new Promise((r) => setTimeout(r, 5000)); }
  setImmediate(poll);
}
// first run: don't flood the owner with history
if (!state.primed) { try { for (const t of await agents('/tasks')) state.sent[t.id] = (await agents(`/tasks/${t.id}`)).messages.length; } catch {} state.primed = true; persist(); }
setInterval(() => pushUpdates().catch((e) => log('push.error', { error: e.message })), 15000);
log('started', { paired: !!state.owner });
poll();
