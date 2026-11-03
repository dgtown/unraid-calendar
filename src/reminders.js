'use strict';
const store = require('./db');
const config = require('./config');
const { sendSms, dailyTime, morningAgenda } = require('./sms');
const { describeEvent } = require('./format');

// Local date + minutes-since-midnight in the configured time zone.
function localNow(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: config.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: +parts.hour * 60 + +parts.minute };
}

async function maybeSendDaily(now = new Date()) {
  const t = dailyTime();
  if (t === 'off' || !config.allowedNumbers.length) return;
  const [h, m] = t.split(':').map(Number);
  const { date, minutes } = localNow(now);
  const target = h * 60 + m;
  // Send once per day, within an hour of the chosen time (so a restart at noon doesn't send a stale agenda).
  if (minutes < target || minutes > target + 60 || store.kvGet('daily_sent') === date) return;
  store.kvSet('daily_sent', date);
  const msg = morningAgenda(now);
  for (const n of config.allowedNumbers) await sendSms(n, msg);
}

// Once a day (first check after midnight, and at startup), copy the database to DATA_DIR/backups.
async function maybeBackup(now = new Date()) {
  const { date } = localNow(now);
  if (store.kvGet('backup_date') === date) return;
  const file = await store.backup(date);
  store.kvSet('backup_date', date);
  console.log(`[backup] saved ${file}`);
}

function startReminders() {
  const tick = async () => {
    try {
      for (const ev of store.dueReminders(Date.now())) {
        store.markReminded(ev);
        const to = ev.phone || config.allowedNumbers[0];
        if (to) await sendSms(to, `Reminder: ${describeEvent(ev)}`);
      }
      await maybeSendDaily();
      await maybeBackup();
    } catch (err) { console.error('[reminders]', err.message); }
  };
  setInterval(tick, 30000);
  tick();
}

module.exports = { startReminders, maybeSendDaily, maybeBackup };
