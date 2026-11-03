'use strict';
const chrono = require('chrono-node');

const UNITS = { m: 1, min: 1, mins: 1, minute: 1, minutes: 1, h: 60, hr: 60, hrs: 60, hour: 60, hours: 60, d: 1440, day: 1440, days: 1440 };
const FILLER = /^(?:(?:on|at|for|from|this|by|@|-|,)\s+)+|(?:\s+(?:on|at|for|from|this|by|@|-|,))+$/gi;

/**
 * Turn a text message into either a command or a new event.
 * Returns one of:
 *   { type: 'command', cmd, arg }
 *   { type: 'event', title, allDay, start: Date, end: Date|null, location, reminderMin }
 *   { type: 'error', message }
 */
function parseMessage(raw, ref = new Date(), opts = {}) {
  const defaultDurationMin = opts.defaultDurationMin || 60;
  let text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return { type: 'error', message: 'Empty message.' };
  const lower = text.toLowerCase().replace(/[.!?]+$/, '');

  // --- Commands -----------------------------------------------------------
  if (/^(help|\?|commands)$/.test(lower)) return { type: 'command', cmd: 'help' };
  if (/^(undo|oops)$/.test(lower)) return { type: 'command', cmd: 'undo' };
  if (/^(today|what'?s today|agenda)$/.test(lower)) return { type: 'command', cmd: 'agenda', arg: 'today' };
  if (/^tomorrow$/.test(lower)) return { type: 'command', cmd: 'agenda', arg: 'tomorrow' };
  if (/^(list|week|upcoming|this week|next)$/.test(lower)) return { type: 'command', cmd: 'agenda', arg: 'week' };
  let m = lower.match(/^(?:cancel|delete|remove)\s+(.+)$/);
  if (m) return { type: 'command', cmd: 'cancel', arg: m[1].trim() };

  // --- Reminder: "remind 30m", "remind me 1 hour", "remind" ---------------
  let reminderMin = null;
  m = text.match(/\bremind(?:er)?(?:\s+me)?(?:\s+(\d+)\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?)\b(?:\s+before)?)?/i);
  if (m) {
    reminderMin = m[1] ? parseInt(m[1], 10) * UNITS[m[2].toLowerCase()] : 30;
    text = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
  }

  // --- Location: "@ Main St Clinic" (must be "@ " or " at the ") ---------
  let location = null;
  m = text.match(/(?:^|\s)@\s*([^@]+)$/);
  if (m) {
    location = m[1].trim();
    text = text.slice(0, m.index).trim();
    // If the location swallowed the date ("@ clinic tue 3pm"), give the date back.
    const inLoc = chrono.parse(location, ref, { forwardDate: true })[0];
    if (inLoc && !chrono.parse(text, ref, { forwardDate: true })[0]) {
      text = `${text} ${inLoc.text}`.trim();
      location = (location.slice(0, inLoc.index) + location.slice(inLoc.index + inLoc.text.length)).replace(FILLER, '').trim() || null;
    }
  }

  // --- Date / time ---------------------------------------------------------
  const results = chrono.parse(text, ref, { forwardDate: true });
  if (!results.length) {
    return { type: 'error', message: `I couldn't find a date in "${raw}". Try something like "Dentist tue 3pm".` };
  }
  const r = results[0];
  const hasTime = r.start.isCertain('hour');
  let start = r.start.date();
  let end = r.end ? r.end.date() : null;

  // "6:30" with no am/pm almost always means evening for 1-7 o'clock.
  if (hasTime && !r.start.isCertain('meridiem') && start.getHours() >= 1 && start.getHours() <= 7) {
    start = new Date(start.getTime() + 12 * 3600 * 1000);
    if (end && !r.end.isCertain('meridiem') && end.getHours() < 12) end = new Date(end.getTime() + 12 * 3600 * 1000);
  }

  let leftover = (text.slice(0, r.index) + ' ' + text.slice(r.index + r.text.length)).replace(/\s+/g, ' ').trim();

  // A bare time range chrono skipped, e.g. "party Saturday 2-5".
  if (!hasTime) {
    const tr = leftover.match(/(?:^|\s)(?:from\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?=\s|$)/i);
    if (tr && +tr[1] <= 12 && +tr[4] <= 12) {
      const to24 = (h, ap, fallbackAp) => {
        h = +h % 12;
        ap = (ap || fallbackAp || '').toLowerCase();
        if (ap === 'pm') return h + 12;
        if (ap === 'am') return h;
        return h >= 1 && h <= 7 ? h + 12 : h; // guess: 1-7 means afternoon/evening
      };
      const day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      const sh = to24(tr[1], tr[3], tr[6]);
      let eh = to24(tr[4], tr[6]);
      if (!tr[6] && eh < sh && eh + 12 < 24) eh += 12;
      const s2 = new Date(day); s2.setHours(sh, +(tr[2] || 0));
      let e2 = new Date(day); e2.setHours(eh, +(tr[5] || 0));
      if (e2 <= s2) e2 = new Date(e2.getTime() + 24 * 3600 * 1000);
      leftover = (leftover.slice(0, tr.index) + ' ' + leftover.slice(tr.index + tr[0].length)).replace(/\s+/g, ' ').trim();
      return finish(leftover, { allDay: false, start: s2, end: e2, location, reminderMin });
    }
  }

  if (!hasTime) {
    start = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    end = end ? new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1)
              : new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  } else {
    if (end && end <= start) {
      // "9pm-1am" style: end rolls into the next day.
      end = new Date(end.getTime() + 24 * 3600 * 1000);
    }
    if (!end) end = new Date(start.getTime() + defaultDurationMin * 60000);
  }

  return finish(leftover, { allDay: !hasTime, start, end, location, reminderMin });
}

// Title = whatever is left once the date, location and reminder are removed.
function finish(leftover, ev) {
  let title = leftover;
  let prev;
  do { prev = title; title = title.replace(FILLER, '').replace(/^[\s,;:-]+|[\s,;:-]+$/g, '').trim(); } while (title !== prev);
  if (!title) title = 'Event';
  title = title.charAt(0).toUpperCase() + title.slice(1);

  return { type: 'event', title, ...ev };
}

module.exports = { parseMessage };
