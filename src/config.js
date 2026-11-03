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

config.smsEnabled = Boolean(config.voipms.user && config.voipms.password && config.voipms.did);

module.exports = config;
