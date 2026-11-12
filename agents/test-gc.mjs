// node agents/test-gc.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { taskCleanup, previewIsDead, previewNeedsPrCheck, diskAlert, imagesToRemove, anonymousVolumes, parseCreated, HEAVY } from './gc.mjs';

let n = 0;
const test = (name, f) => { f(); n++; console.log('ok', name); };
const NOW = Date.parse('2026-11-12T12:00:00Z');
const ago = (h) => new Date(NOW - h * 3600000).toISOString();
const t = (o) => ({ status: 'merged', updatedAt: ago(7), ...o });

test('merged/done tasks older than 6 h are cleaned, younger are kept', () => {
  assert.equal(taskCleanup(t(), { now: NOW }).clean, true);
  assert.equal(taskCleanup(t({ status: 'done' }), { now: NOW }).clean, true);
  assert.equal(taskCleanup(t({ updatedAt: ago(5) }), { now: NOW }).clean, false);
});
test('a paused task whose PR merged counts as finished', () => {
  assert.equal(taskCleanup(t({ status: 'paused', pr: { state: 'merged' } }), { now: NOW }).clean, true);
});
test('active, waiting and busy tasks are never cleaned', () => {
  for (const s of ['working', 'reviewing', 'waiting for you', 'ready for you', 'paused', 'queued']) assert.equal(taskCleanup(t({ status: s, updatedAt: ago(1000) }), { now: NOW }).clean, false, s);
  assert.equal(taskCleanup(t(), { now: NOW, busy: true }).clean, false);
});
test('a task with a preview up keeps its checkout (the preview builds from it)', () => {
  assert.equal(taskCleanup(t({ previewPr: 43 }), { now: NOW }).clean, false);
});
test('stopped tasks keep their checkout for a week', () => {
  assert.equal(taskCleanup(t({ status: 'stopped', updatedAt: ago(24) }), { now: NOW }).clean, false);
  assert.equal(taskCleanup(t({ status: 'stopped', updatedAt: ago(24 * 8) }), { now: NOW }).clean, true);
});
test('a missing timestamp is not cleaned', () => assert.equal(taskCleanup({ status: 'merged', updatedAt: undefined }, { now: NOW }).clean, false));
test('what the dashboard serves is never in the delete list', () => {
  for (const keep of ['task.json', 'messages.jsonl', 'activity.log', 'claude', 'workspace/screens', 'workspace/videos', 'workspace/attachments', 'workspace/decisions.tsv'])
    assert.ok(!HEAVY.some((h) => keep === h || keep.startsWith(`${h}/`)), keep);
});

test('preview of a merged task is dead; paused task with stale open PR needs a GitHub check', () => {
  assert.equal(previewIsDead({ previewPr: 43, status: 'merged' }), true);
  assert.equal(previewIsDead({ previewPr: 43, status: 'paused', pr: { number: 43, state: 'closed' } }), true);
  assert.equal(previewIsDead({ status: 'merged' }), false);
  const paused = { previewPr: 43, status: 'paused', pr: { number: 43, state: 'open' } };
  assert.equal(previewIsDead(paused), false);
  assert.equal(previewNeedsPrCheck(paused), true);
  assert.equal(previewNeedsPrCheck({ ...paused, status: 'merged' }), false);
});

test('disk alert: silent below, once at 85, quiet while high, again after a day, re-arms below 80', () => {
  let r = diskAlert(84, {}, NOW); assert.equal(r.alert, false);
  r = diskAlert(85, r.state, NOW); assert.equal(r.alert, true);
  let s = r.state;
  r = diskAlert(90, s, NOW + 3600000); assert.equal(r.alert, false);
  r = diskAlert(90, s, NOW + 25 * 3600000); assert.equal(r.alert, true);
  r = diskAlert(82, s, NOW + 3600000); assert.deepEqual(r.state, s); // hovering just under: not re-armed
  r = diskAlert(79, s, NOW + 3600000); assert.deepEqual(r.state, {});
  assert.equal(diskAlert(85, r.state, NOW + 7200000).alert, true);
  assert.equal(diskAlert(NaN, {}, NOW).alert, false);
});

const repo = 'byvvptimlajxjnwqngqhxgxt_api';
const img = (i, o = {}) => ({ id: `sha${i}`, repo, tag: `c${i}`, created: new Date(NOW - i * 3600000).toISOString(), ...o });
test('keeps the 5 newest tags per Coolify repo, removes the older', () => {
  const imgs = Array.from({ length: 8 }, (_, i) => img(i));
  assert.deepEqual(imagesToRemove(imgs), [`${repo}:c5`, `${repo}:c6`, `${repo}:c7`]);
});
test('an old image in use is kept; groups are independent', () => {
  const imgs = [...Array.from({ length: 7 }, (_, i) => img(i)), ...Array.from({ length: 2 }, (_, i) => img(i, { repo: 'itk0dt7d0za7gp653qh3odxe', id: `o${i}` }))];
  assert.deepEqual(imagesToRemove(imgs, new Set(['sha6'])), [`${repo}:c5`]);
});
test('other tenants and the factory\'s own images are never touched', () => {
  const others = ['localhost:5000/sayra-base', 'factory-agent', 'postgres', 'ghcr.io/coollabsio/coolify', 'alpine'].flatMap((r) => Array.from({ length: 9 }, (_, i) => img(i, { repo: r })));
  assert.deepEqual(imagesToRemove(others), []);
  assert.deepEqual(imagesToRemove(Array.from({ length: 9 }, (_, i) => img(i, { tag: 'latest' }))), []);
});
test('only anonymous (64 hex) volumes are listed', () => {
  const h = 'a'.repeat(64);
  assert.deepEqual(anonymousVolumes([h, 'deploy_media', 'pgdata', 'a'.repeat(63), `${h}x`]), [h]);
});
test('CLI: images and volumes', () => {
  const d = mkdtempSync(`${tmpdir()}/gc-`); writeFileSync(`${d}/inuse`, 'sha7\n');
  const lines = Array.from({ length: 8 }, (_, i) => `sha${i}|${repo}|c${i}|${new Date(NOW - i * 3600000).toISOString()}`).join('\n');
  const out = execFileSync('node', [new URL('./gc.mjs', import.meta.url).pathname, 'images', '5', `${d}/inuse`], { input: lines }).toString().trim().split('\n');
  assert.deepEqual(out, [`${repo}:c5`, `${repo}:c6`]);
  const v = execFileSync('node', [new URL('./gc.mjs', import.meta.url).pathname, 'volumes'], { input: `${'b'.repeat(64)}\ndeploy_media\n` }).toString().trim();
  assert.equal(v, 'b'.repeat(64));
});
test('docker CreatedAt is parsed with its offset', () => {
  assert.equal(parseCreated('2026-11-12 10:00:00 +0500 +05'), Date.parse('2026-11-12T05:00:00Z'));
  assert.equal(parseCreated('2026-11-12T05:00:00Z'), Date.parse('2026-11-12T05:00:00Z'));
});
console.log(`${n} passed`);
