// The factory in Slack: one channel per task. Socket Mode (outbound only, no
// public endpoint), answers only its paired owner, talks to factory-agents.
//  - create a channel and write your idea in it: that is the task. The
//    channel name can pick the project (<project>-…); otherwise the
//    factory works it out from the words and asks with buttons when unsure
//  - or DM the bot: a plain message starts a task in a new channel; "queue:",
//    "bug:", "epic:" (or "program:") as on Telegram ("<project>:" picks the project)
//  - tasks from issues, queues and programs get their own channel too
//  - everything you write in a task's channel goes to that task; briefs and
//    plans get a Go button; an epic starts in a discussion with a Plan it button
//  - when the PR is merged or closed (or the task is stopped or done), the
//    channel is archived
//  - /factory pause | resume | stop (in a task's channel), status, tasks,
//    digest, help; the morning summary arrives in the DM at 08:00 Tashkent
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const SECRETS = process.env.SECRETS_DIR ?? '/run/factory';
const STATE_FILE = process.env.BOT_STATE ?? '/data/state.json';
const AGENTS = process.env.AGENTS_API ?? 'http://172.24.0.1:19300';
const SLACK = process.env.SLACK_API ?? 'https://slack.com/api';
const FACTS = process.env.FACTS_FILE ?? '/srv/factory/state/status.json';
const DASHBOARD = process.env.DASHBOARD ?? 'https://factory.contentcoach.org';
const PUSH_EVERY_MS = Number(process.env.PUSH_EVERY_MS ?? 15000);
// project -> channel-name prefixes (the first is used for channels the bot makes)
// the projects come from the factory (GET /projects), refreshed every few
// minutes: adding a project is a box config change, never a code change here
export let PROJECTS = { factory: ['factory'] };
let NAMES = 'factory';
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function setProjects(list) {
  const names = (Array.isArray(list) ? list : []).map((p) => String(p?.name ?? '').toLowerCase()).filter((n) => /^[a-z0-9][a-z0-9_-]{0,30}$/.test(n));
  if (!names.length) return PROJECTS;
  PROJECTS = Object.fromEntries(names.map((n) => [n, [n]]));
  NAMES = names.map(escRe).join('|');
  return PROJECTS;
}
export async function loadProjects() {
  try { return setProjects(await agents('/projects')); } catch (e) { log('projects.error', { error: e.message }); return PROJECTS; }
}
const secret = (n) => readFileSync(`${SECRETS}/${n}`, 'utf8').trim();
const log = (event, f = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...f }));

// ---- state: owner, DM channel, pairing code, task <-> channel, what was sent
export const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
state.sent ??= {}; state.taskChannel ??= {}; state.channelTask ??= {}; state.archived ??= {}; state.batches ??= {}; state.skip ??= {}; state.fresh ??= {}; state.pending ??= {}; state.planPosted ??= {}; state.topic ??= {};
if (!state.owner && !state.pairing) state.pairing = randomBytes(4).toString('hex');
const persist = () => writeFileSync(STATE_FILE, JSON.stringify(state));
persist();

export async function slack(method, payload, token = secret('slack-bot-token')) {
  const r = await fetch(`${SLACK}/${method}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(payload ?? {}), signal: AbortSignal.timeout(20000) });
  const j = await r.json();
  if (!j.ok) throw Object.assign(new Error(`${method}: ${j.error}`), { slack: j.error });
  return j;
}
async function agents(path, init = {}, timeoutMs = 10000) {
  const r = await fetch(`${AGENTS}${path}`, { ...init, headers: { authorization: `Bearer ${secret('agents-token')}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error ?? r.status); return j;
}

// ---- images the person attaches: Slack keeps them private, so the bot fetches
// them with its own token (needs the files:read scope) and hands them to the
// agents API, which saves them into the task's workspace
export const MAX_IMAGES = 6;
export const imageFilesOf = (ev) => (ev?.files ?? []).filter((f) => /^image\//.test(f?.mimetype ?? '')).slice(0, MAX_IMAGES)
  .map((f) => ({ id: f.id, name: f.name ?? f.title ?? 'image', url: f.url_private_download ?? f.url_private ?? null }));
export async function downloadImages(files, { token = secret('slack-bot-token'), get = fetch } = {}) {
  const attachments = [], problems = [];
  for (const f of files ?? []) {
    try {
      let url = f.url;
      if (!url) url = (await slack('files.info', { file: f.id }, token)).file?.url_private_download;
      if (!url) throw new Error('no download link');
      const r = await get(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      // without files:read Slack answers with its sign-in page, not the file
      if (/text\/html/.test(r.headers.get('content-type') ?? '')) throw new Error('Slack sent a sign-in page: the app needs the files:read permission');
      attachments.push({ name: f.name, data: Buffer.from(await r.arrayBuffer()).toString('base64') });
    } catch (e) { problems.push(`${f.name}: ${e.message}`); }
  }
  return { attachments, problems };
}
// the attachments to send, plus a warning for the person when some could not be read
async function withImages(files, channel) {
  if (!files?.length) return [];
  const { attachments, problems } = await downloadImages(files);
  if (problems.length) await post(channel ?? state.dm, `⚠️ I couldn't read ${problems.length === files.length ? 'your image' + (files.length > 1 ? 's' : '') : 'some images'}, so the agent won't see ${problems.length > 1 ? 'them' : 'it'}:\n${problems.map((p) => `• ${esc(p)}`).join('\n')}`).catch(() => {});
  return attachments;
}

// ---- formatting: Slack mrkdwn, short messages, the full text one tap away
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const short = (s, n = 60) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
function clip(s, n) {
  if (s.length <= n) return { text: s, cut: false };
  const at = s.lastIndexOf('\n', n);
  return { text: s.slice(0, at > n / 2 ? at : n).trimEnd(), cut: true };
}
export function mrkdwn(md) {
  const blocks = [];
  let h = md.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, c) => `\u0000${blocks.push(c.trimEnd()) - 1}\u0000`);
  h = esc(h)
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>')
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1_$2_')
    .replace(/^(\s*)[-*]\s+/gm, (_, sp) => `${sp}• `)
    .replace(/\n{3,}/g, '\n\n');
  return h.replace(/\u0000(\d+)\u0000/g, (_, i) => '```' + esc(blocks[i]) + '```');
}
const taskLink = (id) => `${DASHBOARD}/?task=${id}`;
const isBriefLike = (t) => (t.kind === 'program' && t.phase === 'brief') || (t.kind === 'change' && t.phase === 'brief' && t.status === 'waiting for you');
// one task message, ready to post: { text, go, plan } (go: show a Go button; plan: a Plan it button, epic in talk phase)
export function render(t, m) {
  const links = [t.pr ? `<${t.pr.url}|PR #${t.pr.number}>` : '', `<${taskLink(t.id)}|full conversation>`].filter(Boolean).join(' · ');
  const head = (icon, label) => `${icon} *${esc(label)}*`;
  if (m.from === 'review') {
    const verdict = /VERDICT:\s*(PASS|CHANGES)/i.exec(m.text)?.[1]?.toUpperCase();
    const [main, notes = ''] = m.text.replace(/^\s*VERDICT:.*$/gim, '').trim().split(/^#{1,6}\s*Notes\b.*$/im);
    const n = (notes.match(/^\s*[-*]\s/gm) ?? []).length;
    const body = clip(main.trim() + (n ? `\n\n_${n} non-blocking note${n === 1 ? '' : 's'} on the PR._` : ''), 2500);
    const label = verdict === 'PASS' ? 'Review passed' : verdict === 'CHANGES' ? 'Reviewer asked for changes: the agent is on it' : 'Review finished without a verdict';
    return { text: `${head(verdict === 'PASS' ? '✅' : verdict === 'CHANGES' ? '🔁' : '⚠️', label)}\n${mrkdwn(body.text)}${body.cut ? '\n…' : ''}\n${links}` };
  }
  if (m.from === 'qa') {
    const verdict = /QA VERDICT:\s*(PASS|FAIL|NOT APPLICABLE)/i.exec(m.text)?.[1]?.toUpperCase();
    const body = clip(m.text.replace(/^\s*QA VERDICT:.*$/gim, '').trim(), 2500);
    const label = verdict === 'PASS' ? 'QA passed on the preview: on to review' : verdict === 'FAIL' ? 'QA found failures: the agent is on it' : verdict === 'NOT APPLICABLE' ? 'Nothing for QA to test: on to review' : 'QA finished without a verdict';
    return { text: `${head(verdict === 'PASS' ? '🧪' : verdict === 'FAIL' ? '🔁' : verdict === 'NOT APPLICABLE' ? '➖' : '⚠️', label)}\n${mrkdwn(body.text)}${body.cut ? '\n…' : ''}\n${links}` };
  }
  if (m.from === 'factory') return { text: `🏭 ${mrkdwn(clip(m.text.replace(/^\[factory\]\s*/, '').split('\n')[0], 400).text)}` };
  const decision = /^\s*DECISION NEEDED\b/m.test(m.text);
  const body = clip(m.text, 3500);
  const triage = t.kind === 'report' && /^TRIAGE:\s*(\S+)\s+(\S+)\s*(\S*)/m.exec(m.text);
  const brief = !decision && isBriefLike(t);
  const talk = !decision && t.kind === 'program' && t.phase === 'talk';
  const label = decision ? 'Decision needed: reply here with your choice'
    : talk ? 'Epic discussion: talk it through, then Plan it'
    : t.kind === 'program' ? (t.phase === 'brief' ? 'Epic plan: Go, or reply to change it' : 'Epic coordinator')
    : triage ? `Triage: ${triage[1]} → ${triage[2]}`
    : brief ? 'Brief: Go, or reply with your answers' : 'Agent';
  const icon = decision ? '❓' : t.kind === 'program' ? '🧭' : t.kind === 'report' ? '🔎' : '🤖';
  return { text: `${head(icon, label)}\n${mrkdwn(body.text)}${body.cut ? '\n…' : ''}\n${links}`, go: brief, plan: talk };
}
async function post(channel, text, { go, plan, taskId } = {}) {
  const chunks = []; for (let i = 0; i < text.length; i += 3900) chunks.push(text.slice(i, i + 3900));
  for (const [i, c] of chunks.entries()) {
    const last = i === chunks.length - 1;
    const btn = go ? ['Go', 'go'] : plan ? ['Plan it', 'plan'] : null;
    const blocks = btn && last ? [{ type: 'section', text: { type: 'mrkdwn', text: c } }, { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: btn[0] }, style: 'primary', action_id: btn[1], value: taskId }] }] : undefined;
    await slack('chat.postMessage', { channel, text: c, blocks, unfurl_links: false, unfurl_media: false });
  }
}
const dm = (text) => (state.dm ? post(state.dm, text) : Promise.resolve());

// ---- projects and channels
export function projectOfChannel(name = '') {
  for (const [p, prefixes] of Object.entries(PROJECTS)) if (prefixes.some((x) => name === x || name.startsWith(`${x}-`) || name.startsWith(`${x}_`))) return p;
  return null;
}
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
export const channelName = (t) => t.kind === 'program' ? `epic-${slug(t.title.replace(/^\s*epic\b\s*:?\s*/i, '')) || 'epic'}-${t.id.slice(-6)}`.slice(0, 80) : `${PROJECTS[t.project]?.[0] ?? t.project}-${slug(t.title) || 'task'}-${t.id.slice(-6)}`.slice(0, 80);
function bind(taskId, channel) { state.taskChannel[taskId] = channel; state.channelTask[channel] = taskId; persist(); }
async function channelFor(t) {
  if (state.taskChannel[t.id]) return state.taskChannel[t.id];
  let c;
  try { c = (await slack('conversations.create', { name: channelName(t) })).channel; }
  catch (e) { if (e.slack !== 'name_taken') throw e; c = (await slack('conversations.create', { name: `${channelName(t).slice(0, 72)}-${randomBytes(3).toString('hex')}` })).channel; }
  bind(t.id, c.id);
  await slack('conversations.invite', { channel: c.id, users: state.owner }).catch((e) => log('invite.error', { error: e.message }));
  await slack('conversations.setTopic', { channel: c.id, topic: `${t.project} · ${t.id} · ${taskLink(t.id)}` }).catch(() => {});
  return c.id;
}
// ---- an epic's own channel: topic "M/T merged" + the epic issue, the plan once, then the factory's lines
let taskList = [];
const isMerged = (k) => k && (k.pr?.state === 'merged' || k.status === 'merged');
export function epicTopic(t, list = taskList) {
  const byId = Object.fromEntries(list.map((k) => [k.id, k]));
  const plan = t.plan ?? [];
  const merged = plan.filter((i) => isMerged(byId[i.taskId])).length;
  return [`${merged}/${plan.length} merged`, t.epicIssue?.url, `${t.project} · ${t.id}`, taskLink(t.id)].filter(Boolean).join(' · ');
}
export function planSummary(t) {
  const plan = t.plan ?? [], w = Math.max(0, ...plan.map((i) => i.wave ?? 1));
  const lines = [`📋 *Plan approved: ${plan.length} task${plan.length === 1 ? '' : 's'} in ${w} wave${w === 1 ? '' : 's'}*`];
  for (let n = 1; n <= w; n++) lines.push(`*Wave ${n}*\n${plan.filter((i) => (i.wave ?? 1) === n).map((i) => `• ${esc(short(i.title, 80))}`).join('\n')}`);
  if (t.epicIssue?.url) lines.push(`Epic issue: <${t.epicIssue.url}|#${t.epicIssue.number}>`);
  return lines.join('\n');
}
async function syncEpicChannel(t, ch) {
  if (t.kind !== 'program' || !ch) return;
  if (t.phase === 'run' && t.plan?.length && !state.planPosted[t.id]) {
    state.planPosted[t.id] = true; persist();
    await post(ch, planSummary(t));
  }
  const topic = epicTopic(t);
  if (t.plan?.length && state.topic[t.id] !== topic) {
    await slack('conversations.setTopic', { channel: ch, topic: topic.slice(0, 250) }).catch((e) => log('topic.error', { error: e.message }));
    state.topic[t.id] = topic; persist();
  }
}
const finished = (t) => ['merged', 'closed'].includes(t.pr?.state) || ['merged', 'done', 'stopped'].includes(t.status);
async function archiveIfFinished(t) {
  const ch = state.taskChannel[t.id];
  if (!ch || state.archived[t.id] || t.running || !finished(t)) return;
  const why = t.pr?.state === 'merged' || t.status === 'merged' ? `PR #${t.pr?.number ?? ''} merged` : t.pr?.state === 'closed' ? `PR #${t.pr.number} closed` : `task ${t.status}`;
  await post(ch, `📦 ${why}: archiving this channel. The conversation stays on the <${taskLink(t.id)}|dashboard>.`);
  await slack('conversations.archive', { channel: ch }).catch((e) => { if (e.slack !== 'already_archived') throw e; });
  state.archived[t.id] = true; persist();
  log('archived', { task: t.id, channel: ch, why });
}

// ---- incoming
const help = () => `*What I understand* (projects: ${Object.keys(PROJECTS).map((p) => `\`${p}\``).join(', ')})
• create a channel and write your idea: that's the task (name it \`<project>-…\` to pick the project, or I'll work it out and ask if unsure)
• or DM me: a plain message starts a task in a new channel (I work out the project from your words and ask if unsure; \`<project>:\` at the start picks it)
• \`queue:\` + one task per line · \`bug:\` + what's wrong · \`epic:\` + a big goal: you talk it through with the coordinator, press Plan it (or write plan) and it plans every task with what it depends on, then press Go; unrelated tasks run in parallel (add the project, e.g. \`epic <project>:\`)
• in a task's channel, everything you write goes to the agent; Go starts a brief or a plan; Plan it ends an epic discussion
• \`/factory pause\` · \`resume\` · \`stop\` in a task's channel; \`/factory status\` · \`tasks\` · \`digest\` · \`help\` anywhere`;

// ---- what to start, once the project is known
// kind: task | queue | bug | program; channel: the founder's own channel (task only)
async function begin(kind, project, text, channel, note = '', files = []) {
  if (kind === 'queue') {
    const items = text.split('\n').map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean);
    const b = await agents('/batches', { method: 'POST', body: JSON.stringify({ project, items }) });
    state.batches[b.batch] = { ids: b.tasks.map((t) => t.id), project, reported: false };
    for (const t of b.tasks) state.sent[t.id] = 1;
    persist();
    for (const t of b.tasks) await channelFor(t);
    return dm(`📦 *Queue started: ${b.tasks.length} tasks* (${project}${note}), each in its own channel. One summary comes here when all are done.`);
  }
  const attachments = await withImages(files, channel);
  const wait = attachments.length ? 120000 : 10000;
  if (kind === 'bug' || kind === 'program') {
    const t = kind === 'bug'
      ? await agents('/tasks', { method: 'POST', body: JSON.stringify({ project, kind: 'report', text, attachments }) }, wait)
      : await agents('/programs', { method: 'POST', body: JSON.stringify({ project, goal: text, attachments }) }, wait);
    state.sent[t.id] = 1; persist();
    const ch = await channelFor(t);
    return dm(`${kind === 'bug' ? '🔎 Triage' : '🧭 Epic'} started (${project}${note}) in <#${ch}>.`);
  }
  const t = await agents('/tasks', { method: 'POST', body: JSON.stringify({ project, text, attachments }) }, wait);
  state.sent[t.id] = 1; // the person's own message is #0
  if (channel) bind(t.id, channel); else persist();
  const ch = channel ?? await channelFor(t);
  await post(ch, `▶️ Task \`${t.id}\` started (${project}${note}). The brief comes next: press Go or answer it here.`);
  if (!channel) await dm(`▶️ Task \`${t.id}\` started (${project}${note}) in <#${ch}>.`);
  return t;
}

// ---- no project named: guess from the words, ask when unsure
const titleCase = (p) => p[0].toUpperCase() + p.slice(1);
async function resolve(kind, text, channel, files = []) {
  let guess = { project: null, why: '' };
  try { guess = await agents('/classify', { method: 'POST', body: JSON.stringify({ text: text || '(only an image was sent)' }) }, 120000); } catch (e) { log('classify.error', { error: e.message }); }
  if (guess.project && PROJECTS[guess.project]) {
    return begin(kind, guess.project, text, channel, `, guessed from your message: ${esc(guess.why || titleCase(guess.project))}. Wrong project? \`/factory stop\` and resend starting with the project name`, files);
  }
  const key = randomBytes(4).toString('hex');
  state.pending[key] = { kind, text, channel: channel ?? null, files, at: new Date().toISOString() }; persist();
  const where = channel ?? state.dm;
  const why = guess.why ? ` (${esc(guess.why)})` : '';
  await slack('chat.postMessage', { channel: where, text: `Which project is this for?${why}`, blocks: [
    { type: 'section', text: { type: 'mrkdwn', text: `🤔 *Which project is this for?*${why}\n_${esc(short(text.split('\n')[0], 120))}_` } },
    { type: 'actions', elements: Object.keys(PROJECTS).map((p) => ({ type: 'button', text: { type: 'plain_text', text: titleCase(p) }, action_id: `pick_${p}`, value: `${key}|${p}` })) },
  ] });
}

export async function onMessage(ev) {
  if (ev.bot_id || (ev.subtype && ev.subtype !== 'file_share')) return;
  const text = (ev.text ?? '').trim();
  if (!state.owner) {
    if (ev.channel_type !== 'im') return;
    const code = text.replace(/^pair\s*/i, '');
    if (state.pairing && code.length === state.pairing.length && timingSafeEqual(Buffer.from(code), Buffer.from(state.pairing))) {
      state.owner = ev.user; state.dm = ev.channel; delete state.pairing; persist();
      log('paired', { owner: ev.user });
      return post(ev.channel, `Paired.\n\n${help()}`);
    }
    return; // silent to strangers
  }
  const files = imageFilesOf(ev);
  if (ev.user !== state.owner || (!text && !files.length)) return;
  const taskId = state.channelTask[ev.channel];
  if (taskId) {
    // a bare stop / pause / resume is a command, not an answer for the agent
    const cmd = /^(stop|pause|resume)[.!]?$/i.exec(text)?.[1]?.toLowerCase();
    if (cmd) { const r = await onCommand({ user_id: ev.user, channel_id: ev.channel, text: cmd }); return post(ev.channel, r.text); }
    const attachments = await withImages(files, ev.channel);
    if (!text && !attachments.length) return;
    await agents(`/tasks/${taskId}/messages`, { method: 'POST', body: JSON.stringify({ text, attachments }) }, attachments.length ? 120000 : 10000);
    return slack('reactions.add', { channel: ev.channel, timestamp: ev.ts, name: 'eyes' }).catch(() => {});
  }
  if (ev.channel_type === 'im') return onDm(text, files);
  if (state.fresh[ev.channel]) {
    // a channel the founder just created: its first message is the idea.
    // Any other channel the bot happens to be in is never a task.
    delete state.fresh[ev.channel]; persist();
    const info = (await slack('conversations.info', { channel: ev.channel })).channel;
    const named = projectOfChannel(info.name);
    return named ? begin('task', named, text, ev.channel, '', files) : resolve('task', text, ev.channel, files);
  }
}

async function onDm(text, files = []) {
  const q = text.match(new RegExp(`^queue(?:\\s+(${NAMES}))?\\s*(?::|(?=\\n)|$)`, 'i'));
  const k = !q && text.match(new RegExp(`^(bug|program|epic)(?:\\s+(${NAMES}))?\\s*:\\s*`, 'i'));
  const m = !q && !k && text.match(new RegExp(`^(${NAMES})\\s*:\\s*`, 'i'));
  const kind = q ? 'queue' : k ? (k[1].toLowerCase() === 'epic' ? 'program' : k[1].toLowerCase()) : 'task';
  const project = (q?.[1] ?? k?.[2] ?? m?.[1])?.toLowerCase() ?? null;
  const rest = (q ? text.slice(q[0].length) : k ? text.slice(k[0].length) : m ? text.slice(m[0].length) : text).trim();
  if (!rest && !(files.length && kind !== 'queue')) return kind === 'queue' ? dm('A queue is one task per line:\n```queue:\n- make the Save button sticky on phones\n- fix the login redirect```') : dm(help());
  return project ? begin(kind, project, rest, undefined, '', kind === 'queue' ? [] : files) : resolve(kind, rest, undefined, kind === 'queue' ? [] : files);
}

// a channel the founder creates: join it so its first message can become the task
export async function onChannelCreated(ev) {
  if (!state.owner || ev.channel?.creator !== state.owner) return;
  await slack('conversations.join', { channel: ev.channel.id });
  state.fresh[ev.channel.id] = true; persist();
  log('joined', { channel: ev.channel.id, name: ev.channel.name });
}

export async function onCommand(p) {
  if (p.user_id !== state.owner) return { text: 'Not paired with you.' };
  const [cmd = 'help'] = (p.text ?? '').trim().toLowerCase().split(/\s+/);
  const taskId = state.channelTask[p.channel_id];
  if (['pause', 'stop', 'resume'].includes(cmd)) {
    if (!taskId) return { text: 'Use this in a task\'s channel.' };
    if (cmd === 'resume') await agents(`/tasks/${taskId}/messages`, { method: 'POST', body: JSON.stringify({ text: 'Resume: read your resume note and decision log, then carry on.' }) });
    else await agents(`/tasks/${taskId}/${cmd}`, { method: 'POST' });
    return { response_type: 'in_channel', text: `${cmd === 'pause' ? '⏸ pausing' : cmd === 'stop' ? '⏹ stopped' : '▶️ resuming'} \`${taskId}\`` };
  }
  if (cmd === 'status') return { text: statusLine() };
  if (cmd === 'digest') { sendDigest(24).catch((e) => log('digest.error', { error: e.message })); return { text: 'The summary is on its way to our DM.' }; }
  if (cmd === 'tasks') {
    const tasks = (await agents('/tasks')).filter((t) => !finished(t)).slice(0, 15);
    return { text: tasks.length ? tasks.map((t) => `• \`${t.id}\` ${esc(short(t.title))} · ${t.status}${state.taskChannel[t.id] ? ` · <#${state.taskChannel[t.id]}>` : ''}`).join('\n') : 'No active tasks.' };
  }
  return { text: help() };
}

export async function onAction(p) {
  if (p.user?.id !== state.owner) return;
  const a = p.actions?.[0];
  if (a?.action_id?.startsWith('pick_')) {
    const [key, project] = String(a.value ?? '').split('|');
    const job = state.pending[key];
    if (!job || !PROJECTS[project]) return;
    delete state.pending[key]; persist();
    if (p.channel?.id && p.message?.ts) await slack('chat.update', { channel: p.channel.id, ts: p.message.ts, text: `Project: ${project}`, blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text: `✔️ ${titleCase(project)}: ${esc(short(job.text.split('\n')[0], 120))}` }] }] }).catch(() => {});
    return begin(job.kind, project, job.text, job.channel ?? undefined, '', job.files ?? []);
  }
  if (!['go', 'plan'].includes(a?.action_id) || !a.value) return;
  const planIt = a.action_id === 'plan';
  await agents(`/tasks/${a.value}/messages`, { method: 'POST', body: JSON.stringify({ text: a.action_id }) });
  // replace the button with who pressed it, so it can't be pressed twice
  const section = p.message?.blocks?.find((b) => b.type === 'section');
  if (p.channel?.id && p.message?.ts) await slack('chat.update', { channel: p.channel.id, ts: p.message.ts, text: p.message.text, blocks: [...(section ? [section] : []), { type: 'context', elements: [{ type: 'mrkdwn', text: planIt ? '🗺️ Plan it: the coordinator is writing the plan.' : '▶️ Go: the agent is on it.' }] }] }).catch(() => {});
}

function statusLine() {
  try {
    const f = JSON.parse(readFileSync(FACTS, 'utf8'));
    const bad = [...Object.entries(f.services ?? {}).filter(([, s]) => !['active', 'running', 'healthy'].includes(s)).map(([k]) => k), ...(f.runners ?? []).filter((r) => r.active !== 'active').map((r) => r.name)];
    return `${bad.length ? `⚠️ needs a look: ${bad.join(', ')}` : '✅ factory healthy'} · disk ${f.disk_used_pct}% · ${f.agent_containers_running ?? 0} agents running · <${DASHBOARD}|dashboard>`;
  } catch { return `factory facts unavailable · <${DASHBOARD}|dashboard>`; }
}

// ---- outgoing: what's new in each task goes to its channel
export async function pushUpdates() {
  if (!state.owner) return;
  taskList = await agents('/tasks');
  for (const t of taskList) {
    if (state.archived[t.id] || state.skip[t.id]) continue;
    const full = { ...(await agents(`/tasks/${t.id}`)), running: t.running };
    const from = state.sent[t.id] ?? 0;
    const fresh = full.messages.slice(from).filter((m) => m.from !== 'you');
    if (fresh.length) {
      const ch = await channelFor(full);
      for (const m of fresh) { const r = render(full, m); await post(ch, r.text, { go: r.go, plan: r.plan, taskId: t.id }); }
    }
    state.sent[t.id] = full.messages.length; persist();
    if (full.kind === 'program') await syncEpicChannel(full, state.taskChannel[t.id]);
    await archiveIfFinished(full);
  }
  await batchSummaries();
}

const SETTLED = ['ready for you', 'decision needed', 'waiting for you', 'stopped', 'paused', 'done', 'merged'];
async function batchSummaries() {
  const open = Object.entries(state.batches).filter(([, b]) => !b.reported);
  if (!open.length) return;
  const tasks = await agents('/tasks');
  for (const [, b] of open) {
    const mine = tasks.filter((t) => b.ids.includes(t.id));
    if (mine.length < b.ids.length || mine.some((t) => t.running || !(SETTLED.includes(t.status) || t.pr?.state === 'merged'))) continue;
    const line = (t) => `${t.status === 'merged' || t.pr?.state === 'merged' ? '🚀' : t.status === 'ready for you' ? '✅' : t.status === 'decision needed' ? '❓' : t.status === 'stopped' ? '⏹' : '⚠️'} ${esc(short(t.title, 50))} · ${t.pr ? `<${t.pr.url}|PR #${t.pr.number}> · ` : ''}${t.status}`;
    const merged = mine.filter((t) => t.status === 'merged' || t.pr?.state === 'merged').length, ready = mine.filter((t) => t.status === 'ready for you').length;
    await dm(`📦 *Queue done: ${merged ? `${merged} merged, ` : ''}${ready} ready for you, of ${mine.length}*\n${mine.map(line).join('\n')}`);
    b.reported = true; persist();
  }
}

async function sendDigest(hours) {
  const d = await agents(`/digest?hours=${hours}`);
  const where = (t) => (state.taskChannel[t.id] && !state.archived[t.id] ? ` · <#${state.taskChannel[t.id]}>` : t.pr ? ` · <${t.pr.url}|PR #${t.pr.number}>` : '');
  const item = (t) => `• ${esc(short(t.title, 60))}${where(t)}`;
  const parts = [`☀️ *Factory, last ${hours} hours*`];
  if (d.ready.length) parts.push(`*Ready to merge (${d.ready.length})*\n${d.ready.map(item).join('\n')}`);
  if (d.decisions.length) parts.push(`*❓ Decisions for you (${d.decisions.length})*\n${d.decisions.map(item).join('\n')}`);
  if (d.waiting.length) parts.push(`*Waiting for you (${d.waiting.length})*\n${d.waiting.map((t) => `${item(t)} · ${esc(t.status)}`).join('\n')}`);
  if (d.moving.length) parts.push(`*Still moving (${d.moving.length})*\n${d.moving.map((t) => `${item(t)} · ${esc(t.status)}`).join('\n')}`);
  if (d.finished.length || d.merged.length) parts.push(`*Finished*: ${d.merged.length} merged, ${d.finished.length} triaged or completed`);
  if (d.stopped.length) parts.push(`*Stopped or paused*: ${d.stopped.map((t) => esc(short(t.title, 40))).join(', ')}`);
  if (parts.length === 1) parts.push('Quiet: nothing ran.');
  parts.push(`_Usage ≈ $${d.costUsd.toFixed(2)} at API prices_ · <${DASHBOARD}|dashboard>`);
  return dm(parts.join('\n\n'));
}
function morning() {
  const now = new Date(Date.now() + 5 * 3600e3); // Asia/Tashkent, UTC+5, no DST
  const day = now.toISOString().slice(0, 10);
  if (!state.owner || now.getUTCHours() < 8 || state.lastDigest === day) return;
  state.lastDigest = day; persist();
  sendDigest(24).catch((e) => log('digest.error', { error: e.message }));
}

// ---- Socket Mode: one WebSocket, every envelope acked at once
export async function dispatch(env) {
  const p = env.payload ?? {};
  if (env.type === 'events_api') {
    const ev = p.event ?? {};
    if (ev.type === 'message') return onMessage(ev);
    if (ev.type === 'channel_created') return onChannelCreated(ev);
  }
  if (env.type === 'interactive' && p.type === 'block_actions') return onAction(p);
}
function connect() {
  slack('apps.connections.open', {}, secret('slack-app-token')).then(({ url }) => {
    const ws = new WebSocket(url);
    ws.onmessage = async (e) => {
      let env; try { env = JSON.parse(e.data); } catch { return; }
      if (env.type === 'hello') return log('socket.ready');
      if (env.type === 'disconnect') { log('socket.disconnect', { reason: env.reason }); return ws.close(); }
      if (!env.envelope_id) return;
      const fail = (err) => { log('event.error', { type: env.type, error: err.message }); if (state.dm) dm(`Something went wrong: ${err.message}`).catch(() => {}); };
      if (env.type === 'slash_commands') {
        const reply = await onCommand(env.payload).catch((err) => { fail(err); return { text: `Something went wrong: ${err.message}` }; });
        return ws.send(JSON.stringify({ envelope_id: env.envelope_id, payload: reply }));
      }
      ws.send(JSON.stringify({ envelope_id: env.envelope_id }));
      dispatch(env).catch(fail);
    };
    ws.onclose = () => { log('socket.closed'); setTimeout(connect, 2000); };
    ws.onerror = (e) => log('socket.error', { error: e.message ?? String(e) });
  }).catch((e) => { log('socket.open.error', { error: e.message }); setTimeout(connect, 10000); });
}

export async function prime() {
  await loadProjects();
  // first run: no channels for history, only for tasks that start from now on
  if (state.primed) return;
  try { for (const t of await agents('/tasks')) { state.skip[t.id] = true; state.sent[t.id] = (await agents(`/tasks/${t.id}`)).messages.length; } } catch (e) { log('prime.error', { error: e.message }); return; }
  state.primed = true; persist();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (!state.owner) log('pairing', { code: state.pairing, hint: 'DM the bot: pair <code>' });
  await prime();
  state.lastDigest ??= new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10); persist();
  setInterval(() => pushUpdates().catch((e) => log('push.error', { error: e.message })), PUSH_EVERY_MS);
  setInterval(morning, 60000);
  setInterval(() => loadProjects(), 5 * 60000);
  log('started', { paired: !!state.owner });
  connect();
}
