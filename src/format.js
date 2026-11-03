'use strict';
const config = require('./config');

const fmt = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: config.tz, ...opts });
const dayFmt = fmt({ weekday: 'short', month: 'short', day: 'numeric' });
const timeFmt = fmt({ hour: 'numeric', minute: '2-digit' });

function describeWhen(ev) {
  const s = new Date(ev.start_ts);
  const e = new Date(ev.end_ts);
  if (ev.all_day) {
    const last = new Date(ev.end_ts - 1);
    const sameDay = dayFmt.format(s) === dayFmt.format(last);
    return sameDay ? `${dayFmt.format(s)} (all day)` : `${dayFmt.format(s)} – ${dayFmt.format(last)}`;
  }
  const sameDay = dayFmt.format(s) === dayFmt.format(e);
  return sameDay
    ? `${dayFmt.format(s)}, ${timeFmt.format(s)}–${timeFmt.format(e)}`
    : `${dayFmt.format(s)} ${timeFmt.format(s)} – ${dayFmt.format(e)} ${timeFmt.format(e)}`;
}

function describeEvent(ev) {
  let out = `${ev.title}, ${describeWhen(ev)}`;
  if (ev.location) out += ` @ ${ev.location}`;
  return out;
}

module.exports = { describeWhen, describeEvent, timeFmt, dayFmt };
