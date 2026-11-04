'use strict';
// Counts failed logins (wrong password or wrong feed token) per client address and
// locks an address out for a while after too many. Kept in memory: a restart clears it.

function createLimiter({ maxAttempts, windowMs, now = Date.now }) {
  const hits = new Map(); // ip -> { fails: [timestamps], until: ms }

  function entry(ip) {
    const t = now();
    let e = hits.get(ip);
    if (e) {
      e.fails = e.fails.filter(x => t - x < windowMs);
      if (e.until <= t && !e.fails.length) { hits.delete(ip); e = null; }
    }
    return e;
  }

  return {
    // Milliseconds until this address may try again, or 0.
    blockedFor(ip) {
      if (!maxAttempts) return 0;
      const e = entry(ip);
      return e && e.until > now() ? e.until - now() : 0;
    },
    fail(ip) {
      if (!maxAttempts) return;
      const t = now();
      const e = entry(ip) || { fails: [], until: 0 };
      e.fails.push(t);
      if (e.fails.length >= maxAttempts) {
        e.until = t + windowMs;
        e.fails = [];
        console.warn(`Too many failed logins from ${ip}; blocked for ${Math.round(windowMs / 60000)} min`);
      }
      hits.set(ip, e);
      if (hits.size > 10000) hits.delete(hits.keys().next().value); // don't grow without bound
    },
    success(ip) { hits.delete(ip); },
  };
}

module.exports = { createLimiter };
