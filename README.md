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
| `Golf Sat 10am for 4 hours`, `Meeting tue 2pm 90 min`, `Cottage Dec 4 for 3 days` | Sets how long it lasts (otherwise 1 hour) |
| `Oil change Dec 12` | All-day event |
| `Vacation Dec 20 - Dec 27` | Multi-day event |
| `Doctor thu 9am @ Main St Clinic` | Adds a location |
| `Soccer every Saturday 10am`, `Gym every mon, wed and fri 6pm`, `Standup every weekday 9am` | Repeating event (also `every other week`, `daily`, `monthly on the 1st`, `every 15th`, `Mom's birthday every Mar 14`, `... until Dec 19`) |
| `... remind 30m` / `remind me 2 hours` / `remind` | Texts you a reminder (default 30 min) |
| `today`, `tomorrow`, `week` (also "what do I have today?", "appointments tomorrow") | Texts back your agenda |
| `what's on Friday?`, `anything Saturday?`, `what do I have next week` | Agenda for that day or week (questions never create events) |
| `second week of November`, `this weekend`, `in December`, `next month`, `Nov 9-15` | Agenda for that range (weeks run Sunday–Saturday) |
| `find dentist`, `when is my haircut?` | Lists the next matching events ("dentist" also matches "Dentist appt") |
| `cancel dentist` | Deletes the upcoming event matching "dentist". For a repeating event it asks: reply 1 for just the next one, 2 for all of them (same for `move`) |
| `move lunch to 1pm`, `move dentist to Thursday 3pm`, `reschedule haircut to Nov 21` | Moves it. A time alone keeps the day, a day alone keeps the time, and the length stays the same |
| `push lunch back an hour`, `move dentist 30 min earlier` | Shifts it by that much |
| `remind me 30 min before soccer`, `remind me about the dentist 1 hour before`, `no reminder for soccer` | Sets or removes a reminder on an existing event |
| `2` | When more than one event matches a cancel, move or reminder, you get a numbered list; reply with the number |
| `undo` | Reverses your last text: removes an added event, brings back a cancelled one, or puts a moved one back |
| `daily 6:30am` / `daily off` / `daily` | Change, stop, or check the morning agenda text (default 7:00 AM) |
| `help` | Lists commands |

Anything that isn't a command (and has a date) is added as a new event, so `Move-in day Dec 1` still works.

If a new or moved event overlaps another timed event, the reply says so ("Heads up, overlaps Dentist 3:00 PM–4:00 PM").

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
| `BASE_PATH` | Serve the app under a sub-path such as `/calendar` (default: the root). |
| `TRUST_PROXY` | Which proxies may send `X-Forwarded-*` headers. Default: this machine and private networks. `off`, `true`, a hop count, or IPs/subnets like `172.18.0.0/16`. |
| `LOGIN_MAX_ATTEMPTS` | Wrong passwords (or feed tokens) from one address before it's blocked (default 10, `0` = off). |
| `LOGIN_LOCKOUT_MIN` | How long that block lasts, and the window the attempts are counted in (default 15). |

## Seeing it on your phone

- **Web app:** open `http://<unraid-ip>:8080` in Chrome → menu → *Add to Home screen*.
- **Phone calendar (read-only for now):** install **ICSx⁵** (Android) and subscribe to
  `http://<unraid-ip>:8080/calendar.ics?token=<FEED_TOKEN>`. On iPhone: Settings → Calendar → Accounts →
  Add Subscribed Calendar.
- **Away from home:** use a reverse proxy (see below), or install the Tailscale plugin on Unraid and the Tailscale app on your phone, then use the
  Tailscale address instead of the LAN IP. Texting works from anywhere without this.

## Behind a reverse proxy

You can put the calendar behind Nginx Proxy Manager, SWAG, Caddy or Cloudflare Tunnel to reach it at
`https://calendar.example.com` from anywhere.

- **Set `APP_PASSWORD` first.** The proxy makes the page reachable from the internet. Always use HTTPS, since the
  browser sends the password with every request.
- After `LOGIN_MAX_ATTEMPTS` wrong passwords (default 10) from one address, that address gets "Too many failed
  attempts" for 15 minutes. Wrong feed tokens count too. Restarting the container clears all blocks.
- The app reads the visitor's real address and `https` from the proxy's `X-Forwarded-For` / `X-Forwarded-Proto`
  headers. By default it believes them only from proxies on the same machine or a private network (`10.x`,
  `172.16–31.x`, `192.168.x`), which covers a proxy container on Unraid. If the app is reachable directly from the
  internet as well, set `TRUST_PROXY` to your proxy's address only.
- Health checks stay at `/healthz` even with `BASE_PATH`.

**Nginx Proxy Manager:** Hosts → Proxy Hosts → Add. Domain `calendar.example.com`, scheme `http`, forward host
your Unraid IP, port `8080`. On the SSL tab request a Let's Encrypt certificate and tick *Force SSL*. NPM sends the
`X-Forwarded-*` headers on its own.

**pfSense (HAProxy package):** Services → HAProxy.

- *Backend*: server address = your Unraid IP, port `8080`, no SSL. Tick **Use "forwardfor" option** so the app sees
  each visitor's real address (without it every visitor looks like pfSense, and the login lockout would block
  everyone at once).
- *Frontend*: listen on 443 with SSL offloading and your certificate (ACME package), and under
  **Advanced pass thru** add:

  ```
  http-request set-header X-Forwarded-Proto https if { ssl_fc }
  ```

- pfSense's LAN address is private, so the default `TRUST_PROXY` already accepts it. To be stricter, set
  `TRUST_PROXY` to pfSense's LAN IP (e.g. `192.168.1.1`).

**SWAG** (`/mnt/user/appdata/swag/nginx/proxy-confs/calendar.subdomain.conf`):

```nginx
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name calendar.*;
    include /config/nginx/ssl.conf;
    client_max_body_size 1m;

    location / {
        include /config/nginx/proxy.conf;      # sets X-Forwarded-For / -Proto / -Host
        include /config/nginx/resolver.conf;
        set $upstream_app 192.168.1.10;        # your Unraid IP, or "calendar" on a shared Docker network
        set $upstream_port 8080;
        set $upstream_proto http;
        proxy_pass $upstream_proto://$upstream_app:$upstream_port;
    }
}
```

**Plain nginx under a sub-path** (with `BASE_PATH=/calendar`):

```nginx
location /calendar/ {
    proxy_pass http://192.168.1.10:8080;      # no trailing slash: keep the /calendar prefix
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
}
```

**Caddy** (adds the headers and HTTPS itself):

```caddy
calendar.example.com {
    reverse_proxy 192.168.1.10:8080
}
```

With a proxy in place, the phone feed becomes `https://calendar.example.com/calendar.ics?token=<FEED_TOKEN>` and
the optional voip.ms SMS URL Callback can point at the same host.

## Development

```bash
npm install
npm test
TZ=America/Toronto DATA_DIR=./data node src/server.js   # http://localhost:8080
```

## Backups

Every night (and on startup) the app copies its database to `appdata/calendar/backups/calendar-YYYY-MM-DD.db`
and keeps the newest 7. To restore one, stop the container, copy the backup over `calendar.db`, and start it again.
