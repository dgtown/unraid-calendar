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

test('smarter commands: find, cancel with choice, move, remind, undo', () => {
  const t = b => handleMessage('5551234567', b, now);
  const store = require('../src/db');
  t('Vet appt Nov 10 3pm');
  t('Soccer Sat 10am');
  t('Soccer Nov 14 10am');
  t('Lunch with Bob tomorrow 12pm');

  // find ignores "appt" / "my"
  assert.match(t('find my vet'), /^Vet appt, Tue, Nov 10, 3:00\sPM/);
  assert.match(t('find soccer'), /^- Soccer, Sat, Nov 7.*\n- Soccer, Sat, Nov 14/);

  // move keeps the day when only a time is given, and the time when only a day is given
  assert.match(t('move lunch to 1pm'), /^Moved: Lunch with Bob, Wed, Nov 4, 1:00\sPM–2:00\sPM \(was Wed, Nov 4, 12:00\sPM/);
  assert.match(t('move vet to Thursday'), /^Moved: Vet appt, Thu, Nov 5, 3:00\sPM–4:00\sPM/);
  assert.match(t('move vet to nov 12 at 4'), /Thu, Nov 12, 4:00\sPM–5:00\sPM/);
  assert.match(t('push lunch back an hour'), /Wed, Nov 4, 2:00\sPM–3:00\sPM/);
  assert.match(t('undo'), /^Put back: Lunch with Bob, Wed, Nov 4, 1:00\sPM/);

  // remind
  assert.match(t('remind me 45 min before lunch'), /45 min before Lunch with Bob/);
  assert.equal(store.findUpcomingByTitle('Lunch', now.getTime())[0].reminder_min, 45);
  assert.match(t('no reminder for lunch'), /no reminder/);

  // ambiguous cancel: numbered list, then reply with a number
  assert.match(t('cancel soccer'), /^Which one do you want to cancel\? Reply with the number:\n1\. Soccer, Sat, Nov 7.*\n2\. Soccer, Sat, Nov 14/);
  assert.match(t('2'), /^Cancelled: Soccer, Sat, Nov 14/);
  assert.equal(store.findUpcomingByTitle('Soccer', now.getTime()).length, 1);
  assert.match(t('undo'), /^Restored: Soccer, Sat, Nov 14/);
  assert.equal(store.findUpcomingByTitle('Soccer', now.getTime()).length, 2);
  assert.match(t('2'), /^Not sure/);

  // ambiguous remind, answered by number
  assert.match(t('remind me 1 hour before soccer'), /^Which one do you want to set a reminder for\?/);
  assert.match(t('1'), /1 hour before Soccer, Sat, Nov 7/);

  // not a known event, but it has a date: treated as a new event
  assert.match(t('Move in day Dec 1'), /^Added: Move in day, Tue, Dec 1/);
  assert.match(t('cancel nothing like this'), /^No upcoming event matching/);
  assert.match(t('help'), /MOVE/);
});

test('long replies split at lines and words, numbered', () => {
  const { splitSms } = require('../src/sms');
  assert.deepEqual(splitSms('short'), ['short']);
  const agenda = 'Next 7 days:\n' + Array.from({ length: 8 }, (_, i) => `- Tue, Nov ${i + 3} 3:00 PM Dentist appointment number ${i + 1}`).join('\n');
  const parts = splitSms(agenda);
  assert.ok(parts.length > 1);
  parts.forEach((p, i) => {
    assert.ok(p.length <= 160, p);
    assert.ok(p.startsWith(`(${i + 1}/${parts.length}) `), p);
  });
  // every line arrives whole
  const lines = parts.map(p => p.replace(/^\(\d+\/\d+\) /, '')).join('\n').split('\n');
  assert.deepEqual(lines, agenda.split('\n'));
  // a long single line breaks between words, never mid-word
  const words = Array.from({ length: 60 }, (_, i) => `word${i}`);
  const wp = splitSms(words.join(' '));
  assert.deepEqual(wp.map(p => p.replace(/^\(\d+\/\d+\) /, '')).join(' ').split(' '), words);
  wp.forEach(p => assert.ok(p.length <= 160));
});
