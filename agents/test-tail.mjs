import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { tailLines, lastJsonLine } from './tail.mjs';

const d = mkdtempSync(`${tmpdir()}/tail-`);
let n = 0; const test = (name, f) => { f(); n++; console.log('ok', name); };
const w = (name, s) => { writeFileSync(`${d}/${name}`, s); return `${d}/${name}`; };
const lines = Array.from({ length: 5000 }, (_, i) => `line ${i} ${'é'.repeat(i % 50)}`);

test('missing file: nothing', () => { assert.deepEqual(tailLines(`${d}/none`, 3), []); assert.equal(lastJsonLine(`${d}/none`, () => true), undefined); });
test('last n lines match slice(-n) across chunk boundaries and multibyte text', () => {
  const f = w('big', lines.join('\n') + '\n');
  for (const k of [1, 8, 1000, 5000, 9999]) assert.deepEqual(tailLines(f, k), lines.slice(-k));
});
test('no trailing newline, blank lines, short file', () => {
  assert.deepEqual(tailLines(w('a', 'x\n\ny\nz'), 2), ['y', 'z']);
  assert.deepEqual(tailLines(w('b', ''), 2), []);
  assert.deepEqual(tailLines(w('c', 'only'), 5), ['only']);
});
test('a line longer than a chunk is read whole', () => {
  const long = 'z'.repeat(200000);
  assert.deepEqual(tailLines(w('long', `first\n${long}\nlast\n`), 2), [long, 'last']);
});
test('lastJsonLine: newest match, skips bad lines, same answer as a full parse', () => {
  const rows = Array.from({ length: 3000 }, (_, i) => JSON.stringify({ from: i % 7 === 0 ? 'agent' : 'you', text: `m${i}` }));
  rows.splice(2990, 0, 'not json');
  const f = w('m.jsonl', rows.join('\n') + '\n');
  const want = rows.flatMap((r) => { try { return [JSON.parse(r)]; } catch { return []; } }).filter((m) => m.from === 'agent').at(-1);
  assert.deepEqual(lastJsonLine(f, (m) => m.from === 'agent'), want);
  assert.equal(lastJsonLine(f, (m) => m.from === 'qa'), undefined);
});
console.log(`${n} passed`);
