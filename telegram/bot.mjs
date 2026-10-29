// @omarfactory_bot: the factory on your phone. Long-polls Telegram (no public
// endpoint), answers only its paired owner, and talks to factory-agents.
//  - a plain message starts a task ("factory: ..." for the factory repo;
//    ContentCoach by default); the brief comes back here
//  - replying to a task's message continues that task ("go", answers)
//  - new agent / [factory] messages are pushed to you
//  - "queue:" + one task per line starts a batch: every item runs without a
//    brief to a reviewed PR; one summary arrives when the whole batch settled
//  - "bug:" + a report: triage (classify, dedupe, reproduce, file the issue)
//  - "program:" + a goal: a coordinator plans phases of PRs; reply "go"
//  - ❓ marks a decision only you can make: reply with your choice
//  - reply /pause, /resume or /stop to a task's message
//  - a morning summary at 08:00 Tashkent; /digest any time
//  - /tasks, /status, /help
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
const HELP = `<b>What I understand</b>
• a plain message starts a task (brief first). Prefix <code>factory:</code> for the factory repo
• <code>queue:</code> + one task per line: a batch, no briefs, one summary at the end
• <code>bug:</code> + what's wrong: triage, reproduce, file the issue (the fix starts by itself if it's clear)
• <code>program:</code> + a big goal: a plan in phases of PRs; reply "go"
• reply to a task's message to answer it; ❓ waits for your choice
• reply <code>/pause</code>, <code>/resume</code> or <code>/stop</code> to a task's message
• <code>/digest</code> the summary (it also comes at 08:00) · <code>/tasks</code> · <code>/status</code> · <code>/help</code>
Projects: contentcoach (default) or factory, e.g. <code>bug factory:</code> or <code>program factory:</code>.`;
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
  if (m.from === 'qa') {
    const verdict = /QA VERDICT:\s*(PASS|FAIL|NOT APPLICABLE)/i.exec(m.text)?.[1]?.toUpperCase();
    const body = clip(m.text.replace(/^\s*QA VERDICT:.*$/gim, '').trim(), 900);
    const label = verdict === 'PASS' ? 'QA passed on the preview: on to review' : verdict === 'FAIL' ? 'QA found failures on the preview: the agent is on it' : verdict === 'NOT APPLICABLE' ? 'Nothing for QA to test: on to review' : 'QA finished without a verdict';
    return `${head(verdict === 'PASS' ? '🧪' : verdict === 'FAIL' ? '🔁' : verdict === 'NOT APPLICABLE' ? '➖' : '⚠️', label)}\n\n${html(body.text)}${body.cut ? '\n…' : ''}\n\n${links}`;
  }
  if (m.from === 'factory') {
    const text = m.text.replace(/^\[factory\]\s*/, '');
    return `🏭 ${html(clip(text.split('\n')[0], 400).text)}\n${esc(short(t.title))} · <code>${t.id}</code>`;
  }
  const decision = /^\s*DECISION NEEDED\b/m.test(m.text);
  const body = clip(m.text, decision || t.kind === 'program' ? 2500 : 1200);
  const triage = t.kind === 'report' && /^TRIAGE:\s*(\S+)\s+(\S+)\s*(\S*)/m.exec(m.text);
  const label = decision ? 'Decision needed'
    : t.kind === 'program' ? (t.phase === 'brief' ? 'Program plan: reply "go" or change it' : 'Program coordinator')
    : triage ? `Triage: ${triage[1]} → ${triage[2]}`
    : t.phase === 'brief' && t.status !== 'working' ? 'Brief: reply "go" or answer' : 'Agent';
  const icon = decision ? '❓' : t.kind === 'program' ? '🧭' : t.kind === 'report' ? '🔎' : '🤖';
  return `${head(icon, label)}\n\n${html(body.text)}${body.cut ? '\n…' : ''}\n\n${links}${decision ? '\n\n<i>Reply to this message with your choice.</i>' : ''}`;
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
      return sendHtml(`Paired.\n\n${HELP}`);
    }
    return; // silent to strangers
  }
  if (msg.from.id !== state.owner) return;
  if (text === '/status') return send(statusLine());
  if (text === '/help') return sendHtml(HELP);
  if (text === '/digest') return sendDigest(24);
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
  const k = text.match(/^(bug|program)(?:\s+(contentcoach|factory))?\s*:\s*/i);
  if (k) {
    const project = (k[2] ?? 'contentcoach').toLowerCase(), rest = text.slice(k[0].length).trim();
    if (!rest) return sendHtml(HELP);
    const t = k[1].toLowerCase() === 'bug'
      ? await agents('/tasks', { method: 'POST', body: JSON.stringify({ project, kind: 'report', text: rest }) })
      : await agents('/programs', { method: 'POST', body: JSON.stringify({ project, goal: rest }) });
    state.sent[t.id] = 1; persist();
    return sendHtml(k[1].toLowerCase() === 'bug'
      ? `🔎 <b>Triage started</b> (${project})\nI'll classify it, look for duplicates, try to reproduce it and file the issue. If the fix is clear, it starts by itself.`
      : `🧭 <b>Program started</b> (${project})\nThe coordinator is reading the code and drafting a plan in phases. Reply "go" to it, or change it.`, t.id);
  }
  const replyTo = msg.reply_to_message?.message_id;
  const taskId = replyTo && state.msgTask[replyTo];
  if (taskId && /^\/(pause|stop)$/i.test(text)) {
    await agents(`/tasks/${taskId}/${text.slice(1).toLowerCase()}`, { method: 'POST' });
    return send(`${text.slice(1).toLowerCase() === 'pause' ? '⏸ pausing' : '⏹ stopped'} #${taskId}.`, taskId);
  }
  if (taskId && /^\/resume$/i.test(text)) {
    await agents(`/tasks/${taskId}/messages`, { method: 'POST', body: JSON.stringify({ text: 'Resume: read your resume note and decision log, then carry on.' }) });
    return send(`▶️ resuming #${taskId}.`, taskId);
  }
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
const SETTLED = ['ready for you', 'decision needed', 'waiting for you', 'stopped', 'paused', 'done', 'merged'];
async function batchSummaries() {
  const open = Object.entries(state.batches).filter(([, b]) => !b.reported);
  if (!open.length) return;
  const tasks = await agents('/tasks');
  for (const [id, b] of open) {
    const mine = tasks.filter((t) => b.ids.includes(t.id));
    if (mine.length < b.ids.length || mine.some((t) => t.running || !(SETTLED.includes(t.status) || t.pr?.state === 'merged'))) continue;
    const line = (t) => `${t.status === 'merged' || t.pr?.state === 'merged' ? '🚀' : t.status === 'ready for you' ? '✅' : t.status === 'decision needed' ? '❓' : t.status === 'stopped' ? '⏹' : '⚠️'} ${esc(short(t.title, 50))}\n      ${t.pr ? `<a href="${t.pr.url}">PR #${t.pr.number}</a> · ` : ''}<a href="${taskLink(t.id)}">${t.status}</a>`;
    const merged = mine.filter((t) => t.status === 'merged' || t.pr?.state === 'merged').length, ready = mine.filter((t) => t.status === 'ready for you').length;
    await sendHtml(`📦 <b>Queue done: ${merged ? `${merged} merged, ` : ''}${ready} ready for you, of ${mine.length}</b>\n\n${mine.map(line).join('\n\n')}`);
    b.reported = true; persist();
  }
}

// ---- the summary: what's ready, what needs you, what moved
async function sendDigest(hours) {
  const d = await agents(`/digest?hours=${hours}`);
  const pr = (t) => (t.pr ? ` · <a href="${t.pr.url}">PR #${t.pr.number}</a>` : '');
  const item = (t) => `• ${esc(short(t.title, 60))}${pr(t)}`;
  const parts = [`☀️ <b>Factory, last ${hours} hours</b>`];
  if (d.ready.length) parts.push(`<b>Ready to merge (${d.ready.length})</b>\n${d.ready.map((t) => `${item(t)}${t.attention && !/^\s*(nothing|none)\b/i.test(t.attention) ? `\n   <i>Attention:</i> ${html(clip(t.attention.replace(/\n+/g, ' '), 220).text)}` : ''}`).join('\n')}`);
  if (d.decisions.length) parts.push(`<b>❓ Decisions for you (${d.decisions.length})</b>\n${d.decisions.map(item).join('\n')}`);
  if (d.waiting.length) parts.push(`<b>Waiting for you (${d.waiting.length})</b>\n${d.waiting.map((t) => `${item(t)} · ${esc(t.status)}`).join('\n')}`);
  if (d.moving.length) parts.push(`<b>Still moving (${d.moving.length})</b>\n${d.moving.map((t) => `${item(t)} · ${esc(t.status)}`).join('\n')}`);
  if (d.finished.length || d.merged.length) parts.push(`<b>Finished</b>: ${d.merged.length} merged, ${d.finished.length} triaged or completed`);
  if (d.stopped.length) parts.push(`<b>Stopped or paused</b>: ${d.stopped.map((t) => esc(short(t.title, 40))).join(', ')}`);
  if (parts.length === 1) parts.push('Quiet: nothing ran.');
  parts.push(`<i>Usage ≈ $${d.costUsd.toFixed(2)} at API prices (your plan isn't charged; it counts toward its limits)</i> · <a href="${DASHBOARD}">dashboard</a>`);
  return sendHtml(parts.join('\n\n'));
}
// 08:00 in Tashkent, once a day
function morning() {
  const now = new Date(Date.now() + 5 * 3600e3); // Asia/Tashkent is UTC+5, no DST
  const day = now.toISOString().slice(0, 10);
  if (!state.owner || now.getUTCHours() < 8 || state.lastDigest === day) return;
  state.lastDigest = day; persist();
  sendDigest(24).catch((e) => log('digest.error', { error: e.message }));
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
state.lastDigest ??= new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10); persist(); // first summary tomorrow, not on deploy
setInterval(morning, 60000);
log('started', { paired: !!state.owner });
poll();
