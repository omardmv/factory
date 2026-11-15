// Usage: node agents/bench-taskcache.mjs  — allTasks()-style listing of 400 task files of 20 KB, uncached vs cached.
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { makeJsonCache } from './taskcache.mjs';
const root = mkdtempSync(`${tmpdir()}/bench-`);
for (let i = 0; i < 400; i++) { mkdirSync(`${root}/t${i}`); writeFileSync(`${root}/t${i}/task.json`, JSON.stringify({ id: `t${i}`, updatedAt: new Date(i * 1e6).toISOString(), blob: 'x'.repeat(20000) }, null, 1)); }
const all = (load) => readdirSync(root).map((d) => load(`${root}/${d}/task.json`)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
const raw = (f) => JSON.parse(readFileSync(f, 'utf8')), cached = makeJsonCache();
for (const [name, l] of [['uncached', raw], ['cached', cached], ['uncached', raw], ['cached', cached]]) {
  all(l); const t = process.hrtime.bigint(); for (let k = 0; k < 30; k++) all(l);
  console.log(name, (Number(process.hrtime.bigint() - t) / 30 / 1e6).toFixed(1), 'ms per listing');
}
