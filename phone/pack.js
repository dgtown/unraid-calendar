// Turns an .ics calendar (such as Outlook's published calendar) into the messages the Bluetooth
// display understands: the same day and month shapes as the calendar app's /api/display, so the
// display draws them exactly like the server's. Runs in the phone's browser (and in Node for tests);
// everything is in the phone's own time zone.
//
// Messages, one JSON per line (see display/src/main.cpp, "Bluetooth"):
//   hello  {type, v, key, now, offset, updated, from, to}
//   day    {type, date, off, title, long, events: [{title, where, allDay, time, end, start, stop, repeats}]}
//   month  {type, ym, title, year, month, firstWeekday, days, counts}
//   end    {type}

const DAY = 86400000;
const MAX_PER_EVENT = 2000;
const MAX_PER_DAY = 30;
export const MAX_BYTES = 46 * 1024;  // the display keeps up to 48 KB

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

const pad = n => String(n).padStart(2, '0');
export const isoDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const midnight = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });

// The display's fonts only have ASCII: swap common punctuation, drop accents and the rest.
export function ascii(s, max = 120) {
  if (!s) return '';
  const out = String(s)
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[  -​  ]/g, ' ')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ').trim();
  return out.length > max ? out.slice(0, max - 3).trimEnd() + '...' : out;
}
const time = ts => ascii(timeFmt.format(new Date(ts)));

// Wall-clock time in an IANA zone -> epoch ms (for TZIDs the file didn't describe).
function zonedToEpoch(y, mo, d, h, mi, s, tz) {
  let guess = Date.UTC(y, mo - 1, d, h, mi, s);
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric',
      day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    for (let i = 0; i < 2; i++) {
      const p = Object.fromEntries(fmt.formatToParts(new Date(guess)).map(x => [x.type, +x.value]));
      guess += Date.UTC(y, mo - 1, d, h, mi, s) - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    }
    return guess;
  } catch { return null; }
}

function toEpoch(t, tzid) {
  if (t.isDate) return new Date(t.year, t.month - 1, t.day).getTime();
  const zone = t.zone && t.zone.tzid;
  if (zone && zone !== 'floating') return t.toUnixTime() * 1000;
  if (tzid) {
    const ms = zonedToEpoch(t.year, t.month, t.day, t.hour, t.minute, t.second, tzid);
    if (ms != null) return ms;
  }
  return new Date(t.year, t.month - 1, t.day, t.hour, t.minute, t.second).getTime();
}

/** .ics text -> occurrences overlapping [from, to): {title, location, allDay, start, end, recurring} (ms). */
export function parseICS(ICAL, text, from, to) {
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("That isn't a calendar (.ics) file");
  const root = new ICAL.Component(ICAL.parse(text));
  for (const tz of root.getAllSubcomponents('vtimezone')) {
    try { ICAL.TimezoneService.register(tz); } catch { /* bad zone, skip */ }
  }
  const masters = new Map(), exceptions = [];
  let n = 0;
  for (const comp of root.getAllSubcomponents('vevent')) {
    if (comp.hasProperty('recurrence-id')) exceptions.push(comp);
    else masters.set(comp.getFirstPropertyValue('uid') || `anon${n++}`, new ICAL.Event(comp));
  }
  for (const comp of exceptions) {
    const master = masters.get(comp.getFirstPropertyValue('uid'));
    if (master && master.isRecurring()) {
      try { master.relateException(comp); } catch { /* ignore */ }
    } else {
      masters.set(`${comp.getFirstPropertyValue('uid')}#${comp.getFirstPropertyValue('recurrence-id')}`, new ICAL.Event(comp));
    }
  }

  const rows = [];
  const cancelled = c => String(c.getFirstPropertyValue('status') || '').toUpperCase() === 'CANCELLED';
  // Outlook marks cancelled meetings in the title rather than STATUS.
  const cancelledTitle = s => /^\s*(canceled|cancelled)\s*:/i.test(s || '');
  const add = (item, startT, endT, recurring) => {
    if (cancelled(item.component) || cancelledTitle(item.summary)) return;
    const tzid = item.component.getFirstProperty('dtstart')?.getParameter('tzid');
    const allDay = Boolean(startT.isDate);
    const start = toEpoch(startT, tzid);
    let end = endT ? toEpoch(endT, item.component.getFirstProperty('dtend')?.getParameter('tzid') || tzid) : NaN;
    if (!(end > start)) end = start + (allDay ? DAY : 0);
    if (!(start < to && (end > from || (end === start && start >= from)))) return;
    rows.push({ title: item.summary || '', location: item.location || '', allDay, start, end, recurring });
  };
  for (const [, ev] of masters) {
    if (cancelled(ev.component) || !ev.startDate) continue;
    try {
      if (!ev.isRecurring()) { add(ev, ev.startDate, ev.endDate, false); continue; }
      const it = ev.iterator();
      for (let i = 0, next; i < 100000 && i < MAX_PER_EVENT * 50 && (next = it.next()); i++) {
        if (toEpoch(next) >= to) break;
        const occ = ev.getOccurrenceDetails(next);
        add(occ.item, occ.startDate, occ.endDate, true);
      }
    } catch (err) {
      console.warn('skipped an event:', err.message);
    }
  }
  rows.sort((a, b) => a.start - b.start);
  return rows;
}

/** One day, like the server's /api/display. */
export function buildDay(events, day) {
  const from = day.getTime(), to = addDays(day, 1).getTime();
  const list = events
    .filter(e => e.start < to && (e.end > from || (e.end === e.start && e.start >= from)))
    .sort((a, b) => (b.allDay - a.allDay) || a.start - b.start)
    .slice(0, MAX_PER_DAY)
    .map(e => {
      const startsToday = e.start >= from, endsToday = e.end <= to;
      return {
        title: ascii(e.title, 80) || '(no title)',
        where: ascii(e.location, 60),
        allDay: e.allDay,
        time: e.allDay ? 'All day' : startsToday ? time(e.start) : 'cont.',
        end: e.allDay ? '' : endsToday ? time(e.end) : '',
        start: Math.floor(e.start / 1000),
        stop: Math.floor(e.end / 1000),
        repeats: e.recurring,
      };
    });
  const noon = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12);
  return {
    type: 'day',
    date: isoDay(day),
    off: -noon.getTimezoneOffset() * 60,
    title: `${WEEKDAYS[day.getDay()]} ${MONTHS[day.getMonth()]} ${day.getDate()}`,
    long: `${WEEKDAYS_LONG[day.getDay()]}, ${MONTHS_LONG[day.getMonth()]} ${day.getDate()}`,
    events: list,
  };
}

export function buildMonth(events, year, month) {
  const n = new Date(year, month, 0).getDate();
  const counts = [];
  for (let d = 1; d <= n; d++) {
    const from = new Date(year, month - 1, d).getTime(), to = new Date(year, month - 1, d + 1).getTime();
    counts.push(events.filter(e => e.start < to && (e.end > from || (e.end === e.start && e.start >= from))).length);
  }
  return {
    type: 'month', ym: `${year}-${pad(month)}`, title: `${MONTHS_LONG[month - 1]} ${year}`,
    year, month, firstWeekday: new Date(year, month - 1, 1).getDay(), days: n, counts,
  };
}

/**
 * Everything to send, as lines of JSON. Trims days off the end until it fits the display.
 * @returns {{lines: string[], from: string, to: string, days: number, events: number, bytes: number}}
 */
export function buildMessages(events, { key, now = Date.now(), daysBack = 7, weeksAhead = 6, maxBytes = MAX_BYTES } = {}) {
  const today = midnight(new Date(now));
  const first = addDays(today, -daysBack);
  let nDays = daysBack + weeksAhead * 7;
  const dayMsgs = [];
  for (let i = 0; i < nDays; i++) dayMsgs.push(buildDay(events, addDays(first, i)));

  const build = n => {
    const last = addDays(first, n - 1);
    const months = [];
    for (let y = first.getFullYear(), m = first.getMonth() + 1; y < last.getFullYear() || (y === last.getFullYear() && m <= last.getMonth() + 1);) {
      months.push(buildMonth(events, y, m));
      if (++m > 12) { m = 1; y++; }
    }
    const hello = {
      type: 'hello', v: 1, key, now: Math.floor(now / 1000),
      offset: -new Date(now).getTimezoneOffset() * 60,
      updated: ascii(`${WEEKDAYS[new Date(now).getDay()]} ${time(now)}`),
      from: isoDay(first), to: isoDay(last),
    };
    const lines = [hello, ...dayMsgs.slice(0, n), ...months, { type: 'end' }].map(o => JSON.stringify(o));
    return { lines, from: hello.from, to: hello.to };
  };
  let out = build(nDays);
  const size = ls => ls.slice(1, -1).reduce((s, l) => s + l.length + 1, 0);  // what the display stores
  while (size(out.lines) > maxBytes && nDays > daysBack + 1) {
    nDays--;
    out = build(nDays);
  }
  const sent = dayMsgs.slice(0, nDays);
  return {
    ...out, days: nDays,
    events: sent.reduce((s, d) => s + d.events.length, 0),
    bytes: size(out.lines),
  };
}
