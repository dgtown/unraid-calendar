'use strict';
process.env.TZ = 'America/Toronto';
const os = require('os'), fs = require('fs'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-test-'));
process.env.ALLOWED_NUMBERS = '555-123-4567';
const test = require('node:test');
const assert = require('node:assert');
const { handleMessage, isAllowed } = require('../src/sms');

const now = new Date(2026, 10, 3, 9, 0);

test('allow list', () => {
  assert.ok(isAllowed('15551234567'));
  assert.ok(!isAllowed('5559999999'));
});

test('add, list, undo, cancel', () => {
  const added = handleMessage('5551234567', 'Dentist tue 3pm', now);
  assert.match(added, /^Added: Dentist, Tue, Nov 3, 3:00\s?PM/);
  assert.match(handleMessage('5551234567', 'today', now), /3:00\s?PM Dentist/);
  assert.match(handleMessage('5551234567', 'undo', now), /^Removed: Dentist/);
  assert.match(handleMessage('5551234567', 'today', now), /Nothing/);
  handleMessage('5551234567', 'Oil change Dec 12', now);
  assert.match(handleMessage('5551234567', 'week', now), /Nothing/);
  assert.match(handleMessage('5551234567', 'cancel oil', now), /^Cancelled: Oil change/);
});

test('daily agenda settings by text', () => {
  const { dailyTime, parseClock, morningAgenda } = require('../src/sms');
  assert.equal(dailyTime(), '07:00');
  assert.match(handleMessage('5551234567', 'daily 6:30am', now), /6:30 AM/);
  assert.equal(dailyTime(), '06:30');
  assert.match(handleMessage('5551234567', 'daily off', now), /no more/);
  assert.equal(dailyTime(), 'off');
  assert.match(handleMessage('5551234567', 'daily on', now), /7:00 AM/);
  assert.equal(parseClock('7pm'), '19:00');
  assert.equal(parseClock('0730'), '07:30');
  handleMessage('5551234567', 'Dentist today 3pm', now);
  assert.match(morningAgenda(now), /^Good morning! Today \(Tue, Nov 3\):\n- 3:00\sPM Dentist/);
});

test('natural agenda requests', () => {
  assert.match(handleMessage('5551234567', 'what do I have today?', now), /Dentist/);
  assert.match(handleMessage('5551234567', 'appointments tomorrow', now), /Nothing/);
});

test('questions look things up instead of adding events', () => {
  for (const q of ['what do i have tomorrow', 'whats happening tomorrow', 'do I have anything Friday', 'what’s on tomorrow', 'anything on Saturday?']) {
    assert.doesNotMatch(handleMessage('5551234567', q, now), /^Added/, q);
  }
  assert.match(handleMessage('5551234567', 'what do i have next week', now), /Nov 8 – Sat, Nov 14/);
  handleMessage('5551234567', 'Haircut Nov 20 10am', now);
  assert.match(handleMessage('5551234567', 'when is my haircut?', now), /^Haircut, Fri, Nov 20/);
});
