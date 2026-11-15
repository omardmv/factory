// node agents/test-throttle.mjs
import assert from 'node:assert/strict';
import { loginThrottle } from '../dashboard/throttle.mjs';
let t = 0; const th = loginThrottle({ max: 3, windowMs: 60000, now: () => t });
for (let i = 0; i < 3; i++) { assert.equal(th.wait(), 0); th.fail(); t += 1000; }
assert.equal(th.wait(), 57, 'three failures: wait until the first leaves the window');
t += 57000; assert.equal(th.wait(), 0, 'window passed: attempts allowed again');
console.log('ok 1 - brute force is capped at max failures per window');
