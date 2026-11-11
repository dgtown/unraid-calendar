'use strict';
// Compact, pre-formatted agenda for small screens such as the ESP32 "Cheap Yellow Display".
// Everything is plain ASCII and already in the calendar's time zone, so the device only draws text.
const { timeFmt } = require('./format');

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

const pad = n => String(n).padStart(2, '0');
const isoDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

// The display's built-in fonts only have ASCII: swap common punctuation, drop accents and the rest.
function ascii(s, max = 120) {
  if (!s) return '';
  const out = String(s)
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[  -   ]/g, ' ')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ').trim();
  return out.length > max ? out.slice(0, max - 3).trimEnd() + '...' : out;
}

const time = ts => ascii(timeFmt.format(new Date(ts)));

/**
 * @param {Array} events  rows from store.eventsInRange (repeating events already expanded)
 * @param {number} now    epoch ms
 * @param {number} days   how many days, starting today
 */
function buildDisplay(events, now, days = 7, maxPerDay = 30) {
  const today = new Date(now);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const out = [];
  for (let i = 0; i < days; i++) {
    const day = addDays(start, i);
    const from = day.getTime(), to = addDays(start, i + 1).getTime();
    const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : WEEKDAYS[day.getDay()];
    const list = events
      .filter(e => e.start_ts < to && e.end_ts > from)
      .sort((a, b) => (b.all_day - a.all_day) || a.start_ts - b.start_ts)
      .slice(0, maxPerDay)
      .map(e => {
        const allDay = Boolean(e.all_day);
        const startsToday = e.start_ts >= from, endsToday = e.end_ts <= to;
        return {
          title: ascii(e.title, 80) || '(no title)',
          where: ascii(e.location, 60),
          allDay,
          time: allDay ? 'All day' : startsToday ? time(e.start_ts) : 'cont.',
          end: allDay ? '' : endsToday ? time(e.end_ts) : '',
          start: Math.floor(e.start_ts / 1000),
          stop: Math.floor(e.end_ts / 1000),
          repeats: Boolean(e.rrule),
        };
      });
    out.push({
      date: isoDay(day),
      label,
      title: `${WEEKDAYS[day.getDay()]} ${MONTHS[day.getMonth()]} ${day.getDate()}`,
      long: `${WEEKDAYS_LONG[day.getDay()]}, ${MONTHS_LONG[day.getMonth()]} ${day.getDate()}`,
      events: list,
    });
  }
  return {
    now: Math.floor(now / 1000),
    // Seconds east of UTC right now, so the device can show local time without its own time-zone rules.
    offset: -today.getTimezoneOffset() * 60,
    updated: time(now),
    days: out,
  };
}

module.exports = { buildDisplay, ascii };
