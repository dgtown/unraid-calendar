// Calendar viewer for the ESP32-2432S028R "Cheap Yellow Display" (2.8" 320x240 touchscreen).
//
// Fetches /api/display?token=FEED_TOKEN from the calendar app every few minutes and shows an agenda.
// Touch: tap the right half for the next page, the left half for the previous one, the top bar to
// refresh now. Hold the screen for 5 seconds (or while it boots) to open the setup portal.

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <SPI.h>
#include <TFT_eSPI.h>
#include <XPT2046_Touchscreen.h>
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
XPT2046_Touchscreen ts(TOUCH_CS, TOUCH_IRQ);
Preferences prefs;

struct Settings {
  String url, token;
  int days = 7, refreshMin = 5;
  int dimFrom = 22, dimTo = 7, dimLevel = 10;  // hours (local), brightness percent
  bool flip = false, invert = false;
} cfg;

struct Event {
  String title, where, time, end;
  bool allDay = false;
  uint32_t start = 0, stop = 0;  // unix seconds
};
struct Day {
  String label, title, longTitle;
  std::vector<Event> events;
};

std::vector<Day> days;
bool haveData = false;
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

void drawHeader() {
  tft.fillRect(0, 0, W, HEADER_H, C_ACCENT);
  tft.setFreeFont(&FreeSansBold9pt7b);
  tft.setTextColor(C_HEADER_TEXT);
  String clock = clockText();
  int clockW = clock.length() ? tft.textWidth(clock) + 16 : 0;
  String date = haveData && !days.empty() ? days[0].longTitle : String("Calendar");
  tft.setTextDatum(ML_DATUM);
  tft.drawString(fit(date, W - 16 - clockW), 8, HEADER_H / 2);
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
  String right = pageCount > 1 ? String(page + 1) + " / " + String(pageCount) + "  >" : String("");
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
  for (int d = 0; d < (int)days.size(); d++) {
    std::vector<Row> evRows;
    for (int i = 0; i < (int)days[d].events.size(); i++) {
      const Event &e = days[d].events[i];
      if (d == 0 && t && e.stop <= t && !e.allDay) continue;  // already over today
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
  const Day &day = days[d];
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

void drawEventRow(const Row &r, int y) {
  const Event &e = days[r.day].events[r.ev];
  if (r.now) {
    tft.fillRect(0, y + 1, W, r.h - 2, C_NOW_BG);
    tft.fillRect(0, y + 1, 4, r.h - 2, C_ACCENT);
  }
  int mid = y + EVENT_H / 2;
  tft.setTextDatum(ML_DATUM);
  tft.setFreeFont(&FreeSans9pt7b);
  tft.setTextColor(e.allDay ? C_ALLDAY : C_TIME);
  tft.drawString(fit(e.time, TITLE_X - TIME_X - 6), TIME_X, mid);
  tft.setTextColor(C_TEXT);
  tft.drawString(fit(e.title, W - TITLE_X - 6), TITLE_X, mid);
  String line2 = secondLine(e, r.now);
  if (line2.length()) {
    tft.setTextFont(2);
    tft.setTextColor(C_DIM);
    tft.drawString(fit(line2, W - TITLE_X - 6), TITLE_X, mid + 17);
  }
}

bool drawBody(bool force = true) {
  uint32_t sig;
  std::vector<Row> rows = buildRows(sig);
  std::vector<int> starts = paginate(rows);
  pageCount = starts.size();
  if (page >= pageCount) page = pageCount - 1;
  sig ^= page * 7919u;
  if (!force && sig == bodySig) return false;
  bodySig = sig;

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
  if (pageCount == 1 && rows.size() <= 2 && days.size() > 1) {
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

// Returns true when the calendar was fetched. Redraws whatever changed.
bool fetchCalendar() {
  if (WiFi.status() != WL_CONNECTED) {
    setStatus("No Wi-Fi, retrying...", true);
    return false;
  }
  String url = baseUrl() + "/api/display?days=" + String(cfg.days) + "&token=" + urlEncode(cfg.token);
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
  String body = http.getString();
  http.end();

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, body);
  if (err) {
    setStatus(String("Bad reply from calendar: ") + err.c_str(), true);
    return false;
  }
  std::vector<Day> fresh;
  for (JsonObject jd : doc["days"].as<JsonArray>()) {
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
    fresh.push_back(d);
  }
  serverNow = doc["now"] | 0;
  syncedAtMs = millis();
  utcOffset = doc["offset"] | 0;
  updatedText = doc["updated"] | "";
  statusText = "";
  statusIsError = false;

  // Only repaint the agenda when something changed ("now" and "updated" change on every fetch).
  doc.remove("now");
  doc.remove("updated");
  String stable;
  serializeJson(doc, stable);
  uint32_t h = fnv(stable);
  bool changed = !haveData || h != payloadHash;
  payloadHash = h;
  days.swap(fresh);
  haveData = true;
  if (changed) drawAll();
  else {
    drawHeader();
    drawFooter();
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Setup portal (Wi-Fi + calendar settings), served by the display itself
// ---------------------------------------------------------------------------------------------
bool settingsSaved = false;

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
}

// onDemand: opened from the screen (always show the portal); otherwise connect with saved Wi-Fi
// and only fall back to the portal if that fails or the calendar isn't configured yet.
void runPortal(bool onDemand) {
  WiFiManager wm;
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
  WiFiManagerParameter pFlip("flip", "Turn the picture upside down", "1", 2,
                             cfg.flip ? "type=\"checkbox\" checked" : "type=\"checkbox\"", WFM_LABEL_AFTER);
  WiFiManagerParameter pInvert("invert", "Invert colours (if they look like a photo negative)", "1", 2,
                               cfg.invert ? "type=\"checkbox\" checked" : "type=\"checkbox\"", WFM_LABEL_AFTER);
  for (WiFiManagerParameter *p : {&hdr, &pUrl, &pToken, &pDays, &pRefresh, &hdr2, &pDimFrom, &pDimTo, &pDimLevel,
                                  &pFlip, &pInvert})
    wm.addParameter(p);

  settingsSaved = false;
  wm.setTitle("Calendar display");
  std::vector<const char *> menu = {"wifi", "exit"};
  wm.setMenu(menu);
  wm.setSaveParamsCallback([] { settingsSaved = true; });
  wm.setBreakAfterConfig(true);  // keep the settings even if the Wi-Fi password was wrong
  wm.setAPCallback(showSetupScreen);
  wm.setConnectTimeout(20);
  wm.setConfigPortalTimeout(onDemand ? 600 : 300);

  bool connected = (onDemand || cfg.url.isEmpty()) ? wm.startConfigPortal(AP_NAME, AP_PASS)
                                                   : wm.autoConnect(AP_NAME, AP_PASS);
  if (settingsSaved) {
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
  }
  if (onDemand || settingsSaved || !connected || cfg.url.isEmpty()) {
    drawMessage(settingsSaved ? "Saved" : "Restarting", {"Starting the calendar..."});
    delay(1200);
    ESP.restart();
  }
}

// ---------------------------------------------------------------------------------------------
// Touch
// ---------------------------------------------------------------------------------------------
bool touchDown = false, longPressFired = false;
uint32_t touchStartMs = 0, touchSeenMs = 0;
int touchX = 0, touchY = 0;

bool readTouch(int &x, int &y) {
  if (!(ts.tirqTouched() && ts.touched())) return false;
  TS_Point p = ts.getPoint();
  x = constrain(map(p.x, 200, 3700, 0, W - 1), 0, W - 1);
  y = constrain(map(p.y, 240, 3800, 0, H - 1), 0, H - 1);
  return true;
}

void onTap(int x, int y) {
  if (isNight() && millis() > wakeUntilMs) {  // first tap at night just lights the screen
    wakeUntilMs = millis() + 30000;
    updateBacklight();
    return;
  }
  if (isNight()) wakeUntilMs = millis() + 30000;
  if (y < HEADER_H) {
    setStatus("Refreshing...", false);
    nextFetchInMs = 0;
    lastFetchMs = millis();
    return;
  }
  if (pageCount <= 1) return;
  page = x >= W / 2 ? (page + 1) % pageCount : (page > 0 ? page - 1 : pageCount - 1);
  drawBody(true);
  drawFooter();
}

void handleTouch() {
  int x, y;
  uint32_t ms = millis();
  if (readTouch(x, y)) {
    touchSeenMs = ms;
    if (!touchDown) {
      touchDown = true;
      longPressFired = false;
      touchStartMs = ms;
      touchX = x;
      touchY = y;
    } else if (!longPressFired && ms - touchStartMs > 5000) {
      longPressFired = true;
      runPortal(true);  // restarts when done
    }
  } else if (touchDown && ms - touchSeenMs > 80) {  // released (with a little debounce)
    touchDown = false;
    lastTouchMs = ms;
    if (!longPressFired) onTap(touchX, touchY);
  }
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
  loadSettings();

  tft.init();
  tft.setRotation(cfg.flip ? 3 : 1);
  tft.invertDisplay(cfg.invert);
  ledcSetup(BL_CHANNEL, 5000, 8);
  ledcAttachPin(BACKLIGHT, BL_CHANNEL);
  setBacklight(100);

  touchSpi.begin(TOUCH_CLK, TOUCH_MISO, TOUCH_MOSI, TOUCH_CS);
  ts.begin(touchSpi);
  ts.setRotation(cfg.flip ? 3 : 1);

  drawMessage("Calendar", {"Connecting to Wi-Fi...", "", "Hold the screen to open setup."});
  bool setupRequested = false;
  for (int i = 0; i < 20 && !setupRequested; i++) {  // 2 seconds to touch and hold
    int x, y;
    setupRequested = readTouch(x, y);
    delay(100);
  }
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  runPortal(setupRequested);  // connects; shows the portal only when needed

  tft.fillScreen(C_BG);
  drawAll();
  fetchCalendar();
  lastFetchMs = millis();
  nextFetchInMs = (statusIsError ? 1 : cfg.refreshMin) * 60000UL;
}

void loop() {
  handleTouch();
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

  // Go back to the first page after a minute without touches.
  if (page != 0 && !touchDown && ms - lastTouchMs > 60000) {
    page = 0;
    drawBody(true);
    drawFooter();
  }
  updateBacklight();
  delay(10);
}
