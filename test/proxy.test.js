'use strict';
process.env.TZ = 'America/Toronto';
const os = require('os'), fs = require('fs'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-test-'));
process.env.APP_PASSWORD = 'secret';
process.env.FEED_TOKEN = 'feedtoken123';
process.env.BASE_PATH = 'calendar/';
process.env.LOGIN_MAX_ATTEMPTS = '3';
const test = require('node:test');
const assert = require('node:assert');
const app = require('../src/server');
const { createLimiter } = require('../src/limiter');

let base;
const server = app.listen(0);
test.before(() => new Promise(r => server.on('listening', () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => server.close());

const auth = pass => ({ Authorization: 'Basic ' + Buffer.from('x:' + pass).toString('base64') });
const get = (p, headers = {}) => fetch(base + p, { headers, redirect: 'manual' });

test('healthz stays at the root; app is under BASE_PATH', async () => {
  assert.equal((await get('/healthz')).status, 200);
  const r = await get('/calendar?x=1');
  assert.equal(r.status, 308);
  assert.equal(r.headers.get('location'), '/calendar/?x=1');
  assert.equal((await get('/calendar/', auth('secret'))).status, 200);
  assert.equal((await get('/calendar/api/status', auth('secret'))).status, 200);
  assert.equal((await get('/api/status', auth('secret'))).status, 404);
  assert.equal((await get('/calendar/')).headers.get('x-content-type-options'), 'nosniff');
});

test('wrong passwords lock out only the forwarded client', async () => {
  const a = { 'X-Forwarded-For': '203.0.113.5' }, b = { 'X-Forwarded-For': '203.0.113.9' };
  // Requests without a password (the browser's first try) don't count.
  for (let i = 0; i < 5; i++) assert.equal((await get('/calendar/', a)).status, 401);
  for (let i = 0; i < 3; i++) assert.equal((await get('/calendar/', { ...a, ...auth('nope') })).status, 401);
  const blocked = await get('/calendar/', { ...a, ...auth('secret') });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.equal((await get('/calendar/', { ...b, ...auth('secret') })).status, 200);
});

test('wrong feed tokens count too', async () => {
  const c = { 'X-Forwarded-For': '198.51.100.7' };
  assert.equal((await get('/calendar/calendar.ics?token=feedtoken123', c)).status, 200);
  for (let i = 0; i < 3; i++) assert.equal((await get('/calendar/calendar.ics?token=bad', c)).status, 403);
  assert.equal((await get('/calendar/calendar.ics?token=feedtoken123', c)).status, 429);
});

test('download button returns the calendar as a file, behind the web password', async () => {
  assert.equal((await get('/calendar/api/export.ics')).status, 401);
  const r = await get('/calendar/api/export.ics', auth('secret'));
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/calendar/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="calendar-\d{4}-\d{2}-\d{2}\.ics"/);
  assert.match(await r.text(), /BEGIN:VCALENDAR/);
});

test('forwarded proto is trusted from a local proxy', async () => {
  app.get('/__proto', (req, res) => res.json({ secure: req.secure, ip: req.ip, host: req.hostname }));
  const r = await (await get('/__proto', { 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.1', 'X-Forwarded-Host': 'cal.example.com' })).json();
  assert.deepEqual(r, { secure: true, ip: '203.0.113.1', host: 'cal.example.com' });
});

test('limiter window expires', () => {
  let t = 0;
  const l = createLimiter({ maxAttempts: 2, windowMs: 1000, now: () => t });
  l.fail('x'); l.fail('x');
  assert.ok(l.blockedFor('x') > 0);
  t = 1001;
  assert.equal(l.blockedFor('x'), 0);
  l.fail('x'); l.success('x'); l.fail('x');
  assert.equal(l.blockedFor('x'), 0);
});
