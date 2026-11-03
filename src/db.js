'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const config = require('./config');
const recur = require('./recur');

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new Database(path.join(config.dataDir, 'calendar.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  start_ts INTEGER NOT NULL,       -- epoch ms (all-day: local midnight)
  end_ts INTEGER NOT NULL,         -- epoch ms, exclusive
  location TEXT,
  notes TEXT,
  reminder_min INTEGER,            -- minutes before start, NULL = none
  reminded INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'web',
  phone TEXT,                      -- who created it by text (for confirmations/reminders)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_range ON events(start_ts, end_ts);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sms_seen (id TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sms_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction TEXT NOT NULL, number TEXT, body TEXT, at INTEGER NOT NULL
);
`);

// Columns added after v1 (repeating events).
const cols = new Set(db.prepare('PRAGMA table_info(events)').all().map(c => c.name));
if (!cols.has('rrule')) db.exec('ALTER TABLE events ADD COLUMN rrule TEXT');            // JSON rule, NULL = one-off
if (!cols.has('exdates')) db.exec('ALTER TABLE events ADD COLUMN exdates TEXT');        // JSON array of skipped starts
if (!cols.has('reminded_ts')) db.exec('ALTER TABLE events ADD COLUMN reminded_ts INTEGER'); // last occurrence reminded

const FIELDS = ['title', 'all_day', 'start_ts', 'end_ts', 'location', 'notes', 'reminder_min', 'source', 'phone', 'rrule', 'exdates'];
const json = v => (v == null ? null : typeof v === 'string' ? v : JSON.stringify(v));

function createEvent(e) {
  const now = Date.now();
  const row = {
    uid: crypto.randomUUID(),
    title: e.title, all_day: e.all_day ? 1 : 0, start_ts: e.start_ts, end_ts: e.end_ts,
    location: e.location || null, notes: e.notes || null,
    reminder_min: e.reminder_min ?? null, source: e.source || 'web', phone: e.phone || null,
    rrule: json(e.rrule), exdates: json(e.exdates), created_at: now, updated_at: now,
  };
  const info = db.prepare(`INSERT INTO events (uid,title,all_day,start_ts,end_ts,location,notes,reminder_min,source,phone,rrule,exdates,created_at,updated_at)
    VALUES (@uid,@title,@all_day,@start_ts,@end_ts,@location,@notes,@reminder_min,@source,@phone,@rrule,@exdates,@created_at,@updated_at)`).run(row);
  return getEvent(info.lastInsertRowid);
}

function updateEvent(id, patch) {
  const cur = getEvent(id);
  if (!cur) return null;
  const next = { ...cur };
  for (const f of FIELDS) if (patch[f] !== undefined) next[f] = patch[f];
  next.all_day = next.all_day ? 1 : 0;
  next.rrule = json(next.rrule);
  next.exdates = json(next.exdates);
  // Re-arm the reminder if timing changed.
  if (patch.start_ts !== undefined || patch.reminder_min !== undefined || patch.rrule !== undefined) { next.reminded = 0; next.reminded_ts = null; }
  next.updated_at = Date.now();
  db.prepare(`UPDATE events SET title=@title, all_day=@all_day, start_ts=@start_ts, end_ts=@end_ts, location=@location,
    notes=@notes, reminder_min=@reminder_min, reminded=@reminded, reminded_ts=@reminded_ts, phone=@phone,
    rrule=@rrule, exdates=@exdates, updated_at=@updated_at WHERE id=@id`).run(next);
  return getEvent(id);
}

// Put back a deleted event exactly as it was (same id and uid), for UNDO.
function restoreEvent(row) {
  db.prepare(`INSERT INTO events (id,uid,title,all_day,start_ts,end_ts,location,notes,reminder_min,reminded,reminded_ts,source,phone,rrule,exdates,created_at,updated_at)
    VALUES (@id,@uid,@title,@all_day,@start_ts,@end_ts,@location,@notes,@reminder_min,@reminded,@reminded_ts,@source,@phone,@rrule,@exdates,@created_at,@updated_at)`)
    .run({ reminded_ts: null, rrule: null, exdates: null, ...row, updated_at: Date.now() });
  return getEvent(row.id);
}

const getEvent = id => db.prepare('SELECT * FROM events WHERE id = ?').get(id);
const deleteEvent = id => db.prepare('DELETE FROM events WHERE id = ?').run(id).changes > 0;
// One row per occurrence: repeating events are expanded into the window.
function eventsInRange(from, to) {
  const single = db.prepare('SELECT * FROM events WHERE rrule IS NULL AND start_ts < ? AND end_ts > ?').all(to, from);
  const series = db.prepare('SELECT * FROM events WHERE rrule IS NOT NULL AND start_ts < ?').all(to);
  const occ = series.flatMap(ev => recur.occurrences(ev, from, to).map(t => recur.occurrence(ev, t)));
  return single.concat(occ).sort((a, b) => a.start_ts - b.start_ts || a.id - b.id);
}
const allEvents = () => db.prepare('SELECT * FROM events ORDER BY start_ts').all();
const findUpcomingByTitle = (q, now) =>
  db.prepare(`SELECT * FROM events WHERE end_ts > ? AND title LIKE ? ORDER BY start_ts LIMIT 5`).all(now, `%${q}%`);
// Upcoming one-off events plus the next occurrence of each repeating event.
function upcomingEvents(now, limit = 1000) {
  const single = db.prepare('SELECT * FROM events WHERE rrule IS NULL AND end_ts > ? ORDER BY start_ts LIMIT ?').all(now, limit);
  const series = db.prepare('SELECT * FROM events WHERE rrule IS NOT NULL').all()
    .map(ev => recur.nextOccurrence(ev, now)).filter(Boolean);
  return single.concat(series).sort((a, b) => a.start_ts - b.start_ts || a.id - b.id);
}
const lastCreatedBy = phone =>
  db.prepare(`SELECT * FROM events WHERE phone = ? AND source = 'sms' ORDER BY created_at DESC LIMIT 1`).get(phone);
function dueReminders(now) {
  const single = db.prepare(`SELECT * FROM events WHERE rrule IS NULL AND reminder_min IS NOT NULL AND reminded = 0
    AND start_ts - reminder_min * 60000 <= ? AND start_ts > ?`).all(now, now - 3600000);
  const series = db.prepare('SELECT * FROM events WHERE rrule IS NOT NULL AND reminder_min IS NOT NULL').all()
    .map(ev => recur.nextOccurrence(ev, now - 3600000))
    .filter(o => o && o.start_ts > now - 3600000 && o.start_ts - o.reminder_min * 60000 <= now && (o.reminded_ts || 0) < o.start_ts);
  return single.concat(series);
}
const markReminded = ev => (ev.occ_ts
  ? db.prepare('UPDATE events SET reminded_ts = ? WHERE id = ?').run(ev.occ_ts, ev.id)
  : db.prepare('UPDATE events SET reminded = 1 WHERE id = ?').run(ev.id ?? ev));

// Nightly copy of the database into DATA_DIR/backups, keeping the newest `keep`.
async function backup(dateStr, keep = 7) {
  const dir = path.join(config.dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `calendar-${dateStr}.db`);
  if (!fs.existsSync(file)) await db.backup(file);
  const old = fs.readdirSync(dir).filter(f => /^calendar-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().reverse().slice(keep);
  for (const f of old) fs.unlinkSync(path.join(dir, f));
  return file;
}
const listBackups = () => {
  try { return fs.readdirSync(path.join(config.dataDir, 'backups')).filter(f => f.endsWith('.db')).sort(); } catch { return []; }
};

const kvGet = k => db.prepare('SELECT value FROM kv WHERE key = ?').get(k)?.value;
const kvSet = (k, v) => db.prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));

const smsSeen = id => Boolean(db.prepare('SELECT 1 FROM sms_seen WHERE id = ?').get(String(id)));
const markSmsSeen = id => db.prepare('INSERT OR IGNORE INTO sms_seen(id, seen_at) VALUES(?, ?)').run(String(id), Date.now());
const logSms = (direction, number, body) => {
  db.prepare('INSERT INTO sms_log(direction, number, body, at) VALUES(?,?,?,?)').run(direction, number, body, Date.now());
  db.prepare('DELETE FROM sms_log WHERE id NOT IN (SELECT id FROM sms_log ORDER BY id DESC LIMIT 200)').run();
};
const recentSms = (limit = 50) => db.prepare('SELECT * FROM sms_log ORDER BY id DESC LIMIT ?').all(limit);

module.exports = {
  db, createEvent, updateEvent, getEvent, deleteEvent, eventsInRange, allEvents, findUpcomingByTitle, upcomingEvents, restoreEvent,
  lastCreatedBy, dueReminders, markReminded, backup, listBackups, kvGet, kvSet, smsSeen, markSmsSeen, logSms, recentSms,
};
