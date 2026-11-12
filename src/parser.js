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
  if (text === text.toUpperCase() && /[A-Z]{3,}\s+[A-Z0-9]{2,}/.test(text)) text = text.toLowerCase(); // ALL CAPS
  text = relativeDates(shorthand(text), ref);
  const lower = text.toLowerCase().replace(/[.!?\s]+$/, '');

  // --- Commands -----------------------------------------------------------
  if (!opts.eventOnly) {
    const cmd = parseCommand(text, lower, ref);
    if (cmd) return cmd;
  }
  let m;

  // Leading verbs people naturally type: "add ...", "schedule ...", "new event ...".
  text = text.replace(/^(?:please\s+)?(?:add|schedule|book(?!\s+club)|create|new(?=\s+(?:event|appt|appointment)\b)|put|set up|make)(?:\s+(?:an?|new))?(?:\s+(?:event|appt|appointment)(?=\s+(?:with|for|at|on)\b))?\s+/i, (m) =>
    /appointment|appt/i.test(m) ? 'Appointment ' : '');

  // Chatty openers: "I have a ...", "We've got ...", "Need to ...", "Don't forget to ..."
  text = text.replace(/^(?:i|we)(?:'ve\s+got|\s+have\s+got|'ve|\s+have|\s+got)\s+(?!to\b)(?:(?:an?|the|my|our)\s+)?/i, '')
    .replace(/^(?:(?:i|we)\s+)?(?:(?:need|have|got|want)\s+to|gotta)\s+/i, '')
    .replace(/^don'?t\s+(?:let\s+me\s+)?forget(?:\s+(?:to|about))?\s+(?:(?:the|my|our)\s+)?/i, '');

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
    if (/^\d{1,2}(?::?\d{2})?\s*(?:am|pm)?$/i.test(location)) { text = `${text} at ${location}`; location = null; } // "@ 10" is a time
    // If the location swallowed the date ("@ clinic tue 3pm"), give the date back.
    const inLoc = chrono.parse(location, ref, { forwardDate: true })[0];
    if (inLoc && !chrono.parse(text, ref, { forwardDate: true })[0]) {
      text = `${text} ${inLoc.text}`.trim();
      location = (location.slice(0, inLoc.index) + location.slice(inLoc.index + inLoc.text.length)).replace(FILLER, '').trim() || null;
    }
  }

  // --- Repeats: "every Saturday", "every other week", "monthly on the 1st" ---
  const hintText = text;
  const rec = extractRepeat(text, ref);
  if (rec) text = rec.text;

  // --- Length: "for 4 hours", "2h", "90 min", "for 3 days" (not "in 2 hours") ---
  let lengthMin = null;
  m = text.match(new RegExp(`(?:^|\\s)(?:for\\s+)?(${DUR})(?:\\s+long)?(?=[\\s,.]|$)`, 'i'));
  if (m && !/\bin$/i.test(text.slice(0, m.index).trim()) && !/\d\s*[MHD]$/.test(m[1]) && (/^\s*for\b/i.test(m[0]) || !/d(?:ays?)?$/i.test(m[1]))) {
    lengthMin = parseDuration(m[1]);
    if (lengthMin) text = (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim();
  }

  // --- Date / time ---------------------------------------------------------
  // Words that tell 9 AM from 9 PM when the text doesn't say.
  const amHint = /\b(?:mornings?|breakfast|brunch|sunrise)\b/i.test(hintText);
  const pmHint = !amHint && /\b(?:tonight|nights?|evenings?|afternoons?|dinner|supper|drinks|happy hour|concert|bedtime)\b/i.test(hintText);
  const to24 = (h, ap) => {
    ap = (ap || '').toLowerCase();
    if (ap) return (h % 12) + (ap[0] === 'p' ? 12 : 0);
    if (h > 12 || h === 0) return h;
    if (amHint) return h % 12;
    if (pmHint) return (h % 12) + 12;
    return h >= 1 && h <= 7 ? h + 12 : h; // bare 1-7 o'clock is almost always afternoon/evening
  };
  // "Game night", "Morning walk": part of the name, not a time of day (unless it follows a day: "Fri night").
  text = text.replace(new RegExp(`(?<!\\b(?:${WDAY}|today|tomorrow|this|last|every|the|at|in the|on|late|early)\\s)\\b(n)(ight)\\b|(?<!\\b(?:${WDAY}|today|tomorrow|this|last|every|the|at|in the|on|late|early)\\s)\\b(m)(orning|idnight)\\b(?=\\s+[a-z])`, 'gi'),
    (all, ...g) => { const [a, b] = g.filter(x => typeof x === 'string' && x.length); return `${a}${MASK}${b}`; });

  let results = chrono.parse(text, ref, { forwardDate: true }).filter(r => !/^(?:half\b|\d+\s*[a-z]+$)/i.test(r.text) || /^\d+\s*(?:am|pm)$/i.test(r.text)); // not "half day", "3M", "100 day"
  const hasDay = r => r.start.isCertain('day') || r.start.isCertain('weekday');
  let dateRes = results.find(hasDay);
  // A holiday name counts as the date when nothing else does ("Thanksgiving dinner 4pm").
  let holiday = null;
  if (!dateRes) holiday = holidayIn(text, ref);
  if (!dateRes && !holiday) dateRes = results.find(r => r.start.isCertain('month')) || null;
  let timeRes = dateRes && dateRes.start.isCertain('hour') ? dateRes
    : results.find(r => r !== dateRes && r.start.isCertain('hour') && !hasDay(r)) || null;
  if (!dateRes && !timeRes && !holiday && results.length) dateRes = results[0];
  if (!dateRes && !timeRes && !holiday && rec) holiday = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate()); // "Meds every day"
  if (!dateRes && !timeRes && !holiday) {
    const n = text.match(/^(.*\S)\s+(\d{1,2})$/);
    if (n && +n[2] >= 1 && +n[2] <= 12) return { type: 'error', message: `I couldn't find a day or time in "${raw}". If you meant ${n[2]} o'clock, try "${n[1]} at ${n[2]}".` };
    return { type: 'error', message: `I couldn't find a date in "${raw}". Try something like "Dentist tue 3pm".` };
  }

  // Cut the date and time words out of the title, leaving a marker where the date was.
  let leftover = text;
  for (const r of [dateRes, timeRes].filter((r, i, a) => r && a.indexOf(r) === i).sort((x, y) => y.index - x.index)) {
    leftover = `${leftover.slice(0, r.index)} ${r === dateRes ? HERE : ''} ${leftover.slice(r.index + r.text.length)}`;
  }
  const squeeze = t => t.replace(/\s+/g, ' ').trim();
  leftover = squeeze(leftover);

  const base = dateRes ? dateRes.start.date() : holiday || timeRes.start.date();
  let day = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  const today0 = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  // A bare weekday always means the coming one.
  if (dateRes && !dateRes.start.isCertain('day') && dateRes.start.isCertain('weekday') && !/\blast\b/i.test(dateRes.text)) {
    while (day < today0) day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 7);
  }
  const at = (h, min) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, min || 0);
  let start = null, end = null;

  if (timeRes) {
    const clock = (c) => at(to24(c.get('hour'), c.isCertain('meridiem') ? (c.get('hour') >= 12 ? 'pm' : 'am') : ''), c.get('minute'));
    start = clock(timeRes.start);
    if (timeRes.end && timeRes.end.isCertain('hour')) {
      end = clock(timeRes.end);
      if (dateRes === timeRes && (timeRes.end.isCertain('day') || timeRes.end.isCertain('weekday'))) { // "Fri 9pm - Sat 2am"
        const e = timeRes.end.date();
        end = new Date(e.getFullYear(), e.getMonth(), e.getDate(), end.getHours(), end.getMinutes());
      }
    }
  } else {
    // Times chrono doesn't see: "2-5", "8 to 12", "345", "1230", and a bare hour next to the date ("tomorrow 3").
    let tr = leftover.match(/(?:^|\s)(?:from\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?=\s|$)/i);
    if (tr && +tr[1] <= 12 && +tr[4] <= 12) {
      const sh = to24(+tr[1], tr[3] || tr[6]);
      let eh = to24(+tr[4], tr[6]);
      if (!tr[6] && eh < sh && eh + 12 < 24) eh += 12;
      start = at(sh, +(tr[2] || 0));
      end = at(eh, +(tr[5] || 0));
    } else if ((tr = leftover.match(new RegExp(`${HERE}\\s*(?:at\\s+)?(\\d{1,2})(00|15|30|45)(?=\\s|$)|(?<![#$\\w.:/-])(\\d{1,2})(00|15|30|45)(?=\\s*${HERE})|(?<![#$\\w.:/-]|\\b(?:room|rm|flight|apt|suite|gate|unit|no|number)\\.?\\s)(\\d{1,2})(00|15|30|45)$`, 'i')))
        && +(tr[1] || tr[3] || tr[5]) <= 23 && !/^(?:19|20)\d\d$/.test((tr[1] || tr[3] || tr[5]) + (tr[2] || tr[4] || tr[6]))) {
      const hh = tr[1] || tr[3] || tr[5];
      start = at(hh[0] === '0' ? +hh : to24(+hh), +(tr[2] || tr[4] || tr[6])); // "0600" is 6 AM
      if (tr[1]) tr = { index: tr.index + HERE.length, 0: tr[0].slice(HERE.length) };       // keep the marker
      else if (tr[3]) tr = { index: tr.index, 0: tr[3] + tr[4] };
    } else if ((dateRes || holiday) && (tr = leftover.match(new RegExp(`${HERE}\\s*(?:at\\s+)?(\\d{1,2})(?=\\s|$)|(?<!\\b(?:of|for|x|by|no|number|grade|room|gate|week|day|top|age|turns?|is|#)\\s)(?<![#$\\w.:/-])(\\d{1,2})$`, 'i'))) && +(tr[1] || tr[2]) >= 1 && +(tr[1] || tr[2]) <= 12) {
      start = at(to24(+(tr[1] || tr[2])), 0);
      if (tr[1]) tr = { index: tr.index + HERE.length, 0: tr[0].slice(HERE.length) }; // keep the marker
    } else tr = null;
    if (tr && start) leftover = squeeze(`${leftover.slice(0, tr.index)} ${leftover.slice(tr.index + tr[0].length)}`);
  }
  leftover = squeeze(leftover.replace(HERE, ' '));

  if (!start) {
    // All day (possibly several days).
    const e = dateRes && dateRes.end ? dateRes.end.date() : null;
    let days = lengthMin && lengthMin % 1440 === 0 ? lengthMin / 1440 : 1;
    if (!e && dateRes && /\bweekend\b/i.test(dateRes.text) && day.getDay() === 6) days = Math.max(days, 2);
    end = e ? new Date(e.getFullYear(), e.getMonth(), e.getDate() + 1) : new Date(day.getFullYear(), day.getMonth(), day.getDate() + days);
    return finish(leftover, { allDay: true, start: day, end, location, reminderMin }, rec);
  }
  if (end && end <= start) end = new Date(end.getTime() + 24 * 3600 * 1000); // "9pm-1am" rolls into the next day
  if (!dateRes && !holiday && !rec) {
    // Only a time ("Dinner at 6"): today if that's still ahead, otherwise tomorrow.
    const shift = Math.round((today0 - day) / 86400000) + (new Date(today0.getFullYear(), today0.getMonth(), today0.getDate(), start.getHours(), start.getMinutes()) <= ref ? 1 : 0);
    if (shift) { start = shiftDays(start, shift); if (end) end = shiftDays(end, shift); }
  }
  else if (!dateRes && rec && start < ref && start >= today0) {
    // "Standup every weekday 9" texted after 9: start tomorrow, like "9am" does.
    start = shiftDays(start, 1); if (end) end = shiftDays(end, 1);
  }
  if (!end) end = new Date(start.getTime() + (lengthMin || defaultDurationMin) * 60000);
  return finish(leftover, { allDay: false, start, end, location, reminderMin }, rec);
}

const MASK = '\u200b'; // hides "night" in "Game night" from the date parser
const HERE = '\u0001'; // where the date was cut out of the text

// ---------------------------------------------------------------------------
// Texting shorthand: "tmrw", "tues", "11a", "4:30 p.m.", "between 2 and 4", "11-20".
// ---------------------------------------------------------------------------
function shorthand(text) {
  return text
    .replace(/\b(?:tmrw|tmw|tmr|tomm?or+ow|2mor+ow|2moro|tomoro)\b/gi, 'tomorrow')
    .replace(/\btonite\b/gi, 'tonight')
    .replace(/\btues\b/gi, 'Tue').replace(/\bthurs?\b/gi, 'Thu').replace(/\bweds\b/gi, 'Wed')
    .replace(/\b(this|next)\s+coming\b/gi, '$1')
    .replace(/\b(\d{1,2}(?::\d{2})?)\s*([ap])\.\s?m\.?(?=[\s,]|$)/gi, '$1$2m')          // 8:00 a.m. -> 8:00am
    .replace(/\b(\d{1,2}(?::\d{2})?)([ap])\b(?!\.)/gi, '$1$2m')                          // 11a -> 11am
    .replace(/\bbetween\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s+and\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)(?=\s|$)/gi, '$1-$2')
    // "11-20" as a date: only when it can't be a time range (second number over 12) and no month comes before it
    .replace(/(\S*\s*)\b(\d{1,2})-(\d{1,2})\b(?![\w:/-])/g, (all, pre, a, b) =>
      (+a >= 1 && +a <= 12 && +b > 12 && +b <= 31 && !/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*$/i.test(pre) ? `${pre}${a}/${b}` : all));
}

// ---------------------------------------------------------------------------
// Holidays, used only when the text has no other date. Returns the next one (today counts).
// ---------------------------------------------------------------------------
const nth = (y, m, wd, n) => { const d = new Date(y, m, 1); return new Date(y, m, 1 + ((wd - d.getDay() + 7) % 7) + (n - 1) * 7); };
const lastWd = (y, m, wd) => { const d = new Date(y, m + 1, 0); return new Date(y, m, d.getDate() - ((d.getDay() - wd + 7) % 7)); };
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  return new Date(y, Math.floor((h + l - 7 * m + 114) / 31) - 1, ((h + l - 7 * m + 114) % 31) + 1);
}
// Thanksgiving is the 2nd Monday of October in Canadian time zones, the 4th Thursday of November elsewhere.
const CANADA = /^(?:Canada\/|America\/(?:Toronto|Montreal|Vancouver|Edmonton|Calgary|Winnipeg|Regina|Halifax|St_Johns|Moncton|Whitehorse|Yellowknife|Iqaluit|Thunder_Bay)$)/;
const HOLIDAYS = [
  [/\bchristmas eve\b/i, y => new Date(y, 11, 24)], [/\b(?:christmas|xmas)\b/i, y => new Date(y, 11, 25)],
  [/\bnew year'?s eve\b|\bnye\b/i, y => new Date(y, 11, 31)], [/\bnew year'?s(?: day)?\b/i, y => new Date(y, 0, 1)],
  [/\bthanksgiving\b/i, y => (CANADA.test(process.env.TZ || '') ? nth(y, 9, 1, 2) : nth(y, 10, 4, 4))], [/\bhalloween\b/i, y => new Date(y, 9, 31)],
  [/\bvalentine'?s(?: day)?\b/i, y => new Date(y, 1, 14)], [/\bst\.? patrick'?s(?: day)?\b/i, y => new Date(y, 2, 17)],
  [/\beaster\b/i, easter], [/\bmother'?s day\b/i, y => nth(y, 4, 0, 2)], [/\bfather'?s day\b/i, y => nth(y, 5, 0, 3)],
  [/\bmemorial day\b/i, y => lastWd(y, 4, 1)], [/\blabou?r day\b/i, y => nth(y, 8, 1, 1)],
  [/\b(?:independence day|fourth of july)\b/i, y => new Date(y, 6, 4)],
];
function holidayIn(text, ref) {
  const today = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  for (const [re, on] of HOLIDAYS) {
    if (!re.test(text)) continue;
    const d = on(today.getFullYear());
    return d >= today ? d : on(today.getFullYear() + 1);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Relative dates chrono gets wrong, rewritten to a plain date ("Nov 13 2026"):
// "a week from today", "2 weeks from tomorrow", "a week from Friday",
// "3 days from now", "next week Tue" / "Tuesday next week".
// ---------------------------------------------------------------------------
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const NUMW = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const WDAY = '(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)';
const wdayIndex = w => ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'].indexOf(w.slice(0, 2).toLowerCase());
const plainDate = d => `${MONTH_ABBR[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}`;

function relativeDates(text, ref) {
  const today = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  const nextWeekday = (i, from = today) => addDays(from, ((i - from.getDay() + 7) % 7) || 7);
  text = text.replace(new RegExp(`\\b(?:(\\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten)\\s+(day|week|month)s?|(?:the\\s+)?(next)\\s+(day|week|month))\\s+(?:from|after)\\s+(today|now|tomorrow|(?:this\\s+|next\\s+)?${WDAY})\\b`, 'gi'),
    (all, n, unit, nxt, unit2, base) => {
      const count = nxt ? 1 : (NUMW[n.toLowerCase()] || parseInt(n, 10));
      const u = (unit || unit2).toLowerCase();
      const b = base.toLowerCase();
      let d = b === 'tomorrow' ? addDays(today, 1) : /^(today|now)$/.test(b) ? today
        : nextWeekday(wdayIndex(b.replace(/^(this|next)\s+/, '')), b.startsWith('next') ? addDays(today, 7 - today.getDay() - 1) : today);
      d = u === 'month' ? new Date(d.getFullYear(), d.getMonth() + count, d.getDate()) : addDays(d, count * (u === 'week' ? 7 : 1));
      return plainDate(d);
    });
  // "the 15th", "on the 21st", "Saturday the 21st" (no month): the next day with that number.
  const MONTHW = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
  text = text.replace(new RegExp(`(\\S*\\s*)\\b(?:${WDAY},?\\s+)?(?:on\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)\\b(?!\\s+(?:of\\s+)?${MONTHW}(?:\\s|$))(?!\\s+(?:day|week|floor|grade|birthday|bday|anniversary|street|st|ave|annual|time|place|inning|period|quarter|hole)\\b)(?=(\\s+(?:at\\b|@|\\d)|\\s*[,.!?]|\\s*$)?)`, 'gi'),
    (all, pre, wd, n, after) => {
      const lead = all.slice(pre.length, all.length - n.length - 2);
      if (!lead.trim() && after === undefined) return all; // a bare "5th" mid-sentence is not a date
      if (+n < 1 || +n > 31 || new RegExp(`\\b(?:${MONTHW}|every|each|monthly|months?|of)\\s*$`, 'i').test(pre)) return all;
      for (let k = 0; k < 14; k++) {
        const d = new Date(today.getFullYear(), today.getMonth() + k, +n);
        if (d.getDate() === +n && d >= today) return `${pre}${plainDate(d)}`;
      }
      return all;
    });
  // "next week tuesday", "next week on tue", "tuesday next week"
  const nextWeekDay = i => addDays(addDays(today, -today.getDay() + 7), i);
  text = text.replace(new RegExp(`\\bnext\\s+week\\s+(?:on\\s+)?${WDAY}\\b`, 'gi'), (all, w) => plainDate(nextWeekDay(wdayIndex(w))));
  text = text.replace(new RegExp(`\\b(?:on\\s+)?${WDAY}\\s+(?:of\\s+)?next\\s+week\\b`, 'gi'), (all, w) => plainDate(nextWeekDay(wdayIndex(w))));
  return text;
}

// ---------------------------------------------------------------------------
// Commands. Returns { type: 'command', cmd, ... } or null (= treat as an event).
// ---------------------------------------------------------------------------
// Digits may touch a short unit ("2h", "90m"); spelled-out numbers need a space and a full unit,
// so "am" and "and" are never read as "a minute" / "a day".
const DUR = "(?:half an hour|an? hour and a half|\\d+(?:\\.\\d+)?\\s*(?:m|mins?|minutes?|h|hrs?|hours?|d|days?)|(?:an?|one|two|three|four|five|six|half an?)\\s+(?:mins?|minutes?|hrs?|hours?|days?))(?![a-z])";
const durRe = s => new RegExp(s.replace(/DUR/g, DUR));

// "30 min", "1h", "an hour", "half an hour", "1.5 hours" -> minutes
function parseDuration(s) {
  s = String(s || '').trim().toLowerCase();
  if (/^half an? hour$/.test(s)) return 30;
  if (/^an? hour and a half$/.test(s)) return 90;
  const m = s.match(/^(\d+(?:\.\d+)?|an?|one|two|three|four|five|six|half an?)\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?)$/);
  if (!m) return null;
  const WORDN = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
  const n = WORDN[m[1]] || (/^half/.test(m[1]) ? 0.5 : parseFloat(m[1]));
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
  m = lower.match(/^(?:when|what time|what day)(?:'s| is| are| was)?\s+(?:my|the|our)?\s*(.+?)$/);
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
  // "daily 7am" / "morning text off" are settings; "Morning walk tomorrow 7" and "Daily standup 9am" are events.
  if (m && (!m[1] || /^(?:on|off|stop|no|yes|start|(?:at\s+)?\d{1,2}(?::?\d{2})?\s*(?:am|pm|a|p)?)$/.test(m[1].trim()))) {
    return { type: 'command', cmd: 'daily', arg: (m[1] || '').trim() };
  }
  return null;
}

// Title = whatever is left once the date, location and reminder are removed.
function finish(leftover, ev, rec) {
  if (rec) {
    // Slide the first occurrence forward onto a matching day.
    const ok = d => (rec.rule.byday ? rec.rule.byday.includes(d.getDay()) : true) && (rec.monthDay ? d.getDate() === rec.monthDay : true);
    for (let i = 0; i < 400 && !ok(ev.start); i++) {
      ev.start = shiftDays(ev.start, 1);
      ev.end = shiftDays(ev.end, 1);
    }
    ev.rrule = rec.rule;
  }
  let title = leftover.split(MASK).join('').replace(/\s+([,.;:!?])/g, '$1').replace(/([,;:])(?:\s*[,;:.])+/g, '$1');
  let prev;
  const trim = () => { do { prev = title; title = title.replace(FILLER, '').replace(/^[\s,;:?!.-]+|[\s,;:?!-]+$|(?<![A-Za-z]\.[A-Za-z]|\b[A-Z][a-z]{0,2})\.+$/g, '').trim(); } while (title !== prev); };
  trim();
  // "Dinner at Olive Garden", "Oil change at the dealer": a trailing "at <Place>" is the location.
  if (!ev.location) {
    const m = title.match(/^(.+?)\s+at\s+((?:the\s+\S+|\d+\s+[A-Z][\w'&.-]*|[A-Z][\w'&.-]*)(?:\s+[\w'&.#-]+){0,4})$/);
    if (m) {
      const [place, ...rest] = m[2].split(/\s+(?=(?:with|w\/|w|for|to)\s)/i);
      title = [m[1], ...rest].join(' '); ev.location = place; trim();
    }
  }
  if (!title) title = 'Event';
  title = title.charAt(0).toUpperCase() + title.slice(1);

  return { type: 'event', title, ...ev };
}

const shiftDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());

// ---------------------------------------------------------------------------
// Repeating events. Returns { text (with the phrase removed), rule, monthDay } or null.
// ---------------------------------------------------------------------------
const DAY = '(?:sundays?|sun|mondays?|mon|tuesdays?|tues?|wednesdays?|weds?|thursdays?|thurs?|thu|fridays?|fri|saturdays?|sat)\\.?';
const DAYLIST = `${DAY}(?:(?:\\s*(?:,|and|&|/)\\s*|\\s+)${DAY})*`;
const PLURAL = '(?:sundays|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays)';
const MON = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const dayIndex = w => ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'].indexOf(w.slice(0, 2).toLowerCase());
const daysIn = list => [...new Set((list.match(new RegExp(DAY, 'gi')) || []).map(dayIndex))].sort();

function extractRepeat(text, ref) {
  let m, rule = null, monthDay = null;
  const cut = (mm, keep = '') => { text = (text.slice(0, mm.index) + ' ' + keep + ' ' + text.slice(mm.index + mm[0].length)).replace(/\s+/g, ' ').trim(); };
  // Optional tail after "every month" / "weekly": "on the 15th", "on mon and wed"
  const tail = (mm) => {
    const rest = text.slice(mm.index + mm[0].length);
    let t = rest.match(/^\s+on\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/i);
    if (t && rule.freq === 'monthly') { monthDay = +t[1]; return t[0].length; }
    t = rest.match(new RegExp(`^\\s+on\\s+(${DAYLIST})`, 'i'));
    if (t && rule.freq === 'weekly') { rule.byday = daysIn(t[1]); return t[0].length; }
    return 0;
  };

  if ((m = text.match(new RegExp(`\\bevery\\s+(?=${MON}\\s+\\d{1,2}\\b|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON})`, 'i')))) {
    rule = { freq: 'yearly', interval: 1 }; cut(m);
  } else if ((m = text.match(new RegExp(`\\bevery\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)\\b(?!\\s+(?:of\\s+)?${MON})`, 'i')))) {
    rule = { freq: 'monthly', interval: 1 }; monthDay = +m[1]; cut(m);
  } else if ((m = text.match(/\b(?:every|each)\s+(other\s+)?(?:week\s*days?|work\s*days?)\b|\bweekdays\b/i))) {
    rule = { freq: 'weekly', interval: m[1] ? 2 : 1, byday: [1, 2, 3, 4, 5] }; cut(m);
  } else if ((m = text.match(new RegExp(`\\b(?:every|each)\\s+(other\\s+)?(${DAYLIST})\\b(?:\\s+(?:mornings?|afternoons?|evenings?|nights?)\\b)?`, 'i')))) {
    rule = { freq: 'weekly', interval: m[1] ? 2 : 1, byday: daysIn(m[2]) }; cut(m);
  } else if ((m = text.match(/\b(?:every|each)\s+(?:(other)\s+|(\d+)\s+)?(day|week|month|year)s?\b/i))) {
    rule = { freq: { day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' }[m[3].toLowerCase()], interval: m[1] ? 2 : +(m[2] || 1) };
    const extra = tail(m); m[0] += text.slice(m.index + m[0].length, m.index + m[0].length + extra); cut(m);
  } else if ((m = text.match(/(?<=\S\s+)\b(daily|weekly|bi-?weekly|fortnightly|monthly|yearly|annually)\b/i))) {
    // Not as the first word: "Monthly review nov 20" is a title, "Rent monthly" repeats.
    const w = m[1].toLowerCase();
    rule = /bi|fort/.test(w) ? { freq: 'weekly', interval: 2 } : { freq: w === 'annually' ? 'yearly' : w, interval: 1 };
    const extra = tail(m); m[0] += text.slice(m.index + m[0].length, m.index + m[0].length + extra); cut(m);
  } else if ((m = text.match(new RegExp(`\\b(?:on\\s+)?(${PLURAL}(?:\\s*(?:,|and|&)\\s*${PLURAL})*)\\b`, 'i')))) {
    rule = { freq: 'weekly', interval: 1, byday: daysIn(m[1]) }; cut(m);
  }
  if (!rule) return null;
  if (rule.byday && !rule.byday.length) delete rule.byday;

  // "until Dec 31"
  m = text.match(/\b(?:until|till|thru|through|ending)\s+(.+)$/i);
  if (m) {
    const r = chrono.parse(m[1], ref, { forwardDate: true })[0];
    if (r && r.index === 0 && (r.start.isCertain('day') || r.start.isCertain('month'))) {
      const d = r.start.date();
      rule.until = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59).getTime();
      text = (text.slice(0, m.index) + ' ' + m[1].slice(r.text.length)).replace(/\s+/g, ' ').trim();
    }
  }
  return { text, rule, monthDay };
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
