// The final evidence report on a PR: ONE comment the factory keeps up to date
// (found by REPORT_MARK, edited in place), posted when the PR is ready (review
// PASS) or when the round limit stops the loop. Pure: no I/O.
// Split: the factory writes every fact (sha, results, files, open findings);
// the agent supplies only the expectation → proof mapping, in a fenced block:
//   ```evidence
//   <what the task expected> | video videos/x.webm
//   <another> | screenshot screens/a.png
//   <a no-UI result> | test test_name_that_covers_it
//   <a third> | not shown
//   ```
// A video/screenshot the factory cannot find is downgraded to "not shown".
export const REPORT_MARK = '<!-- factory-report -->';
const clip = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n)}\n[…cut, ${String(s).length - n} more characters]` : String(s ?? ''));

// text: an agent message. → [{expected, kind: 'video'|'screenshot'|'test'|'none', ref}] from its LAST evidence block, or null
export function parseMapping(text) {
  const blocks = [...String(text ?? '').matchAll(/```evidence[^\n]*\n([\s\S]*?)```/gi)];
  if (!blocks.length) return null;
  const out = [];
  for (const raw of blocks.at(-1)[1].split('\n')) {
    const line = raw.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim();
    const i = line.lastIndexOf('|');
    if (!line || i < 1) continue;
    const expected = line.slice(0, i).trim(), proof = line.slice(i + 1).trim();
    const m = /^(video|screenshot|test)\s*:?\s+(.+)$/i.exec(proof);
    if (expected) out.push(m ? { expected, kind: m[1].toLowerCase(), ref: m[2].trim().replace(/^`|`$/g, '') } : { expected, kind: 'none', ref: '' });
  }
  return out.length ? out : null;
}
// the agent's newest message that carries a mapping block
export const mappingFrom = (msgs) => { for (const m of [...(msgs ?? [])].reverse()) if (m.from === 'agent') { const p = parseMapping(m.text); if (p) return p; } return null; };

const findItem = (items, ref, video) => {
  const r = ref.replace(/^\/?workspace\//, '').replace(/^\.\//, '');
  return items.find((i) => i.video === video && (`${i.sub}/${i.rel}` === r || i.rel === r || i.rel.split('/').pop() === r.split('/').pop()));
};
export function resolveProof(entry, items) {
  if (entry.kind === 'test') return entry.ref ? { kind: 'test', ref: entry.ref } : { kind: 'none' };
  if (entry.kind === 'video' || entry.kind === 'screenshot') {
    const item = findItem(items, entry.ref, entry.kind === 'video');
    return item ? { kind: entry.kind, item } : { kind: 'none', missing: entry.ref };
  }
  return { kind: 'none' };
}

// checks: { state: 'green'|'red'|'none', sha } — the last e2e report and the sha it was for
export function checksLine(checks, head) {
  const h = (head ?? '').slice(0, 7), s = (checks?.sha ?? '').slice(0, 7);
  if (!checks || checks.state === 'none' || !s) return '⚪ No e2e/preview result was reported for this PR.';
  const word = checks.state === 'green' ? '✅ e2e and checks passed' : '❌ e2e or checks failed';
  return s === h ? `${word} on the final head \`${h}\`.` : `⚠️ ${word} on \`${s}\`, **not the final head \`${h}\`**: nothing reported a result on the head itself.`;
}

export function buildReport({ taskId, repo, pr, head, outcome, title, mapping, items = [], checks, findings = {}, dashboard, tests = null }) {
  const url = (i, raw) => `https://github.com/${repo}/blob/${i.commit}/${i.repoPath.split('/').map(encodeURIComponent).join('/')}${raw ? '?raw=true' : ''}`;
  const rows = (mapping ?? []).map((e, k) => {
    const p = resolveProof(e, items);
    const proof = p.kind === 'video' ? `🎬 [${p.item.sub}/${p.item.rel}](${url(p.item)})`
      : p.kind === 'screenshot' ? `📸 [${p.item.sub}/${p.item.rel}](${url(p.item)})`
      : p.kind === 'test' ? `🧪 test \`${p.ref}\` (the agent's claim)`
      : `❌ not shown${p.missing ? ` (the agent named \`${p.missing}\`, which the factory did not find)` : ''}`;
    return `${k + 1}. ${e.expected}\n   → ${proof}`;
  });
  const pics = items.filter((i) => !i.video), vids = items.filter((i) => i.video);
  const gallery = [];
  for (let k = 0; k < pics.length; k += 2) gallery.push(`| ${pics.slice(k, k + 2).map((i) => `<img src="${url(i, true)}" width="360"><br><sub>${i.sub}/${i.rel}</sub>`).join(' | ')} |${pics.length - k === 1 && pics.length > 1 ? ' |' : ''}`);
  const stopped = outcome === 'stopped';
  const open = [['Review panel', findings.review], ['QA tester', findings.qa]].filter(([, t]) => t && t.trim());
  return [REPORT_MARK,
    `### ${stopped ? '🛑 Evidence report: the loop stopped' : '✅ Evidence report: ready'}`,
    `Task \`${taskId}\` · PR #${pr} at \`${(head ?? '').slice(0, 7)}\` · [everything on the dashboard](${dashboard}/?task=${taskId})`,
    title ? `\n**Expected:** ${title}` : '',
    `\n**Expected results and their proof**\n${rows.length ? rows.join('\n') : '❌ The agent gave no expectation → proof mapping: nothing is claimed as shown.'}`,
    `\n**Results on the final head**\n${checksLine(checks, head)}${tests ? `\n${tests}` : ''}`,
    stopped ? `\n**Still failing and why** (the round limit stopped the loop; the last findings, in their own words)\n${open.length ? open.map(([who, t]) => `<details open><summary>${who}</summary>\n\n${clip(t.trim(), 3000)}\n\n</details>`).join('\n\n') : 'No review or QA findings were recorded; see the checks line above.'}` : '',
    vids.length ? `\n**Videos** (open to play on GitHub)\n${vids.map((i) => `- 🎬 [${i.sub}/${i.rel}](${url(i)})`).join('\n')}` : '',
    pics.length ? `\n**Screenshots**\n\n${pics.length > 1 ? '| | |\n|---|---|\n' : '| |\n|---|\n'}${gallery.join('\n')}` : '',
    !pics.length && !vids.length ? '\n_No screenshots or videos were recorded._' : '',
    `\n<sub>Written by the factory; only the expectation → proof mapping is the agent's claim. Edited in place on every final outcome.</sub>`].filter(Boolean).join('\n');
}

// the one-line Slack summary
export const reportSummary = ({ outcome, pr, prUrl, mapping, items }) => {
  const rs = (mapping ?? []).map((e) => resolveProof(e, items).kind), shown = rs.filter((k) => k !== 'none').length;
  return `[factory] ${outcome === 'stopped' ? '🛑 stopped at the round limit' : '✅ ready'}: PR #${pr} ${prUrl}. Evidence report: ${shown} of ${rs.length} expected results with proof.`;
};
