'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const config = require('./config');

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

const FIELDS = ['title', 'all_day', 'start_ts', 'end_ts', 'location', 'notes', 'reminder_min', 'source', 'phone'];

function createEvent(e) {
  const now = Date.now();
  const row = {
    uid: crypto.randomUUID(),
    title: e.title, all_day: e.all_day ? 1 : 0, start_ts: e.start_ts, end_ts: e.end_ts,
    location: e.location || null, notes: e.notes || null,
    reminder_min: e.reminder_min ?? null, source: e.source || 'web', phone: e.phone || null,
    created_at: now, updated_at: now,
  };
  const info = db.prepare(`INSERT INTO events (uid,title,all_day,start_ts,end_ts,location,notes,reminder_min,source,phone,created_at,updated_at)
    VALUES (@uid,@title,@all_day,@start_ts,@end_ts,@location,@notes,@reminder_min,@source,@phone,@created_at,@updated_at)`).run(row);
  return getEvent(info.lastInsertRowid);
}

function updateEvent(id, patch) {
  const cur = getEvent(id);
  if (!cur) return null;
  const next = { ...cur };
  for (const f of FIELDS) if (patch[f] !== undefined) next[f] = patch[f];
  next.all_day = next.all_day ? 1 : 0;
  // Re-arm the reminder if timing changed.
  if (patch.start_ts !== undefined || patch.reminder_min !== undefined) next.reminded = 0;
  next.updated_at = Date.now();
  db.prepare(`UPDATE events SET title=@title, all_day=@all_day, start_ts=@start_ts, end_ts=@end_ts, location=@location,
    notes=@notes, reminder_min=@reminder_min, reminded=@reminded, phone=@phone, updated_at=@updated_at WHERE id=@id`).run(next);
  return getEvent(id);
}

// Put back a deleted event exactly as it was (same id and uid), for UNDO.
function restoreEvent(row) {
  db.prepare(`INSERT INTO events (id,uid,title,all_day,start_ts,end_ts,location,notes,reminder_min,reminded,source,phone,created_at,updated_at)
    VALUES (@id,@uid,@title,@all_day,@start_ts,@end_ts,@location,@notes,@reminder_min,@reminded,@source,@phone,@created_at,@updated_at)`)
    .run({ ...row, updated_at: Date.now() });
  return getEvent(row.id);
}

const getEvent = id => db.prepare('SELECT * FROM events WHERE id = ?').get(id);
const deleteEvent = id => db.prepare('DELETE FROM events WHERE id = ?').run(id).changes > 0;
const eventsInRange = (from, to) =>
  db.prepare('SELECT * FROM events WHERE start_ts < ? AND end_ts > ? ORDER BY start_ts').all(to, from);
const allEvents = () => db.prepare('SELECT * FROM events ORDER BY start_ts').all();
const findUpcomingByTitle = (q, now) =>
  db.prepare(`SELECT * FROM events WHERE end_ts > ? AND title LIKE ? ORDER BY start_ts LIMIT 5`).all(now, `%${q}%`);
const upcomingEvents = (now, limit = 1000) =>
  db.prepare('SELECT * FROM events WHERE end_ts > ? ORDER BY start_ts LIMIT ?').all(now, limit);
const lastCreatedBy = phone =>
  db.prepare(`SELECT * FROM events WHERE phone = ? AND source = 'sms' ORDER BY created_at DESC LIMIT 1`).get(phone);
const dueReminders = now =>
  db.prepare(`SELECT * FROM events WHERE reminder_min IS NOT NULL AND reminded = 0
    AND start_ts - reminder_min * 60000 <= ? AND start_ts > ?`).all(now, now - 3600000);
const markReminded = id => db.prepare('UPDATE events SET reminded = 1 WHERE id = ?').run(id);

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
  lastCreatedBy, dueReminders, markReminded, kvGet, kvSet, smsSeen, markSmsSeen, logSms, recentSms,
};
