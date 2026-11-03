'use strict';
// Repeating events. A rule is stored as JSON in events.rrule:
//   { freq: 'daily'|'weekly'|'monthly'|'yearly', interval: 1, byday?: [0-6], until?: epoch ms }
// Exceptions (cancelled single occurrences) are a JSON array of start times in events.exdates.
// All date math is in local time so occurrences keep their clock time across DST.

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ICS_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const ruleOf = ev => {
  if (!ev || !ev.rrule) return null;
  try { return typeof ev.rrule === 'string' ? JSON.parse(ev.rrule) : ev.rrule; } catch { return null; }
};
const exdatesOf = ev => {
  try { return new Set(JSON.parse(ev.exdates || '[]')); } catch { return new Set(); }
};

const at = (d, days) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, d.getHours(), d.getMinutes());

// Start times (epoch ms) of occurrences that overlap [from, to), oldest first.
function occurrences(ev, from, to, limit = 1000) {
  const rule = ruleOf(ev);
  const dur = ev.end_ts - ev.start_ts;
  if (!rule) return ev.start_ts < to && ev.end_ts > from ? [ev.start_ts] : [];
  const ex = exdatesOf(ev);
  const until = rule.until || Infinity;
  const n = Math.max(1, rule.interval || 1);
  const first = new Date(ev.start_ts);
  const out = [];
  const take = t => {
    if (t < ev.start_ts || t > until || ex.has(t)) return;
    if (t < to && t + dur > from) out.push(t);
  };
  const lowest = from - dur;

  if (rule.freq === 'daily' || (rule.freq === 'weekly' && !rule.byday?.length)) {
    const step = rule.freq === 'daily' ? n : 7 * n;
    // Jump close to the window instead of walking from the first occurrence.
    let k = Math.max(0, Math.floor((lowest - ev.start_ts) / (step * 86400000)) - 1);
    for (let i = 0; i < 100000 && out.length < limit; i++, k++) {
      const t = at(first, k * step).getTime();
      if (t >= to || t > until) break;
      take(t);
    }
  } else if (rule.freq === 'weekly') {
    const days = [...new Set(rule.byday)].sort();
    const week0 = at(first, -first.getDay()); // Sunday of the first week, at the event's time
    let w = Math.max(0, Math.floor((lowest - week0.getTime()) / (7 * n * 86400000)) - 1);
    for (let i = 0; i < 100000 && out.length < limit; i++, w++) {
      const weekStart = at(week0, w * 7 * n);
      if (weekStart.getTime() >= to || weekStart.getTime() > until) break;
      for (const d of days) take(at(weekStart, d).getTime());
    }
  } else if (rule.freq === 'monthly' || rule.freq === 'yearly') {
    const months = rule.freq === 'monthly' ? n : 12 * n;
    const day = first.getDate();
    for (let k = 0; k < 100000 && out.length < limit; k++) {
      const d = new Date(first.getFullYear(), first.getMonth() + k * months, 1, first.getHours(), first.getMinutes());
      if (d.getTime() >= to || d.getTime() > until) break;
      const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      if (day > last) continue; // no Feb 30, no Feb 29 in other years
      d.setDate(day);
      take(d.getTime());
    }
  }
  return out.slice(0, limit);
}

// One occurrence as an event-shaped row.
const occurrence = (ev, t) => ({ ...ev, start_ts: t, end_ts: t + (ev.end_ts - ev.start_ts), occ_ts: t });

// Next occurrence still going on or starting after `after`.
function nextOccurrence(ev, after) {
  const rule = ruleOf(ev);
  if (!rule) return ev.end_ts > after ? ev : null;
  const span = { daily: 2, weekly: 15, monthly: 63, yearly: 800 }[rule.freq] * Math.max(1, rule.interval || 1) * 86400000;
  for (let from = after, i = 0; i < 20; i++, from += span) {
    const [t] = occurrences(ev, from, from + span, 1);
    if (t !== undefined) return occurrence(ev, t);
  }
  return null;
}

const ordinal = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');

// "every Saturday", "every 2 weeks on Mon, Wed", "every month on the 15th"
function describeRule(ev) {
  const r = ruleOf(ev);
  if (!r) return '';
  const n = Math.max(1, r.interval || 1);
  const d = new Date(ev.start_ts);
  let s;
  if (r.freq === 'daily') s = n === 1 ? 'every day' : `every ${n} days`;
  else if (r.freq === 'weekly') {
    const days = (r.byday?.length ? [...r.byday].sort() : [d.getDay()]);
    const weekdays = days.join() === '1,2,3,4,5';
    const names = weekdays ? 'weekday' : days.map(x => DAY_NAMES[x].slice(0, days.length > 1 ? 3 : 9)).join(', ');
    s = n === 1 ? `every ${names}` : n === 2 ? `every other ${names}` : `every ${n} weeks on ${names}`;
  } else if (r.freq === 'monthly') s = `${n === 1 ? 'every month' : `every ${n} months`} on the ${ordinal(d.getDate())}`;
  else s = `every year on ${MONTHS[d.getMonth()]} ${d.getDate()}`;
  if (r.until) s += ` until ${MONTHS[new Date(r.until).getMonth()]} ${new Date(r.until).getDate()}`;
  return s;
}

// RFC 5545 RRULE value
function toRRule(ev) {
  const r = ruleOf(ev);
  if (!r) return null;
  const parts = [`FREQ=${r.freq.toUpperCase()}`];
  if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
  if (r.freq === 'weekly' && r.byday?.length) parts.push(`BYDAY=${[...r.byday].sort().map(x => ICS_DAYS[x]).join(',')}`);
  if (r.until) parts.push(`UNTIL=${new Date(r.until).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`);
  return parts.join(';');
}

module.exports = { ruleOf, exdatesOf, occurrences, occurrence, nextOccurrence, describeRule, toRRule, DAY_NAMES };
