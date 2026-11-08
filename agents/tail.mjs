// Read the end of an append-only log without reading the whole file. The task
// list is polled every few seconds and only needs the last line of each
// task's activity log and the last agent message; whole-file reads of logs
// that grow all run blocked the event loop (see test-tail.mjs).
import { openSync, readSync, fstatSync, closeSync, existsSync } from 'node:fs';

const CHUNK = 64 * 1024;

// Walk the file's lines from the last to the first, in chunks from the end.
// `visit(line)` returns true to stop. Empty lines are skipped.
export function eachLineFromEnd(file, visit) {
  if (!existsSync(file)) return;
  const fd = openSync(file, 'r');
  try {
    let pos = fstatSync(fd).size, carry = Buffer.alloc(0);
    while (pos > 0) {
      const len = Math.min(CHUNK, pos); pos -= len;
      const buf = Buffer.alloc(len); readSync(fd, buf, 0, len, pos);
      let data = Buffer.concat([buf, carry]), end = data.length;
      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i] !== 10) continue;
        const line = data.subarray(i + 1, end).toString('utf8');
        end = i;
        if (line.trim() && visit(line)) return;
      }
      carry = data.subarray(0, end);
    }
    const line = carry.toString('utf8');
    if (line.trim()) visit(line);
  } finally { closeSync(fd); }
}

// The last n non-empty lines, oldest first.
export function tailLines(file, n) {
  const out = [];
  if (n > 0) eachLineFromEnd(file, (l) => { out.push(l); return out.length >= n; });
  return out.reverse();
}

// The newest JSON line of a .jsonl file that satisfies `pred`, or undefined.
export function lastJsonLine(file, pred) {
  let found;
  eachLineFromEnd(file, (l) => { try { const o = JSON.parse(l); if (pred(o)) { found = o; return true; } } catch {} return false; });
  return found;
}
