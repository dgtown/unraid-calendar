'use strict';

const esc = s => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
const utc = ts => new Date(ts).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
function localDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}
// RFC 5545 lines must be folded at 75 octets.
function fold(line) {
  const out = [];
  let buf = '';
  for (const ch of line) {
    if (Buffer.byteLength(buf + ch) > 74) { out.push(buf); buf = ' '; }
    buf += ch;
  }
  out.push(buf);
  return out.join('\r\n');
}

function toICS(events, name = 'Calendar') {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//unraid-calendar//EN', 'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${esc(name)}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT15M', 'X-PUBLISHED-TTL:PT15M'];
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${e.uid}`, `DTSTAMP:${utc(e.updated_at)}`, `LAST-MODIFIED:${utc(e.updated_at)}`);
    if (e.all_day) {
      lines.push(`DTSTART;VALUE=DATE:${localDate(e.start_ts)}`, `DTEND;VALUE=DATE:${localDate(e.end_ts)}`);
    } else {
      lines.push(`DTSTART:${utc(e.start_ts)}`, `DTEND:${utc(e.end_ts)}`);
    }
    lines.push(`SUMMARY:${esc(e.title)}`);
    if (e.location) lines.push(`LOCATION:${esc(e.location)}`);
    if (e.notes) lines.push(`DESCRIPTION:${esc(e.notes)}`);
    if (e.reminder_min != null) {
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(e.title)}`, `TRIGGER:-PT${e.reminder_min}M`, 'END:VALARM');
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

module.exports = { toICS };
