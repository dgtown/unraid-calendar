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
