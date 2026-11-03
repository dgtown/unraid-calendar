'use strict';
const store = require('./db');
const config = require('./config');
const { sendSms } = require('./sms');
const { describeEvent } = require('./format');

function startReminders() {
  const tick = async () => {
    try {
      for (const ev of store.dueReminders(Date.now())) {
        store.markReminded(ev.id);
        const to = ev.phone || config.allowedNumbers[0];
        if (to) await sendSms(to, `Reminder: ${describeEvent(ev)}`);
      }
    } catch (err) { console.error('[reminders]', err.message); }
  };
  setInterval(tick, 30000);
  tick();
}

module.exports = { startReminders };
