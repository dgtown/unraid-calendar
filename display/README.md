# Calendar on a Cheap Yellow Display

Firmware for the ESP32-2432S028R "Cheap Yellow Display" (2.8" 320x240 touchscreen) that shows the
next few days of your calendar, refreshing every few minutes over Wi-Fi.

- Agenda for today and the coming days (7 by default), with the event that's on now highlighted
- Month view with a dot for each event (up to three per day); tap a day to see its events
- Clock in the top bar, using the calendar server's time zone
- Tap the top bar to switch between the list and the month (it remembers your choice)
- List: tap the right half (or swipe left) for the next page, the left half for the previous page
- Month: tap the arrows at either end of the top bar (or swipe left/right) for the next/previous
  month; in a day, the arrows (or a swipe) go to the next/previous day and the middle of the top bar
  goes back to the month
- Dims at night (10pm-7am by default); a tap lights it up for 30 seconds
- Everything is set up from your phone, no code changes needed

## 1. Turn on the display feed in the calendar app

The display reads `/api/display?token=...`, which uses the same `FEED_TOKEN` as the phone feed.
If you already subscribed your phone to `calendar.ics?token=...`, you're done. Otherwise set
`FEED_TOKEN` to a long random string in the Unraid template and apply.

Check it in a browser: `http://<unraid-ip>:8080/api/display?token=<FEED_TOKEN>` should show JSON.

## 2. Flash the firmware (no tools to install)

1. On GitHub, open **Actions → Build display firmware**, pick the latest green run, and download
   the artifact: `calendar-display-cyd` for the usual board with one micro-USB port, or
   `calendar-display-cyd2usb` for the newer board with both micro-USB and USB-C. Unzip it.
2. Plug the display into your computer with a USB data cable.
3. In Chrome or Edge, open <https://espressif.github.io/esptool-js/>, click **Connect** and pick the
   serial port (it's a CH340; Windows and older macOS may need the CH340 driver).
4. Set **Flash Address** to `0x0`, choose the `.bin` file, click **Program** and wait for it to
   finish. Press the board's RST button (or unplug and replug).

With PlatformIO instead: `cd display && pio run -e cyd -t upload`.

## 3. Set it up from your phone

On first start the screen shows setup instructions:

1. Join the Wi-Fi **Calendar-Setup** (password `calendar`).
2. A setup page opens (or browse to `http://192.168.4.1`). Tap **Configure WiFi**.
3. Pick your home Wi-Fi and enter its password, then fill in:
   - **Calendar address**: `http://<unraid-ip>:8080` (add the `BASE_PATH` if you use one, or use your
     `https://` reverse-proxy address)
   - **FEED_TOKEN**
4. Tap **Save**. The display restarts and shows your calendar.

The setup screen shows why it opened at the bottom. To change settings later, hold your finger on the
screen until the bottom line says "Let go to open setup" (about 5 seconds), then let go. Once it's set up it
never opens setup by itself: if your Wi-Fi isn't back yet after a power cut, it shows "No Wi-Fi, retrying"
and keeps trying every 30 seconds.

## Troubleshooting

| Bottom line says | Fix |
| --- | --- |
| Wrong token | The token doesn't match `FEED_TOKEN` in the app. |
| Not found | Update the calendar container (Force Update) so it has `/api/display`, or check `BASE_PATH`. |
| Can't reach calendar | Check the address. Use the server's LAN IP, not `localhost`. |
| Too many wrong tokens | The app locks out an address after repeated bad tokens; wait 15 minutes. |

- **Colours look like a negative**: open setup and tick *Invert colours*.
- **Upside down**: tick *Turn the picture upside down*.
- **White or garbled screen**: you probably have the other board version; flash the other `.bin`.
- **Taps land in the wrong place**: on first start the display asks you to tap five crosses so it
  learns how its touch panel is wired (press each firmly for a second). The small numbers at the
  bottom are the raw readings, useful when reporting a problem. To do it again, hold the screen 5 s, let go, tick
  "Redo touch calibration" in setup and Save.
