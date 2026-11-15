// Limits wrong-password attempts at the login: at most `max` failures per `windowMs`, counted for everyone
// together (behind the proxy the client address is not trustworthy, so a per-address limit could be dodged).
// While the limit is reached, even a correct password waits: an attacker can only slow the owner down
// for the rest of a minute, not guess faster than `max` a window. Existing sessions are not affected.
export function loginThrottle({ max = 10, windowMs = 60000, now = Date.now } = {}) {
  let fails = [];
  const prune = () => { const t = now(); fails = fails.filter((x) => t - x < windowMs); };
  return {
    // -> 0 when an attempt may be checked, else the seconds to wait
    wait() { prune(); return fails.length < max ? 0 : Math.ceil((windowMs - (now() - fails[0])) / 1000); },
    fail() { prune(); fails.push(now()); },
  };
}
