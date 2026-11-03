'use strict';
const config = require('./config');
const store = require('./db');
const { parseMessage } = require('./parser');
const { describeEvent, timeFmt, dayFmt } = require('./format');

const HELP = 'Text an event like "Dentist tue 3pm" or "Party Sat 2-5 @ Sam\'s remind 1h". ' +
  'Other commands: TODAY, TOMORROW, WEEK, UNDO, CANCEL <name>.';

const normalize = n => String(n || '').replace(/\D/g, '').slice(-10);

function isAllowed(number) {
  if (!config.allowedNumbers.length) return false; // closed by default
  return config.allowedNumbers.includes(normalize(number));
}

// ---------------------------------------------------------------------------
// voip.ms REST API
// ---------------------------------------------------------------------------
async function voipms(method, params = {}) {
  const url = new URL(config.voipms.apiUrl);
  url.searchParams.set('api_username', config.voipms.user);
  url.searchParams.set('api_password', config.voipms.password);
  url.searchParams.set('method', method);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`voip.ms ${method}: HTTP ${res.status}`);
  return res.json();
}

async function sendSms(to, message) {
  store.logSms('out', normalize(to), message);
  if (!config.smsEnabled) { console.log(`[sms] (disabled) -> ${to}: ${message}`); return; }
  // voip.ms SMS is limited to 160 characters; split longer replies.
  const chunks = message.match(/[\s\S]{1,160}/g) || [];
  for (const chunk of chunks) {
    const r = await voipms('sendSMS', { did: config.voipms.did, dst: normalize(to), message: chunk });
    if (r.status !== 'success') console.error('[sms] send failed:', r.status);
  }
}

// ---------------------------------------------------------------------------
// Turning a message into an action + reply text (no I/O, easy to test)
// ---------------------------------------------------------------------------
function dayBounds(offsetDays, now = new Date()) {
  const s = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);
  const e = new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1);
  return [s.getTime(), e.getTime()];
}

function agendaText(label, events, withDay = false) {
  if (!events.length) return `Nothing on the calendar ${label}.`;
  return `${label[0].toUpperCase()}${label.slice(1)}:\n` + events.map(e => {
    const d = new Date(e.start_ts);
    const when = [withDay ? dayFmt.format(d) : '', e.all_day ? '' : timeFmt.format(d)].filter(Boolean).join(' ');
    return `- ${when ? when + ' ' : ''}${e.title}`;
  }).join('\n');
}

function handleMessage(from, body, now = new Date()) {
  const phone = normalize(from);
  const p = parseMessage(body, now, { defaultDurationMin: config.defaultDurationMin });

  if (p.type === 'error') return p.message;
  if (p.type === 'event') {
    const ev = store.createEvent({
      title: p.title, all_day: p.allDay, start_ts: p.start.getTime(), end_ts: p.end.getTime(),
      location: p.location, reminder_min: p.reminderMin, source: 'sms', phone,
    });
    let reply = `Added: ${describeEvent(ev)}`;
    if (ev.reminder_min) reply += ` (reminder ${ev.reminder_min} min before)`;
    return reply + '. Reply UNDO to remove.';
  }

  switch (p.cmd) {
    case 'help': return HELP;
    case 'undo': {
      const last = store.lastCreatedBy(phone);
      if (!last) return 'Nothing to undo.';
      store.deleteEvent(last.id);
      return `Removed: ${describeEvent(last)}`;
    }
    case 'agenda': {
      if (p.arg === 'week') {
        const [s] = dayBounds(0, now);
        return agendaText('the next 7 days', store.eventsInRange(s, s + 7 * 86400000), true);
      }
      const [s, e] = dayBounds(p.arg === 'tomorrow' ? 1 : 0, now);
      return agendaText(p.arg, store.eventsInRange(s, e));
    }
    case 'cancel': {
      const matches = store.findUpcomingByTitle(p.arg, now.getTime());
      if (!matches.length) return `No upcoming event matching "${p.arg}".`;
      if (matches.length > 1) {
        return `Found ${matches.length} matches, be more specific:\n` + matches.map(m => `- ${describeEvent(m)}`).join('\n');
      }
      store.deleteEvent(matches[0].id);
      return `Cancelled: ${describeEvent(matches[0])}`;
    }
  }
  return HELP;
}

async function receive(id, from, body) {
  if (id != null) {
    if (store.smsSeen(id)) return;
    store.markSmsSeen(id);
  }
  store.logSms('in', normalize(from), body);
  console.log(`[sms] received from ${normalize(from)}: ${body}`);
  if (!isAllowed(from)) {
    console.log(`[sms] ignoring text from ${from}: not in ALLOWED_NUMBERS`);
    return;
  }
  let reply;
  try { reply = handleMessage(from, body); } catch (err) {
    console.error('[sms] handler error', err);
    reply = 'Sorry, something went wrong adding that.';
  }
  await sendSms(from, reply);
}

// ---------------------------------------------------------------------------
// Polling: ask voip.ms for new inbound texts every N seconds.
// ---------------------------------------------------------------------------
const status = { lastPoll: null, lastError: null };

function ymd(d) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: config.tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  return p.format(d);
}

async function pollOnce() {
  const now = new Date();
  const r = await voipms('getSMS', {
    did: config.voipms.did, type: 1, limit: 100,
    from: ymd(new Date(now.getTime() - 2 * 86400000)), to: ymd(now),
  });
  status.lastPoll = Date.now();
  if (r.status === 'no_sms') return;
  if (r.status !== 'success') throw new Error(`getSMS: ${r.status}`);
  const msgs = (r.sms || []).sort((a, b) => Number(a.id) - Number(b.id));

  // First run: don't replay texts that arrived before the app existed.
  if (!store.kvGet('sms_primed')) {
    msgs.forEach(m => {
      store.markSmsSeen(m.id);
      store.logSms('in', normalize(m.contact), `[skipped: arrived before the app was set up] ${m.message}`);
    });
    console.log(`[sms] connected to voip.ms; skipped ${msgs.length} older text(s)`);
    store.kvSet('sms_primed', '1');
    return;
  }
  for (const m of msgs) await receive(m.id, m.contact, m.message);
}

function startPolling() {
  if (!config.smsEnabled) {
    console.log('[sms] voip.ms not configured; text messaging disabled');
    return;
  }
  console.log(`[sms] checking voip.ms number ${config.voipms.did} every ${config.voipms.pollSeconds}s; allowed senders: ${config.allowedNumbers.join(', ') || 'NONE'}`);
  if (!config.allowedNumbers.length) console.warn('[sms] ALLOWED_NUMBERS is empty; all incoming texts will be ignored');
  const tick = async () => {
    try { await pollOnce(); status.lastError = null; } catch (err) {
      status.lastError = err.message;
      console.error('[sms] poll error:', err.message);
    }
    setTimeout(tick, config.voipms.pollSeconds * 1000);
  };
  tick();
}

module.exports = { handleMessage, receive, sendSms, startPolling, status, isAllowed, normalize };
