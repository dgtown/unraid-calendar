'use strict';
// The phone page's calendar packing (phone/pack.js): Outlook-style .ics in, display messages out.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const ICAL = require('ical.js');

const load = () => import(path.join(__dirname, '..', 'phone', 'pack.js'));

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:Microsoft Exchange Server 2010
BEGIN:VTIMEZONE
TZID:Eastern Standard Time
BEGIN:STANDARD
DTSTART:16010101T020000
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:16010101T020000
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
UID:standup
SUMMARY:Stand–up “daily”
LOCATION:Room 4 café
DTSTART;TZID=Eastern Standard Time:20261116T093000
DTEND;TZID=Eastern Standard Time:20261116T094500
RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR
EXDATE;TZID=Eastern Standard Time:20261124T093000
END:VEVENT
BEGIN:VEVENT
UID:standup
RECURRENCE-ID;TZID=Eastern Standard Time:20261125T093000
SUMMARY:Stand-up (moved)
DTSTART;TZID=Eastern Standard Time:20261125T110000
DTEND;TZID=Eastern Standard Time:20261125T111500
END:VEVENT
BEGIN:VEVENT
UID:holiday
SUMMARY:Thanksgiving
DTSTART;VALUE=DATE:20261126
DTEND;VALUE=DATE:20261128
END:VEVENT
BEGIN:VEVENT
UID:cancelled
SUMMARY:Canceled: Budget review
DTSTART;TZID=Eastern Standard Time:20261123T140000
DTEND;TZID=Eastern Standard Time:20261123T150000
END:VEVENT
END:VCALENDAR`;

process.env.TZ = 'America/New_York';
const NOW = new Date(2026, 10, 23, 8, 0).getTime(); // Mon Nov 23 2026, 8 AM

test('parses recurring Outlook events with exceptions, skips cancelled', async () => {
  const { parseICS } = await load();
  const rows = parseICS(ICAL, ICS, NOW - 8 * 864e5, NOW + 14 * 864e5);
  const standups = rows.filter(r => /Stand/.test(r.title));
  const days = standups.map(r => new Date(r.start).getDate());
  assert.ok(days.includes(23) && !days.includes(24), 'Nov 24 excluded');
  const moved = standups.find(r => new Date(r.start).getDate() === 25);
  assert.strictEqual(moved.title, 'Stand-up (moved)');
  assert.strictEqual(new Date(moved.start).getHours(), 11);
  assert.ok(!rows.some(r => /Budget/.test(r.title)));
});

test('builds display days, months and fits the size limit', async () => {
  const { parseICS, buildMessages } = await load();
  const rows = parseICS(ICAL, ICS, NOW - 8 * 864e5, NOW + 44 * 864e5);
  const out = buildMessages(rows, { key: 'abcdefgh12345678', now: NOW, weeksAhead: 6 });
  const msgs = out.lines.map(l => JSON.parse(l));
  assert.strictEqual(msgs[0].type, 'hello');
  assert.strictEqual(msgs[0].from, '2026-11-16');
  assert.strictEqual(msgs[0].to, '2027-01-03');
  assert.strictEqual(msgs[0].offset, -5 * 3600);
  assert.strictEqual(msgs.at(-1).type, 'end');
  const today = msgs.find(m => m.type === 'day' && m.date === '2026-11-23');
  assert.strictEqual(today.title, 'Mon Nov 23');
  assert.strictEqual(today.long, 'Monday, November 23');
  assert.deepStrictEqual(today.events.map(e => [e.time, e.end, e.title, e.where]),
    [['9:30 AM', '9:45 AM', 'Stand-up "daily"', 'Room 4 cafe']]);
  const thanks = msgs.find(m => m.type === 'day' && m.date === '2026-11-27');
  assert.strictEqual(thanks.events[0].time, 'All day');
  const months = msgs.filter(m => m.type === 'month').map(m => m.ym);
  assert.deepStrictEqual(months, ['2026-11', '2026-12', '2027-01']);
  const nov = msgs.find(m => m.ym === '2026-11');
  assert.strictEqual(nov.days, 30);
  assert.strictEqual(nov.firstWeekday, 0);
  assert.strictEqual(nov.counts[22], 1);
  assert.ok(out.lines.every(l => /^[\x20-\x7E]*$/.test(l)), 'ASCII only');

  const small = buildMessages(rows, { key: 'k', now: NOW, weeksAhead: 6, maxBytes: 3000 });
  assert.ok(small.bytes <= 3000 && small.days < out.days);
});
