// node gallery.mjs <run dir> <title>: write <run dir>/index.html from the
// e2e report.json in it - every selected test, its status, its video(s)
// playing inline and its trace page. No dependencies (runs on the box).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const [dir, title = 'e2e'] = process.argv.slice(2);
const report = JSON.parse(readFileSync(path.join(dir, 'report.json'), 'utf8')).run;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// artifact paths are absolute or relative to the e2e project: keep what follows ".e2e/"
const rel = (p) => { const i = p.indexOf('.e2e/'); return i >= 0 ? p.slice(i + 5) : p; };
const files = (r) => [...(r.artifacts ?? []), ...(r.attempts ?? []).flatMap((a) => a.artifacts ?? [])]
  .map((a) => (typeof a === 'string' ? a : a.path)).filter(Boolean).map(rel)
  // report paths are relative to the run's artifacts/ dir, older ones to the run itself
  .map((p) => (existsSync(path.join(dir, p)) ? p : `artifacts/${p}`))
  .filter((p) => existsSync(path.join(dir, p)));

const rows = report.results.filter((r) => r.selected !== false && r.status !== 'skipped').map((r) => {
  const f = files(r);
  const videos = f.filter((p) => p.endsWith('.webm') || p.endsWith('.mp4'));
  const traces = f.filter((p) => p.endsWith('trace.md'));
  const ms = (r.attempts ?? []).reduce((t, a) => t + (a.durationMs ?? 0), 0);
  return `<section class="${esc(r.status)}">
  <h2><span class="badge">${esc(r.status)}</span> ${esc(r.titlePath.join(' › '))}</h2>
  <p class="meta">${esc(r.file)} · ${(ms / 1000).toFixed(1)} s ${traces.map((t) => `· <a href="${esc(t)}">trace</a>`).join(' ')}</p>
  ${videos.map((v) => `<video src="${esc(v)}#t=1" controls preload="metadata" playsinline></video>`).join('\n  ') || '<p class="meta">no video</p>'}
  ${r.error ? `<pre>${esc(r.error.message ?? JSON.stringify(r.error)).slice(0, 2000)}</pre>` : ''}
</section>`;
});
const s = report.summary;
writeFileSync(path.join(dir, 'index.html'), `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
 body{font:15px/1.5 system-ui,sans-serif;margin:0 auto;max-width:1100px;padding:20px;color:#222}
 h1{font-size:22px;margin:0 0 4px} h2{font-size:16px;margin:0 0 4px}
 .meta{color:#666;margin:0 0 8px;font-size:13px}
 section{border:1px solid #ddd;border-radius:10px;padding:14px;margin:12px 0}
 .badge{font-size:12px;padding:2px 8px;border-radius:99px;background:#e3f6ef;color:#085041;margin-right:6px}
 .failed .badge,.timedOut .badge,.interrupted .badge{background:#fde8e6;color:#791f1f}
 .flaky .badge{background:#faeeda;color:#633806}
 video{width:100%;max-width:1000px;border-radius:6px;background:#000}
 pre{white-space:pre-wrap;background:#fafafa;padding:8px;border-radius:6px;font-size:12px}
</style>
<h1>${esc(title)}</h1>
<p class="meta">${s.passed} passed · ${s.failed} failed · ${s.flaky} flaky · ${new Date(report.finishedAt ?? Date.now()).toUTCString()}</p>
${rows.join('\n')}
`);
console.log(`${s.passed} passed, ${s.failed} failed${s.flaky ? `, ${s.flaky} flaky` : ''}`);
