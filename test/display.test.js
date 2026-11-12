'use strict';
process.env.TZ = 'America/Toronto';
const os = require('os'), fs = require('fs'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-test-'));
process.env.APP_PASSWORD = 'secret';
process.env.FEED_TOKEN = 'displaytoken';
const test = require('node:test');
const assert = require('node:assert');
const { buildDisplay, ascii } = require('../src/display');

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const ev = (title, s, e, extra = {}) => ({ id: 1, title, start_ts: s, end_ts: e, all_day: 0, location: null, rrule: null, ...extra });

test('groups events by local day, all-day first, with ready-made labels', () => {
  const now = at(2026, 11, 11, 15, 30);
  const out = buildDisplay([
    ev('Dentist', at(2026, 11, 11, 16), at(2026, 11, 11, 17), { location: 'Main St' }),
    ev('Holiday', at(2026, 11, 11), at(2026, 11, 12), { all_day: 1 }),
    ev('Trip', at(2026, 11, 12, 20), at(2026, 11, 13, 10)),
  ], now, 3);
  assert.equal(out.now, now / 1000);
  assert.equal(out.offset, -5 * 3600);
  assert.equal(out.updated, '3:30 PM');
  assert.deepEqual(out.days.map(d => [d.date, d.label, d.title]),
    [['2026-11-11', 'Today', 'Wed Nov 11'], ['2026-11-12', 'Tomorrow', 'Thu Nov 12'], ['2026-11-13', 'Fri', 'Fri Nov 13']]);
  assert.equal(out.days[0].long, 'Wednesday, November 11');
  assert.deepEqual(out.days[0].events.map(e => [e.title, e.time, e.end, e.where]),
    [['Holiday', 'All day', '', ''], ['Dentist', '4:00 PM', '5:00 PM', 'Main St']]);
  // Overnight event shows on both days.
  assert.deepEqual(out.days[1].events.map(e => [e.time, e.end]), [['8:00 PM', '']]);
  assert.deepEqual(out.days[2].events.map(e => [e.time, e.end]), [['cont.', '10:00 AM']]);
});

test('text is plain ASCII for the display fonts', () => {
  assert.equal(ascii('Café “Lunch” – Zoë’s'), 'Cafe "Lunch" - Zoe\'s');
  assert.equal(ascii('🎉 Party'), 'Party');
  assert.equal(ascii('x'.repeat(50), 10), 'xxxxxxx...');
});

test('/api/display needs the feed token and expands repeating events', async () => {
  const store = require('../src/db');
  const app = require('../src/server');
  const now = new Date();
  const s = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9).getTime();
  store.createEvent({ title: 'Standup', start_ts: s, end_ts: s + 900000, all_day: 0, source: 'web', rrule: { freq: 'daily', interval: 1 } });
  const server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + '/api/display')).status, 403);
    assert.equal((await fetch(base + '/api/display?token=nope')).status, 403);
    const r = await fetch(base + '/api/display?token=displaytoken&days=3');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.days.length, 3);
    assert.deepEqual(body.days.map(d => d.events.map(e => [e.title, e.time, e.repeats])),
      [[['Standup', '9:00 AM', true]], [['Standup', '9:00 AM', true]], [['Standup', '9:00 AM', true]]]);
  } finally { server.close(); }
});

test('month grid counts events per day, including multi-day and all-day ones', () => {
  const { buildMonth } = require('../src/display');
  const m = buildMonth([
    ev('Dentist', at(2026, 11, 3, 9), at(2026, 11, 3, 10)),
    ev('Lunch', at(2026, 11, 3, 12), at(2026, 11, 3, 13)),
    ev('Trip', at(2026, 11, 20, 18), at(2026, 11, 22, 9)),
    ev('Holiday', at(2026, 11, 26), at(2026, 11, 27), { all_day: 1 }),
    ev('Ends at midnight', at(2026, 11, 28, 22), at(2026, 11, 29)),
  ], at(2026, 11, 11, 15), 2026, 11);
  assert.equal(m.title, 'November 2026');
  assert.equal(m.firstWeekday, 0); // Nov 1 2026 is a Sunday
  assert.equal(m.days, 30);
  assert.equal(m.today, 11);
  assert.equal(m.counts.length, 30);
  assert.deepEqual([m.counts[2], m.counts[19], m.counts[20], m.counts[21], m.counts[22], m.counts[25], m.counts[27], m.counts[28]],
    [2, 1, 1, 1, 0, 1, 1, 0]);
  assert.equal(buildMonth([], at(2026, 11, 11), 2026, 12).today, 0);
});

test('a start date shows that day with a relative label', () => {
  const out = buildDisplay([], at(2026, 11, 11, 15), 2, 30, new Date(2026, 10, 10));
  assert.deepEqual(out.days.map(d => [d.date, d.label]), [['2026-11-10', 'Yesterday'], ['2026-11-11', 'Today']]);
});

test('/api/display includes this month; /api/display/month serves others', async () => {
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const body = await (await fetch(base + '/api/display?token=displaytoken&days=1&start=2026-12-25')).json();
    assert.equal(body.days[0].date, '2026-12-25');
    const now = new Date();
    assert.equal(body.month.month, now.getMonth() + 1);
    // The daily Standup from the earlier test starts today.
    assert.ok(body.month.counts.slice(now.getDate() - 1).every(n => n >= 1));
    assert.equal(body.month.today, now.getDate());
    const r = await fetch(base + '/api/display/month?token=displaytoken&ym=2027-02');
    const feb = await r.json();
    assert.deepEqual([feb.title, feb.days, feb.firstWeekday, feb.today], ['February 2027', 28, 1, 0]);
    assert.equal((await fetch(base + '/api/display/month?token=displaytoken&ym=2027-13')).status, 400);
    assert.equal((await fetch(base + '/api/display/month?ym=2027-02')).status, 403);
  } finally { server.close(); }
});
