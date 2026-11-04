'use strict';
const path = require('path');

function list(v) {
  return (v || '').split(',').map(s => s.trim()).filter(Boolean);
}

const config = {
  port: parseInt(process.env.PORT || '8080', 10),
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  tz: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
  // Optional password for the web UI (username can be anything).
  appPassword: process.env.APP_PASSWORD || '',
  // Secret token for the read-only .ics feed and the optional SMS webhook.
  feedToken: process.env.FEED_TOKEN || '',
  // Time to text today's agenda each morning ("07:00"), or "off".
  dailyAgendaTime: process.env.DAILY_AGENDA_TIME || '07:00',
  defaultDurationMin: parseInt(process.env.DEFAULT_DURATION_MIN || '60', 10),
  voipms: {
    user: process.env.VOIPMS_API_USER || '',
    password: process.env.VOIPMS_API_PASSWORD || '',
    did: (process.env.VOIPMS_DID || '').replace(/\D/g, '').slice(-10), // voip.ms wants 10 digits, no leading 1
    pollSeconds: parseInt(process.env.VOIPMS_POLL_SECONDS || '30', 10),
    apiUrl: process.env.VOIPMS_API_URL || 'https://voip.ms/api/v1/rest.php',
  },
  // Only texts from these numbers are accepted (digits; last 10 are compared).
  allowedNumbers: list(process.env.ALLOWED_NUMBERS).map(n => n.replace(/\D/g, '').slice(-10)),
};

// Reverse proxy support -------------------------------------------------------
// Which proxies may set X-Forwarded-For / -Proto / -Host. Default trusts proxies on
// this machine and private networks (Nginx Proxy Manager, SWAG, Caddy on the same Unraid box).
// "off" ignores the headers; "true" trusts any; a number trusts that many hops; or list IPs/subnets.
function trustProxy(v) {
  v = (v ?? '').trim();
  if (!v) return 'loopback, linklocal, uniquelocal';
  if (/^(off|false|no|0)$/i.test(v)) return false;
  if (/^(on|true|yes)$/i.test(v)) return true;
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  return v;
}
config.trustProxy = trustProxy(process.env.TRUST_PROXY);

// Serve the app under a sub-path, e.g. BASE_PATH=/calendar -> https://example.com/calendar/
function basePath(v) {
  v = (v || '').trim().replace(/\/+$/, '');
  if (!v) return '';
  if (!v.startsWith('/')) v = '/' + v;
  if (!/^\/[A-Za-z0-9._~\/-]*$/.test(v)) throw new Error(`BASE_PATH has unsupported characters: ${v}`);
  return v;
}
config.basePath = basePath(process.env.BASE_PATH);

// Wrong-password lockout: after LOGIN_MAX_ATTEMPTS bad tries from one address within
// LOGIN_LOCKOUT_MIN minutes, that address is refused for LOGIN_LOCKOUT_MIN minutes. 0 disables.
const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : d; };
config.loginMaxAttempts = int(process.env.LOGIN_MAX_ATTEMPTS, 10);
config.loginLockoutMin = int(process.env.LOGIN_LOCKOUT_MIN, 15) || 15;

config.smsEnabled = Boolean(config.voipms.user && config.voipms.password && config.voipms.did);

module.exports = config;
