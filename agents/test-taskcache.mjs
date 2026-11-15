import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { makeJsonCache } from './taskcache.mjs';

const d = mkdtempSync(`${tmpdir()}/tc-`);

test('second load does not re-read; changed file is re-read', () => {
  let reads = 0;
  const load = makeJsonCache({ read: (f) => { reads++; return readFileSync(f, 'utf8'); } });
  const f = `${d}/a.json`; writeFileSync(f, '{"n":1}');
  assert.equal(load(f).n, 1); assert.equal(load(f).n, 1); assert.equal(reads, 1);
  writeFileSync(f, '{"n":22}');
  assert.equal(load(f).n, 22); assert.equal(reads, 2);
});

test('callers get their own copy: mutating one does not leak into the cache', () => {
  const load = makeJsonCache();
  const f = `${d}/b.json`; writeFileSync(f, '{"m":[1]}');
  load(f).m.push(2);
  assert.deepEqual(load(f), { m: [1] });
});

test('a missing file throws like readFileSync', () => {
  assert.throws(() => makeJsonCache()(`${d}/none.json`), /ENOENT/);
});

test('same-size rewrite is noticed (ns mtime)', async () => {
  const load = makeJsonCache(); const f = `${d}/c.json`;
  writeFileSync(f, '{"n":1}'); load(f);
  await new Promise((r) => setTimeout(r, 5));
  writeFileSync(f, '{"n":2}');
  assert.equal(load(f).n, 2);
});
