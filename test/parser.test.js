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

test('leading "add" is dropped', () => {
  const r = parseMessage('add appointment with Dr Chen at 1pm on Nov. 19', ref);
  assert.equal(r.title, 'Appointment with Dr Chen');
  assert.equal(local(r.start), '2026-11-19 13:00');
  assert.equal(parseMessage('Add dentist tue 3pm', ref).title, 'Dentist');
  assert.equal(parseMessage('schedule an oil change Dec 12', ref).title, 'Oil change');
  assert.equal(parseMessage('Address change tue', ref).title, 'Address change');
});

test('agenda ranges', () => {
  const d = x => `${x.getMonth() + 1}/${x.getDate()}`;
  const q = t => { const r = parseMessage(t, ref); assert.equal(r.cmd, 'agenda', t); return `${d(r.start)}-${d(r.end)}`; };
  assert.equal(q('what do i have the second week of november'), '11/8-11/15');
  assert.equal(q('last week of november'), '11/29-12/1');
  assert.equal(q('whats on this weekend'), '11/7-11/9');
  assert.equal(q('what do i have in december'), '12/1-1/1');
  assert.equal(q('what do i have nov 9-15'), '11/9-11/16');
  assert.equal(q('next week'), '11/8-11/15');
  assert.equal(q('anything friday?'), '11/6-11/7');
  assert.equal(parseMessage('Dinner Friday 7pm?', ref).type, 'event');
});

test('smarter commands vs new events', () => {
  const c = t => parseMessage(t, ref);
  assert.equal(c("what's tomorrow?").arg, 'tomorrow');
  assert.equal(c("what's friday?").arg, 'range');
  assert.deepEqual(c('remind me 30 min before soccer'), { type: 'command', cmd: 'remind', arg: 'soccer', minutes: 30 });
  assert.equal(c('remind me about the dentist 2 hours before').minutes, 120);
  assert.deepEqual(c('move lunch to 1pm'), { type: 'command', cmd: 'move', arg: 'lunch', when: '1pm' });
  assert.equal(c('move dentist thursday 3pm').when, 'thursday 3pm');
  assert.equal(c('push lunch back half an hour').shiftMin, 30);
  assert.equal(c('move lunch 15 min earlier').shiftMin, -15);
  assert.equal(c('find dentist').cmd, 'find');
  assert.equal(c('3').cmd, 'choose');
  // These are still new events
  assert.equal(c('Change oil Dec 12').type, 'event');
  assert.equal(c('Soccer sat 10am remind me 1 hour before').reminderMin, 60);
  assert.equal(c('remind me to call mom tue 3pm').title, 'Call mom');
});

test('event length: "for 4 hours"', () => {
  const ev = t => { const r = parseMessage(t, ref); return `${r.title} ${local(r.start)} ${local(r.end)}`; };
  assert.equal(ev('Golf sat 10am for 4 hours'), 'Golf 2026-11-7 10:00 2026-11-7 14:00');
  assert.equal(ev('Meeting tue 2pm 90 min'), 'Meeting 2026-11-3 14:00 2026-11-3 15:30');
  assert.equal(ev('Workshop thu 9am for two hours'), 'Workshop 2026-11-5 9:00 2026-11-5 11:00');
  assert.equal(ev('Movie fri 7pm for an hour and a half'), 'Movie 2026-11-6 19:00 2026-11-6 20:30');
  assert.equal(ev('Golf for 2.5 hrs sat 10am'), 'Golf 2026-11-7 10:00 2026-11-7 12:30');
  assert.equal(ev('Cottage Dec 4 for 3 days'), 'Cottage 2026-12-4 0:00 2026-12-7 0:00');
  assert.equal(ev('Call mom in 2 hours'), 'Call mom 2026-11-3 11:00 2026-11-3 12:00');
  const r = parseMessage('Dentist tue 3pm remind 1 hour', ref);
  assert.equal(r.reminderMin, 60);
  assert.equal(local(r.end), '2026-11-3 16:00');
});

test('relative dates: "a week from today", "next week tue"', () => {
  const fri = new Date(2026, 10, 6, 14); // Fri Nov 6
  const ev = t => { const r = parseMessage(t, fri); return `${r.title} ${local(r.start)}${r.allDay ? ' allday' : ''}`; };
  assert.equal(ev('add an appointment a week from today'), 'Appointment 2026-11-13 0:00 allday');
  assert.equal(ev('Dentist a week from today at 3pm'), 'Dentist 2026-11-13 15:00');
  assert.equal(ev('Dentist 2 weeks from tomorrow 10am'), 'Dentist 2026-11-21 10:00');
  assert.equal(ev('Dentist a week from monday'), 'Dentist 2026-11-16 0:00 allday');
  assert.equal(ev('Dentist 3 days from now 9am'), 'Dentist 2026-11-9 9:00');
  assert.equal(ev('Dentist next week tue 3pm'), 'Dentist 2026-11-10 15:00');
  assert.equal(ev('Dentist tuesday next week at 3'), 'Dentist 2026-11-10 15:00');
  assert.equal(ev('Haircut a month from today'), 'Haircut 2026-12-6 0:00 allday');
  const q = parseMessage('what do i have a week from today', fri);
  assert.equal(`${q.cmd} ${local(q.start)}`, 'agenda 2026-11-13 0:00');
});

test('"am" and "and" are not read as lengths', () => {
  const tue = new Date(2026, 10, 10, 18, 45);
  const ev = t => { const r = parseMessage(t, tue); return `${r.title} ${local(r.start)} ${local(r.end)}`; };
  assert.equal(ev('Tomorrow 8:00 a.m. call and cancel doctor appointment'), 'Call and cancel doctor appointment 2026-11-11 8:00 2026-11-11 9:00');
  assert.equal(ev('Tomorrow 8:00 am call doctor'), 'Call doctor 2026-11-11 8:00 2026-11-11 9:00');
  assert.equal(ev('Lunch and shopping sat 1pm'), 'Lunch and shopping 2026-11-14 13:00 2026-11-14 14:00');
  assert.equal(ev('Golf sat 10am 4h'), 'Golf 2026-11-14 10:00 2026-11-14 14:00');
});

// Everyday phrasings from the stress test. Wed Nov 11 2026, 8:46pm local.
const ref2 = new Date(2026, 10, 11, 20, 46);
const everyday = [
  ['Dentist tomorrow 3', 'Dentist', '2026-11-12 15:00', '2026-11-12 16:00', false],
  ['Dinner tonight 7', 'Dinner', '2026-11-11 19:00', '2026-11-11 20:00', false],
  ['Tomorrow dentist 3pm', 'Dentist', '2026-11-12 15:00', '2026-11-12 16:00', false],
  ['Friday: lunch with Bob 12:30', 'Lunch with Bob', '2026-11-13 12:30', '2026-11-13 13:30', false],
  ['Doctor appointment on the 15th at 2pm', 'Doctor appointment', '2026-11-15 14:00', '2026-11-15 15:00', false],
  ['Mtg tmw 9', 'Mtg', '2026-11-12 9:00', '2026-11-12 10:00', false],
  ['dr appt wed 11a', 'Dr appt', '2026-11-18 11:00', '2026-11-18 12:00', false],
  ['Kids dentist Thursday 345', 'Kids dentist', '2026-11-12 15:45', '2026-11-12 16:45', false],
  ['gym 0600 tomorrow', 'Gym', '2026-11-12 6:00', '2026-11-12 7:00', false],
  ['Game night next saturday 7pm', 'Game night', '2026-11-21 19:00', '2026-11-21 20:00', false],
  ['Dinner at Olive Garden friday 6pm', 'Dinner', '2026-11-13 18:00', '2026-11-13 19:00', false, 'Olive Garden'],
  ['Party sat 3pm at 123 Main St', 'Party', '2026-11-14 15:00', '2026-11-14 16:00', false, '123 Main St'],
  ['Soccer sat @ 10', 'Soccer', '2026-11-14 10:00', '2026-11-14 11:00', false],
  ['Christmas dinner 5pm', 'Christmas dinner', '2026-12-25 17:00', '2026-12-25 18:00', false],
  ['New years eve party', 'New years eve party', '2026-12-31 0:00', '2027-1-1 0:00', true],
  ['Camping this weekend', 'Camping', '2026-11-14 0:00', '2026-11-16 0:00', true],
  ['I have a dentist appointment tuesday at 3pm', 'Dentist appointment', '2026-11-17 15:00', '2026-11-17 16:00', false],
  ['Meeting with 3M tomorrow 2pm', 'Meeting with 3M', '2026-11-12 14:00', '2026-11-12 15:00', false],
  ['100 day celebration feb 12', '100 day celebration', '2027-2-12 0:00', '2027-2-13 0:00', true],
  ['Kids 1st day of school Aug 25', 'Kids 1st day of school', '2027-8-25 0:00', '2027-8-26 0:00', true],
  ['Morning walk tomorrow 7', 'Morning walk', '2026-11-12 7:00', '2026-11-12 8:00', false],
  ['DENTIST TUESDAY 3PM', 'Dentist', '2026-11-17 15:00', '2026-11-17 16:00', false],
  ['Meeting thursday between 2 and 4', 'Meeting', '2026-11-12 14:00', '2026-11-12 16:00', false],
  ['Haircut 11-20', 'Haircut', '2026-11-20 0:00', '2026-11-21 0:00', true],
  ['Standup every weekday 9', 'Standup', '2026-11-12 9:00', '2026-11-12 10:00', false],
  ['Take out trash every thursday night', 'Take out trash', '2026-11-12 0:00', '2026-11-13 0:00', true],
];

for (const [text, title, start, end, allDay, location] of everyday) {
  test(`everyday: ${text}`, () => {
    const r = parseMessage(text, ref2);
    assert.equal(r.type, 'event');
    assert.equal(r.title, title);
    assert.equal(local(r.start), start);
    assert.equal(local(r.end), end);
    assert.equal(r.allDay, allDay);
    if (location) assert.equal(r.location, location);
  });
}

test('a time with no day means today if it is still ahead, otherwise tomorrow', () => {
  assert.equal(local(parseMessage('Dinner at 6', new Date(2026, 2, 2, 7, 0)).start), '2026-3-2 18:00');
  assert.equal(local(parseMessage('Dinner at 6', ref2).start), '2026-11-12 18:00');
});

test('a bare number with no day is not guessed at', () => {
  const r = parseMessage('Yoga 6', ref2);
  assert.notEqual(r.type, 'event');
});

test('Thanksgiving follows the time zone', () => {
  const old = process.env.TZ;
  assert.equal(local(parseMessage('Thanksgiving dinner 4pm', ref2).start), '2027-10-11 16:00'); // Canada: 2nd Monday of October
  process.env.TZ = 'America/New_York';
  assert.equal(local(parseMessage('Thanksgiving dinner 4pm', ref2).start), '2026-11-26 16:00');
  process.env.TZ = old;
});
