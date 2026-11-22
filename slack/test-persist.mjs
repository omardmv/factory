// `node slack/test-persist.mjs`
import assert from 'node:assert/strict';
import { makeSaver } from './persist.mjs';
const timers = []; let writes = 0, cleared = 0;
const mk = () => makeSaver(() => writes++, { delay: 50, setTimer: (f) => (timers.push(f), timers.length), clearTimer: () => cleared++ });
const s = mk();
for (let i = 0; i < 100; i++) s.save();
assert.equal(writes, 0, 'save() does not write'); assert.equal(timers.length, 1, 'one timer for 100 saves'); assert.ok(s.pending());
timers[0](); assert.equal(writes, 1, 'one write for 100 saves'); assert.ok(!s.pending());
s.save(); assert.equal(timers.length, 2, 'a later save schedules again');
s.flush(); assert.equal(writes, 2, 'flush writes at once'); assert.equal(cleared, 1, 'and cancels the timer'); assert.ok(!s.pending());
s.flush(); assert.equal(writes, 3, 'flush with nothing pending still writes (the initial state)');
console.log('persist ok');
