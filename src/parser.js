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
  text = text.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
  const lower = text.toLowerCase().replace(/[.!?\s]+$/, '');

  // --- Commands -----------------------------------------------------------
  if (!opts.eventOnly) {
    const cmd = parseCommand(text, lower, ref);
    if (cmd) return cmd;
  }
  let m;

  // Leading verbs people naturally type: "add ...", "schedule ...", "new event ...".
  text = text.replace(/^(?:please\s+)?(?:add|schedule|book|create|new|put|set up|make)(?:\s+(?:an?|new))?(?:\s+(?:event|appt|appointment)(?=\s+(?:with|for|at|on)\b))?\s+/i, (m) =>
    /appointment|appt/i.test(m) ? 'Appointment ' : '');

  // --- Reminder: "remind 30m", "remind me 1 hour", "remind" ---------------
  let reminderMin = null;
  m = text.match(/\bremind(?:er)?(?:\s+me)?(?:\s+(\d+)\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?)\b(?:\s+before)?)?/i);
  if (m) {
    reminderMin = m[1] ? parseInt(m[1], 10) * UNITS[m[2].toLowerCase()] : 30;
    text = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
    if (m.index === 0) text = text.replace(/^to\s+/i, ''); // "remind me to call mom tue 3pm"
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

// ---------------------------------------------------------------------------
// Commands. Returns { type: 'command', cmd, ... } or null (= treat as an event).
// ---------------------------------------------------------------------------
const DUR = "(?:(?:\\d+(?:\\.\\d+)?|an?|one|half an?)\\s*(?:m|mins?|minutes?|h|hrs?|hours?|d|days?)|half an hour|an hour and a half)";
const durRe = s => new RegExp(s.replace(/DUR/g, DUR));

// "30 min", "1h", "an hour", "half an hour", "1.5 hours" -> minutes
function parseDuration(s) {
  s = String(s || '').trim().toLowerCase();
  if (/^half an? hour$/.test(s)) return 30;
  if (s === 'an hour and a half') return 90;
  const m = s.match(/^(\d+(?:\.\d+)?|an?|one|half an?)\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?)$/);
  if (!m) return null;
  const n = /^(a|an|one)$/.test(m[1]) ? 1 : /^half/.test(m[1]) ? 0.5 : parseFloat(m[1]);
  return Math.round(n * UNITS[m[2].replace(/s$/, '').replace(/^mi$/, 'min')] || 0) || null;
}

// True when the text names a day or a clock time, i.e. it's really a new event.
function hasWhen(s, ref) {
  const r = chrono.parse(s, ref)[0];
  return Boolean(r && (r.start.isCertain('hour') || r.start.isCertain('day') || r.start.isCertain('weekday')));
}
const target = s => s.replace(/^(?:my|the|our)\s+/, '').trim();

function parseCommand(text, lower, ref) {
  if (/^(help|\?|commands|menu)$/.test(lower)) return { type: 'command', cmd: 'help' };
  if (/^(undo|oops)$/.test(lower)) return { type: 'command', cmd: 'undo' };
  let m;

  // A reply to a numbered list: "2" or "#2"
  m = lower.match(/^#?\s*(\d{1,2})$/);
  if (m) return { type: 'command', cmd: 'choose', arg: +m[1] };

  m = lower.match(/^(?:find|search(?:\s+for)?|look\s*up|lookup)\s+(.+)$/);
  if (m) return { type: 'command', cmd: 'find', arg: target(m[1]) };

  m = lower.match(/^(?:cancel|delete|remove)\s+(.+)$/);
  if (m) return { type: 'command', cmd: 'cancel', arg: target(m[1]) };

  // "remind me 30 min before soccer", "remind me about soccer 1 hour before", "remind me before soccer"
  m = lower.match(durRe('^(?:set\\s+an?\\s+)?remind(?:er)?(?:\\s+me)?\\s+(?:(DUR)\\s+)?(?:before|ahead of|prior to)\\s+(.+)$'));
  if (m && !hasWhen(m[2], ref)) return { type: 'command', cmd: 'remind', arg: target(m[2]), minutes: m[1] ? parseDuration(m[1]) : 30 };
  m = lower.match(durRe('^(?:set\\s+an?\\s+)?remind(?:er)?(?:\\s+me)?\\s+(?:about|of|for)\\s+(.+?)(?:\\s+(DUR)(?:\\s+(?:before|ahead|early|earlier))?)?$'));
  if (m && !hasWhen(m[1], ref)) return { type: 'command', cmd: 'remind', arg: target(m[1]), minutes: m[2] ? parseDuration(m[2]) : 30 };
  m = lower.match(/^(?:no reminder|don'?t remind me|stop reminding me|remove (?:the )?reminder|cancel (?:the )?reminder)\s+(?:for|about|of|on)\s+(.+)$/);
  if (m) return { type: 'command', cmd: 'remind', arg: target(m[1]), minutes: null };

  // "push lunch back an hour", "move dentist 30 min later", "move lunch earlier by 15 min"
  const verb = '(?:move|push|shift|bump|reschedule|change)';
  m = lower.match(durRe(`^${verb}\\s+(.+?)\\s+(?:(back|later|forward|ahead|up|earlier)\\s+(?:by\\s+)?(DUR)|(?:by\\s+)?(DUR)\\s+(back|later|forward|ahead|up|earlier|sooner))$`));
  if (m) {
    const dir = m[2] || m[5];
    const mins = parseDuration(m[3] || m[4]);
    if (mins) return { type: 'command', cmd: 'move', arg: target(m[1]), shiftMin: /back|later/.test(dir) ? mins : -mins };
  }
  // "move lunch to 1pm", "reschedule dentist to thursday 3pm", "change soccer to 10am"
  m = lower.match(new RegExp(`^${verb}\\s+(.+?)\\s+(?:to|till|until|for)\\s+(.+)$`));
  if (m && (hasWhen(m[2], ref) || /^(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm|a|p)?$/.test(m[2]))) {
    return { type: 'command', cmd: 'move', arg: target(m[1]), when: m[2] };
  }
  // "move dentist thursday 3pm" (no "to")
  m = lower.match(/^(?:move|reschedule)\s+(.+)$/);
  if (m) {
    const r = chrono.parse(m[1], ref)[0];
    if (r && r.index > 0) return { type: 'command', cmd: 'move', arg: target(m[1].slice(0, r.index).replace(/\s+(?:on|at)$/, '')), when: m[1].slice(r.index) };
  }
  if (/^(help|\?|commands)$/.test(lower)) return { type: 'command', cmd: 'help' };
  if (/^(undo|oops)$/.test(lower)) return { type: 'command', cmd: 'undo' };
  // "today", "appointments", "what do I have today", "my schedule tomorrow", "this week"...
  const ask = "(?:(?:what'?s(?: on)?|what do i have|what have i got|my|any|show(?: me)?)\\s+)?" +
    "(?:(?:appointments?|appts?|events?|schedule|agenda|calendar|plans)\\s*)?(?:(?:for|on)\\s+)?";
  if (/^(?:appointments?|appts?|events?|schedule|agenda|calendar|plans)$/.test(lower) ||
      new RegExp(`^${ask}(?:today|this morning|tonight)$`).test(lower)) {
    return { type: 'command', cmd: 'agenda', arg: 'today' };
  }
  if (new RegExp(`^${ask}tomorrow$`).test(lower)) return { type: 'command', cmd: 'agenda', arg: 'tomorrow' };
  if (new RegExp(`^${ask}(?:this |the )?(week|upcoming|next 7 days|next|list)$`).test(lower)) return { type: 'command', cmd: 'agenda', arg: 'week' };
  // Any other question about a date ("what's on friday?", "anything Saturday") is an agenda lookup, never a new event.
  m = lower.match(/^when(?:'s| is| are| was)?\s+(?:my|the|our)?\s*(.+?)$/);
  if (m && !chrono.parse(m[1], ref)[0]) return { type: 'command', cmd: 'find', arg: m[1].trim() };
  const questionWord = /^(?:what|whats|when|where|do i|did i|am i|any|anything|is there|are there|show|list|check|tell me)\b/.test(lower);
  const justARange = /^(?:the\s+)?(?:(?:this|next)\s+(?:week|weekend|month)|weekend|(?:first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last)\s+week\s+(?:of|in)\s+[a-z]+\.?(?:\s+\d{4})?)$/.test(lower);
  const timelessQuestion = /\?\s*$/.test(text) && !(chrono.parse(text, ref)[0]?.start.isCertain('hour'));
  if (questionWord || justARange || timelessQuestion) {
    const range = resolveRange(lower, text, ref);
    if (range) return { type: 'command', cmd: 'agenda', arg: 'range', ...range };
    if (/\bweek\b/.test(lower)) return { type: 'command', cmd: 'agenda', arg: 'week' };
    if (!/\d/.test(lower)) return { type: 'command', cmd: 'agenda', arg: 'today' };
  }
  m = lower.match(/^(?:daily|morning)(?:\s+(?:text|agenda|summary))?(?:\s+(.+))?$/);
  if (m) return { type: 'command', cmd: 'daily', arg: (m[1] || '').trim() };
  return null;
}

// Title = whatever is left once the date, location and reminder are removed.
function finish(leftover, ev) {
  let title = leftover;
  let prev;
  do { prev = title; title = title.replace(FILLER, '').replace(/^[\s,;:?!-]+|[\s,;:?!-]+$/g, '').trim(); } while (title !== prev);
  if (!title) title = 'Event';
  title = title.charAt(0).toUpperCase() + title.slice(1);

  return { type: 'event', title, ...ev };
}

// ---------------------------------------------------------------------------
// Date ranges for questions: "second week of november", "in december",
// "this weekend", "nov 9-15", "next week", "friday".
// Returns { start: Date, end: Date (exclusive), multiDay: bool } or null.
// ---------------------------------------------------------------------------
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const ORD = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5 };
const day0 = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

function monthIndex(word) {
  const i = MONTHS.indexOf(word.slice(0, 3));
  return i >= 0 && (word.length <= 3 || 'january february march april may june july august september october november december'.includes(word)) ? i : -1;
}
// The next occurrence of a month (this month counts), or the given year.
function monthStart(mi, year, ref) {
  if (year) return new Date(year, mi, 1);
  const y = mi < ref.getMonth() ? ref.getFullYear() + 1 : ref.getFullYear();
  return new Date(y, mi, 1);
}

function resolveRange(lower, text, ref) {
  const today = day0(ref);
  let m;

  // "second week of november", "last week of dec 2027"
  m = lower.match(/\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last)\s+week\s+(?:of|in)\s+([a-z]+)\.?(?:\s+(\d{4}))?/);
  if (m && monthIndex(m[2]) >= 0) {
    const first = monthStart(monthIndex(m[2]), m[3] && +m[3], ref);
    const next = new Date(first.getFullYear(), first.getMonth() + 1, 1);
    // Weeks run Sunday-Saturday; week 1 is the (possibly partial) week containing the 1st.
    const week1End = addDays(first, 7 - first.getDay());
    let start, end;
    if (m[1] === 'last') {
      const lastDay = addDays(next, -1);
      start = addDays(lastDay, -lastDay.getDay());
      if (start < first) start = first;
      end = next;
    } else {
      const n = ORD[m[1]];
      start = n === 1 ? first : addDays(week1End, (n - 2) * 7);
      end = n === 1 ? week1End : addDays(start, 7);
      if (start >= next) return null;
      if (end > next) end = next;
    }
    return { start, end, multiDay: true };
  }

  // "this weekend", "next weekend"
  m = lower.match(/\b(this|next)?\s*weekend\b/);
  if (m) {
    let sat = addDays(today, (6 - today.getDay() + 7) % 7);
    if (today.getDay() === 0) sat = addDays(today, -1); // Sunday: still "this weekend"
    if (m[1] === 'next') sat = addDays(sat, 7);
    const start = sat < today ? today : sat;
    return { start, end: addDays(sat, 2), multiDay: true };
  }

  // "this month", "next month"
  m = lower.match(/\b(this|next)\s+month\b/);
  if (m) {
    const start = new Date(ref.getFullYear(), ref.getMonth() + (m[1] === 'next' ? 1 : 0), 1);
    return { start: m[1] === 'this' ? today : start, end: new Date(start.getFullYear(), start.getMonth() + 1, 1), multiDay: true };
  }

  // "this week", "next week"
  m = lower.match(/\b(this|next)\s+week\b/);
  if (m) {
    const sunday = addDays(today, -today.getDay());
    if (m[1] === 'this') return { start: today, end: addDays(sunday, 7), multiDay: true };
    return { start: addDays(sunday, 7), end: addDays(sunday, 14), multiDay: true };
  }

  // "in december", "december", "for march 2027" (a month with no day number)
  m = lower.match(/\b(?:in|for|during|of)?\s*([a-z]+)\.?(?:\s+(\d{4}))?$/);
  if (m && monthIndex(m[1]) >= 0 && m[1].length >= 3 && !/\d{1,2}(?:st|nd|rd|th)?\b/.test(lower.replace(/\d{4}/, ''))) {
    const start = monthStart(monthIndex(m[1]), m[2] && +m[2], ref);
    return { start, end: new Date(start.getFullYear(), start.getMonth() + 1, 1), multiDay: true };
  }

  // Anything chrono understands: "friday", "nov 19", "nov 9-15", "next tuesday"
  const r = chrono.parse(text, ref, { forwardDate: true })[0];
  if (r) {
    const start = day0(r.start.date());
    if (r.end) return { start, end: addDays(day0(r.end.date()), 1), multiDay: true };
    if (/\bweek\b/.test(lower)) return { start, end: addDays(start, 7), multiDay: true };
    return { start, end: addDays(start, 1), multiDay: false };
  }
  return null;
}

module.exports = { parseMessage, resolveRange, parseDuration };
