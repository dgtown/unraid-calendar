'use strict';
process.env.TZ = 'America/Toronto';
const os = require('os'), fs = require('fs'), path = require('path'), http = require('http');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-test-'));
process.env.FEED_TOKEN = 'tok';
const test = require('node:test');
const assert = require('node:assert');

// A trimmed copy of what Google Calendar's "Secret address in iCal format" returns.
const ICS = [
  'BEGIN:VCALENDAR', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN', 'VERSION:2.0', 'CALSCALE:GREGORIAN',
  'METHOD:PUBLISH', 'X-WR-CALNAME:dave@example.com', 'X-WR-TIMEZONE:America/Toronto',
  'BEGIN:VTIMEZONE', 'TZID:America/Toronto', 'X-LIC-LOCATION:America/Toronto',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:EDT', 'DTSTART:19700308T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:EST', 'DTSTART:19701101T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD', 'END:VTIMEZONE',
  // Weekly on Mondays 6pm, one skipped, one moved to 7pm.
  'BEGIN:VEVENT', 'DTSTART;TZID=America/Toronto:20261102T180000', 'DTEND;TZID=America/Toronto:20261102T190000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO', 'EXDATE;TZID=America/Toronto:20261109T180000',
  'UID:hockey@google.com', 'SUMMARY:Hockey', 'LOCATION:Arena\\, Rink 2', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART;TZID=America/Toronto:20261116T190000', 'DTEND;TZID=America/Toronto:20261116T200000',
  'RECURRENCE-ID;TZID=America/Toronto:20261116T180000', 'UID:hockey@google.com', 'SUMMARY:Hockey (late)', 'END:VEVENT',
  // All-day, two days.
  'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261120', 'DTEND;VALUE=DATE:20261122', 'UID:trip@google.com',
  'SUMMARY:Cottage', 'END:VEVENT',
  // UTC time.
  'BEGIN:VEVENT', 'DTSTART:20261117T150000Z', 'DTEND:20261117T160000Z', 'UID:call@google.com',
  'SUMMARY:Call with Sam', 'DESCRIPTION:Line one\\nLine two', 'END:VEVENT',
  // A zone the file doesn't describe (Google sometimes leaves these out).
  'BEGIN:VEVENT', 'DTSTART;TZID=Europe/London:20261118T120000', 'DTEND;TZID=Europe/London:20261118T130000',
  'UID:london@google.com', 'SUMMARY:London lunch', 'END:VEVENT',
  // Cancelled: never shown.
  'BEGIN:VEVENT', 'DTSTART:20261117T200000Z', 'DTEND:20261117T210000Z', 'UID:gone@google.com',
  'STATUS:CANCELLED', 'SUMMARY:Gone', 'END:VEVENT',
  'END:VCALENDAR', '',
].join('\r\n');

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

let srv, hits = 0, body = ICS;
test.before(async () => {
  srv = http.createServer((req, res) => { hits++; res.setHeader('Content-Type', 'text/calendar'); res.end(body); }).listen(0);
  await new Promise(r => srv.on('listening', r));
  process.env.ICAL_IMPORT_URLS = `Google=http://127.0.0.1:${srv.address().port}/calendar/ical/x/private-abc/basic.ics`;
});
test.after(() => srv.close());

test('config reads labels, several links and webcal://', () => {
  const { _importFeeds } = require('../src/config');
  assert.deepStrictEqual(_importFeeds('Work=https://a.example/x.ics, webcal://b.example/y.ics\nnope'), [
    { name: 'Work', url: 'https://a.example/x.ics' }, { name: '', url: 'https://b.example/y.ics' }]);
  assert.deepStrictEqual(_importFeeds(''), []);
});

test('parses a Google feed: repeats, skipped and moved occurrences, all-day, time zones, cancelled', () => {
  const { parseICS } = require('../src/feeds');
  const { name, events } = parseICS(ICS, { from: at(2026, 11, 1), to: at(2026, 12, 1) });
  assert.equal(name, 'dave@example.com');
  const list = events.map(e => [e.title, new Date(e.start_ts).toString().slice(4, 21), e.all_day]);
  assert.deepStrictEqual(list, [
    ['Hockey', 'Nov 02 2026 18:00', 0],
    // Nov 9 skipped
    ['Hockey (late)', 'Nov 16 2026 19:00', 0],
    ['Call with Sam', 'Nov 17 2026 10:00', 0],
    ['London lunch', 'Nov 18 2026 07:00', 0],
    ['Cottage', 'Nov 20 2026 00:00', 1],
    ['Hockey', 'Nov 23 2026 18:00', 0],
    ['Hockey', 'Nov 30 2026 18:00', 0],
  ]);
  const cottage = events.find(e => e.title === 'Cottage');
  assert.equal(cottage.end_ts, at(2026, 11, 22));
  assert.equal(events[0].location, 'Arena, Rink 2');
  assert.equal(events[0].recurring, true);
  assert.equal(events.find(e => e.title === 'Call with Sam').notes, 'Line one\nLine two');
  assert.ok(events.every(e => e.readonly && String(e.id).startsWith('ext:')));
  assert.equal(new Set(events.map(e => e.id)).size, events.length);
});

test('end to end: fetched events show in the web view, display and agenda, but not the export feed', async () => {
  const feeds = require('../src/feeds');
  const store = require('../src/db');
  const app = require('../src/server');
  await feeds.refreshAll();
  assert.equal(hits, 1);
  const [st] = feeds.status();
  assert.equal(st.name, 'Google');
  assert.ok(st.events > 0 && !st.error);
  assert.ok(!JSON.stringify(feeds.status()).includes('private-abc'), 'status never shows the secret address');

  // An own event with the same title/time as an imported copy is shown once.
  store.createEvent({ title: 'Call with Sam', start_ts: at(2026, 11, 17, 10), end_ts: at(2026, 11, 17, 11) });
  const day = store.eventsInRange(at(2026, 11, 17), at(2026, 11, 18));
  assert.deepStrictEqual(day.map(e => [e.title, Boolean(e.readonly)]), [['Call with Sam', false]]);
  assert.equal(store.eventsInRange(at(2026, 11, 16), at(2026, 11, 17), { ownOnly: true }).length, 0);

  const server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const evs = await (await fetch(`${base}/api/events?start=2026-11-16T00:00:00-05:00&end=2026-11-17T00:00:00-05:00`)).json();
    assert.equal(evs.length, 1);
    assert.equal(evs[0].title, 'Hockey (late)');
    assert.equal(evs[0].readOnly, true);
    assert.equal(evs[0].calendar, 'Google');
    const put = await fetch(`${base}/api/events/${encodeURIComponent(evs[0].id)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"title":"x"}' });
    assert.equal(put.status, 404);

    const disp = await (await fetch(`${base}/api/display?token=tok&start=2026-11-20&days=1`)).json();
    assert.deepStrictEqual(disp.days[0].events.map(e => [e.title, e.time]), [['Cottage', 'All day']]);

    const ics = await (await fetch(`${base}/calendar.ics?token=tok`)).text();
    assert.ok(!ics.includes('Hockey'), 'imported events are not re-exported');

    const status = await (await fetch(`${base}/api/status`)).json();
    assert.equal(status.imports[0].name, 'Google');
  } finally { server.close(); }

  const sms = require('../src/sms');
  assert.match(sms.morningAgenda(new Date(at(2026, 11, 23, 7))), /6:00\s?PM Hockey/);

  // A failed refresh keeps the last good copy and reports the error.
  body = 'not a calendar';
  await feeds.refreshAll();
  assert.match(feeds.status()[0].error, /did not return a calendar/);
  assert.ok(store.eventsInRange(at(2026, 11, 23), at(2026, 11, 24)).some(e => e.title === 'Hockey'));
});
