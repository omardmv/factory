// node agents/test-media.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mediaFiles, lastE2eRun } from './media.mjs';

let n = 0; const ok = (name) => console.log(`ok ${++n} - ${name}`);
const ws = mkdtempSync(`${tmpdir()}/media-`);
const put = (p, body = 'x') => { mkdirSync(p.slice(0, p.lastIndexOf('/')), { recursive: true }); writeFileSync(p, body); };

// the real case (Sayra PR #41): 36 screenshots and 8 recordings; a single cap of 30 dropped every video
for (let i = 0; i < 36; i++) put(`${ws}/screens/shot-${String(i).padStart(2, '0')}.png`);
for (const v of ['main-action', 'topics', 'empty', 'loading', 'error', 'partners', 'layout-390', 'layout-1280']) put(`${ws}/videos/speaking-home-${v}/video.webm`);
const m = mediaFiles(ws);
assert.equal(m.filter((x) => x.video).length, 8, 'every video is listed');
assert.equal(m.filter((x) => !x.video).length, 36);
ok('screenshots never crowd out videos: each kind has its own cap');

assert.equal(lastE2eRun(ws), null, 'no run recorded: nothing to say');
put(`${ws}/videos/.last-run.json`, JSON.stringify({ status: 'failed', failedTests: ['8f81-bd3c'] }));
put(`${ws}/videos/speaking-home-main-action/error-context.md`, '# Instructions\n\n# Test info\n\n- Name: speaking-home.spec.js >> main action: one primary button starts the search\n- Location: e2e/speaking-home.spec.js:12:1\n');
const r = lastE2eRun(ws);
assert.equal(r.status, 'failed'); assert.equal(r.count, 1);
assert.deepEqual(r.failed, ['speaking-home.spec.js >> main action: one primary button starts the search']);
assert.match(r.at, /^\d{4}-\d\d-\d\dT/);
put(`${ws}/videos/.last-run.json`, JSON.stringify({ status: 'passed', failedTests: [] }));
assert.deepEqual([lastE2eRun(ws).status, lastE2eRun(ws).failed], ['passed', []]);
put(`${ws}/videos/.last-run.json`, '{not json');
assert.equal(lastE2eRun(ws), null, 'unreadable: nothing claimed');
ok('the last e2e run: failed with the failing tests named, passed, or nothing when unknown');

console.log(`all ${n} passed`);
