// The dashboard's main view: conversations with factory agents, grouped by
// project, with each task's PR / preview / e2e pinned on top. Talks to
// factory-agents server-side; the browser never sees its token.
import { readFileSync } from 'node:fs';
import { shipped, deploys, openPrs } from './github.mjs';

const AGENTS = process.env.AGENTS_API ?? 'http://172.24.0.1:19300';
const ARTIFACTS = process.env.ARTIFACTS_DIR ?? '/srv/factory/artifacts';
const PREVIEW = { contentcoach: { prefix: 'cc', host: (n) => `https://pr${n}.contentcoach.org` } };
const token = () => readFileSync(`${process.env.SECRETS_DIR ?? '/run/factory'}/agents-token`, 'utf8').trim();

export async function agents(path, init = {}) {
  const r = await fetch(`${AGENTS}${path}`, { ...init, headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(8000) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error ?? `agents ${r.status}`); return j;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// just enough markdown for agent replies: code, bold, links, lists, line breaks
function md(text) {
  let h = esc(text);
  h = h.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, c) => `<pre>${c}</pre>`);
  h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  h = h.replace(/(https?:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  return h.replace(/\n/g, '<br>');
}
const ago = (t) => { const m = Math.round((Date.now() - new Date(t)) / 60000); return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };
const dot = (t) => t.running ? '<span class="dot live" title="working"></span>'
  : t.pr?.state === 'merged' || t.status === 'done' ? '<span class="dot done" title="done">✓</span>'
  : t.status === 'waiting for you' ? '<span class="dot you" title="waiting for you"></span>'
  : t.status === 'stopped' ? '<span class="dot off" title="stopped"></span>' : '<span class="dot wait" title="waiting for checks"></span>';

function e2eFor(project, pr) {
  const p = PREVIEW[project]; if (!p || !pr) return null;
  try { const s = JSON.parse(readFileSync(`${ARTIFACTS}/${p.prefix}/pr-${pr}/latest/report.json`, 'utf8')).run.summary; return s; } catch { return null; }
}

const STATE = process.env.STATE_DIR ?? '/srv/factory/state';
const settle = async (p, fallback) => { try { return await p; } catch (e) { return { error: e.message, fallback }; } };
const card = (body, href, label = 'view more →', ext = false) => `<div class="ov">${body}${href ? `<a class="more" href="${href}"${ext ? ' target="_blank" rel="noopener"' : ''}>${label}</a>` : ''}</div>`;
const quick = (id) => `<form method="post" action="/t/${id}/reply" class="qa"><input type="hidden" name="text" value="go"><button>Go</button></form>
  <form method="post" action="/t/${id}/reply" class="qa"><input type="hidden" name="text" value="go. Skip any questions and use your best judgment; log the decisions."><button>Go without questions</button></form>`;

async function overview(tasks, healthy) {
  let facts = {}; try { facts = JSON.parse(readFileSync(`${STATE}/status.json`, 'utf8')); } catch {}
  const [prs, ship, dep] = await Promise.all([settle(openPrs()), settle(shipped()), settle(deploys())]);
  const working = tasks.filter((t) => t.running);
  const needYou = tasks.filter((t) => !t.running && t.status === 'waiting for you');
  const live = Array.isArray(prs) ? prs : [];
  const head = `<div class="big">${working.length} agent${working.length === 1 ? '' : 's'} working · ${needYou.length} waiting for you · ${live.length} preview${live.length === 1 ? '' : 's'} live</div>
    <div class="hint">${healthy ? '<span style="color:#0f6e56">●</span> all healthy' : '<span style="color:#a32d2d">● the factory needs a look</span>'} · disk ${facts.disk_used_pct ?? '?'}% · data snapshot ${(facts.snapshots ?? []).map((x) => { const t = (x.note.match(/taken (\S+)/) ?? [])[1]; return t ? ago(t) + ' old' : '?'; }).join(', ')} · <a href="/health">health →</a> <a class="back" href="/?list=1">· all tasks →</a></div>`;

  const needs = needYou.map((t) => card(`<b>${esc(t.title)}</b><div class="hint">${esc(t.project)} · ${t.phase === 'brief' ? 'brief ready' : 'stopped, needs you'} · ${ago(t.updatedAt)}</div>
    <div class="snip">${esc((t.lastAgent ?? '').slice(0, 260))}</div>${t.phase === 'brief' ? `<div class="row">${quick(t.id)}</div>` : ''}`, `/?task=${t.id}`, 'open chat →')).join('') || '<div class="hint pad">Nothing waits for you.</div>';

  const work = working.map((t) => card(`<span class="dot live"></span> <b>${esc(t.title)}</b><div class="hint">${esc(t.project)}${t.pr ? ` · PR #${t.pr.number}` : ''}${t.lastActivity ? ` · ${esc(t.lastActivity.tool)}: ${esc(t.lastActivity.detail)} · ${ago(t.lastActivity.at)} ago` : ''}</div>`, `/?task=${t.id}`, 'open chat →')).join('') || '<div class="hint pad">No agent is working right now. <a href="/?task=new">Start one →</a></div>';

  const previews = live.map((p) => {
    const e = e2eFor('contentcoach', p.number), host = PREVIEW.contentcoach.host(p.number);
    const agentTask = p.branch.startsWith('agent/') ? p.branch.slice(6) : null;
    return card(`<b>#${p.number}</b> ${esc(p.title)}<div class="hint">${esc(p.author ?? '')} · ${ago(p.at)} · ${e ? (e.failed ? `❌ e2e ${e.failed} failed` : `✅ e2e ${e.passed}`) : 'no e2e yet'}</div>
      <div class="row links"><a href="${host}/app/" target="_blank">open</a><a href="${host}/_factory/login" target="_blank">sign in</a><a href="${host}/_factory/" target="_blank">videos</a>${agentTask ? `<a href="/?task=${agentTask}">agent chat</a>` : ''}</div>`, p.url, 'PR on GitHub →', true);
  }).join('') || `<div class="hint pad">${prs?.error ? esc(prs.error) : 'No open pull requests.'}</div>`;

  const shippedHtml = Array.isArray(ship) && ship.length ? ship.slice(0, 8).map((p) => `<li><a href="${p.url}" target="_blank">#${p.number} ${esc(p.title)}</a> <span class="hint">· ${esc(p.author ?? '')} · ${ago(p.at)} ago</span></li>`).join('') : `<li class="hint">${ship?.error ? esc(ship.error) : 'Nothing merged this week.'}</li>`;
  const depHtml = Array.isArray(dep) && dep.length ? dep.map((d) => `<li>${d.status !== 'completed' ? '<span class="dot live"></span>' : d.conclusion === 'success' ? '✅' : d.conclusion === 'cancelled' ? '⏹' : '❌'} <b>${d.env}</b> <a href="${d.url}" target="_blank">${esc(d.title)}</a> <span class="hint">· ${d.sha} · ${ago(d.at)} ago</span></li>`).join('') : `<li class="hint">${dep?.error ? esc(dep.error) : 'No deploys found.'}</li>`;

  return `<div class="overview">${head}
    <h3>Needs you</h3>${needs}
    <h3>Agents at work</h3>${work}
    <h3>Live previews</h3><div class="grid2">${previews}</div>
    <div class="grid2"><div><h3>Shipped to dev · 7 days</h3><ul class="list">${shippedHtml}</ul><a class="more" href="https://github.com/contentcoach/contentcoach/pulls?q=is%3Apr+is%3Amerged+base%3Adev" target="_blank">all merged →</a></div>
    <div><h3>Deploys</h3><ul class="list">${depHtml}</ul><a class="more" href="https://github.com/contentcoach/contentcoach/actions" target="_blank">all runs →</a></div></div>
  </div>`;
}

export const chatCss = `
.app{display:grid;grid-template-columns:280px minmax(0,1fr);min-height:100vh}
*{box-sizing:border-box} input[type=checkbox]{width:auto;margin-right:6px;vertical-align:middle}
.side{border-right:1px solid #e6e4dc;padding:18px 14px;background:#f4f3ee;display:flex;flex-direction:column;gap:6px;min-width:0}
.side h1{font-size:18px;margin:0 0 6px} .side .grp{font-size:12px;color:#888780;margin:14px 6px 2px;text-transform:lowercase}
.side a.t{display:flex;gap:8px;align-items:baseline;padding:7px 8px;border-radius:8px;color:#1f1f1d;text-decoration:none;font-size:14px}
.side a.t:hover{background:#ebe9e1} .side a.t.on{background:#fff;border:1px solid #e6e4dc}
.side a.t span.ttl{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap} .side small{color:#888780;font-size:11px}
.newbtn{display:block;text-align:center;padding:8px;border-radius:8px;background:#1f1f1d;color:#fff !important;text-decoration:none;font-size:14px}
.health{margin-top:auto;font-size:13px;padding:8px} .main{display:flex;flex-direction:column;min-width:0}
.head{padding:16px 22px;border-bottom:1px solid #e6e4dc;background:#fff} .head h2{margin:0;font-size:17px;font-weight:500}
.meta{font-size:13px;color:#5f5e5a;margin-top:4px;display:flex;flex-wrap:wrap;gap:12px;align-items:center}
.msgs{flex:1;overflow:auto;padding:18px 22px;display:flex;flex-direction:column;gap:12px}
.m{max-width:760px;padding:10px 14px;border-radius:12px;font-size:14.5px;line-height:1.55;background:#fff;border:1px solid #e6e4dc}
.m.you{align-self:flex-end;background:#e6effa;border-color:#b5d4f4} .m.factory{background:#f1efe8;font-size:13.5px}
.m .who{font-size:11px;color:#888780;margin-bottom:3px} .m pre{white-space:pre-wrap;background:#f7f6f2;padding:8px;border-radius:6px;font-size:12.5px}
.m code{background:#f1efe8;padding:1px 4px;border-radius:4px;font-size:13px}
.compose{border-top:1px solid #e6e4dc;padding:12px 22px;background:#fff;display:flex;gap:8px}
.compose textarea{flex:1;font:inherit;padding:9px 11px;border:1px solid #d3d1c7;border-radius:10px;min-height:44px;resize:vertical}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;flex:none} .dot.live{background:#378add;animation:p 1.4s infinite}
.dot.you{background:#ef9f27} .dot.wait{background:#b4b2a9} .dot.off{background:#d3d1c7} .dot.done{width:auto;height:auto;background:none;color:#0f6e56;font-size:12px}
@keyframes p{50%{opacity:.35}}
.overview{padding:22px 28px;max-width:1100px;overflow:auto} .overview .big{font-size:26px;font-weight:500;margin:0 0 4px}
.overview h3{font-size:13px;font-weight:500;color:#5f5e5a;margin:26px 0 8px;text-transform:uppercase;letter-spacing:.04em}
.ov{background:#fff;border:1px solid #e6e4dc;border-radius:12px;padding:12px 14px;margin:8px 0;position:relative}
.ov .more,.more{font-size:13px;display:inline-block;margin-top:6px} .ov .snip{font-size:13.5px;color:#444441;margin-top:6px;white-space:pre-wrap}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:0 18px} .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:8px}
.links a{font-size:13px} .list{list-style:none;padding:0;margin:0} .list li{padding:6px 0;border-bottom:1px solid #efede6;font-size:14px}
.pad{padding:6px 2px} form.qa{display:inline} form.qa button{background:#1f1f1d;color:#fff;border-color:#1f1f1d}
.main{height:100vh} .activity{font-size:12.5px;color:#5f5e5a;background:#f7f6f2;border-radius:8px;padding:8px 10px;margin-top:8px;font-family:ui-monospace,Menlo,monospace}
.actions{display:flex;gap:8px;padding:8px 22px 0;background:#fff;border-top:1px solid #e6e4dc}
.hint{color:#888780;font-size:13px} .empty{margin:auto;text-align:center;color:#5f5e5a;max-width:420px}
select,input[type=text]{font:inherit;padding:8px 10px;border:1px solid #d3d1c7;border-radius:8px}
a.back{display:none}
@media (max-width:760px){a.back{display:inline}.app{grid-template-columns:minmax(0,1fr)}.side{border-right:none}.app.has-task .side{display:none}.app:not(.has-task) .main{display:none}}`;

export async function chatView({ taskId, healthy, list = false }) {
  let tasks = [], task = null, err = '';
  try { tasks = await agents('/tasks'); if (taskId && taskId !== 'new') task = await agents(`/tasks/${encodeURIComponent(taskId)}`); }
  catch (e) { err = e.message; }
  const projects = [...new Set(['contentcoach', 'factory', ...tasks.map((t) => t.project)])];
  const side = projects.map((p) => {
    const ts = tasks.filter((t) => t.project === p);
    if (!ts.length) return '';
    return `<div class="grp">${esc(p)}</div>` + ts.map((t) => `<a class="t ${task?.id === t.id ? 'on' : ''}" href="/?task=${t.id}">${dot(t)}<span class="ttl">${esc(t.title)}</span><small>${ago(t.updatedAt)}</small></a>`).join('');
  }).join('');

  let main;
  if (task) {
    const pv = PREVIEW[task.project], pr = task.pr?.number, e2e = e2eFor(task.project, pr);
    const links = [
      task.pr ? `<a href="${esc(task.pr.url)}" target="_blank">PR #${pr} · ${esc(task.pr.state)}</a>` : '<span class="hint">no PR yet</span>',
      pv && pr ? `<a href="${pv.host(pr)}/app/" target="_blank">preview</a><a href="${pv.host(pr)}/_factory/login" target="_blank">sign in</a><a href="${pv.host(pr)}/_factory/" target="_blank">videos</a>` : '',
      e2e ? `<span>${e2e.failed ? '❌' : '✅'} e2e ${e2e.passed} passed${e2e.failed ? `, ${e2e.failed} failed` : ''}</span>` : '',
      `<span class="hint">${esc(task.status)}${task.costUsd ? ` · $${task.costUsd.toFixed(2)}` : ''}</span>`,
      task.running ? `<form method="post" action="/t/${task.id}/stop" style="display:inline"><button>Stop</button></form>` : '',
    ].join(' ');
    const msgs = task.messages.map((m) => `<div class="m ${m.from}"><div class="who">${m.from === 'you' ? 'you' : m.from === 'agent' ? 'agent' : 'factory'} · ${ago(m.at)}</div>${md(m.text)}</div>`).join('')
      + (task.running ? `<div class="hint"><span class="dot live"></span> the agent is working${task.activity?.length ? `<div class="activity">${task.activity.slice(-5).map((x) => `${ago(x.at)} · ${esc(x.tool)} · ${esc(x.detail)}`).join('<br>')}</div>` : ''}</div>` : '');
    const placeholder = task.phase === 'brief' && !task.running ? 'Reply to the brief: "go", or your answers' : 'Message the agent…';
    main = `<div class="head"><a href="/?list=1" class="hint back" style="font-size:12px">← tasks</a><h2>${esc(task.title)}</h2><div class="meta">${esc(task.project)} · ${links}</div></div>
      <div class="msgs" id="msgs" data-task="${task.id}" data-n="${task.messages.length}" data-running="${task.running}">${msgs}</div>
      ${task.phase === 'brief' && !task.running ? `<div class="actions">${quick(task.id)}</div>` : ''}
      <form class="compose" method="post" action="/t/${task.id}/reply"><textarea name="text" placeholder="${placeholder}" required></textarea><button>Send</button></form>`;
  } else if (taskId !== 'new') {
    main = await overview(tasks, healthy);
  } else {
    main = `<div class="msgs"><div class="empty"><a href="/?list=1" class="hint back" style="font-size:12px">← tasks</a><h2 style="font-weight:500">New task</h2>
      <p class="hint">Describe what you want. The agent replies once with questions (if any), a plan and what "done" means. After your "go" it works until its PR is green, without asking.</p>
      <form method="post" action="/tasks" class="card" style="text-align:left">
        <select name="project">${['contentcoach', 'factory'].map((p) => `<option>${p}</option>`).join('')}</select>
        <textarea name="text" required style="width:100%;min-height:110px;margin:10px 0;font:inherit;padding:9px;border:1px solid #d3d1c7;border-radius:10px" placeholder="e.g. Make the schedule sheet's Save button stay visible on phones"></textarea>
        <label class="hint" style="display:block;margin-bottom:12px"><input type="checkbox" name="auto">skip the brief, start right away</label><button>Start</button></form>
      ${err ? `<p class="pill bad">${esc(err)}</p>` : ''}</div></div>`;
  }
  const html = `<div class="app ${list ? '' : 'has-task'}"><aside class="side"><h1><a href="/" style="color:inherit;text-decoration:none">Factory</a></h1><a class="newbtn" href="/?task=new">+ New task</a>${side || '<p class="hint">No tasks yet.</p>'}
    <div class="health">${healthy ? '<span style="color:#0f6e56">●</span> all healthy' : '<span style="color:#a32d2d">● needs a look</span>'} · <a href="/health">health</a> · <a href="/logout">sign out</a></div></aside>
    <section class="main">${main}</section></div>
    <script>
      const m = document.getElementById('msgs');
      if (m) { m.scrollTop = m.scrollHeight;
        setInterval(async () => { try { const r = await fetch('/t/' + m.dataset.task + '/state'); const s = await r.json();
          if (s.n != m.dataset.n || String(s.running) != m.dataset.running) location.reload(); } catch {} }, 5000); }
      document.querySelectorAll('textarea[name=text]').forEach((t) => t.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) t.form.submit(); }));
    </script>`;
  return html;
}
