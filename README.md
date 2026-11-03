# Unraid Calendar

A small self-hosted calendar that runs as one Docker container on Unraid.

- **Add events by text message** through your voip.ms number: `Dentist tue 3pm`, `Sam's party Sat 2-5 @ 12 Oak St remind 1h`.
- **Web page** that works on desktop and phone (Android: Chrome → "Add to Home screen").
- **Phone calendar subscription** (`.ics` feed) for Google Calendar, Samsung Calendar (via ICSx⁵) or iPhone.
- **Text reminders** before events, plus a **morning agenda text** every day at 7:00 AM.
- Everything is stored in one SQLite file in `/mnt/user/appdata/calendar`.

## Texting it

| You text | It does |
|---|---|
| `Dentist tue 3pm` | 1-hour event Tuesday at 3pm |
| `Party Saturday 2-5` | Saturday 2–5pm (bare 1–7 o'clock times are assumed PM) |
| `Oil change Dec 12` | All-day event |
| `Vacation Dec 20 - Dec 27` | Multi-day event |
| `Doctor thu 9am @ Main St Clinic` | Adds a location |
| `... remind 30m` / `remind me 2 hours` / `remind` | Texts you a reminder (default 30 min) |
| `today`, `tomorrow`, `week` (also "what do I have today?", "appointments tomorrow") | Texts back your agenda |
| `daily 6:30am` / `daily off` / `daily` | Change, stop, or check the morning agenda text (default 7:00 AM) |
| `undo` | Removes the last event you texted |
| `cancel dentist` | Deletes the upcoming event matching "dentist" |
| `help` | Lists commands |

Every new event gets a confirmation text, e.g. `Added: Dentist, Tue, Nov 10, 3:00 PM–4:00 PM. Reply UNDO to remove.`
Only numbers listed in `ALLOWED_NUMBERS` are accepted; anything else is ignored.

## voip.ms setup

1. **DID Numbers → Manage DIDs →** edit your number → tick **Enable SMS/MMS** → Apply.
2. **Main Menu → SOAP and REST/JSON API**: enable the API, set an **API password**, and add your home's
   public IP address (search "what is my ip") to the allowed IP list.
3. Put your voip.ms login email, the API password, and the DID in the container settings below.

The app checks voip.ms for new texts every 30 seconds, so nothing needs to be exposed to the internet.

*Optional instant delivery:* if your server is reachable from the internet (e.g. Cloudflare Tunnel), set the DID's
**SMS URL Callback** to
`https://YOUR-HOST/sms/voipms?token=FEED_TOKEN&id={ID}&from={FROM}&message={MESSAGE}`.

## Install on Unraid

The GitHub Action in this repo builds the image on every push to `main` and publishes it to
`ghcr.io/dgtown/unraid-calendar:latest`.

1. After the first build finishes, open the repo on GitHub → **Packages → unraid-calendar → Package settings** and
   either make the package **Public**, or log Unraid in to GHCR (`docker login ghcr.io` with a personal access token
   that has `read:packages`).
2. Copy `unraid/calendar.xml` to `/boot/config/plugins/dockerMan/templates-user/my-calendar.xml` on the Unraid flash
   drive.
3. **Docker → Add Container →** pick the `calendar` template, fill in the settings, **Apply**.
4. Open `http://<unraid-ip>:8080`.

Prefer compose? Use `docker-compose.yml` with the Compose Manager plugin.

### Settings

| Variable | Purpose |
|---|---|
| `TZ` | Your time zone, e.g. `America/Chicago`. Important for parsing "3pm". |
| `APP_PASSWORD` | Optional password for the web page. |
| `FEED_TOKEN` | Long random string; enables `/calendar.ics?token=...` and the SMS webhook. |
| `VOIPMS_API_USER` | voip.ms login email. |
| `VOIPMS_API_PASSWORD` | voip.ms API password. |
| `VOIPMS_DID` | Your voip.ms number (digits). |
| `ALLOWED_NUMBERS` | Comma-separated numbers allowed to text it. |
| `DAILY_AGENDA_TIME` | When to text the day's agenda (default `07:00`; `off` to disable). Texting `DAILY ...` overrides it. |
| `VOIPMS_POLL_SECONDS` | How often to check for texts (default 30). |
| `DEFAULT_DURATION_MIN` | Length of events with no end time (default 60). |

## Seeing it on your phone

- **Web app:** open `http://<unraid-ip>:8080` in Chrome → menu → *Add to Home screen*.
- **Phone calendar (read-only for now):** install **ICSx⁵** (Android) and subscribe to
  `http://<unraid-ip>:8080/calendar.ics?token=<FEED_TOKEN>`. On iPhone: Settings → Calendar → Accounts →
  Add Subscribed Calendar.
- **Away from home:** install the Tailscale plugin on Unraid and the Tailscale app on your phone, then use the
  Tailscale address instead of the LAN IP. Texting works from anywhere without this.

## Development

```bash
npm install
npm test
TZ=America/Toronto DATA_DIR=./data node src/server.js   # http://localhost:8080
```
