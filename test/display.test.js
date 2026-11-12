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
