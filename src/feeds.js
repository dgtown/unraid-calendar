'use strict';
// Read-only calendars pulled in from iCal links, such as Google Calendar's
// "Secret address in iCal format". Each feed is downloaded every ICAL_IMPORT_MINUTES,
// expanded into one row per occurrence, and kept in memory. The last good copy is saved
// under DATA_DIR/imports so the events show right away after a restart.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ICAL = require('ical.js');
const config = require('./config');

const DAY = 86400000;
const PAST_DAYS = 400;     // keep about a year of history
const FUTURE_DAYS = 760;   // and two years ahead
const MAX_PER_EVENT = 5000;
const MAX_ROWS = 100000;

// feed.url -> { name, events, lastFetch, lastOk, error }
const state = new Map();

const cacheDir = () => path.join(config.dataDir, 'imports');
const cacheFile = url => path.join(cacheDir(), crypto.createHash('sha1').update(url).digest('hex').slice(0, 16) + '.ics');

// Wall-clock time in an IANA zone -> epoch ms (for TZIDs the feed didn't describe).
function zonedToEpoch(y, mo, d, h, mi, s, tz) {
  let guess = Date.UTC(y, mo - 1, d, h, mi, s);
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric',
      day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    for (let i = 0; i < 2; i++) {
      const p = Object.fromEntries(fmt.formatToParts(new Date(guess)).map(x => [x.type, +x.value]));
      const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
      guess += Date.UTC(y, mo - 1, d, h, mi, s) - shown;
    }
    return guess;
  } catch { return null; } // not an IANA name
}

// ICAL.Time -> epoch ms. Dates (all-day) become local midnight, like the app's own all-day events.
function toEpoch(t, tzid) {
  if (t.isDate) return new Date(t.year, t.month - 1, t.day).getTime();
  const zone = t.zone && t.zone.tzid;
  if (zone && zone !== 'floating') return t.toUnixTime() * 1000;
  if (tzid) {
    const ms = zonedToEpoch(t.year, t.month, t.day, t.hour, t.minute, t.second, tzid);
    if (ms != null) return ms;
  }
  return new Date(t.year, t.month - 1, t.day, t.hour, t.minute, t.second).getTime(); // floating: container's TZ
}

const clean = (v, max) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

/**
 * Parses an .ics file into one row per occurrence overlapping [from, to).
 * Rows look like the app's own events (start_ts, end_ts, all_day, title, ...) plus
 * id "ext:...", readonly: true and calendar: the feed's name.
 */
function parseICS(text, { from, to, name = '', feedKey = '' } = {}) {
  const root = new ICAL.Component(ICAL.parse(text));
  for (const tz of root.getAllSubcomponents('vtimezone')) {
    try { ICAL.TimezoneService.register(tz); } catch { /* bad zone, skip */ }
  }
  const calName = name || clean(root.getFirstPropertyValue('x-wr-calname'), 80) || 'Imported';

  // Masters and their moved/edited single occurrences (RECURRENCE-ID), grouped by UID.
  const masters = new Map(), exceptions = [];
  for (const comp of root.getAllSubcomponents('vevent')) {
    if (comp.hasProperty('recurrence-id')) exceptions.push(comp);
    else masters.set(comp.getFirstPropertyValue('uid') || crypto.randomUUID(), new ICAL.Event(comp));
  }
  for (const comp of exceptions) {
    const master = masters.get(comp.getFirstPropertyValue('uid'));
    if (master && master.isRecurring()) {
      try { master.relateException(comp); } catch { /* ignore */ }
    } else {
      // An edited occurrence whose series isn't in the feed: show it as a one-off.
      masters.set(`${comp.getFirstPropertyValue('uid')}#${comp.getFirstPropertyValue('recurrence-id')}`, new ICAL.Event(comp));
    }
  }

  const rows = [];
  const cancelled = c => String(c.getFirstPropertyValue('status') || '').toUpperCase() === 'CANCELLED';
  const add = (uid, item, startT, endT) => {
    if (cancelled(item.component)) return;
    const tzid = item.component.getFirstProperty('dtstart')?.getParameter('tzid');
    const allDay = Boolean(startT.isDate);
    const start = toEpoch(startT, tzid);
    let end = endT ? toEpoch(endT, item.component.getFirstProperty('dtend')?.getParameter('tzid') || tzid) : NaN;
    if (!(end > start)) end = start + (allDay ? DAY : 0);
    if (!(start < to && (end > from || (end === start && start >= from)))) return;
    rows.push({
      id: `ext:${feedKey}:${uid}:${start}`,
      uid, title: clean(item.summary, 300) || '(no title)', all_day: allDay ? 1 : 0, start_ts: start, end_ts: end,
      location: clean(item.location, 300), notes: clean(item.description, 5000),
      reminder_min: null, rrule: null, recurring: false, readonly: true, calendar: calName, source: 'import',
    });
  };

  for (const [uid, ev] of masters) {
    if (cancelled(ev.component) || !ev.startDate) continue;
    try {
      if (!ev.isRecurring()) { add(uid, ev, ev.startDate, ev.endDate); continue; }
      const it = ev.iterator();
      const before = rows.length;
      for (let i = 0, next; i < 200000 && rows.length - before < MAX_PER_EVENT && (next = it.next()); i++) {
        if (toEpoch(next) >= to) break;
        const occ = ev.getOccurrenceDetails(next);
        add(uid, occ.item, occ.startDate, occ.endDate);
      }
      for (let i = before; i < rows.length; i++) rows[i].recurring = true;
    } catch (err) {
      console.error(`[import] skipped event ${uid}: ${err.message}`);
    }
    if (rows.length > MAX_ROWS) break;
  }
  rows.sort((a, b) => a.start_ts - b.start_ts);
  return { name: calName, events: rows };
}

function windowNow(now = Date.now()) {
  return { from: now - PAST_DAYS * DAY, to: now + FUTURE_DAYS * DAY };
}

function load(feed, text, i) {
  const out = parseICS(text, { ...windowNow(), name: feed.name, feedKey: String(i) });
  const s = state.get(feed.url) || {};
  state.set(feed.url, { ...s, name: feed.name || out.name, events: out.events, loadedAt: Date.now() });
  return out.events.length;
}

async function refreshOne(feed, i) {
  const s = state.get(feed.url) || { name: feed.name || '', events: [] };
  s.lastFetch = Date.now();
  state.set(feed.url, s);
  try {
    const res = await fetch(feed.url, { signal: AbortSignal.timeout(30000), headers: { Accept: 'text/calendar' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 404 ? ' (check the address; it changes if you reset it in Google)' : ''}`);
    const text = await res.text();
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('The address did not return a calendar (.ics)');
    const n = load(feed, text, i);
    Object.assign(state.get(feed.url), { lastOk: Date.now(), error: null });
    try { fs.mkdirSync(cacheDir(), { recursive: true }); fs.writeFileSync(cacheFile(feed.url), text); } catch { /* cache is optional */ }
    return n;
  } catch (err) {
    const msg = err.name === 'TimeoutError' ? 'Timed out' : err.message;
    state.get(feed.url).error = msg;
    console.error(`[import] ${feed.name || 'calendar'} ${i + 1}: ${msg}`);
    return null;
  }
}

const refreshAll = () => Promise.all(config.importFeeds.map(refreshOne));

// All imported occurrences overlapping [from, to).
function inRange(from, to) {
  const out = [];
  for (const feed of config.importFeeds) {
    for (const e of state.get(feed.url)?.events || []) {
      if (e.start_ts < to && (e.end_ts > from || (e.end_ts === e.start_ts && e.start_ts >= from))) out.push(e);
    }
  }
  return out;
}

// For the status page: never shows the secret address itself.
function status() {
  return config.importFeeds.map(f => {
    const s = state.get(f.url) || {};
    return { name: s.name || f.name || 'Calendar', events: (s.events || []).length,
      lastOk: s.lastOk || null, lastFetch: s.lastFetch || null, error: s.error || null };
  });
}

function start() {
  if (!config.importFeeds.length) return;
  config.importFeeds.forEach((feed, i) => {
    try {
      const n = load(feed, fs.readFileSync(cacheFile(feed.url), 'utf8'), i);
      console.log(`[import] loaded ${n} saved events for ${state.get(feed.url).name}`);
    } catch { /* no saved copy yet */ }
  });
  const tick = async () => {
    await refreshAll();
    setTimeout(tick, Math.max(5, config.importMinutes) * 60000).unref?.();
  };
  tick();
}

// Test hook: put parsed events in place without fetching.
function _set(url, name, events) { state.set(url, { name, events }); }

module.exports = { parseICS, inRange, status, start, refreshAll, toEpoch, zonedToEpoch, _set };
