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

test('back-to-back same-size writes with forget() always read back the newest (the save path)', () => {
  const load = makeJsonCache(); const f = `${d}/c.json`;
  for (let i = 0; i < 300; i++) {
    const v = String(1000 + i);
    writeFileSync(f, `{"n":"${v}"}`); load.forget(f);
    assert.equal(load(f).n, v);
  }
});
