// Calendar viewer for the ESP32-2432S028R "Cheap Yellow Display" (2.8" 320x240 touchscreen).
//
// Fetches /api/display?token=FEED_TOKEN from the calendar app every few minutes and shows either an
// agenda list or a month grid with a dot for each event. Touch:
//   - tap the top bar to switch between the list and the month
//   - list: tap the right/left half (or swipe) for the next/previous page
//   - month: swipe for the next/previous month, tap a day to see its events (top bar goes back)
// Hold the screen for 5 seconds, then let go, to open the setup portal.
//
// Start-up and setup flow (display/SETUP_FLOW.md has the long version with diagrams):
//   1. loadSettings()     read everything saved in flash (NVS namespace "cal"); fresh board = defaults
//   2. screen + touch     start the panel, then calibrateTouch() if no calibration is saved yet (or the
//                         picture was flipped since): tap 4 corners + 1 check in the middle
//   3. runPortal()        only if no calendar address is saved (first start). The display becomes a
//                         Wi-Fi hotspot "Calendar-Setup" (password "calendar") with a setup page; the
//                         phone fills in Wi-Fi + calendar settings, they're saved, and the board restarts
//   4. connect            WiFi.begin() with the network the ESP32 itself remembered, wait up to 15 s
//   5. loop()             show the calendar; keepWifiUp() retries every 30 s for as long as it takes.
//                         Holding the screen 5 s and letting go reopens the portal (step 3) on purpose.
// A Wi-Fi network that is slow to come back (power cut) never sends the display back into setup.

#include <algorithm>
#include <Arduino.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <WiFiManager.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Preferences.h>
#include <WebServer.h>
#include <Update.h>
#include <ESPmDNS.h>
#include <ArduinoJson.h>
#include <SPI.h>
#include <TFT_eSPI.h>
#include <vector>

// ---------------------------------------------------------------------------------------------
// Board pins (ESP32-2432S028R)
// ---------------------------------------------------------------------------------------------
static const int TOUCH_IRQ = 36, TOUCH_MOSI = 32, TOUCH_MISO = 39, TOUCH_CLK = 25, TOUCH_CS = 33;
static const int BACKLIGHT = 21, LED_R = 4, LED_G = 16, LED_B = 17;
static const int BL_CHANNEL = 0;

static const char *AP_NAME = "Calendar-Setup";
static const char *AP_PASS = "calendar";  // shown on screen during setup

// ---------------------------------------------------------------------------------------------
// Layout and colours
// ---------------------------------------------------------------------------------------------
static const int W = 320, H = 240;
static const int HEADER_H = 30, FOOTER_H = 18;
static const int BODY_Y = HEADER_H + 2, BODY_H = H - BODY_Y - FOOTER_H;
static const int DAY_H = 24, EVENT_H = 24, LINE2_H = 16;
static const int TIME_X = 8, TITLE_X = 86;

#define RGB(r, g, b) (uint16_t)((((r) & 0xF8) << 8) | (((g) & 0xFC) << 3) | ((b) >> 3))
static const uint16_t C_BG = RGB(16, 18, 26);
static const uint16_t C_ACCENT = RGB(250, 204, 40);  // cheap yellow
static const uint16_t C_HEADER_TEXT = RGB(20, 20, 20);
static const uint16_t C_TEXT = RGB(240, 240, 240);
static const uint16_t C_DIM = RGB(150, 155, 165);
static const uint16_t C_TIME = RGB(120, 190, 255);
static const uint16_t C_ALLDAY = RGB(120, 220, 150);
static const uint16_t C_LINE = RGB(55, 60, 75);
static const uint16_t C_NOW_BG = RGB(38, 52, 80);
static const uint16_t C_ERROR = RGB(255, 110, 100);

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------
TFT_eSPI tft;
SPIClass touchSpi(VSPI);
struct TS_Point {
  int16_t x = 0, y = 0, z = 0;
};
// Settings live in the ESP32's NVS flash (a small key/value store that survives power cuts and
// firmware updates over Wi-Fi). Everything of ours is in the namespace "cal"; the Wi-Fi network
// and password are NOT kept here, the ESP32's Wi-Fi driver stores those itself (see savedSsid()).
// Flashing the full "factory" .bin over USB at 0x0 wipes both.
Preferences prefs;

// What the setup page asks for. An empty url means "never set up" and makes setup() open the portal.
struct Settings {
  String url, token;
  int days = 7, refreshMin = 5;
  int dimFrom = 22, dimTo = 7, dimLevel = 10;  // hours (local), brightness percent
  bool flip = false, invert = false;
} cfg;

// Touch calibration: how raw touch-chip readings (0-4095) turn into screen pixels. Made by tapping
// five crosses on first start, because touch panels differ between boards (some are mirrored, turned
// or slanted). Saved with the settings; `ok` false means "ask for the taps on the next start".
struct TouchCal {
  bool ok = false, flip = false;  // flip: the screen rotation it was made for
  // screen x = ax * rawX + bx * rawY + cx, and the same for y. Covers panels that are mirrored,
  // turned, or read at a slant. The defaults fit the usual board.
  float ax = 319.0f / 3500, bx = 0, cx = -200 * 319.0f / 3500;
  float ay = 0, by = 239.0f / 3560, cy = -240 * 239.0f / 3560;
} tcal;

struct Event {
  String title, where, time, end;
  bool allDay = false;
  uint32_t start = 0, stop = 0;  // unix seconds
};
struct Day {
  String label, title, longTitle;
  std::vector<Event> events;
};

std::vector<Day> days;        // the agenda (today onwards)
std::vector<Day> dayDetail;   // one day picked from the month grid
bool haveData = false;

struct Month {
  bool valid = false;
  String title;
  int year = 0, month = 0, firstWeekday = 0, ndays = 0, today = 0;  // today: day number, 0 = not this month
  std::vector<uint8_t> counts;                                       // events per day
};
Month curMonth;    // this month, sent with every agenda fetch
Month otherMonth;  // a month browsed to with a swipe
int monthDelta = 0;  // months away from this one (0 = curMonth)
int detailY = 0, detailM = 0, detailD = 0;  // date shown in dayDetail

enum View : uint8_t { VIEW_AGENDA, VIEW_MONTH, VIEW_DAY };
View view = VIEW_AGENDA;

const Month &shownMonth() { return monthDelta == 0 ? curMonth : otherMonth; }
std::vector<Day> &listDays() { return view == VIEW_DAY ? dayDetail : days; }
uint32_t serverNow = 0, syncedAtMs = 0;  // server time at the last fetch, and millis() then
int32_t utcOffset = 0;                  // seconds east of UTC, from the server
String updatedText, statusText;
bool statusIsError = false;
uint32_t payloadHash = 0;

int page = 0, pageCount = 1;
uint32_t bodySig = 0;
uint32_t lastFetchMs = 0, nextFetchInMs = 0, lastTouchMs = 0, wakeUntilMs = 0;
long lastMinute = -1, lastLocalDay = -1;
int lastBrightness = -1;

// ---------------------------------------------------------------------------------------------
// Time (taken from the server, so no NTP or time-zone rules are needed on the device)
// ---------------------------------------------------------------------------------------------
uint32_t nowUtc() { return serverNow ? serverNow + (millis() - syncedAtMs) / 1000 : 0; }
long localSeconds() { return serverNow ? (long)nowUtc() + utcOffset : -1; }

String clockText() {
  long t = localSeconds();
  if (t < 0) return "";
  int h = (t % 86400) / 3600, m = (t % 3600) / 60;
  char buf[12];
  snprintf(buf, sizeof buf, "%d:%02d %s", h % 12 ? h % 12 : 12, m, h < 12 ? "AM" : "PM");
  return buf;
}

int localHour() {
  long t = localSeconds();
  return t < 0 ? 12 : (t % 86400) / 3600;
}

// ---------------------------------------------------------------------------------------------
// Settings
//
// Keys in NVS namespace "cal" (keys are at most 15 characters):
//   url, token, days, refresh, dimFrom, dimTo, dimLevel, flip, invert   - from the setup page
//   view                                                                 - list or month, last used
//   t2Ok, t2Flip, t2ax..t2cy                                             - touch calibration
// The second argument of get*() is the default used on a fresh board, so a missing key is harmless.
// begin(.., true) opens read-only; always end() so the next begin() works.
// ---------------------------------------------------------------------------------------------
void loadSettings() {
  prefs.begin("cal", true);
  cfg.url = prefs.getString("url", "");
  cfg.token = prefs.getString("token", "");
  cfg.days = prefs.getInt("days", 7);
  cfg.refreshMin = prefs.getInt("refresh", 5);
  cfg.dimFrom = prefs.getInt("dimFrom", 22);
  cfg.dimTo = prefs.getInt("dimTo", 7);
  cfg.dimLevel = prefs.getInt("dimLevel", 10);
  cfg.flip = prefs.getBool("flip", false);
  cfg.invert = prefs.getBool("invert", false);
  view = prefs.getUChar("view", VIEW_AGENDA) == VIEW_MONTH ? VIEW_MONTH : VIEW_AGENDA;
  tcal.ok = prefs.getBool("t2Ok", false);
  if (tcal.ok) {
    tcal.flip = prefs.getBool("t2Flip", false);
    tcal.ax = prefs.getFloat("t2ax", tcal.ax);
    tcal.bx = prefs.getFloat("t2bx", tcal.bx);
    tcal.cx = prefs.getFloat("t2cx", tcal.cx);
    tcal.ay = prefs.getFloat("t2ay", tcal.ay);
    tcal.by = prefs.getFloat("t2by", tcal.by);
    tcal.cy = prefs.getFloat("t2cy", tcal.cy);
  }
  prefs.end();
}

void saveView() {
  prefs.begin("cal", false);
  prefs.putUChar("view", view == VIEW_MONTH ? VIEW_MONTH : VIEW_AGENDA);
  prefs.end();
}

void saveSettings() {
  prefs.begin("cal", false);
  prefs.putString("url", cfg.url);
  prefs.putString("token", cfg.token);
  prefs.putInt("days", cfg.days);
  prefs.putInt("refresh", cfg.refreshMin);
  prefs.putInt("dimFrom", cfg.dimFrom);
  prefs.putInt("dimTo", cfg.dimTo);
  prefs.putInt("dimLevel", cfg.dimLevel);
  prefs.putBool("flip", cfg.flip);
  prefs.putBool("invert", cfg.invert);
  prefs.end();
}

void saveTouchCal() {
  prefs.begin("cal", false);
  prefs.putBool("t2Ok", tcal.ok);
  prefs.putBool("t2Flip", tcal.flip);
  prefs.putFloat("t2ax", tcal.ax);
  prefs.putFloat("t2bx", tcal.bx);
  prefs.putFloat("t2cx", tcal.cx);
  prefs.putFloat("t2ay", tcal.ay);
  prefs.putFloat("t2by", tcal.by);
  prefs.putFloat("t2cy", tcal.cy);
  prefs.end();
}

int clampInt(const char *s, int lo, int hi, int fallback) {
  if (!s || !*s) return fallback;
  int v = atoi(s);
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------------------------
String fit(String s, int maxW) {
  if (tft.textWidth(s) <= maxW) return s;
  while (s.length() && tft.textWidth(s + "...") > maxW) s.remove(s.length() - 1);
  s.trim();
  return s + "...";
}

void setBacklight(int percent) {
  int duty = percent <= 0 ? 0 : max(1, percent * 255 / 100);
  if (duty == lastBrightness) return;
  lastBrightness = duty;
  ledcWrite(BL_CHANNEL, duty);
}

bool isNight() {
  if (!serverNow || cfg.dimFrom == cfg.dimTo) return false;
  int h = localHour();
  return cfg.dimFrom < cfg.dimTo ? (h >= cfg.dimFrom && h < cfg.dimTo) : (h >= cfg.dimFrom || h < cfg.dimTo);
}

void updateBacklight() { setBacklight(isNight() && millis() > wakeUntilMs ? cfg.dimLevel : 100); }

// Full-screen message, used for setup instructions and start-up. Lines wrap at word boundaries;
// "1. ..." items get a hanging indent, and lines starting with ">" are highlighted and indented.
void drawMessage(const String &title, const std::vector<String> &lines, uint16_t titleColor = C_ACCENT) {
  tft.fillScreen(C_BG);
  tft.setTextDatum(TL_DATUM);
  tft.setFreeFont(&FreeSansBold12pt7b);
  tft.setTextColor(titleColor);
  tft.drawString(title, 12, 12);
  tft.setFreeFont(&FreeSans9pt7b);
  const int left = 12, lineH = 21;
  int y = 48;
  for (String text : lines) {
    int indent = 0, wrapIndent = 0;
    uint16_t color = C_TEXT;
    if (text.startsWith(">")) {
      text.remove(0, 1);
      indent = wrapIndent = 18;
      color = C_ACCENT;
    } else if (text.length() > 2 && isdigit(text[0]) && text[1] == '.') {
      wrapIndent = tft.textWidth(text.substring(0, 3));
    }
    tft.setTextColor(color);
    if (!text.length()) {
      y += lineH / 2;
      continue;
    }
    while (text.length() && y < H) {
      int maxW = W - left - indent - 8;
      int cut = text.length();
      if (tft.textWidth(text) > maxW) {  // break at the last space that fits
        cut = -1;
        for (int i = 0; i < (int)text.length(); i++)
          if (text[i] == ' ' && tft.textWidth(text.substring(0, i)) <= maxW) cut = i;
        if (cut <= 0) cut = text.length();  // one long word: let fit() shorten it
      }
      tft.drawString(fit(text.substring(0, cut), maxW), left + indent, y);
      text = text.substring(cut);
      text.trim();
      indent = wrapIndent;
      y += lineH;
    }
  }
}

// In the month and day views the top bar has an arrow at each end: tap them for the previous / next
// month or day (swiping does the same, but is fiddly on this kind of touch panel).
static const int ARROW_ZONE = 90;  // width of the tap area around each arrow
int headerNextX = W;               // taps at or right of this are "next"

void drawHeader() {
  tft.fillRect(0, 0, W, HEADER_H, C_ACCENT);
  tft.setFreeFont(&FreeSansBold9pt7b);
  tft.setTextColor(C_HEADER_TEXT);
  String clock = clockText();
  int clockW = clock.length() ? tft.textWidth(clock) + 16 : 0;
  bool arrows = view == VIEW_MONTH || view == VIEW_DAY;
  int left = arrows ? 30 : 8, avail = W - left - 8 - clockW - (arrows ? 26 : 0);
  String date = "Calendar";
  if (view == VIEW_MONTH && shownMonth().valid) date = shownMonth().title;
  else if (view == VIEW_DAY && !dayDetail.empty())
    date = tft.textWidth(dayDetail[0].longTitle) <= avail ? dayDetail[0].longTitle : dayDetail[0].title;
  else if (haveData && !days.empty()) date = days[0].longTitle;
  tft.setTextDatum(ML_DATUM);
  tft.drawString(fit(date, avail), left, HEADER_H / 2);
  headerNextX = W;
  if (arrows) {
    int my = HEADER_H / 2, rx = W - clockW - 12;  // rx: tip of the right arrow
    tft.fillTriangle(6, my, 22, my - 10, 22, my + 10, C_HEADER_TEXT);
    tft.fillTriangle(rx + 2, my, rx - 14, my - 10, rx - 14, my + 10, C_HEADER_TEXT);
    headerNextX = rx - 6 - ARROW_ZONE / 2;
  }
  if (clock.length()) {
    tft.setTextDatum(MR_DATUM);
    tft.drawString(clock, W - 8, HEADER_H / 2);
  }
}

void drawFooter() {
  int y = H - FOOTER_H;
  tft.fillRect(0, y, W, FOOTER_H, C_BG);
  tft.drawFastHLine(0, y, W, C_LINE);
  tft.setTextFont(2);
  tft.setTextDatum(ML_DATUM);
  String left = statusText.length() ? statusText : (updatedText.length() ? "Updated " + updatedText : String(""));
  String right;
  if (view == VIEW_MONTH) right = "arrows: month";
  else if (pageCount > 1) right = String(page + 1) + " / " + String(pageCount) + "  >";
  else if (view == VIEW_DAY) right = "arrows: day";
  else right = "top bar: month";
  int rightW = right.length() ? tft.textWidth(right) + 12 : 0;
  tft.setTextColor(statusIsError ? C_ERROR : C_DIM);
  tft.drawString(fit(left, W - 12 - rightW), 6, y + FOOTER_H / 2 + 1);
  if (right.length()) {
    tft.setTextColor(C_DIM);
    tft.setTextDatum(MR_DATUM);
    tft.drawString(right, W - 6, y + FOOTER_H / 2 + 1);
  }
}

void setStatus(const String &s, bool error) {
  statusText = s;
  statusIsError = error;
  drawFooter();
}

// ---------------------------------------------------------------------------------------------
// Agenda layout: a list of rows (day headings and events) split into screen-sized pages
// ---------------------------------------------------------------------------------------------
enum RowType : uint8_t { ROW_DAY, ROW_EVENT, ROW_EMPTY };
struct Row {
  RowType type;
  int16_t day, ev;
  int16_t h;
  bool now;
};

bool eventIsNow(const Event &e, uint32_t t) { return !e.allDay && t && e.start <= t && t < e.stop; }

String secondLine(const Event &e, bool now) {
  String s;
  if (now && e.end.length()) s = "until " + e.end;
  if (e.where.length()) s += (s.length() ? ", " : "") + e.where;
  return s;
}

std::vector<Row> buildRows(uint32_t &sig) {
  std::vector<Row> rows;
  uint32_t t = nowUtc();
  sig = 2166136261u;
  auto mix = [&](uint32_t v) { sig = (sig ^ v) * 16777619u; };
  std::vector<Day> &days = listDays();
  bool hidePast = view == VIEW_AGENDA;
  for (int d = 0; d < (int)days.size(); d++) {
    std::vector<Row> evRows;
    for (int i = 0; i < (int)days[d].events.size(); i++) {
      const Event &e = days[d].events[i];
      if (hidePast && d == 0 && t && e.stop <= t && !e.allDay) continue;  // already over today
      bool now = eventIsNow(e, t);
      int h = EVENT_H + (secondLine(e, now).length() ? LINE2_H : 0);
      evRows.push_back({ROW_EVENT, (int16_t)d, (int16_t)i, (int16_t)h, now});
      mix(d * 1000 + i);
      mix(now);
    }
    if (evRows.empty() && d != 0) continue;  // skip empty days, but always show today
    rows.push_back({ROW_DAY, (int16_t)d, -1, DAY_H, false});
    if (evRows.empty()) {
      rows.push_back({ROW_EMPTY, (int16_t)d, (int16_t)days[d].events.size(), EVENT_H, false});
      mix(0xE0 + days[d].events.size());
    }
    rows.insert(rows.end(), evRows.begin(), evRows.end());
  }
  return rows;
}

std::vector<int> paginate(const std::vector<Row> &rows) {
  std::vector<int> starts;
  size_t i = 0;
  while (i < rows.size()) {
    size_t first = i;
    starts.push_back(i);
    int y = rows[i].type == ROW_DAY ? 0 : DAY_H;  // continued pages repeat the day heading
    while (i < rows.size()) {
      int need = rows[i].h;
      // Don't leave a day heading alone at the bottom of a page.
      if (rows[i].type == ROW_DAY && i + 1 < rows.size()) need += rows[i + 1].h;
      if (y + need > BODY_H && i > first) break;
      y += rows[i].h;
      i++;
    }
  }
  if (starts.empty()) starts.push_back(0);
  return starts;
}

void drawDayRow(int d, int y, bool continued) {
  const Day &day = listDays()[d];
  tft.setTextDatum(ML_DATUM);
  tft.setFreeFont(&FreeSansBold9pt7b);
  tft.setTextColor(C_ACCENT);
  // "Today  Wed Nov 11", "Tomorrow  Thu Nov 12", but just "Fri Nov 13" for later days.
  bool named = !day.title.startsWith(day.label);
  int x = TIME_X;
  String first = named ? day.label : day.title;
  tft.drawString(first, x, y + DAY_H / 2);
  x += tft.textWidth(first) + 10;
  tft.setFreeFont(&FreeSans9pt7b);
  tft.setTextColor(C_DIM);
  String rest = String(named ? day.title : "") + (continued ? (named ? " (cont.)" : "(cont.)") : "");
  if (rest.length()) tft.drawString(fit(rest, W - x - 6), x, y + DAY_H / 2);
  tft.drawFastHLine(TIME_X, y + DAY_H - 2, W - 2 * TIME_X, C_LINE);
}

// Text too long for its row scrolls sideways like a ticker: it waits, then slides left and wraps around.
// Each line is drawn into a small off-screen sprite and copied over, so there is no flicker.
static const int MARQUEE_W = W - TITLE_X - 6;
static const int MARQUEE_GAP = 40;          // pixels between the end of the text and its repeat
static const int MARQUEE_PAUSE_MS = 2500;   // still time before each pass
static const int MARQUEE_SPEED = 40;        // pixels per second
struct Marquee {
  String text;
  int y, h, textW;  // top of the strip, its height, full text width
  bool small;       // font 2 (second line) instead of FreeSans 9pt (title)
  uint16_t color, bg;
  int lastOffset;
};
std::vector<Marquee> marquees;
uint32_t marqueeStartMs = 0;
TFT_eSprite strip(&tft);

void drawMarquee(Marquee &m, int offset) {
  if (!strip.created()) return;
  strip.fillSprite(m.bg);
  if (m.small) strip.setTextFont(2);
  else strip.setFreeFont(&FreeSans9pt7b);
  strip.setTextDatum(ML_DATUM);
  strip.setTextColor(m.color);
  strip.drawString(m.text, -offset, m.h / 2);
  if (offset > 0) strip.drawString(m.text, -offset + m.textW + MARQUEE_GAP, m.h / 2);
  // The sprite is as tall as the tallest strip; copy only this strip's rows.
  strip.pushSprite(TITLE_X, m.y, 0, 0, MARQUEE_W, m.h);
  m.lastOffset = offset;
}

void updateMarquees() {
  if (marquees.empty() || (isNight() && millis() > wakeUntilMs)) return;
  uint32_t t = millis() - marqueeStartMs;
  for (Marquee &m : marquees) {
    uint32_t travel = m.textW + MARQUEE_GAP;
    uint32_t cycle = MARQUEE_PAUSE_MS + travel * 1000 / MARQUEE_SPEED;
    uint32_t inCycle = t % cycle;
    int offset = inCycle < (uint32_t)MARQUEE_PAUSE_MS ? 0 : (inCycle - MARQUEE_PAUSE_MS) * MARQUEE_SPEED / 1000;
    if (offset >= (int)travel) offset = 0;
    if (offset != m.lastOffset) drawMarquee(m, offset);
  }
}

// Draws a line at TITLE_X; if it doesn't fit, registers it to scroll instead.
void drawTextLine(const String &text, int mid, bool small, uint16_t color, uint16_t bg) {
  if (small) tft.setTextFont(2);
  else tft.setFreeFont(&FreeSans9pt7b);
  int textW = tft.textWidth(text);
  if (textW <= MARQUEE_W || !strip.created()) {
    tft.setTextDatum(ML_DATUM);
    tft.setTextColor(color);
    tft.drawString(fit(text, MARQUEE_W), TITLE_X, mid);
    return;
  }
  int h = small ? 16 : 19;
  Marquee m{text, mid - h / 2, h, textW, small, color, bg, -1};
  drawMarquee(m, 0);
  marquees.push_back(m);
}

void drawEventRow(const Row &r, int y) {
  const Event &e = listDays()[r.day].events[r.ev];
  uint16_t bg = r.now ? C_NOW_BG : C_BG;
  if (r.now) {
    tft.fillRect(0, y + 1, W, r.h - 2, C_NOW_BG);
    tft.fillRect(0, y + 1, 4, r.h - 2, C_ACCENT);
  }
  int mid = y + EVENT_H / 2;
  tft.setTextDatum(ML_DATUM);
  tft.setFreeFont(&FreeSans9pt7b);
  tft.setTextColor(e.allDay ? C_ALLDAY : C_TIME);
  tft.drawString(fit(e.time, TITLE_X - TIME_X - 6), TIME_X, mid);
  drawTextLine(e.title, mid, false, C_TEXT, bg);
  String line2 = secondLine(e, r.now);
  if (line2.length()) drawTextLine(line2, mid + 17, true, C_DIM, bg);
}

// Month grid geometry: a row of weekday names, then 4-6 week rows.
static const int WEEKDAY_H = 18;
int monthRows(const Month &m) { return (m.firstWeekday + m.ndays + 6) / 7; }
int cellH(const Month &m) { return (BODY_H - WEEKDAY_H) / monthRows(m); }

// Day number under a touch, or 0.
int monthDayAt(int x, int y) {
  const Month &m = shownMonth();
  if (!m.valid || y < BODY_Y + WEEKDAY_H) return 0;
  int row = (y - BODY_Y - WEEKDAY_H) / cellH(m), col = x * 7 / W;
  int d = row * 7 + col - m.firstWeekday + 1;
  return d >= 1 && d <= m.ndays && row < monthRows(m) ? d : 0;
}

uint32_t monthSig() {
  const Month &m = shownMonth();
  uint32_t sig = 2166136261u;
  auto mix = [&](uint32_t v) { sig = (sig ^ v) * 16777619u; };
  mix(0x4D);
  mix(m.valid);
  mix(m.year * 13 + m.month);
  mix(m.today);
  for (uint8_t c : m.counts) mix(c);
  return sig;
}

void drawMonth() {
  tft.fillRect(0, BODY_Y, W, BODY_H, C_BG);
  const Month &m = shownMonth();
  if (!m.valid) {
    tft.setTextDatum(MC_DATUM);
    tft.setFreeFont(&FreeSans9pt7b);
    tft.setTextColor(C_DIM);
    tft.drawString(haveData && monthDelta == 0 ? "Update the calendar app for this view" : "Loading month...",
                   W / 2, BODY_Y + BODY_H / 2);
    return;
  }
  static const char *names[] = {"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"};
  tft.setTextFont(2);
  tft.setTextDatum(MC_DATUM);
  for (int c = 0; c < 7; c++) {
    tft.setTextColor(c == 0 || c == 6 ? C_ACCENT : C_DIM);
    tft.drawString(names[c], (2 * c + 1) * W / 14, BODY_Y + WEEKDAY_H / 2);
  }
  int rows = monthRows(m), ch = cellH(m), top = BODY_Y + WEEKDAY_H;
  for (int r = 0; r < rows; r++) tft.drawFastHLine(4, top + r * ch, W - 8, C_LINE);
  bool pastMonth = monthDelta < 0;
  for (int d = 1; d <= m.ndays; d++) {
    int idx = m.firstWeekday + d - 1, col = idx % 7, row = idx / 7;
    int cx = (2 * col + 1) * W / 14, y0 = top + row * ch;
    bool past = pastMonth || (m.today && d < m.today);
    bool isToday = d == m.today;
    if (isToday) tft.fillRoundRect(cx - 15, y0 + 2, 30, 18, 5, C_ACCENT);
    tft.setTextColor(isToday ? C_HEADER_TEXT : past ? C_DIM : C_TEXT);
    tft.drawString(String(d), cx, y0 + 11);
    int n = d <= (int)m.counts.size() ? min<int>(m.counts[d - 1], 3) : 0;
    for (int i = 0; i < n; i++)
      tft.fillCircle(cx - (n - 1) * 4 + i * 8, y0 + ch - 6, 2, past ? C_DIM : C_TIME);
  }
}

bool drawBody(bool force = true) {
  if (view == VIEW_MONTH) {
    uint32_t sig = monthSig();
    if (!force && sig == bodySig) return false;
    bodySig = sig;
    marquees.clear();
    pageCount = 1;
    drawMonth();
    return true;
  }
  uint32_t sig;
  std::vector<Row> rows = buildRows(sig);
  std::vector<Day> &days = listDays();
  std::vector<int> starts = paginate(rows);
  pageCount = starts.size();
  if (page >= pageCount) page = pageCount - 1;
  sig ^= page * 7919u;
  if (!force && sig == bodySig) return false;
  bodySig = sig;
  marquees.clear();
  marqueeStartMs = millis();

  tft.fillRect(0, BODY_Y, W, BODY_H, C_BG);
  if (!haveData) {
    tft.setTextDatum(MC_DATUM);
    tft.setFreeFont(&FreeSans9pt7b);
    tft.setTextColor(C_DIM);
    tft.drawString("Loading calendar...", W / 2, BODY_Y + BODY_H / 2);
    return true;
  }
  if (rows.empty()) return true;
  size_t from = starts[page], to = page + 1 < pageCount ? starts[page + 1] : rows.size();
  int y = BODY_Y;
  if (rows[from].type != ROW_DAY) {
    drawDayRow(rows[from].day, y, true);
    y += DAY_H;
  }
  for (size_t i = from; i < to; i++) {
    const Row &r = rows[i];
    if (r.type == ROW_DAY) {
      drawDayRow(r.day, y, false);
    } else if (r.type == ROW_EVENT) {
      drawEventRow(r, y);
    } else {
      tft.setTextDatum(ML_DATUM);
      tft.setFreeFont(&FreeSans9pt7b);
      tft.setTextColor(C_DIM);
      tft.drawString(r.ev > 0 ? "Nothing else today" : "Nothing scheduled", TITLE_X, y + EVENT_H / 2);
    }
    y += r.h;
  }
  if (view == VIEW_AGENDA && pageCount == 1 && rows.size() <= 2 && days.size() > 1) {
    tft.setTextDatum(MC_DATUM);
    tft.setTextFont(2);
    tft.setTextColor(C_DIM);
    tft.drawString("Nothing else in the next " + String(days.size()) + " days", W / 2, y + 30);
  }
  return true;
}

void drawAll() {
  drawHeader();
  drawBody(true);
  drawFooter();
}

// ---------------------------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------------------------
String urlEncode(const String &s) {
  String out;
  const char *hex = "0123456789ABCDEF";
  for (size_t i = 0; i < s.length(); i++) {
    uint8_t c = s[i];
    if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
      out += (char)c;
    } else {
      out += '%';
      out += hex[c >> 4];
      out += hex[c & 15];
    }
  }
  return out;
}

String baseUrl() {
  String b = cfg.url;
  b.trim();
  while (b.endsWith("/")) b.remove(b.length() - 1);
  if (!b.startsWith("http://") && !b.startsWith("https://")) b = "http://" + b;
  return b;
}

uint32_t fnv(const String &s) {
  uint32_t h = 2166136261u;
  for (size_t i = 0; i < s.length(); i++) h = (h ^ (uint8_t)s[i]) * 16777619u;
  return h;
}

// GETs a path from the calendar app and parses the JSON. Shows what went wrong in the footer.
bool getJson(const String &path, JsonDocument &doc, String *body = nullptr) {
  if (WiFi.status() != WL_CONNECTED) {
    setStatus("No Wi-Fi, retrying (hold 5 s + let go: setup)", true);
    return false;
  }
  String url = baseUrl() + path + (path.indexOf('?') >= 0 ? "&" : "?") + "token=" + urlEncode(cfg.token);
  WiFiClient plain;
  WiFiClientSecure secure;
  HTTPClient http;
  http.setTimeout(10000);
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  bool begun;
  if (url.startsWith("https://")) {
    secure.setInsecure();  // home server, usually with a self-signed or LAN certificate
    begun = http.begin(secure, url);
  } else {
    begun = http.begin(plain, url);
  }
  if (!begun) {
    setStatus("Bad calendar address - hold screen for setup", true);
    return false;
  }
  int code = http.GET();
  if (code != 200) {
    String msg;
    if (code == 403) msg = "Wrong token - check FEED_TOKEN";
    else if (code == 404) msg = "Not found - update the calendar app?";
    else if (code == 429) msg = "Too many wrong tokens, waiting";
    else if (code < 0) msg = "Can't reach calendar (" + http.errorToString(code) + ")";
    else msg = "Calendar error (HTTP " + String(code) + ")";
    http.end();
    setStatus(msg, true);
    return false;
  }
  String text = http.getString();
  http.end();
  DeserializationError err = deserializeJson(doc, text);
  if (err) {
    setStatus(String("Bad reply from calendar: ") + err.c_str(), true);
    return false;
  }
  if (body) *body = text;
  return true;
}

std::vector<Day> parseDays(JsonArray arr) {
  std::vector<Day> out;
  for (JsonObject jd : arr) {
    Day d;
    d.label = jd["label"] | "";
    d.title = jd["title"] | "";
    d.longTitle = jd["long"] | "";
    for (JsonObject je : jd["events"].as<JsonArray>()) {
      if (d.events.size() >= 40) break;
      Event e;
      e.title = je["title"] | "";
      e.where = je["where"] | "";
      e.time = je["time"] | "";
      e.end = je["end"] | "";
      e.allDay = je["allDay"] | false;
      e.start = je["start"] | 0;
      e.stop = je["stop"] | 0;
      d.events.push_back(e);
    }
    out.push_back(d);
  }
  return out;
}

Month parseMonth(JsonObject jm) {
  Month m;
  if (jm.isNull()) return m;
  m.title = jm["title"] | "";
  m.year = jm["year"] | 0;
  m.month = jm["month"] | 0;
  m.firstWeekday = jm["firstWeekday"] | 0;
  m.ndays = jm["days"] | 0;
  m.today = jm["today"] | 0;
  for (JsonVariant v : jm["counts"].as<JsonArray>()) {
    int c = v.as<int>();
    m.counts.push_back(c > 255 ? 255 : c < 0 ? 0 : c);
  }
  m.valid = m.year > 0 && m.month >= 1 && m.month <= 12 && m.ndays >= 28 && m.ndays <= 31;
  return m;
}

// Returns true when the calendar was fetched. Redraws whatever changed.
bool fetchCalendar() {
  JsonDocument doc;
  String body;
  if (!getJson("/api/display?days=" + String(cfg.days), doc, &body)) return false;
  std::vector<Day> fresh = parseDays(doc["days"].as<JsonArray>());
  curMonth = parseMonth(doc["month"].as<JsonObject>());
  serverNow = doc["now"] | 0;
  syncedAtMs = millis();
  utcOffset = doc["offset"] | 0;
  updatedText = doc["updated"] | "";
  statusText = "";
  statusIsError = false;

  // Only repaint when something changed ("now" and "updated" change on every fetch).
  doc.remove("now");
  doc.remove("updated");
  String stable;
  serializeJson(doc, stable);
  uint32_t h = fnv(stable);
  bool changed = !haveData || h != payloadHash;
  payloadHash = h;
  days.swap(fresh);
  haveData = true;
  if (changed && view != VIEW_DAY && !(view == VIEW_MONTH && monthDelta != 0)) drawAll();
  else {
    drawHeader();
    drawFooter();
  }
  return true;
}

// The month `monthDelta` months from this one, into otherMonth.
bool fetchOtherMonth() {
  if (!curMonth.valid) return false;
  int idx = curMonth.year * 12 + (curMonth.month - 1) + monthDelta;
  char ym[8];
  snprintf(ym, sizeof ym, "%04d-%02d", idx / 12, idx % 12 + 1);
  JsonDocument doc;
  setStatus("Loading...", false);
  if (!getJson(String("/api/display/month?ym=") + ym, doc)) return false;
  otherMonth = parseMonth(doc.as<JsonObject>());
  setStatus("", false);
  return otherMonth.valid;
}

int daysIn(int y, int m) {
  static const uint8_t n[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  return m == 2 && ((y % 4 == 0 && y % 100 != 0) || y % 400 == 0) ? 29 : n[m - 1];
}

// One day's events (from the month grid) into dayDetail.
bool fetchDay(int y, int m, int d) {
  if (d < 1) {
    if (--m < 1) m = 12, y--;
    d = daysIn(y, m);
  } else if (d > daysIn(y, m)) {
    if (++m > 12) m = 1, y++;
    d = 1;
  }
  char date[12];
  snprintf(date, sizeof date, "%04d-%02d-%02d", y, m, d);
  JsonDocument doc;
  setStatus("Loading...", false);
  if (!getJson(String("/api/display?days=1&start=") + date, doc)) return false;
  dayDetail = parseDays(doc["days"].as<JsonArray>());
  detailY = y, detailM = m, detailD = d;
  setStatus("", false);
  return !dayDetail.empty();
}

// ---------------------------------------------------------------------------------------------
// Setup portal (Wi-Fi + calendar settings), served by the display itself
// ---------------------------------------------------------------------------------------------
bool settingsSaved = false;
String setupReason;  // shown at the bottom of the setup screen

void showSetupScreen(WiFiManager *) {
  setBacklight(100);
  drawMessage("Setup", {
    "1. On your phone, join this Wi-Fi:",
    String(">") + AP_NAME,
    String(">password: ") + AP_PASS,
    "2. If no page opens, go to:",
    ">http://192.168.4.1",
    "3. Tap Configure WiFi, pick your network, enter the calendar address and token, then Save.",
  });
  tft.setTextFont(2);
  tft.setTextDatum(BL_DATUM);
  tft.setTextColor(C_DIM);
  tft.drawString("(" + setupReason + ")", 12, H - 4);
}

// Shows the setup portal, saves what was entered and restarts. Only opened on first start (nothing
// saved yet) or when someone holds the screen: a Wi-Fi that's slow to come back never opens it.
//
// How it works: WiFiManager turns the ESP32 into a Wi-Fi hotspot (AP_NAME / AP_PASS) and runs a small
// web server plus a DNS server that answers every name with 192.168.4.1. Phones notice that "the
// internet" is a login page and pop it up by themselves (a captive portal), like hotel Wi-Fi. The page
// has the standard network picker; the WiFiManagerParameter fields below are added to it. When the
// person taps Save, WiFiManager tries the network (it saves it in the ESP32's Wi-Fi memory itself),
// calls our save callback, and startConfigPortal() returns. We then copy the fields into cfg, check
// them, store them in NVS and restart, so the next start is a normal one with everything in place.
// If nobody saves within 10 minutes the portal gives up and the board restarts with what it had.
void stopWeb();

void runPortal(const char *why) {
  stopWeb();  // the setup page needs port 80
  setupReason = why;  // e.g. "first start..." - drawn small on the setup screen, handy for support
  Serial.printf("Opening setup: %s\n", why);
  WiFiManager wm;
  // Each field is (id, label, current value, max length[, extra HTML attributes, label position]).
  // The current values are filled in, so reopening setup shows what's saved and Save keeps it.
  // The plain text ones (hdr, hdr2) are just headings on the page.
  String days = String(cfg.days), refresh = String(cfg.refreshMin);
  String dimFrom = String(cfg.dimFrom), dimTo = String(cfg.dimTo), dimLevel = String(cfg.dimLevel);
  WiFiManagerParameter hdr("<hr><h3>Calendar</h3>");
  WiFiManagerParameter pUrl("url", "Calendar address, e.g. http://192.168.1.20:8080", cfg.url.c_str(), 120);
  WiFiManagerParameter pToken("token", "FEED_TOKEN from the calendar app's settings", cfg.token.c_str(), 100);
  WiFiManagerParameter pDays("days", "Days to show (1-14)", days.c_str(), 3);
  WiFiManagerParameter pRefresh("refresh", "Check for changes every N minutes", refresh.c_str(), 3);
  WiFiManagerParameter hdr2("<hr><h3>Screen</h3>");
  WiFiManagerParameter pDimFrom("dimfrom", "Dim at night from hour (0-23)", dimFrom.c_str(), 2);
  WiFiManagerParameter pDimTo("dimto", "until hour (same hour = never dim)", dimTo.c_str(), 2);
  WiFiManagerParameter pDimLevel("dimlevel", "Night brightness % (0 = off, touch to wake)", dimLevel.c_str(), 3);
  // Checkboxes: WiFiManager only knows text boxes, so type="checkbox" is passed as extra HTML. A ticked
  // box sends "1"; an unticked one sends nothing, so getValue() is then "" (not the default "1").
  WiFiManagerParameter pFlip("flip", "Turn the picture upside down", "1", 2,
                             cfg.flip ? "type=\"checkbox\" checked" : "type=\"checkbox\"", WFM_LABEL_AFTER);
  WiFiManagerParameter pInvert("invert", "Invert colours (if they look like a photo negative)", "1", 2,
                               cfg.invert ? "type=\"checkbox\" checked" : "type=\"checkbox\"", WFM_LABEL_AFTER);
  WiFiManagerParameter pRecal("recal", "Redo touch calibration (if taps land in the wrong place)", "1", 2,
                              "type=\"checkbox\"", WFM_LABEL_AFTER);
  for (WiFiManagerParameter *p : {&hdr, &pUrl, &pToken, &pDays, &pRefresh, &hdr2, &pDimFrom, &pDimTo, &pDimLevel,
                                  &pFlip, &pInvert, &pRecal})
    wm.addParameter(p);

  settingsSaved = false;
  wm.setTitle("Calendar display");
  std::vector<const char *> menu = {"wifi", "exit"};  // only "Configure WiFi" and "Exit" on the start page
  wm.setMenu(menu);
  wm.setSaveParamsCallback([] { settingsSaved = true; });  // just a flag; the values are read below
  wm.setBreakAfterConfig(true);  // return after Save even if the Wi-Fi password was wrong, so the
                                 // calendar settings are kept (otherwise the person types them again)
  wm.setAPCallback(showSetupScreen);  // the hotspot is up: put the instructions on the screen
  wm.setConnectTimeout(20);           // how long Save waits to join the chosen network
  wm.setConfigPortalTimeout(600);     // nobody finished within 10 minutes: give up and restart
  wm.startConfigPortal(AP_NAME, AP_PASS);  // blocks here until Save, Exit or the timeout
  if (settingsSaved) {
    // Read the fields back, tidy them up and clamp numbers to sane ranges before storing.
    cfg.url = pUrl.getValue();
    cfg.url.trim();
    cfg.token = pToken.getValue();
    cfg.token.trim();
    cfg.days = clampInt(pDays.getValue(), 1, 14, 7);
    cfg.refreshMin = clampInt(pRefresh.getValue(), 1, 120, 5);
    cfg.dimFrom = clampInt(pDimFrom.getValue(), 0, 23, 22);
    cfg.dimTo = clampInt(pDimTo.getValue(), 0, 23, 7);
    cfg.dimLevel = clampInt(pDimLevel.getValue(), 0, 100, 10);
    cfg.flip = strcmp(pFlip.getValue(), "1") == 0;
    cfg.invert = strcmp(pInvert.getValue(), "1") == 0;
    saveSettings();
    if (strcmp(pRecal.getValue(), "1") == 0) {  // forget the calibration: the taps are asked for on restart
      tcal.ok = false;
      saveTouchCal();
    }
  }
  // Always restart, saved or not: it's the simplest way back to a clean normal start (the portal
  // leaves the Wi-Fi radio in hotspot mode, and the new screen/touch settings apply from the top).
  drawMessage(settingsSaved ? "Saved" : "Restarting", {"Starting the calendar..."});
  delay(1200);
  ESP.restart();
}

// Saved Wi-Fi network name, or "" if none. The ESP32's Wi-Fi driver keeps the last network it joined
// (name + password) in its own NVS area, and WiFi.begin() with no arguments reconnects to it. That is
// why the firmware never stores the Wi-Fi password itself. Needs WiFi.mode() to have been called.
String savedSsid() {
  wifi_config_t conf;
  if (esp_wifi_get_config(WIFI_IF_STA, &conf) != ESP_OK) return "";
  return String(reinterpret_cast<const char *>(conf.sta.ssid));
}

// Keep trying the saved network in the background (routers can take minutes after a power cut).
// Called every loop(); does nothing while connected, otherwise a fresh attempt every 30 seconds.
// An earlier version let WiFiManager handle a failed connect at start-up, and it opened the setup
// hotspot instead, which looked like the display had "forgotten" the Wi-Fi after a power cut.
uint32_t lastWifiTryMs = 0;
void keepWifiUp() {
  if (WiFi.status() == WL_CONNECTED || millis() - lastWifiTryMs < 30000) return;
  lastWifiTryMs = millis();
  WiFi.disconnect();
  WiFi.begin();
}

// ---------------------------------------------------------------------------------------------
// Touch
// ---------------------------------------------------------------------------------------------
bool touchDown = false, longPressFired = false;
uint32_t touchStartMs = 0, touchSeenMs = 0;
int touchX = 0, touchY = 0, touchLastX = 0, touchLastY = 0;
// Readings of the touch in progress. The first and last couple are taken while the finger is still
// landing or lifting and can be far off, so taps and swipes are worked out from the ones in between.
static int16_t tsX[64], tsY[64], tlX[4], tlY[4];
int tsN = 0;

void touchSample(int x, int y) {
  if (tsN < 64) {
    tsX[tsN] = x;
    tsY[tsN] = y;
  }
  tlX[tsN % 4] = x;
  tlY[tsN % 4] = y;
  tsN++;
}

// Fills in where the touch started and ended (settled readings) and where a tap was (the median).
void touchResult(int &sx, int &sy, int &ex, int &ey, int &tx, int &ty) {
  int kept = min(tsN, 64);
  int si = min(2, kept - 1);
  sx = tsX[si];
  sy = tsY[si];
  int ei = tsN >= 4 ? (tsN - 3) % 4 : -1;
  ex = ei >= 0 ? tlX[ei] : tsX[kept - 1];
  ey = ei >= 0 ? tlY[ei] : tsY[kept - 1];
  if (kept >= 6) {
    std::sort(tsX + 2, tsX + kept - 2);
    std::sort(tsY + 2, tsY + kept - 2);
    tx = tsX[kept / 2];
    ty = tsY[kept / 2];
  } else {
    tx = tsX[kept / 2];
    ty = tsY[kept / 2];
  }
}

// A touch counts only if the controller's pen-down line (IRQ) is actually low and the reading is
// sane. Some boards read as "pressed" with garbage values after a cold power-up; this ignores that.
// One conversion frame: reads the result of the previous command and starts the next one.
static inline int16_t touchFrame(uint8_t next) { return touchSpi.transfer16(next) >> 3; }

static int16_t middleOf4(int16_t *v) {
  std::sort(v, v + 4);
  return (v[1] + v[2]) / 2;
}

// Reads the XPT2046 touch chip directly. Each axis is measured eight times in a row and only the
// last four count: on some boards the panel needs that long to settle after the chip switches
// axis, and reading X and Y alternately (as most libraries do) mixes the two together.
void touchMeasure(TS_Point &p) {
  static const int N = 8;
  int16_t xs[4], ys[4];
  touchSpi.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  digitalWrite(TOUCH_CS, LOW);
  touchSpi.transfer(0xB1);              // pressure, first half
  int z1 = touchFrame(0xC1);            // ... second half
  int z2 = touchFrame(0x91);            // start X
  for (int i = 0; i < N; i++) {
    int16_t v = touchFrame(i < N - 1 ? 0x91 : 0xD1);  // the last one starts Y
    if (i >= N - 4) xs[i - (N - 4)] = v;
  }
  for (int i = 0; i < N; i++) {
    int16_t v = touchFrame(i < N - 1 ? 0xD1 : 0xD0);  // the last one powers down, pen-down line back on
    if (i >= N - 4) ys[i - (N - 4)] = v;
  }
  touchFrame(0);
  digitalWrite(TOUCH_CS, HIGH);
  touchSpi.endTransaction();
  p.z = constrain(z1 + 4095 - z2, 0, 4095);
  p.x = middleOf4(xs);
  p.y = middleOf4(ys);
}

bool readRaw(TS_Point &p) {
  if (digitalRead(TOUCH_IRQ) != LOW) return false;
  touchMeasure(p);
  return !(p.z < 400 || p.x < 100 || p.x > 4000 || p.y < 100 || p.y > 4000);
}

bool readTouch(int &x, int &y) {
  TS_Point p;
  if (!readRaw(p)) return false;
  x = constrain((int)lroundf(tcal.ax * p.x + tcal.bx * p.y + tcal.cx), 0, W - 1);
  y = constrain((int)lroundf(tcal.ay * p.x + tcal.by * p.y + tcal.cy), 0, H - 1);
  return true;
}

// Best-fit plane v = a*rx + b*ry + c through n points (least squares). False if the points don't
// spread out in two directions.
bool fitPlane(const TS_Point *r, const int *v, int n, float &a, float &b, float &c) {
  double mx = 0, my = 0, mv = 0;
  for (int i = 0; i < n; i++) {
    mx += r[i].x;
    my += r[i].y;
    mv += v[i];
  }
  mx /= n;
  my /= n;
  mv /= n;
  double sxx = 0, sxy = 0, syy = 0, sxv = 0, syv = 0;
  for (int i = 0; i < n; i++) {
    double dx = r[i].x - mx, dy = r[i].y - my, dv = v[i] - mv;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
    sxv += dx * dv;
    syv += dy * dv;
  }
  double det = sxx * syy - sxy * sxy;
  if (det < 1e9) return false;
  a = (sxv * syy - syv * sxy) / det;
  b = (syv * sxx - sxv * sxy) / det;
  c = mv - a * mx - b * my;
  return true;
}

// Works the calibration out from n taps; returns how far off (pixels) the worst tap still is.
bool fitTouch(const TS_Point *r, const int *sx, const int *sy, int n, TouchCal &t, float &worst) {
  if (!fitPlane(r, sx, n, t.ax, t.bx, t.cx) || !fitPlane(r, sy, n, t.ay, t.by, t.cy)) return false;
  worst = 0;
  for (int i = 0; i < n; i++) {
    float ex = t.ax * r[i].x + t.bx * r[i].y + t.cx - sx[i], ey = t.ay * r[i].x + t.by * r[i].y + t.cy - sy[i];
    worst = max(worst, max(fabsf(ex), fabsf(ey)));
  }
  return fabsf(t.ax * t.by - t.bx * t.ay) > 0.0008f;  // the panel has to cover a sensible area
}

// Waits for a press and returns its raw position once the finger lifts: the median of the readings,
// without the first and last few (they are taken while the finger is still landing or leaving).
// 1 = got one, 0 = nobody touched, -1 = the readings jumped around too much to trust.
int waitPress(TS_Point &out, uint32_t timeoutMs) {
  static int16_t xs[64], ys[64];
  uint32_t start = millis();
  while (millis() - start < timeoutMs) {
    TS_Point p;
    if (!readRaw(p)) {
      delay(10);
      continue;
    }
    int n = 0;
    uint32_t seen = millis();
    while (millis() - seen < 120) {  // until it has been lifted for a moment
      if (readRaw(p)) {
        seen = millis();
        if (n < 64) {
          xs[n] = p.x;
          ys[n] = p.y;
          n++;
        }
      }
      delay(8);
    }
    if (n < 8) continue;  // too short to be a deliberate tap
    int from = 3, cnt = n - 6;
    std::sort(xs + from, xs + from + cnt);
    std::sort(ys + from, ys + from + cnt);
    out.x = xs[from + cnt / 2];
    out.y = ys[from + cnt / 2];
    int spread = max(xs[from + cnt * 3 / 4] - xs[from + cnt / 4], ys[from + cnt * 3 / 4] - ys[from + cnt / 4]);
    delay(250);
    return spread > 250 ? -1 : 1;
  }
  return 0;
}

void calNote(const String &s, uint16_t color = C_DIM) {  // small line at the bottom, handy in a photo
  tft.fillRect(0, H - 18, W, 18, C_BG);
  tft.setTextFont(2);
  tft.setTextDatum(BC_DATUM);
  tft.setTextColor(color);
  tft.drawString(s, W / 2, H - 2);
}

void drawTarget(int x, int y, const String &line, const String &note) {
  tft.fillScreen(C_BG);
  tft.setTextFont(4);
  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(C_ACCENT);
  tft.drawString("Touch setup", W / 2, H / 2 - 50);
  tft.setTextFont(2);
  tft.setTextColor(C_TEXT);
  tft.drawString(line, W / 2, H / 2 - 22);
  tft.drawString("Press firmly for a second, then let go.", W / 2, H / 2 + 34);
  tft.drawFastHLine(x - 14, y, 29, C_ACCENT);
  tft.drawFastVLine(x, y - 14, 29, C_ACCENT);
  tft.drawCircle(x, y, 7, C_ACCENT);
  calNote(note);
}

// Four corner taps and one in the middle. The first four give the mapping (any mirroring, turn or
// slant of the panel); the middle one has to land on its cross before anything is saved. The raw
// numbers are shown so a photo tells what went wrong.
void calibrateTouch() {
  static const int M = 30;
  const int tx[5] = {M, W - 1 - M, W - 1 - M, M, W / 2}, ty[5] = {M, M, H - 1 - M, H - 1 - M, H / 2 + 4};
  String note = "";
  for (int attempt = 0; attempt < 4; attempt++) {
    TS_Point r[5];
    String raw = "";
    for (int i = 0; i < 5;) {
      drawTarget(tx[i], ty[i], i < 4 ? "Tap the yellow cross (" + String(i + 1) + " of 5)"
                                     : String("Last one: tap the cross in the middle"), note);
      int got = waitPress(r[i], 90000);
      if (got == 0) return;  // nobody there: carry on with what we had, ask again next start
      if (got < 0) {
        note = "Unsteady reading, try that one again";
        continue;
      }
      raw += String(i ? " " : "") + String(r[i].x) + "," + String(r[i].y);
      note = i < 4 ? raw : String("");
      i++;
    }
    Serial.println("Touch raw: " + raw);
    TouchCal t;
    float worst = 0;
    bool ok = fitTouch(r, tx, ty, 4, t, worst) && worst < 25;
    float px = 0, py = 0;
    if (ok) {
      px = t.ax * r[4].x + t.bx * r[4].y + t.cx;
      py = t.ay * r[4].x + t.by * r[4].y + t.cy;
      ok = fabsf(px - tx[4]) <= 40 && fabsf(py - ty[4]) <= 40;
    }
    if (ok && fitTouch(r, tx, ty, 5, t, worst)) {  // use all five for the final numbers
      t.flip = cfg.flip;
      t.ok = true;
      tcal = t;
      saveTouchCal();
      Serial.printf("Touch calibrated: x = %.5f %.5f %.1f, y = %.5f %.5f %.1f\n", t.ax, t.bx, t.cx, t.ay, t.by, t.cy);
      drawMessage("Touch setup", {"Done. Taps now land where you touch.",
                                  "To redo it, hold the screen 5 s, let go, and tick the box in setup."});
      delay(2500);
      return;
    }
    String corners = raw.substring(0, raw.lastIndexOf(' '));
    drawMessage("Touch setup", {"Those taps didn't line up with the crosses.",
                                attempt < 3 ? "Let's try again." : "Carrying on without it for now.",
                                "(corners " + String((int)worst) + " px, middle " + String(r[4].x) + "," +
                                    String(r[4].y) + " seen at " + String((int)px) + "," + String((int)py) + ")"},
                C_ERROR);
    calNote(corners, C_TEXT);
    delay(attempt < 3 ? 6000 : 15000);  // long enough to read (or photograph) the numbers
    note = "";
  }
}

void switchView(View v) {
  view = v;
  page = 0;
  if (v != VIEW_DAY) saveView();
  drawAll();
}

// Returns true if the touch only woke the screen.
bool wakeTouch() {
  if (isNight() && millis() > wakeUntilMs) {  // first touch at night just lights the screen
    wakeUntilMs = millis() + 30000;
    updateBacklight();
    return true;
  }
  if (isNight()) wakeUntilMs = millis() + 30000;
  return false;
}

void turnPage(int dir) {
  if (pageCount <= 1) return;
  page = (page + dir + pageCount) % pageCount;
  drawBody(true);
  drawFooter();
}

void onSwipe(int dir);

void onTap(int x, int y) {
  if (wakeTouch()) return;
  // The month view's row of weekday names does nothing itself, so it counts as top bar: a bigger target.
  // In a day the bar's tap area also reaches a little below it.
  int barH = view == VIEW_MONTH ? BODY_Y + WEEKDAY_H : view == VIEW_DAY ? HEADER_H + 16 : HEADER_H;
  if (y < barH && (view == VIEW_MONTH || view == VIEW_DAY) && (x < ARROW_ZONE || x >= headerNextX)) {
    onSwipe(x < ARROW_ZONE ? -1 : 1);  // arrows: previous / next month or day
    return;
  }
  if (y < barH) {  // top bar: list <-> month; from a day, back to its month
    if (view == VIEW_AGENDA) monthDelta = 0;
    switchView(view == VIEW_MONTH ? VIEW_AGENDA : VIEW_MONTH);
    return;
  }
  if (view == VIEW_MONTH) {
    int d = monthDayAt(x, y);
    const Month &m = shownMonth();
    if (d && fetchDay(m.year, m.month, d)) switchView(VIEW_DAY);
    return;
  }
  turnPage(x >= W / 2 ? 1 : -1);
}

// dir: +1 = swiped left (next), -1 = swiped right (previous).
void onSwipe(int dir) {
  if (wakeTouch()) return;
  lastTouchMs = millis();
  if (view == VIEW_MONTH) {
    monthDelta += dir;
    if (monthDelta != 0 && !fetchOtherMonth()) monthDelta -= dir;
    page = 0;
    drawAll();
  } else if (view == VIEW_DAY) {
    if (fetchDay(detailY, detailM, detailD + dir)) {
      page = 0;
      drawAll();
    }
  } else {
    turnPage(dir);
  }
}

// Setup opens when the screen is held for 5 seconds and then let go. A reading that never lets go
// (a stuck or faulty touch panel) can't open it.
//   held < 5 s           -> tap or swipe when released
//   held 5-15 s, release -> setup portal ("Let go: setup" shows in the footer at 5 s)
//   held > 15 s          -> treated as a stuck reading and ignored, so a faulty panel can't trap the
//                           display in setup
void handleTouch() {
  int x, y;
  uint32_t ms = millis();
  if (ms < 5000) return;  // let the touch controller settle after power-up (it can report phantom presses)
  if (readTouch(x, y)) {
    touchSeenMs = ms;
    if (!touchDown) {
      touchDown = true;
      longPressFired = false;
      touchStartMs = ms;
      tsN = 0;
      touchSample(x, y);
      return;
    }
    touchSample(x, y);
    uint32_t held = ms - touchStartMs;
    if (!longPressFired && held > 5000) {
      longPressFired = true;
      setStatus(WiFi.status() == WL_CONNECTED ? String("Let go: setup. ") + WiFi.localIP().toString()
                                               : String("Let go to open setup"), false);
    } else if (longPressFired && held > 15000) {
      setStatus("", false);  // held far too long: treat as a stuck reading, not a request
    }
  } else if (touchDown && ms - touchSeenMs > 120) {  // released (a short gap mid-swipe doesn't count)
    touchDown = false;
    lastTouchMs = ms;
    uint32_t held = touchSeenMs - touchStartMs;
    if (longPressFired) {
      if (held <= 15000) runPortal("screen held for 5 seconds");  // restarts when done
      return;
    }
    int tapX, tapY;
    touchResult(touchX, touchY, touchLastX, touchLastY, tapX, tapY);
    int dx = touchLastX - touchX, dy = touchLastY - touchY;
    if (abs(dx) > 35 && abs(dx) * 2 > 3 * abs(dy)) onSwipe(dx < 0 ? 1 : -1);
    else onTap(tapX, tapY);
  }
}

// ---------------------------------------------------------------------------------------------
// Updates over Wi-Fi: http://<display>/update takes a new firmware file and keeps all settings.
// Signing in uses the name "calendar" and the FEED_TOKEN as the password.
// ---------------------------------------------------------------------------------------------
WebServer web(80);
bool webStarted = false, otaAllowed = false, otaDone = false;
String otaError;
uint32_t otaShownKb = 0;
static const char *FW_BUILD = __DATE__ " " __TIME__;
static const char *WEB_USER = "calendar";
static const char *MDNS_NAME = "calendar-display";

String webPage(const String &body) {
  return "<!doctype html><html><head><meta name=viewport content='width=device-width,initial-scale=1'>"
         "<title>Calendar display</title><style>body{font-family:sans-serif;max-width:32em;margin:2em auto;"
         "padding:0 1em;line-height:1.5}input,button{font-size:1em;margin:.5em 0}</style></head><body>"
         "<h2>Calendar display</h2>" + body + "<p><small>Firmware built " + FW_BUILD + "</small></p></body></html>";
}

bool webSignedIn() { return cfg.token.length() && web.authenticate(WEB_USER, cfg.token.c_str()); }

bool webAuth() {
  if (webSignedIn()) return true;
  web.requestAuthentication(BASIC_AUTH, "Calendar display",
                            "Sign in with the name \"calendar\" and your FEED_TOKEN as the password.");
  return false;
}

// Called repeatedly while the file arrives.
void otaUpload() {
  HTTPUpload &up = web.upload();
  if (up.status == UPLOAD_FILE_START) {
    otaError = "";
    otaDone = false;
    otaShownKb = 0;
    otaAllowed = webSignedIn();
    if (!otaAllowed) return;
    Serial.printf("Update: receiving %s\n", up.filename.c_str());
    setBacklight(100);
    drawMessage("Updating", {"Receiving new firmware over Wi-Fi.", "Don't unplug the display."});
    if (!Update.begin(UPDATE_SIZE_UNKNOWN)) otaError = Update.errorString();
  } else if (up.status == UPLOAD_FILE_WRITE) {
    if (!otaAllowed || otaError.length()) return;
    if (Update.write(up.buf, up.currentSize) != up.currentSize) otaError = Update.errorString();
    uint32_t kb = up.totalSize / 1024;
    if (kb >= otaShownKb + 64) {
      otaShownKb = kb;
      calNote(String(kb) + " kB received", C_TEXT);
    }
  } else if (up.status == UPLOAD_FILE_END) {
    if (!otaAllowed || otaError.length()) return;
    if (Update.end(true)) otaDone = true;
    else otaError = Update.errorString();
  } else if (up.status == UPLOAD_FILE_ABORTED && otaAllowed) {  // connection dropped: back to the calendar
    otaAllowed = false;
    Update.abort();
    tft.fillScreen(C_BG);
    drawAll();
    setStatus("Update interrupted, nothing changed", true);
  }
}

// Called once the whole upload has arrived.
void otaFinish() {
  if (!otaAllowed) {
    webAuth();
    return;
  }
  otaAllowed = false;
  if (otaError.length() || !otaDone) {
    if (otaError.isEmpty()) otaError = "No firmware file was received";
    Update.abort();
    Serial.println("Update failed: " + otaError);
    web.send(400, "text/html", webPage("<p><b>Update failed:</b> " + otaError + ".</p><p>Nothing was changed. Make sure you "
                                       "picked the file ending in <code>-update.bin</code> for your board, not the "
                                       "USB install file.</p><p><a href='/update'>Try again</a></p>"));
    tft.fillScreen(C_BG);
    drawAll();
    setStatus("Update failed, nothing changed", true);
    return;
  }
  web.send(200, "text/html", webPage("<p><b>Update installed.</b> The display is restarting with its settings kept.</p>"));
  drawMessage("Updated", {"Restarting..."});
  delay(1500);
  ESP.restart();
}

void startWeb() {
  web.on("/", HTTP_GET, [] { web.send(200, "text/html", webPage("<p><a href='/update'>Update the firmware</a></p>")); });
  web.on("/update", HTTP_GET, [] {
    if (!webAuth()) return;
    web.send(200, "text/html",
             webPage("<p>Pick the file ending in <code>-update.bin</code> from the GitHub build and press Update. "
                     "Wi-Fi, calendar and touch settings are kept.</p>"
                     "<form method=post action='/update' enctype='multipart/form-data'>"
                     "<input type=file name=firmware accept='.bin' required><br><button>Update</button></form>"
                     "<p>It takes about half a minute. Don't unplug the display meanwhile.</p>"));
  });
  web.on("/update", HTTP_POST, otaFinish, otaUpload);
  web.begin();
  if (MDNS.begin(MDNS_NAME)) MDNS.addService("http", "tcp", 80);
  webStarted = true;
  Serial.println("Update page: http://" + WiFi.localIP().toString() + "/update");
}

void stopWeb() {
  if (!webStarted) return;
  web.stop();
  MDNS.end();
  webStarted = false;
}

// ---------------------------------------------------------------------------------------------
// Arduino entry points
// ---------------------------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  for (int pin : {LED_R, LED_G, LED_B}) {  // the RGB LED is active-low: switch it off
    pinMode(pin, OUTPUT);
    digitalWrite(pin, HIGH);
  }
  loadSettings();  // 1. everything saved in flash (defaults on a fresh board)

  // 2. Screen, then touch. Rotation and colour inversion come from the saved settings.
  tft.init();
  tft.setRotation(cfg.flip ? 3 : 1);
  tft.invertDisplay(cfg.invert);
  strip.setColorDepth(16);
  strip.createSprite(MARQUEE_W, 19);  // ~9 KB; if it fails, long text is just cut off with "..."
  ledcSetup(BL_CHANNEL, 5000, 8);
  ledcAttachPin(BACKLIGHT, BL_CHANNEL);
  setBacklight(100);

  touchSpi.begin(TOUCH_CLK, TOUCH_MISO, TOUCH_MOSI, TOUCH_CS);
  pinMode(TOUCH_CS, OUTPUT);
  digitalWrite(TOUCH_CS, HIGH);
  pinMode(TOUCH_IRQ, INPUT);
  TS_Point warmUp;
  touchMeasure(warmUp);  // leaves the chip powered down with its pen-down line enabled
  // Touch calibration runs before the Wi-Fi portal on a first start: nothing else needs touch yet,
  // and the setup page is on the phone. Flipping the picture in setup also makes it run again.
  if (!tcal.ok || tcal.flip != cfg.flip) {
    delay(300);  // let the touch controller settle after power-up
    calibrateTouch();  // saves on success; if skipped (no taps for 90 s) it asks again next start
  }

  // 3. Wi-Fi. WIFI_STA = join a network as a normal device (not a hotspot). Auto-reconnect lets the
  // driver rejoin by itself after a short drop; keepWifiUp() covers the long ones.
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  String ssid = savedSsid();
  Serial.printf("Calendar: url=%s, saved Wi-Fi=%s\n", cfg.url.c_str(), ssid.c_str());
  // Setup opens by itself only on first start. Later, hold the screen 5 seconds and let go.
  // It deliberately checks the calendar address, not whether Wi-Fi is saved or connects: a missing
  // router after a power cut must never look like "not set up".
  if (cfg.url.isEmpty()) runPortal("first start: no calendar address saved yet");  // restarts when done

  // 4. Join the saved network. Give it 15 s here so the first fetch usually works; if not, the
  // display starts anyway and keeps retrying in loop().
  drawMessage("Calendar", {"Connecting to Wi-Fi", String(">") + (ssid.length() ? ssid : String("(saved network)"))});
  WiFi.begin();
  lastWifiTryMs = millis();
  for (int i = 0; i < 150 && WiFi.status() != WL_CONNECTED; i++) {  // up to 15 s, then carry on
    delay(100);
  }

  if (WiFi.status() == WL_CONNECTED) {  // say where the update page is
    drawMessage("Calendar", {"Connected. To update later, browse to:",
                             ">http://" + WiFi.localIP().toString() + "/update"});
    delay(2500);
  }

  tft.fillScreen(C_BG);
  drawAll();
  fetchCalendar();
  lastFetchMs = millis();
  nextFetchInMs = (statusIsError ? 1 : cfg.refreshMin) * 60000UL;
}

// 5. Normal running. Nothing here blocks for long, so touches stay responsive.
void loop() {
  handleTouch();  // may open the setup portal (5 s hold), which restarts the board
  if (webStarted) web.handleClient();
  else if (WiFi.status() == WL_CONNECTED) startWeb();  // update page, once there's a network
  keepWifiUp();
  uint32_t ms = millis();

  if (ms - lastFetchMs >= nextFetchInMs) {
    bool ok = fetchCalendar();
    lastFetchMs = millis();
    nextFetchInMs = (ok ? cfg.refreshMin : 1) * 60000UL;
  }

  long t = localSeconds();
  if (t >= 0 && t / 60 != lastMinute) {
    lastMinute = t / 60;
    drawHeader();
    if (drawBody(false)) drawFooter();  // repaints only if an event started or ended
    if (lastLocalDay >= 0 && t / 86400 != lastLocalDay) nextFetchInMs = 0;  // new day: refetch now
    lastLocalDay = t / 86400;
  }

  // After a minute and a half without touches, go back to the first page / this month.
  if ((page != 0 || monthDelta != 0 || view == VIEW_DAY) && !touchDown && ms - lastTouchMs > 90000) {
    page = 0;
    monthDelta = 0;
    if (view == VIEW_DAY) view = VIEW_MONTH;
    drawAll();
  }
  updateMarquees();
  updateBacklight();
  delay(10);
}
