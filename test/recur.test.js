'use strict';
process.env.TZ = 'America/Toronto';
const os = require('os'), fs = require('fs'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-recur-'));
process.env.ALLOWED_NUMBERS = '555-123-4567';
const test = require('node:test');
const assert = require('node:assert');
const { occurrences, describeRule, nextOccurrence } = require('../src/recur');
const { parseMessage } = require('../src/parser');
const { handleMessage } = require('../src/sms');
const store = require('../src/db');
const { toICS } = require('../src/ics');

const ref = new Date(2026, 10, 3, 9, 0); // Tue Nov 3 2026
const fmt = t => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
const ev = (start, rule, extra = {}) => ({ start_ts: start.getTime(), end_ts: start.getTime() + 3600000, rrule: JSON.stringify(rule), ...extra });

test('weekly on several days, keeping clock time across DST', () => {
  const e = ev(new Date(2026, 9, 26, 18, 0), { freq: 'weekly', interval: 1, byday: [1, 3] }); // Mon Oct 26
  const got = occurrences(e, new Date(2026, 9, 26).getTime(), new Date(2026, 10, 9).getTime()).map(fmt);
  assert.deepEqual(got, ['10/26 18:00', '10/28 18:00', '11/2 18:00', '11/4 18:00']);
  assert.equal(describeRule(e), 'every Mon, Wed');
});

test('every other week, monthly on the 31st, yearly, until, exceptions', () => {
  const sat = ev(new Date(2026, 10, 7, 10), { freq: 'weekly', interval: 2, byday: [6] });
  assert.deepEqual(occurrences(sat, ref.getTime(), new Date(2026, 11, 6).getTime()).map(fmt), ['11/7 10:00', '11/21 10:00', '12/5 10:00']);
  assert.equal(describeRule(sat), 'every other Saturday');
  const m31 = ev(new Date(2026, 9, 31, 9), { freq: 'monthly', interval: 1 });
  assert.deepEqual(occurrences(m31, ref.getTime() - 86400000 * 10, new Date(2027, 2, 1).getTime()).map(fmt), ['10/31 9:00', '12/31 9:00', '1/31 9:00']);
  const bday = ev(new Date(2027, 2, 14), { freq: 'yearly', interval: 1 });
  assert.equal(describeRule(bday), 'every year on Mar 14');
  assert.equal(fmt(nextOccurrence(bday, new Date(2027, 5, 1).getTime()).start_ts), '3/14 0:00');
  const until = ev(new Date(2026, 10, 3, 16), { freq: 'weekly', interval: 1, until: new Date(2026, 10, 17, 23, 59).getTime() },
    { exdates: JSON.stringify([new Date(2026, 10, 10, 16).getTime()]) });
  assert.deepEqual(occurrences(until, 0, new Date(2027, 0, 1).getTime()).map(fmt), ['11/3 16:00', '11/17 16:00']);
  const daily = ev(new Date(2020, 0, 1, 8), { freq: 'daily', interval: 1 });
  assert.deepEqual(occurrences(daily, ref.getTime(), ref.getTime() + 86400000).map(fmt), ['11/4 8:00']);
});

test('parsing repeat phrases', () => {
  const p = t => { const r = parseMessage(t, ref); return [r.title, fmt(r.start), r.rrule && describeRule({ start_ts: r.start.getTime(), rrule: r.rrule })]; };
  assert.deepEqual(p('Soccer every Saturday 10am'), ['Soccer', '11/7 10:00', 'every Saturday']);
  assert.deepEqual(p('Gym every mon, wed and fri 6pm'), ['Gym', '11/4 18:00', 'every Mon, Wed, Fri']);
  assert.deepEqual(p('Standup every weekday 9am'), ['Standup', '11/3 9:00', 'every weekday']);
  assert.deepEqual(p('Meds daily 8am'), ['Meds', '11/4 8:00', 'every day']);
  assert.deepEqual(p('Rent monthly on the 1st'), ['Rent', '12/1 0:00', 'every month on the 1st']);
  assert.deepEqual(p("Mom's birthday every Mar 14"), ["Mom's birthday", '3/14 0:00', 'every year on Mar 14']);
  assert.deepEqual(p('Team sync every 2 weeks on thu 2pm'), ['Team sync', '11/5 14:00', 'every other Thursday']);
  assert.deepEqual(p('Swim saturdays 9am until Dec 19'), ['Swim', '11/7 9:00', 'every Saturday until Dec 19']);
  assert.deepEqual(p('Book club every month on the 2nd 7pm'), ['Book club', '12/2 19:00', 'every month on the 2nd']);
  // still one-off events
  assert.equal(parseMessage('Monthly review nov 20 2pm', ref).rrule, undefined);
  assert.equal(parseMessage('Party 2pm until 5pm sat', ref).rrule, undefined);
});

test('repeating events by text: agenda, cancel one or all, move, undo, clashes', () => {
  const t = b => handleMessage('5551234567', b, ref);
  assert.match(t('Hockey every Saturday 10am'), /^Added: Hockey, Sat, Nov 7, 10:00\sAM–11:00\sAM, repeats every Saturday\./);
  assert.match(t('what do i have next week'), /Sat, Nov 14 10:00\sAM Hockey/);
  assert.match(t('find hockey'), /^Hockey, Sat, Nov 7.*, every Saturday$/);

  // cancel just one
  assert.match(t('cancel hockey'), /^Hockey repeats every Saturday\. Reply 1 to cancel just Sat, Nov 7, or 2 to cancel all of them\./);
  assert.match(t('1'), /^Cancelled just Hockey, Sat, Nov 7/);
  assert.match(t('find hockey'), /^Hockey, Sat, Nov 14/);
  assert.match(t('undo'), /^Put back: Hockey, every Saturday/);
  assert.match(t('find hockey'), /^Hockey, Sat, Nov 7/);

  // move just one: becomes a one-off, the series skips that day
  t('move hockey to 11am');
  assert.match(t('1'), /^Moved just this one: Hockey, Sat, Nov 7, 11:00\sAM/);
  assert.match(t('what\'s on saturday'), /11:00\sAM Hockey/);
  assert.doesNotMatch(t('what\'s on saturday'), /10:00\sAM Hockey/);
  assert.match(t('undo'), /^Put back/);
  assert.match(t('what\'s on saturday'), /^On Sat, Nov 7:\n- 10:00\sAM Hockey$/);

  // move all to Sundays at 9
  t('move hockey to sunday 9am');
  assert.match(t('2'), /^Moved all Hockey: now every Sunday, next Sun, Nov 8, 9:00\sAM/);
  assert.match(t('what do i have next week'), /Sun, Nov 8 9:00\sAM Hockey/);

  // reminders on a series fire for each occurrence
  assert.match(t('remind me 30 min before hockey'), /30 min before every Hockey \(every Sunday\)/);
  const sun = new Date(2026, 10, 8, 8, 40).getTime();
  const due = store.dueReminders(sun);
  assert.equal(due.length, 1);
  store.markReminded(due[0]);
  assert.equal(store.dueReminders(sun).length, 0);
  assert.equal(store.dueReminders(new Date(2026, 10, 15, 8, 40).getTime()).length, 1);

  // phone feed carries the rule
  assert.match(toICS(store.allEvents()), /RRULE:FREQ=WEEKLY;BYDAY=SU/);

  // cancel all, undo brings the series back
  t('cancel hockey');
  assert.match(t('2'), /^Cancelled: all Hockey \(every Sunday\)/);
  assert.match(t('find hockey'), /^No upcoming/);
  assert.match(t('undo'), /^Restored: Hockey/);
  assert.match(t('find hockey'), /every Sunday/);

  // clash warnings
  t('Vet check Nov 20 3pm');
  assert.match(t('Grooming Nov 20 3:30pm'), /Heads up, overlaps Vet check 3:00\sPM–4:00\sPM\./);
  assert.doesNotMatch(t('Lunch Nov 20 12pm'), /Heads up/);
  assert.match(t('move lunch to 3pm'), /Heads up, overlaps Vet check.*and Grooming/);
});

test('nightly backup keeps the newest 7', async () => {
  for (let d = 1; d <= 9; d++) await store.backup(`2026-11-0${d}`);
  const files = store.listBackups();
  assert.equal(files.length, 7);
  assert.equal(files[0], 'calendar-2026-11-03.db');
  assert.ok(fs.statSync(path.join(process.env.DATA_DIR, 'backups', files[6])).size > 0);
});
