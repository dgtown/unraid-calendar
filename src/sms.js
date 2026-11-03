'use strict';
const config = require('./config');
const store = require('./db');
const chrono = require('chrono-node');
const { parseMessage } = require('./parser');
const { describeRule, nextOccurrence, occurrence, ruleOf, exdatesOf } = require('./recur');
const { describeEvent, describeWhen, timeFmt, dayFmt } = require('./format');

const HELP = 'Text an event like "Dentist tue 3pm @ Main St remind 1h" or "Soccer every Sat 10am". Commands: ' +
  'TODAY, TOMORROW, WEEK, "what\'s Friday?", FIND dentist, CANCEL dentist, MOVE dentist TO thu 3pm, ' +
  'PUSH lunch BACK 30 min, REMIND ME 30 MIN BEFORE soccer, UNDO, DAILY 7am / DAILY OFF.';

// ---------------------------------------------------------------------------
// Daily agenda time: set by text ("daily 6:30am"), else DAILY_AGENDA_TIME.
// Stored as "HH:MM" (24h) or "off".
// ---------------------------------------------------------------------------
function parseClock(s) {
  const m = String(s || '').trim().toLowerCase().match(/^(?:at\s+)?(\d{1,2})(?::?(\d{2}))?\s*(am|pm|a|p)?$/);
  if (!m) return null;
  let h = +m[1]; const min = +(m[2] || 0);
  if (m[3]) { h %= 12; if (m[3][0] === 'p') h += 12; }
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}
function dailyTime() {
  const v = store.kvGet('daily_time') ?? config.dailyAgendaTime;
  return /^(off|no|false|disabled?)$/i.test(v) ? 'off' : (parseClock(v) || 'off');
}
const prettyClock = hhmm => {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

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

// voip.ms texts are limited to 160 characters. Split longer replies at line
// breaks, then between words, and number the parts: "(1/3) ...".
function splitSms(message, max = 160) {
  message = String(message).trim();
  if (message.length <= max) return [message];
  const room = max - 8; // space for "(12/12) "
  const parts = [];
  let cur = '';
  const push = () => { if (cur.trim()) parts.push(cur.trim()); cur = ''; };
  const add = (piece, sep) => {
    if (!cur) cur = piece;
    else if (cur.length + sep.length + piece.length <= room) cur += sep + piece;
    else { push(); cur = piece; }
  };
  for (const line of message.split('\n')) {
    if (line.length <= room) { add(line, '\n'); continue; }
    for (let word of line.split(' ')) {
      while (word.length > room) { add(word.slice(0, room), ' '); word = word.slice(room); }
      add(word, ' ');
    }
  }
  push();
  return parts.length === 1 ? parts : parts.map((p, i) => `(${i + 1}/${parts.length}) ${p}`);
}

async function sendSms(to, message) {
  store.logSms('out', normalize(to), message);
  if (!config.smsEnabled) { console.log(`[sms] (disabled) -> ${to}: ${message}`); return; }
  for (const chunk of splitSms(message)) {
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

// ---------------------------------------------------------------------------
// Finding the event a text is about ("dentist", "my dentist appt", "lunch w bob").
// Every meaningful word must start a word in the title or location.
// ---------------------------------------------------------------------------
const STOP = new Set(['my', 'the', 'a', 'an', 'our', 'your', 'appt', 'appts', 'appointment', 'appointments',
  'event', 'events', 'with', 'w', 'at', 'on', 'for', 'next', 'upcoming', 'thing']);
const words = s => String(s || '').toLowerCase().replace(/[^a-z0-9'&]+/g, ' ').replace(/'s\b|'/g, '').split(' ').filter(Boolean);

function matchEvents(query, now) {
  let q = words(query).filter(w => !STOP.has(w));
  if (!q.length) q = words(query);
  if (!q.length) return [];
  const stem = w => (w.length > 3 ? w.replace(/(?:es|s)$/, '') : w);
  return store.upcomingEvents(now.getTime()).filter(ev => {
    const hay = words(`${ev.title} ${ev.location || ''}`);
    return q.every(w => hay.some(h => h.startsWith(w) || stem(h) === stem(w)));
  });
}

// Pending numbered choice ("Which one? Reply 1-3") and the last change (for UNDO), per phone.
const PENDING_MS = 30 * 60000;
const jsonGet = k => { try { return JSON.parse(store.kvGet(k) || 'null'); } catch { return null; } };
const setPending = (phone, v) => store.kvSet(`pending:${phone}`, JSON.stringify(v ? { ...v, at: Date.now() } : null));
const getPending = phone => {
  const p = jsonGet(`pending:${phone}`);
  return p && Date.now() - p.at < PENDING_MS ? p : null;
};
const setUndo = (phone, v) => store.kvSet(`undo:${phone}`, JSON.stringify(v));

function numbered(matches, verb) {
  const list = matches.slice(0, 9);
  return `Which one do you want to ${verb}? Reply with the number:\n` +
    list.map((m, i) => `${i + 1}. ${describeEvent(m)}`).join('\n') +
    (matches.length > list.length ? `\n(${matches.length - list.length} more, be more specific)` : '');
}

// ---------------------------------------------------------------------------
// Moving an event: new time keeps the day, new day keeps the time, length is kept.
// ---------------------------------------------------------------------------
function moveTimes(ev, p, now) {
  const dur = ev.end_ts - ev.start_ts;
  if (p.shiftMin) return { all_day: ev.all_day, start_ts: ev.start_ts + p.shiftMin * 60000, end_ts: ev.end_ts + p.shiftMin * 60000 };
  let when = p.when.trim().replace(/^at\s+/, '');
  if (/^\d{1,2}(?::\d{2})?$/.test(when)) when += ':00'.slice(when.includes(':') ? 3 : 0); // "1" -> "1:00"
  const r = chrono.parse(when, now, { forwardDate: true })[0];
  if (!r) return null;
  const dateGiven = r.start.isCertain('day') || r.start.isCertain('weekday');
  const timeGiven = r.start.isCertain('hour');
  if (!dateGiven && !timeGiven) return null;
  const cur = new Date(ev.start_ts);
  const base = dateGiven ? r.start.date() : cur;
  const day = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  const at = (comp, d) => {
    let h = comp.get('hour');
    if (!comp.isCertain('meridiem') && h >= 1 && h <= 7) h += 12; // "move lunch to 1" = 1 PM
    const out = new Date(day); out.setHours(h, comp.get('minute') || 0, 0, 0);
    return out;
  };
  if (timeGiven) {
    const start = at(r.start);
    let end = r.end && r.end.isCertain('hour') ? at(r.end) : new Date(start.getTime() + (ev.all_day ? config.defaultDurationMin * 60000 : dur));
    if (end <= start) end = new Date(end.getTime() + 86400000);
    return { all_day: 0, start_ts: start.getTime(), end_ts: end.getTime() };
  }
  if (ev.all_day) {
    const days = Math.round(dur / 86400000);
    return { all_day: 1, start_ts: day.getTime(), end_ts: new Date(day.getFullYear(), day.getMonth(), day.getDate() + days).getTime() };
  }
  const start = new Date(day); start.setHours(cur.getHours(), cur.getMinutes(), 0, 0);
  return { all_day: 0, start_ts: start.getTime(), end_ts: start.getTime() + dur };
}

const leadText = m => (m % 1440 === 0 ? `${m / 1440} day${m === 1440 ? '' : 's'}`
  : m % 60 === 0 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${m} min`);
const repeatNote = ev => (ev.rrule ? `, ${describeRule(ev)}` : '');

// Timed events that overlap ev (all-day events never count as a clash).
function clashText(ev, ignoreId) {
  if (ev.all_day) return '';
  const hits = store.eventsInRange(ev.start_ts, ev.end_ts).filter(o => o.id !== ignoreId && !o.all_day);
  if (!hits.length) return '';
  return ` Heads up, overlaps ${hits.slice(0, 2).map(o => `${o.title} ${timeFmt.format(new Date(o.start_ts))}–${timeFmt.format(new Date(o.end_ts))}`).join(' and ')}${hits.length > 2 ? ` and ${hits.length - 2} more` : ''}.`;
}

// Apply a cancel / move / remind command to one chosen event (or one occurrence of a repeating one).
// scope: 'one' | 'all' for repeating events; when missing, ask.
function applyTo(phone, p, ev, now, scope) {
  const series = ev.rrule ? store.getEvent(ev.id) : null;
  if (series && !scope && p.cmd !== 'remind') {
    setPending(phone, { cmd: p, ids: [ev.id], series: true, occ: ev.start_ts });
    const verb = p.cmd === 'cancel' ? 'cancel' : 'move';
    return `${ev.title} repeats ${describeRule(series)}. Reply 1 to ${verb} just ${dayFmt.format(new Date(ev.start_ts))}, or 2 to ${verb} all of them.`;
  }

  if (p.cmd === 'cancel') {
    if (series && scope === 'one') {
      const ex = [...exdatesOf(series), ev.start_ts];
      store.updateEvent(series.id, { exdates: ex });
      setUndo(phone, { kind: 'update', row: series });
      return `Cancelled just ${describeEvent(ev)}. The rest still repeat. Reply UNDO to bring it back.`;
    }
    const row = series || ev;
    store.deleteEvent(row.id);
    setUndo(phone, { kind: 'delete', row });
    return `Cancelled: ${series ? `all ${row.title} (${describeRule(row)})` : describeEvent(row)}. Reply UNDO to bring ${series ? 'them' : 'it'} back.`;
  }

  if (p.cmd === 'move') {
    const t = moveTimes(ev, p, now);
    if (!t) return `I couldn't tell when to move ${ev.title} to. Try "move ${ev.title.toLowerCase()} to thu 3pm".`;
    if (series && scope === 'one') {
      // Skip this occurrence in the series and add a one-off copy at the new time.
      store.updateEvent(series.id, { exdates: [...exdatesOf(series), ev.start_ts] });
      const copy = store.createEvent({ ...series, ...t, rrule: null, exdates: null, source: series.source, phone: series.phone || phone });
      setUndo(phone, { kind: 'multi', steps: [{ kind: 'create', id: copy.id }, { kind: 'update', row: series }] });
      return `Moved just this one: ${describeEvent(copy)} (was ${describeWhen(ev)}).${clashText(copy, copy.id)} Reply UNDO to put it back.`;
    }
    if (series) {
      // Shift the whole series by the same amount; weekly days follow along.
      const delta = t.start_ts - ev.start_ts;
      const dayShift = Math.round((new Date(t.start_ts).setHours(0, 0, 0, 0) - new Date(ev.start_ts).setHours(0, 0, 0, 0)) / 86400000);
      const rule = { ...ruleOf(series) };
      if (rule.byday?.length && dayShift) rule.byday = rule.byday.map(d => (((d + dayShift) % 7) + 7) % 7);
      const start = series.start_ts + delta;
      const moved = store.updateEvent(series.id, { all_day: t.all_day, start_ts: start, end_ts: start + (t.end_ts - t.start_ts), rrule: rule, exdates: null });
      setUndo(phone, { kind: 'update', row: series });
      return `Moved all ${moved.title}: now ${describeRule(moved)}, next ${describeWhen(nextOccurrence(moved, now.getTime()) || moved)}. Reply UNDO to put it back.`;
    }
    const moved = store.updateEvent(ev.id, t);
    setUndo(phone, { kind: 'update', row: ev });
    return `Moved: ${describeEvent(moved)} (was ${describeWhen(ev)}).${clashText(moved, moved.id)} Reply UNDO to put it back.`;
  }

  if (p.cmd === 'remind') {
    const row = series || ev;
    const upd = store.updateEvent(row.id, { reminder_min: p.minutes, phone: row.phone || phone });
    setUndo(phone, { kind: 'update', row });
    const label = series ? `every ${upd.title} (${describeRule(upd)})` : describeEvent(upd);
    if (p.minutes == null) return `OK, no reminder for ${label}.`;
    const soon = ev.start_ts - p.minutes * 60000 <= now.getTime() ? ' That time has already passed, so you\'ll get it right away.' : '';
    return `OK, I'll text you ${leadText(p.minutes)} before ${label}.${soon}`;
  }
  return HELP;
}

function undo(u) {
  if (u.kind === 'multi') {
    const out = u.steps.map(undo).filter(Boolean);
    return out[out.length - 1] || null;
  }
  if (u.kind === 'delete' && !store.getEvent(u.row.id)) return `Restored: ${describeEvent(store.restoreEvent(u.row))}${repeatNote(u.row)}`;
  if (u.kind === 'update' && store.getEvent(u.row.id)) {
    const r = u.row;
    const back = store.updateEvent(r.id, { all_day: r.all_day, start_ts: r.start_ts, end_ts: r.end_ts, reminder_min: r.reminder_min,
      phone: r.phone, rrule: r.rrule, exdates: r.exdates, title: r.title, location: r.location });
    return `Put back: ${r.rrule ? `${back.title}, ${describeRule(back)}` : describeEvent(back)}`;
  }
  if (u.kind === 'create') {
    const ev = store.getEvent(u.id);
    if (ev) { store.deleteEvent(ev.id); return `Removed: ${describeEvent(ev)}${repeatNote(ev)}`; }
  }
  return null;
}

const VERB = { cancel: 'cancel', move: 'move', remind: 'set a reminder for' };

function handleMessage(from, body, now = new Date()) {
  const phone = normalize(from);
  const opts = { defaultDurationMin: config.defaultDurationMin };
  const p = parseMessage(body, now, opts);

  if (p.type === 'error') return p.message;
  if (p.type === 'event') return addEvent(phone, p);

  if (p.cmd !== 'choose') setPending(phone, null); // any other text drops an open question

  switch (p.cmd) {
    case 'help': return HELP;
    case 'choose': {
      const pend = getPending(phone);
      if (!pend) return `Not sure what "${p.arg}" is for. ${HELP}`;
      if (pend.series) {
        if (p.arg !== 1 && p.arg !== 2) return 'Reply 1 for just this one, or 2 for all of them.';
        setPending(phone, null);
        const series = store.getEvent(pend.ids[0]);
        if (!series) return 'That event is gone already.';
        return applyTo(phone, pend.cmd, occurrence(series, pend.occ), now, p.arg === 1 ? 'one' : 'all');
      }
      const id = pend.ids[p.arg - 1];
      if (!id) return `Reply with a number from 1 to ${pend.ids.length}.`;
      setPending(phone, null);
      const row = store.getEvent(id);
      if (!row) return 'That event is gone already.';
      const ev = row.rrule ? (pend.occs?.[p.arg - 1] != null ? occurrence(row, pend.occs[p.arg - 1]) : nextOccurrence(row, now.getTime())) : row;
      return applyTo(phone, pend.cmd, ev, now);
    }
    case 'undo': {
      const u = jsonGet(`undo:${phone}`);
      setUndo(phone, null);
      if (u) return undo(u) || 'Nothing to undo.';
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
      if (p.arg === 'range') {
        const s = p.start.getTime(), e = p.end.getTime();
        const [t0] = dayBounds(0, now);
        let label;
        if (!p.multiDay) label = s === t0 ? 'today' : s === t0 + 86400000 ? 'tomorrow' : `on ${dayFmt.format(p.start)}`;
        else label = `${dayFmt.format(p.start)} – ${dayFmt.format(new Date(e - 1))}`;
        return agendaText(label, store.eventsInRange(s, e), p.multiDay);
      }
      const [s, e] = dayBounds(p.arg === 'tomorrow' ? 1 : 0, now);
      return agendaText(p.arg, store.eventsInRange(s, e));
    }
    case 'daily': {
      const a = p.arg;
      if (!a) {
        const t = dailyTime();
        return t === 'off' ? 'Morning agenda texts are off. Text "DAILY 7am" to turn them on.'
          : `You get your agenda every day at ${prettyClock(t)}. Text "DAILY OFF" to stop or "DAILY 6:30am" to change the time.`;
      }
      if (/^(off|stop|no)$/.test(a)) { store.kvSet('daily_time', 'off'); return 'OK, no more morning agenda texts. Text "DAILY 7am" to turn them back on.'; }
      const t = /^(on|yes|start)$/.test(a) ? (parseClock(config.dailyAgendaTime) || '07:00') : parseClock(a);
      if (!t) return 'Try "DAILY 7am", "DAILY 6:30am" or "DAILY OFF".';
      store.kvSet('daily_time', t);
      return `OK, I'll text your agenda every day at ${prettyClock(t)}.`;
    }
    case 'find': {
      const matches = matchEvents(p.arg, now);
      if (!matches.length) return `No upcoming event matching "${p.arg}".`;
      if (matches.length === 1) return describeEvent(matches[0]) + repeatNote(matches[0]);
      const shown = matches.slice(0, 5);
      return shown.map(m => `- ${describeEvent(m)}${repeatNote(m)}`).join('\n') +
        (matches.length > shown.length ? `\n(+${matches.length - shown.length} more)` : '');
    }
    case 'cancel':
    case 'move':
    case 'remind': {
      const matches = matchEvents(p.arg, now);
      if (!matches.length) {
        // "Move-in day Dec 1" is an event, not a command.
        const ev = p.cmd !== 'remind' && parseMessage(body, now, { ...opts, eventOnly: true });
        if (ev && ev.type === 'event') return addEvent(phone, ev);
        return `No upcoming event matching "${p.arg}". Text FIND ${p.arg} to search.`;
      }
      if (matches.length === 1) return applyTo(phone, p, matches[0], now);
      setPending(phone, { cmd: p, ids: matches.slice(0, 9).map(m => m.id), occs: matches.slice(0, 9).map(m => m.start_ts) });
      return numbered(matches, VERB[p.cmd]);
    }
  }
  return HELP;
}

function addEvent(phone, p) {
  const ev = store.createEvent({
    title: p.title, all_day: p.allDay, start_ts: p.start.getTime(), end_ts: p.end.getTime(),
    location: p.location, reminder_min: p.reminderMin, source: 'sms', phone, rrule: p.rrule || null,
  });
  setUndo(phone, { kind: 'create', id: ev.id });
  let reply = `Added: ${describeEvent(ev)}${ev.rrule ? `, repeats ${describeRule(ev)}` : ''}`;
  if (ev.reminder_min) reply += ` (reminder ${leadText(ev.reminder_min)} before)`;
  return `${reply}.${clashText(ev, ev.id)} Reply UNDO to remove.`;
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

function morningAgenda(now = new Date()) {
  const [s, e] = dayBounds(0, now);
  const events = store.eventsInRange(s, e);
  const label = `today (${dayFmt.format(now)})`;
  return events.length ? `Good morning! ${agendaText(label, events)}` : `Good morning! Nothing on the calendar ${label}.`;
}

module.exports = { splitSms, dailyTime, morningAgenda, parseClock, handleMessage, receive, sendSms, startPolling, status, isAllowed, normalize };
