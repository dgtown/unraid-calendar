# How the display sets itself up

This explains how the Cheap Yellow Display firmware (`src/main.cpp`) goes from a blank board to a
working calendar with nothing but a phone and a fingertip, and how it keeps its settings through power
cuts. The last section shows how to reuse the same pattern in another ESP32 project.

If you just want to set up a display, the steps are in [README.md](README.md). This page is about how
it works.

## The idea in one paragraph

On a brand-new board nothing is saved, so the display first asks you to tap five crosses (so it knows
how its touch panel is wired), then turns itself into a small Wi-Fi hotspot called **Calendar-Setup**.
You join that hotspot from your phone, a setup page pops up, and you fill in your home Wi-Fi and the
calendar address. The display saves all of it in its flash memory and restarts. From then on it starts
straight into the calendar, and setup only opens again if you **hold the screen for 5 seconds and let
go**.

## What happens at every start

```
power on
   |
   v
1. loadSettings()  ---- read flash (NVS "cal"). Fresh board: defaults, empty address
   |
   v
2. start screen + touch
   |
   +-- no touch calibration saved (or picture flipped since)?
   |       yes -> calibrateTouch(): tap 4 corners + 1 middle check -> saved
   v
3. calendar address saved?
   |       no  -> runPortal(): hotspot "Calendar-Setup" + setup page
   |                 phone fills it in -> Save -> settings written -> RESTART (back to the top)
   v       yes
4. WiFi.begin() with the network the ESP32 remembered, wait up to 15 s
   |       (connected or not, carry on)
   v
5. loop(): show the calendar, refetch every few minutes
           not connected? keepWifiUp() tries again every 30 s, forever
           screen held 5 s then released? -> runPortal() -> RESTART
```

Two rules make this calm to live with:

- **Setup opens by itself only when no calendar address is saved.** It does not care whether the Wi-Fi
  is there. After a power cut the display usually boots faster than the router; it shows
  "No Wi-Fi, retrying" and connects as soon as the router is back, instead of jumping into setup.
- **Setup always finishes with a restart.** Whether you saved, pressed Exit, or walked away (the portal
  gives up after 10 minutes), the board restarts and goes through the normal start with whatever is
  saved. There is only one way into "running", which keeps things predictable.

## Step by step

### First start: touch calibration (`calibrateTouch()`)

The cheap resistive touch panels on these boards vary: some are mirrored, rotated a quarter turn, or
read slightly at a slant. So before anything else the display shows five yellow crosses one after the
other, four near the corners and one in the middle.

- Each tap is read many times while your finger is down; the first and last few readings (finger
  landing and lifting) are thrown away and the middle value is kept (`waitPress()`).
- The four corners are used to work out a formula that turns raw touch numbers (0-4095) into screen
  pixels (`fitTouch()`, a least-squares fit, so a slanted panel is fine).
- The middle tap is a check: it has to land within 40 px of its cross. If it doesn't, you're asked
  again (up to four rounds). The raw numbers are shown on screen so a photo is enough to diagnose a
  problem.
- If nobody taps for 90 seconds it gives up for now and asks again on the next start.

This runs before the Wi-Fi setup because the setup page is on your phone, so the screen isn't needed
for anything else at that moment.

### First start: phone setup (`runPortal()`)

The firmware uses the [WiFiManager](https://github.com/tzapu/WiFiManager) library for this part.

1. The ESP32 switches its Wi-Fi to **hotspot mode** with the name `Calendar-Setup` and password
   `calendar`, and the screen shows those instructions (`showSetupScreen()`), plus a small line at the
   bottom saying why setup opened.
2. WiFiManager runs a tiny web server and a DNS server that answers every web address with
   `192.168.4.1` (the display itself). Your phone checks whether it has internet, gets the setup page
   instead, and pops it up as a "sign in to network" page, the same trick hotel Wi-Fi uses. If it
   doesn't pop up, browse to `http://192.168.4.1`.
3. **Configure WiFi** shows the usual list of nearby networks. Below it are the calendar's own fields
   (address, token, days, refresh, dimming, flip, invert, redo calibration), added with
   `WiFiManagerParameter`. Each field is pre-filled with what's saved, so reopening setup and pressing
   Save without changes keeps everything.
4. When you tap **Save**, WiFiManager tries to join your network and, if it works, the ESP32's Wi-Fi
   driver remembers that network and password by itself. Then our code reads the fields back, trims
   spaces, clamps numbers to sensible ranges, writes them to flash and restarts.

`setBreakAfterConfig(true)` matters: without it, a mistyped Wi-Fi password would make WiFiManager
throw away the calendar fields too. With it, the calendar settings are saved anyway. (You'll then see
"No Wi-Fi, retrying" and can hold the screen for 5 seconds to fix the password.)

### Later: reopening setup on purpose (`handleTouch()`)

| You do | It does |
| --- | --- |
| Tap or swipe (under 5 s) | Normal calendar controls |
| Hold 5 s | Footer says "Let go: setup" (and the display's IP address) |
| Let go between 5 and 15 s | Opens the setup portal |
| Keep holding past 15 s | Ignored: treated as a stuck or faulty reading |

Two extra safety nets stop setup opening by accident: touches are ignored for the first 5 seconds
after power-up (the touch chip can report phantom presses then), and a touch only counts when the
chip's pen-down line is actually active and the reading is in a sane range (`readRaw()`).

## Where settings are kept

Everything lives in the ESP32's **NVS** ("non-volatile storage"), a small key/value area in flash that
survives power cuts. The firmware writes to it through Arduino's `Preferences` library.

| What | Where | Written by |
| --- | --- | --- |
| Calendar address, token, days, refresh, dim hours/level, flip, invert | NVS namespace `cal`: `url`, `token`, `days`, `refresh`, `dimFrom`, `dimTo`, `dimLevel`, `flip`, `invert` | `saveSettings()` after Save in setup |
| List or month view | `cal` / `view` | `saveView()` when you tap the top bar |
| Touch calibration | `cal` / `t2Ok`, `t2Flip`, `t2ax` ... `t2cy` | `saveTouchCal()` after the five taps |
| Wi-Fi network and password | The ESP32 Wi-Fi driver's own NVS area | WiFiManager / the Wi-Fi driver when it joins |

Things worth knowing:

- **The firmware never stores the Wi-Fi password itself.** `WiFi.begin()` with no arguments reconnects
  to whatever the driver remembered, and `savedSsid()` reads the name back only to show it on screen.
- **Updates over Wi-Fi keep everything.** The update page only replaces the program, not NVS.
- **Flashing the factory `.bin` over USB at `0x0` wipes everything.** That file covers the start of
  flash, including the NVS area, so the board comes up as new: calibration and setup again. That is
  handy as a factory reset.
- **Missing keys are harmless.** Every read gives a default (`prefs.getInt("days", 7)`), so a new
  firmware version that adds a setting works on a board set up by an older one.

### The "Wi-Fi forgotten after a power cut" fix

Early versions handed start-up to WiFiManager's `autoConnect()`, which tries the saved network once
and, if that fails within its timeout, opens the setup hotspot. When the power came back, the display
booted before the router did, the single try failed, and the display sat in setup as if it had
forgotten the Wi-Fi. It hadn't: the network was still saved, it just never tried again.

The fix (PRs #15-#17) splits the two jobs:

- `autoConnect()` is gone. The portal is only ever opened with `startConfigPortal()`, on purpose: first
  start (no address saved) or the 5-second hold.
- Normal start-up calls `WiFi.begin()`, waits up to 15 s, and carries on either way. `keepWifiUp()`
  then retries every 30 s for as long as it takes, and the footer says "No Wi-Fi, retrying".
- Phantom touches at power-up could also fake a "hold to open setup", so touch is now ignored for the
  first seconds, must pass the pen-down and sanity checks, and setup needs hold-then-release.

## Reusing this in another project

The pattern is small enough to copy. You need:

- [WiFiManager](https://github.com/tzapu/WiFiManager) (`tzapu/WiFiManager@2.0.17` in `platformio.ini`)
- `Preferences` (built into the ESP32 Arduino core)
- For touch on a Cheap Yellow Display: the **CYDTouch** library exported from this firmware
  (`cyd-touch/CYDTouch.zip` in the project files). It contains the touch reader, the five-tap
  calibration screen, NVS save/load for the calibration, and a gesture helper that reports taps, swipes
  and the 5-second long press. Its `TouchDemo` example shows calibration on first start and "hold 5 s to
  recalibrate".

A minimal skeleton with the same behaviour:

```cpp
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <Preferences.h>

Preferences prefs;
String serverUrl;  // your own setting(s); empty = not set up yet

void loadSettings() {
  prefs.begin("myapp", true);              // read-only
  serverUrl = prefs.getString("url", "");  // default for a fresh board
  prefs.end();
}

void saveSettings() {
  prefs.begin("myapp", false);
  prefs.putString("url", serverUrl);
  prefs.end();
}

// Opens the hotspot + setup page, saves what was entered, then restarts. Never returns.
void runPortal() {
  WiFiManager wm;
  WiFiManagerParameter pUrl("url", "Server address", serverUrl.c_str(), 120);
  wm.addParameter(&pUrl);
  bool saved = false;
  wm.setSaveParamsCallback([&saved] { saved = true; });
  wm.setBreakAfterConfig(true);     // keep your fields even if the Wi-Fi password was wrong
  wm.setConfigPortalTimeout(600);   // give up after 10 minutes
  wm.startConfigPortal("MyThing-Setup", "password");  // blocks until Save / Exit / timeout
  if (saved) {
    serverUrl = pUrl.getValue();
    serverUrl.trim();
    saveSettings();
  }
  ESP.restart();
}

uint32_t lastWifiTry = 0;
void keepWifiUp() {  // call from loop()
  if (WiFi.status() == WL_CONNECTED || millis() - lastWifiTry < 30000) return;
  lastWifiTry = millis();
  WiFi.disconnect();
  WiFi.begin();  // the network the ESP32 remembered
}

void setup() {
  Serial.begin(115200);
  loadSettings();
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  if (serverUrl.isEmpty()) runPortal();  // first start only
  WiFi.begin();
  for (int i = 0; i < 150 && WiFi.status() != WL_CONNECTED; i++) delay(100);
  lastWifiTry = millis();
}

void loop() {
  keepWifiUp();
  // ... your app. Call runPortal() from a deliberate action, such as a 5 s press
  // (CYDGestures reports Gesture::LongPress for exactly that) or a button held at boot.
}
```

Tips when adapting it:

- **Decide "set up yet?" from your own setting, not from Wi-Fi.** A router that's down must never
  look like a blank board.
- **Restart after the portal.** It's simpler than tearing down the hotspot and continuing.
- **Pre-fill the fields with saved values** so reopening setup is safe.
- **NVS keys are at most 15 characters**, and a namespace is too. Always `end()` after `begin()`.
- **Checkboxes**: pass `type="checkbox"` as the custom HTML and `WFM_LABEL_AFTER`; a ticked box gives
  `"1"`, an unticked one gives `""` (see `pFlip` in `runPortal()`).
- **Show the hotspot name and password on the screen** (`setAPCallback`), so nobody needs the manual.
- **Port 80 is shared.** If your app runs its own web server (like this firmware's update page), stop it
  before opening the portal (`stopWeb()` here).
- **Factory reset** = erase flash, or flash a merged image at `0x0`, or add your own "forget
  everything" checkbox that calls `prefs.clear()` and `WiFi.disconnect(true, true)`.

## Where to look in the code

All in `src/main.cpp`:

| Function | Job |
| --- | --- |
| `setup()` | The start sequence, steps 1-4 above |
| `loadSettings()`, `saveSettings()`, `saveView()`, `saveTouchCal()` | NVS reads and writes |
| `calibrateTouch()`, `waitPress()`, `fitTouch()` | Five-tap touch calibration |
| `runPortal()`, `showSetupScreen()` | Phone setup via WiFiManager |
| `savedSsid()`, `keepWifiUp()` | Remembered network, endless retry |
| `handleTouch()` | Hold-5-seconds-and-let-go to reopen setup |
