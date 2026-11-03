'use strict';
process.env.TZ = 'America/Toronto';
const test = require('node:test');
const assert = require('node:assert');
const { parseMessage } = require('../src/parser');

const ref = new Date(2026, 10, 3, 9, 0); // Tue Nov 3 2026, 9:00 local
const local = d => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;

const cases = [
  ['dentist tue 3pm', 'Dentist', '2026-11-3 15:00', '2026-11-3 16:00', false],
  ["Sam's party Saturday 2-5", "Sam's party", '2026-11-7 14:00', '2026-11-7 17:00', false],
  ['dinner with Mom tomorrow at 6:30', 'Dinner with Mom', '2026-11-4 18:30', '2026-11-4 19:30', false],
  ['oil change Dec 12', 'Oil change', '2026-12-12 0:00', '2026-12-13 0:00', true],
  ['Meeting next friday 10am-11:30am', 'Meeting', '2026-11-13 10:00', '2026-11-13 11:30', false],
  ['Vacation Dec 20 - Dec 27', 'Vacation', '2026-12-20 0:00', '2026-12-28 0:00', true],
  ['Concert 9pm-1am friday', 'Concert', '2026-11-6 21:00', '2026-11-7 1:00', false],
];

for (const [text, title, start, end, allDay] of cases) {
  test(text, () => {
    const r = parseMessage(text, ref);
    assert.equal(r.type, 'event');
    assert.equal(r.title, title);
    assert.equal(local(r.start), start);
    assert.equal(local(r.end), end);
    assert.equal(r.allDay, allDay);
  });
}

test('location and reminder', () => {
  const r = parseMessage('Dentist tuesday at 3pm @ Main St Clinic remind 30m', ref);
  assert.equal(r.title, 'Dentist');
  assert.equal(r.location, 'Main St Clinic');
  assert.equal(r.reminderMin, 30);
  assert.equal(parseMessage('Concert friday 9pm remind me 2 hours', ref).reminderMin, 120);
});

test('commands', () => {
  assert.deepEqual(parseMessage('UNDO', ref), { type: 'command', cmd: 'undo' });
  assert.deepEqual(parseMessage('cancel dentist', ref), { type: 'command', cmd: 'cancel', arg: 'dentist' });
  assert.equal(parseMessage('today', ref).arg, 'today');
  assert.equal(parseMessage('help', ref).cmd, 'help');
});

test('no date gives an error', () => {
  assert.equal(parseMessage('lunch with bob', ref).type, 'error');
});
