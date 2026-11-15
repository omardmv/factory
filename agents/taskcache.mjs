// Parsed task.json files, cached by (mtime in ns, size, inode). allTasks() runs
// on every poll and on many ticks and re-read and re-parsed every task file each
// time; with hundreds of finished tasks that was most of its cost (measure it
// with `node agents/bench-taskcache.mjs`). Callers mutate what load() returns, so every call gets
// its own copy. mtime can be coarse (a few ms), so a writer in this process must
// call forget(file) after writing (save() does); a writer in another process that
// rewrites a same-size file within one tick could still be missed until the next change.
import { readFileSync, statSync } from 'node:fs';

export function makeJsonCache({ read = (f) => readFileSync(f, 'utf8'), stat = (f) => statSync(f, { bigint: true }) } = {}) {
  const cache = new Map();
  const load = (file) => {
    const s = stat(file);
    const key = `${s.mtimeNs}:${s.size}:${s.ino}`;
    const hit = cache.get(file);
    if (hit && hit.key === key) return structuredClone(hit.value);
    const value = JSON.parse(read(file));
    cache.set(file, { key, value });
    return structuredClone(value);
  };
  load.forget = (file) => cache.delete(file);
  load.size = () => cache.size;
  return load;
}
