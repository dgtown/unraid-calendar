'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const config = require('./config');
const store = require('./db');
const sms = require('./sms');
const { toICS } = require('./ics');
const { parseMessage } = require('./parser');
const { describeEvent } = require('./format');
const recur = require('./recur');
const { startReminders } = require('./reminders');
const { createLimiter } = require('./limiter');

const app = express();
app.disable('x-powered-by');
// Behind a reverse proxy, take the client's address and https from X-Forwarded-* (see TRUST_PROXY).
app.set('trust proxy', config.trustProxy);
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'no-referrer', // keeps ?token=... out of Referer headers
  });
  next();
});

// Docker health check always uses /healthz, even when BASE_PATH is set.
app.get('/healthz', (req, res) => res.json({ ok: true }));

// Everything else lives on a router mounted at BASE_PATH (or /).
const router = express.Router();
router.use(express.json({ limit: '100kb' }));

const limiter = createLimiter({ maxAttempts: config.loginMaxAttempts, windowMs: config.loginLockoutMin * 60000 });
function tooMany(req, res) {
  const ms = limiter.blockedFor(req.ip);
  if (!ms) return false;
  res.set('Retry-After', String(Math.ceil(ms / 1000))).status(429).send('Too many failed attempts. Try again later.\n');
  return true;
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
// Checks ?token=FEED_TOKEN, counting wrong tokens toward the lockout. Sends the error itself.
function tokenOk(req, res, message) {
  if (tooMany(req, res)) return false;
  if (config.feedToken && safeEqual(req.query.token || '', config.feedToken)) return true;
  if (config.feedToken && req.query.token) limiter.fail(req.ip);
  res.status(403).send(message);
  return false;
}

// Read-only subscription feed for phones (ICSx5 on Android, "Subscribed calendar" on iPhone).
router.get('/calendar.ics', (req, res) => {
  if (!tokenOk(req, res, 'Set FEED_TOKEN and add ?token=... to the URL.\n')) return;
  res.type('text/calendar; charset=utf-8').send(toICS(store.allEvents()));
});

// Optional instant delivery: voip.ms "SMS URL Callback" pointed at
// https://your-host/sms/voipms?token=FEED_TOKEN&id={ID}&from={FROM}&message={MESSAGE}
router.get('/sms/voipms', async (req, res) => {
  if (!tokenOk(req, res, 'forbidden')) return;
  res.send('ok'); // voip.ms expects a quick "ok"
  try { await sms.receive(req.query.id || null, req.query.from, req.query.message || ''); } catch (e) { console.error(e); }
});

// Everything below needs the web password (if one is set).
router.use((req, res, next) => {
  if (!config.appPassword) return next();
  if (tooMany(req, res)) return;
  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const pass = Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':');
    if (safeEqual(pass, config.appPassword)) { limiter.success(req.ip); return next(); }
    limiter.fail(req.ip); // only real attempts count, not the browser's first password-less request
  }
  res.set('WWW-Authenticate', 'Basic realm="Calendar", charset="UTF-8"').status(401).send('Login required');
});

router.get('/vendor/fullcalendar.js', (req, res) =>
  res.sendFile(path.join(__dirname, '..', 'node_modules', 'fullcalendar', 'index.global.min.js'), { maxAge: '7d' }));
router.use(express.static(path.join(__dirname, '..', 'public')));

// ---------------------------------------------------------------------------
// JSON API
// ---------------------------------------------------------------------------
function toApi(e) {
  const d = ts => { const x = new Date(ts); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
  return {
    id: e.id, title: e.title, allDay: Boolean(e.all_day),
    start: e.all_day ? d(e.start_ts) : new Date(e.start_ts).toISOString(),
    end: e.all_day ? d(e.end_ts) : new Date(e.end_ts).toISOString(),
    location: e.location, notes: e.notes, reminderMin: e.reminder_min, source: e.source,
    repeat: recur.ruleOf(e)?.freq || null, repeatText: e.rrule ? recur.describeRule(e) : null,
    occurrence: e.occ_ts ?? null,
  };
}

// Accepts "2026-11-10" (local midnight) or any ISO date-time.
function parseWhen(v) {
  if (typeof v !== 'string') return NaN;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  return new Date(v).getTime();
}

function fromApi(b, partial = false) {
  const out = {};
  if (b.title !== undefined) out.title = String(b.title).trim().slice(0, 300);
  if (b.allDay !== undefined) out.all_day = b.allDay ? 1 : 0;
  if (b.start !== undefined) out.start_ts = parseWhen(b.start);
  if (b.end !== undefined) out.end_ts = b.end ? parseWhen(b.end) : null;
  if (b.location !== undefined) out.location = b.location ? String(b.location).slice(0, 300) : null;
  if (b.notes !== undefined) out.notes = b.notes ? String(b.notes).slice(0, 5000) : null;
  if (b.repeat !== undefined) {
    if (b.repeat && !['daily', 'weekly', 'monthly', 'yearly'].includes(b.repeat)) throw new Error('Invalid repeat');
    out.rrule = b.repeat ? { freq: b.repeat, interval: 1 } : null;
  }
  if (b.reminderMin !== undefined) out.reminder_min = b.reminderMin === null || b.reminderMin === '' ? null : parseInt(b.reminderMin, 10);
  if (!partial && !out.title) throw new Error('Title is required');
  if (out.start_ts !== undefined && Number.isNaN(out.start_ts)) throw new Error('Invalid start');
  if (out.start_ts !== undefined && (out.end_ts == null || Number.isNaN(out.end_ts))) {
    out.end_ts = out.all_day ? out.start_ts + 86400000 : out.start_ts + config.defaultDurationMin * 60000;
  }
  if (out.end_ts !== undefined && out.end_ts <= out.start_ts) throw new Error('End must be after start');
  return out;
}

const wrap = fn => (req, res) => {
  try { fn(req, res); } catch (err) { res.status(400).json({ error: err.message }); }
};

router.get('/api/events', wrap((req, res) => {
  const from = req.query.start ? new Date(req.query.start).getTime() : 0;
  const to = req.query.end ? new Date(req.query.end).getTime() : 8640000000000000;
  res.json(store.eventsInRange(from, to).map(toApi));
}));

router.post('/api/events', wrap((req, res) => {
  res.status(201).json(toApi(store.createEvent({ ...fromApi(req.body), source: 'web' })));
}));

router.put('/api/events/:id', wrap((req, res) => {
  const cur = store.getEvent(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const patch = fromApi(req.body, true);
  if (patch.start_ts !== undefined && patch.end_ts === undefined) patch.end_ts = patch.start_ts + (cur.end_ts - cur.start_ts);
  const rule = recur.ruleOf(cur);
  if (rule) {
    // Editing one occurrence of a repeating event edits the whole series: shift it by the same amount.
    const occ = Number(req.body.occurrence);
    if (patch.start_ts !== undefined && Number.isFinite(occ)) {
      const len = patch.end_ts - patch.start_ts;
      patch.start_ts = cur.start_ts + (patch.start_ts - occ);
      patch.end_ts = patch.start_ts + len;
      if (patch.start_ts === cur.start_ts) delete patch.start_ts;
    }
    // Keep weekly days / intervals if the repeat kind didn't change.
    if (patch.rrule && patch.rrule.freq === rule.freq) delete patch.rrule;
    else if (patch.rrule && patch.rrule.freq !== rule.freq) patch.exdates = null;
  }
  res.json(toApi(store.updateEvent(cur.id, patch)));
}));

router.delete('/api/events/:id', wrap((req, res) => {
  const cur = store.getEvent(req.params.id);
  if (!cur) return res.status(404).end();
  const occ = Number(req.query.occurrence);
  if (cur.rrule && Number.isFinite(occ)) {
    store.updateEvent(cur.id, { exdates: [...recur.exdatesOf(cur), occ] }); // skip just this one
  } else store.deleteEvent(cur.id);
  res.status(204).end();
}));

// "Quick add" box: same parser as text messages.
router.post('/api/quick-add', wrap((req, res) => {
  const p = parseMessage(req.body.text, new Date(), { defaultDurationMin: config.defaultDurationMin });
  if (p.type !== 'event') return res.status(400).json({ error: p.message || 'Commands only work by text message.' });
  const ev = store.createEvent({
    title: p.title, all_day: p.allDay, start_ts: p.start.getTime(), end_ts: p.end.getTime(),
    location: p.location, reminder_min: p.reminderMin, source: 'web', rrule: p.rrule || null,
  });
  res.status(201).json({ event: toApi(ev), summary: describeEvent(ev) + (ev.rrule ? `, repeats ${recur.describeRule(ev)}` : '') });
}));

router.get('/api/status', (req, res) => {
  res.json({
    timezone: config.tz,
    sms: { enabled: config.smsEnabled, did: config.voipms.did || null, allowed: config.allowedNumbers.length,
      lastPoll: sms.status.lastPoll, lastError: sms.status.lastError },
    feed: Boolean(config.feedToken),
    dailyAgenda: sms.dailyTime(),
    recentSms: store.recentSms(20),
    backups: store.listBackups(),
  });
});

if (config.basePath) {
  // "/calendar" -> "/calendar/" so the page's relative links resolve under the sub-path.
  app.get(config.basePath, (req, res, next) => {
    const q = req.originalUrl.indexOf('?');
    if ((q >= 0 ? req.originalUrl.slice(0, q) : req.originalUrl).endsWith('/')) return next();
    res.redirect(308, config.basePath + '/' + (q >= 0 ? req.originalUrl.slice(q) : ''));
  });
}
app.use(config.basePath || '/', router);

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`Calendar listening on :${config.port}${config.basePath ? ` at ${config.basePath}/` : ''} (TZ ${config.tz}, data in ${config.dataDir})`);
    sms.startPolling();
    startReminders();
  });
}

module.exports = app;
