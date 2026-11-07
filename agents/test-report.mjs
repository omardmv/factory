// node agents/test-report.mjs
import assert from 'node:assert/strict';
import { buildReport, parseMapping, mappingFrom, REPORT_MARK, reportSummary, checksLine } from './report.mjs';

let n = 0;
const test = (name, f) => { f(); n++; console.log('ok', name); };
const item = (sub, rel, video) => ({ sub, rel, video, commit: 'c0ffee', repoPath: `t1/${sub}/${rel}` });
const items = [item('videos', 'login/video.webm', true), item('screens', 'home.png', false)];
const base = { taskId: 't1', repo: 'o/r', pr: 7, head: 'abcdef1234', title: 'Login works', items, dashboard: 'https://d', checks: { state: 'green', sha: 'abcdef1999' } };
const block = '```evidence\n- Login shows the form | video videos/login/video.webm\n2. Home is drawn | screenshot screens/home.png\nParses numbers | test parses numbers\nSomething else | not shown\n```';

test('parseMapping reads the last evidence block, all proof kinds', () => {
  const m = parseMapping(`old\n\`\`\`evidence\nx | not shown\n\`\`\`\nnew\n${block}`);
  assert.deepEqual(m.map((e) => e.kind), ['video', 'screenshot', 'test', 'none']);
  assert.equal(m[2].ref, 'parses numbers');
});
test('parseMapping: no block, or no valid lines → null', () => {
  assert.equal(parseMapping('nothing'), null);
  assert.equal(parseMapping('```evidence\njust text\n```'), null);
});
test('mappingFrom takes the newest agent message with a block', () => {
  const m = mappingFrom([{ from: 'agent', text: block }, { from: 'review', text: block.replace('Login', 'X') }, { from: 'agent', text: 'no block' }]);
  assert.equal(m.length, 4);
});

test('ready case: proof next to each result, media listed, marker first', () => {
  const r = buildReport({ ...base, outcome: 'ready', mapping: parseMapping(block) });
  assert.ok(r.startsWith(REPORT_MARK)); assert.match(r, /Evidence report: ready/);
  assert.match(r, /Login shows the form\n {3}→ 🎬 \[videos\/login\/video\.webm\]\(https:\/\/github\.com\/o\/r\/blob\/c0ffee\/t1\/videos\/login\/video\.webm\)/);
  assert.match(r, /Home is drawn\n {3}→ 📸/); assert.match(r, /Something else\n {3}→ ❌ not shown/);
  assert.match(r, /<img src="[^"]+home\.png\?raw=true"/); assert.doesNotMatch(r, /Still failing/);
});
test('no-UI task: a passing test name counts as proof', () => {
  const r = buildReport({ ...base, items: [], outcome: 'ready', mapping: parseMapping('```evidence\nparses numbers | test parses numbers\n```') });
  assert.match(r, /→ 🧪 test `parses numbers`/); assert.match(r, /No screenshots or videos/);
});
test('missing file is downgraded to not shown', () => {
  const r = buildReport({ ...base, outcome: 'ready', mapping: parseMapping('```evidence\nA | video videos/gone.webm\n```') });
  assert.match(r, /→ ❌ not shown \(the agent named `videos\/gone\.webm`/); assert.doesNotMatch(r, /gone\.webm\]\(/);
});
test('a screenshot named as a video (wrong kind) is not found', () => {
  const r = buildReport({ ...base, outcome: 'ready', mapping: parseMapping('```evidence\nA | video screens/home.png\n```') });
  assert.match(r, /not shown/);
});
test('stopped case: open findings in their own words', () => {
  const r = buildReport({ ...base, outcome: 'stopped', mapping: parseMapping(block), checks: { state: 'red', sha: 'abcdef1' }, findings: { review: '## Must fix\n- server.mjs:5 breaks', qa: 'QA VERDICT: FAIL\nthe button is gone' } });
  assert.match(r, /the loop stopped/); assert.match(r, /Still failing/); assert.match(r, /server\.mjs:5 breaks/); assert.match(r, /the button is gone/);
  assert.match(r, /❌ e2e or checks failed on the final head `abcdef1`/);
});
test('stopped with no recorded findings says so', () => {
  assert.match(buildReport({ ...base, outcome: 'stopped', mapping: null }), /No review or QA findings were recorded/);
});
test('no mapping: nothing is claimed as shown', () => {
  assert.match(buildReport({ ...base, outcome: 'ready', mapping: null }), /gave no expectation → proof mapping/);
});
test('stale sha: results on an older sha are flagged, not passed off as the head', () => {
  assert.match(checksLine({ state: 'green', sha: '1111111' }, 'abcdef1234'), /not the final head `abcdef1`/);
  assert.match(checksLine({ state: 'green', sha: 'abcdef1999' }, 'abcdef1234'), /passed on the final head/);
  assert.match(checksLine(null, 'abc'), /No e2e/);
});
test('summary: one line with the PR link and the count', () => {
  const s = reportSummary({ outcome: 'ready', pr: 7, prUrl: 'https://x/pr', mapping: parseMapping(block), items });
  assert.equal(s.includes('\n'), false); assert.match(s, /PR #7 https:\/\/x\/pr/); assert.match(s, /3 of 4/);
});
console.log(`${n} passed`);
