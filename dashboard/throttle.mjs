// Limits wrong-password attempts at the login, two ways at once: `max` failures per `windowMs` for each
// source, and a looser `globalMax` for everyone together. While a limit is reached, even a correct password
// waits (otherwise guessing would go on). Honest limits: a source can only lock itself out, but a
// sustained flood of failures from more than globalMax/windowMs distinct sources (or from addresses the
// proxy does not overwrite) can keep NEW logins locked for as long as it lasts. Existing sessions are not affected.
export function loginThrottle({ max = 10, globalMax = 100, windowMs = 60000, now = Date.now } = {}) {
  const by = new Map(); let all = [];
  const live = (a) => a.filter((x) => now() - x < windowMs);
  const secs = (a) => Math.ceil((windowMs - (now() - a[0])) / 1000);
  return {
    // -> 0 when an attempt may be checked, else the seconds to wait
    wait(src = '') {
      all = live(all);
      for (const [k, v] of by) { const l = live(v); l.length ? by.set(k, l) : by.delete(k); } // sweep: sources that never return
      const mine = live(by.get(src) ?? []);
      mine.length ? by.set(src, mine) : by.delete(src);
      return Math.max(mine.length >= max ? secs(mine) : 0, all.length >= globalMax ? secs(all) : 0);
    },
    // a failure while blocked is not counted: the lists stay bounded
    fail(src = '') {
      if (this.wait(src)) return;
      all.push(now()); by.set(src, [...(by.get(src) ?? []), now()]);
    },
  };
}
