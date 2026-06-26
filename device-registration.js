(async function () {
  const storage = window.AIOTStorage;
  await storage.init();

  const $ = id => document.getElementById(id);
  const setText = (id, value) => { const el = $(id); if (el) el.textContent = value; };
  const partner = storage.getCurrentPartner();

  if (!partner) {
    storage.toast("Please login before registering devices.");
    window.location.href = "service-partner.html";
    return;
  }

  const survey = storage.getSurvey(partner.id);
  let useUltrasonic = Boolean(survey.usesUltrasonic);
  let lastToken = "";
  let generatedSketch = "";
  let baseSketchTemplate = "";

  const EMBEDDED_FULL_SKETCH = String.raw`/*
  QueuePulse AI - ESP32 Cloud Device
  Reliable public connection version

  Purpose:
  - Read IR entry sensor, IR exit/service sensor and ultrasonic sensor.
  - Send clean JSON readings to the Supabase Edge Function.
  - Print clear Serial Monitor messages when Wi-Fi, upload or cloud push fails.

  Recommended pins:
  IR Entry OUT       -> GPIO 27
  IR Exit OUT        -> GPIO 26
  Ultrasonic TRIG    -> GPIO 25
  Ultrasonic ECHO    -> GPIO 34 through a voltage divider if HC-SR04 uses 5V ECHO

  Important:
  - ESP32 supports 2.4 GHz Wi-Fi only on most development boards.
  - Open Serial Monitor at 115200 baud after upload.
  - Do not share a generated sketch publicly. It contains Wi-Fi and device token values.
*/

#include <WiFi.h>
#include <WebServer.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>

// =========================
// WIFI SETTINGS
// =========================
const char* WIFI_SSID = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// =========================
// CLOUD SETTINGS
// Example: https://YOUR_PROJECT_REF.supabase.co/functions/v1/device-ingest
// =========================
const char* DEVICE_INGEST_URL = "https://YOUR_PROJECT_REF.supabase.co/functions/v1/device-ingest";
const char* DEVICE_TOKEN = "PASTE_DEVICE_TOKEN_HERE";
const bool ENABLE_CLOUD_PUSH = true;
const unsigned long CLOUD_PUSH_INTERVAL_MS = 3000;

// =========================
// SENSOR PINS
// Use the same values in Device Registration.
// =========================
const int IR_ENTRY_PIN = 27;
const int IR_EXIT_PIN = 26;
const int ULTRASONIC_TRIG_PIN = 25;
const int ULTRASONIC_ECHO_PIN = 34;
const bool ENABLE_ULTRASONIC = false;

// Most IR obstacle sensors output LOW when blocked.
const bool IR_ACTIVE_LOW = true;

// =========================
// CONNECTION AND SENSOR TUNING
// =========================
const unsigned long WIFI_CONNECT_TIMEOUT_MS = 20000;
const unsigned long WIFI_RETRY_INTERVAL_MS = 10000;
const unsigned long HTTP_TIMEOUT_MS = 9000;
const unsigned long SERIAL_STATUS_INTERVAL_MS = 10000;
const unsigned long IR_DEBOUNCE_MS = 850;
const float MIN_VALID_DISTANCE_CM = 2.0;
const float MAX_VALID_DISTANCE_CM = 400.0;
const float OCCUPIED_DISTANCE_CM = 90.0;

WebServer server(80);

long entryCount = 0;
long exitCount = 0;
long currentPeople = 0;

bool lastEntryBlocked = false;
bool lastExitBlocked = false;
bool serverStarted = false;

unsigned long lastEntryEventMs = 0;
unsigned long lastExitEventMs = 0;
unsigned long previousExitEventMs = 0;
unsigned long lastCloudPushMs = 0;
unsigned long lastWiFiRetryMs = 0;
unsigned long lastSerialStatusMs = 0;

float lastDistanceCm = -1;
float lastServiceIntervalSec = 0.0;
int lastCloudStatusCode = 0;
String lastCloudMessage = "not pushed yet";
String lastSuccessfulPushAt = "not yet";

String deviceId() {
  uint64_t chipid = ESP.getEfuseMac();
  char id[32];
  snprintf(id, sizeof(id), "ESP32-%04X%08X", (uint16_t)(chipid >> 32), (uint32_t)chipid);
  return String(id);
}

String boolText(bool value) {
  return value ? "true" : "false";
}

String stateText(bool blocked) {
  return blocked ? "blocked" : "clear";
}

String wifiStatusName(wl_status_t status) {
  switch (status) {
    case WL_CONNECTED: return "connected";
    case WL_NO_SSID_AVAIL: return "ssid_not_found";
    case WL_CONNECT_FAILED: return "connect_failed";
    case WL_CONNECTION_LOST: return "connection_lost";
    case WL_DISCONNECTED: return "disconnected";
    case WL_IDLE_STATUS: return "idle";
    default: return "unknown";
  }
}

bool cloudConfigured() {
  String url = String(DEVICE_INGEST_URL);
  String token = String(DEVICE_TOKEN);
  return url.startsWith("https://") && url.indexOf("YOUR_PROJECT_REF") < 0 && token.length() >= 16 && token.indexOf("PASTE_DEVICE_TOKEN") < 0;
}

void printDivider() {
  Serial.println("--------------------------------------------------");
}

void printStartupChecklist() {
  printDivider();
  Serial.println("AIoT ESP32 Queue Device starting");
  Serial.print("Device ID: "); Serial.println(deviceId());
  Serial.print("SSID: "); Serial.println(WIFI_SSID);
  Serial.print("Cloud URL configured: "); Serial.println(cloudConfigured() ? "yes" : "no");
  Serial.print("IR Entry GPIO: "); Serial.println(IR_ENTRY_PIN);
  Serial.print("IR Exit GPIO: "); Serial.println(IR_EXIT_PIN);
  Serial.print("Ultrasonic enabled: "); Serial.println(ENABLE_ULTRASONIC ? "yes" : "no");
  if (ENABLE_ULTRASONIC) {
    Serial.print("Ultrasonic TRIG GPIO: "); Serial.println(ULTRASONIC_TRIG_PIN);
    Serial.print("Ultrasonic ECHO GPIO: "); Serial.println(ULTRASONIC_ECHO_PIN);
  }
  Serial.println("Serial baud: 115200");
  Serial.println("Use 2.4 GHz Wi-Fi. Check SSID/password if connection fails.");
  printDivider();
}

void printConnectionHelp() {
  Serial.println("Wi-Fi not connected yet. Check these:");
  Serial.println("1) SSID spelling, including spaces and capital letters");
  Serial.println("2) Wi-Fi password");
  Serial.println("3) Router 2.4 GHz network is enabled");
  Serial.println("4) ESP32 is close enough to the router");
  Serial.println("5) USB cable is a data cable while uploading");
  printDivider();
}

void scanAndPrintNetworks() {
  Serial.println("Scanning nearby Wi-Fi networks for troubleshooting...");
  WiFi.mode(WIFI_STA);
  int networkCount = WiFi.scanNetworks();

  if (networkCount <= 0) {
    Serial.println("No Wi-Fi networks found. Move ESP32 closer to router and make sure 2.4 GHz is enabled.");
    printDivider();
    return;
  }

  Serial.println("Networks visible to ESP32:");
  for (int i = 0; i < networkCount; i++) {
    Serial.print(i + 1);
    Serial.print(") SSID: ");
    Serial.print(WiFi.SSID(i));
    Serial.print(" | Signal: ");
    Serial.print(WiFi.RSSI(i));
    Serial.print(" dBm | Channel: ");
    Serial.println(WiFi.channel(i));
  }
  Serial.println("If your SSID is not listed exactly, check 2.4 GHz, router range, hidden SSID, and spelling.");
  WiFi.scanDelete();
  printDivider();
}

bool readIrBlocked(int pin) {
  int raw = digitalRead(pin);
  return IR_ACTIVE_LOW ? raw == LOW : raw == HIGH;
}

float readDistanceCm() {
  if (!ENABLE_ULTRASONIC) return -1;
  digitalWrite(ULTRASONIC_TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(ULTRASONIC_TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(ULTRASONIC_TRIG_PIN, LOW);

  unsigned long duration = pulseIn(ULTRASONIC_ECHO_PIN, HIGH, 30000);
  if (duration == 0) return -1;
  float distance = duration * 0.0343 / 2.0;
  if (distance < MIN_VALID_DISTANCE_CM || distance > MAX_VALID_DISTANCE_CM) return -1;
  return distance;
}

void addCors() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  server.sendHeader("Cache-Control", "no-store");
}

void updateSensors() {
  unsigned long now = millis();
  bool entryBlocked = readIrBlocked(IR_ENTRY_PIN);
  bool exitBlocked = readIrBlocked(IR_EXIT_PIN);

  if (entryBlocked && !lastEntryBlocked && now - lastEntryEventMs > IR_DEBOUNCE_MS) {
    entryCount++;
    lastEntryEventMs = now;
    Serial.print("Entry event. Entry count: "); Serial.println(entryCount);
  }

  if (exitBlocked && !lastExitBlocked && now - lastExitEventMs > IR_DEBOUNCE_MS) {
    exitCount++;
    previousExitEventMs = lastExitEventMs;
    lastExitEventMs = now;
    if (previousExitEventMs > 0) {
      lastServiceIntervalSec = (lastExitEventMs - previousExitEventMs) / 1000.0;
    }
    Serial.print("Exit/service event. Exit count: "); Serial.println(exitCount);
  }

  lastEntryBlocked = entryBlocked;
  lastExitBlocked = exitBlocked;

  long calculated = entryCount - exitCount;
  currentPeople = calculated < 0 ? 0 : calculated;
  lastDistanceCm = readDistanceCm();
}

String jsonEscape(String value) {
  value.replace("\\", "\\\\");
  value.replace("\"", "\\\"");
  value.replace("\n", " ");
  value.replace("\r", " ");
  return value;
}

String ipText() {
  return WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : String("not_connected");
}

String buildReadingsJson() {
  bool ultrasonicValid = lastDistanceCm > 0;
  bool ultrasonicOccupied = ultrasonicValid && lastDistanceCm <= OCCUPIED_DISTANCE_CM;
  bool entryBlocked = readIrBlocked(IR_ENTRY_PIN);
  bool exitBlocked = readIrBlocked(IR_EXIT_PIN);

  String json = "{";
  json += "\"deviceId\":\"" + deviceId() + "\",";
  json += "\"readings\":{";
  json += "\"deviceId\":\"" + deviceId() + "\",";
  json += "\"firmware\":\"esp32-reliable-v3\",";
  json += "\"status\":\"online\",";
  json += "\"currentPeople\":" + String(currentPeople) + ",";
  json += "\"entryCount\":" + String(entryCount) + ",";
  json += "\"exitCount\":" + String(exitCount) + ",";
  json += "\"irEntryState\":\"" + stateText(entryBlocked) + "\",";
  json += "\"irExitState\":\"" + stateText(exitBlocked) + "\",";
  json += "\"distanceCm\":" + String(ultrasonicValid ? lastDistanceCm : -1, 1) + ",";
  json += "\"ultrasonicOccupied\":" + boolText(ultrasonicOccupied) + ",";
  json += "\"serviceIntervalSec\":" + String(lastServiceIntervalSec, 1) + ",";
  json += "\"wifiStatus\":\"" + wifiStatusName(WiFi.status()) + "\",";
  json += "\"wifiRssi\":" + String(WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : -999) + ",";
  json += "\"ipAddress\":\"" + ipText() + "\",";
  json += "\"freeHeap\":" + String(ESP.getFreeHeap()) + ",";
  json += "\"uptimeMs\":" + String(millis());
  json += "}";
  json += "}";
  return json;
}

String buildLocalJson() {
  bool ultrasonicValid = lastDistanceCm > 0;
  bool ultrasonicOccupied = ultrasonicValid && lastDistanceCm <= OCCUPIED_DISTANCE_CM;
  bool entryBlocked = readIrBlocked(IR_ENTRY_PIN);
  bool exitBlocked = readIrBlocked(IR_EXIT_PIN);

  String json = "{";
  json += "\"deviceId\":\"" + deviceId() + "\",";
  json += "\"firmware\":\"esp32-reliable-v3\",";
  json += "\"status\":\"online\",";
  json += "\"wifiStatus\":\"" + wifiStatusName(WiFi.status()) + "\",";
  json += "\"ipAddress\":\"" + ipText() + "\",";
  json += "\"currentPeople\":" + String(currentPeople) + ",";
  json += "\"entryCount\":" + String(entryCount) + ",";
  json += "\"exitCount\":" + String(exitCount) + ",";
  json += "\"irEntryState\":\"" + stateText(entryBlocked) + "\",";
  json += "\"irExitState\":\"" + stateText(exitBlocked) + "\",";
  json += "\"distanceCm\":" + String(ultrasonicValid ? lastDistanceCm : -1, 1) + ",";
  json += "\"ultrasonicOccupied\":" + boolText(ultrasonicOccupied) + ",";
  json += "\"serviceIntervalSec\":" + String(lastServiceIntervalSec, 1) + ",";
  json += "\"wifiRssi\":" + String(WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : -999) + ",";
  json += "\"freeHeap\":" + String(ESP.getFreeHeap()) + ",";
  json += "\"uptimeMs\":" + String(millis()) + ",";
  json += "\"cloudConfigured\":" + boolText(cloudConfigured()) + ",";
  json += "\"cloudStatusCode\":" + String(lastCloudStatusCode) + ",";
  json += "\"cloudMessage\":\"" + jsonEscape(lastCloudMessage) + "\",";
  json += "\"lastSuccessfulPushAt\":\"" + lastSuccessfulPushAt + "\"";
  json += "}";
  return json;
}

bool pushToCloud(bool forced = false) {
  if (!ENABLE_CLOUD_PUSH) {
    lastCloudMessage = "cloud push disabled";
    return false;
  }
  if (!cloudConfigured()) {
    lastCloudMessage = "missing cloud URL or device token";
    if (forced) Serial.println(lastCloudMessage);
    return false;
  }
  if (WiFi.status() != WL_CONNECTED) {
    lastCloudMessage = "wifi not connected";
    if (forced) Serial.println(lastCloudMessage);
    return false;
  }

  WiFiClientSecure secureClient;
  secureClient.setInsecure(); // Project demo mode. For production, set a root CA certificate.

  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  if (!http.begin(secureClient, DEVICE_INGEST_URL)) {
    lastCloudStatusCode = -100;
    lastCloudMessage = "http begin failed";
    Serial.println(lastCloudMessage);
    return false;
  }

  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-token", DEVICE_TOKEN);

  String payload = buildReadingsJson();
  int code = http.POST(payload);
  lastCloudStatusCode = code;

  if (code > 0) {
    lastCloudMessage = http.getString();
    Serial.print("Cloud push code: "); Serial.println(code);
    if (code >= 200 && code < 300) {
      lastSuccessfulPushAt = String(millis());
      Serial.println("Cloud push OK. Database should update shortly.");
    } else if (code == 401 || code == 403) {
      Serial.println("Cloud rejected the token. Register device again or paste the correct token.");
    } else if (code == 404) {
      Serial.println("Cloud function not found. Check the Supabase function URL.");
    } else if (code >= 500) {
      Serial.println("Cloud function/database error. Check Supabase logs and schema.");
    }
  } else {
    lastCloudMessage = http.errorToString(code);
    Serial.print("Cloud push failed: "); Serial.println(lastCloudMessage);
  }

  http.end();
  return code >= 200 && code < 300;
}

void handleRoot() {
  addCors();
  server.send(200, "text/plain", "AIoT ESP32 Queue Device is online. Use /api/queue-device, /api/health, /api/test-cloud or /api/reset.");
}

void handleOptions() {
  addCors();
  server.send(204);
}

void handleQueueDevice() {
  updateSensors();
  addCors();
  server.send(200, "application/json", buildLocalJson());
}

void handleHealth() {
  addCors();
  String json = "{";
  json += "\"ok\":" + boolText(WiFi.status() == WL_CONNECTED) + ",";
  json += "\"wifiStatus\":\"" + wifiStatusName(WiFi.status()) + "\",";
  json += "\"ipAddress\":\"" + ipText() + "\",";
  json += "\"cloudConfigured\":" + boolText(cloudConfigured()) + ",";
  json += "\"lastCloudStatusCode\":" + String(lastCloudStatusCode) + ",";
  json += "\"lastCloudMessage\":\"" + jsonEscape(lastCloudMessage) + "\"";
  json += "}";
  server.send(200, "application/json", json);
}

void handleTestCloud() {
  updateSensors();
  bool ok = pushToCloud(true);
  addCors();
  String json = "{";
  json += "\"ok\":" + boolText(ok) + ",";
  json += "\"cloudStatusCode\":" + String(lastCloudStatusCode) + ",";
  json += "\"cloudMessage\":\"" + jsonEscape(lastCloudMessage) + "\"";
  json += "}";
  server.send(ok ? 200 : 502, "application/json", json);
}

void handleReset() {
  entryCount = 0;
  exitCount = 0;
  currentPeople = 0;
  lastEntryEventMs = 0;
  lastExitEventMs = 0;
  previousExitEventMs = 0;
  lastServiceIntervalSec = 0.0;
  addCors();
  server.send(200, "application/json", "{\"ok\":true,\"message\":\"Counts reset\"}");
}

bool connectToWiFiOnce() {
  Serial.print("Connecting to Wi-Fi: ");
  Serial.println(WIFI_SSID);
  WiFi.disconnect(true);
  delay(500);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_CONNECT_TIMEOUT_MS) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("ESP32 connected to Wi-Fi.");
    Serial.print("IP address: "); Serial.println(WiFi.localIP());
    Serial.print("Wi-Fi RSSI: "); Serial.println(WiFi.RSSI());
    printDivider();
    return true;
  }

  Serial.print("Wi-Fi failed. Status: "); Serial.println(wifiStatusName(WiFi.status()));
  printConnectionHelp();
  scanAndPrintNetworks();
  return false;
}

void startLocalServer() {
  if (serverStarted) return;
  server.on("/", HTTP_GET, handleRoot);
  server.on("/api/queue-device", HTTP_GET, handleQueueDevice);
  server.on("/api/queue-device", HTTP_OPTIONS, handleOptions);
  server.on("/api/health", HTTP_GET, handleHealth);
  server.on("/api/health", HTTP_OPTIONS, handleOptions);
  server.on("/api/test-cloud", HTTP_GET, handleTestCloud);
  server.on("/api/test-cloud", HTTP_OPTIONS, handleOptions);
  server.on("/api/reset", HTTP_GET, handleReset);
  server.on("/api/reset", HTTP_OPTIONS, handleOptions);
  server.begin();
  serverStarted = true;
  Serial.println("Local debug server started.");
  Serial.print("Open: http://"); Serial.print(WiFi.localIP()); Serial.println("/api/queue-device");
  Serial.print("Health: http://"); Serial.print(WiFi.localIP()); Serial.println("/api/health");
  Serial.print("Cloud test: http://"); Serial.print(WiFi.localIP()); Serial.println("/api/test-cloud");
  printDivider();
}

void ensureWiFi() {
  if (WiFi.status() == WL_CONNECTED) {
    if (!serverStarted) startLocalServer();
    return;
  }

  unsigned long now = millis();
  if (now - lastWiFiRetryMs < WIFI_RETRY_INTERVAL_MS) return;
  lastWiFiRetryMs = now;
  Serial.print("Wi-Fi disconnected. Status: "); Serial.println(wifiStatusName(WiFi.status()));
  connectToWiFiOnce();
  if (WiFi.status() == WL_CONNECTED) startLocalServer();
}

void printPeriodicStatus() {
  unsigned long now = millis();
  if (now - lastSerialStatusMs < SERIAL_STATUS_INTERVAL_MS) return;
  lastSerialStatusMs = now;
  Serial.print("Status | Wi-Fi: "); Serial.print(wifiStatusName(WiFi.status()));
  Serial.print(" | IP: "); Serial.print(ipText());
  Serial.print(" | People: "); Serial.print(currentPeople);
  Serial.print(" | Entry: "); Serial.print(entryCount);
  Serial.print(" | Exit: "); Serial.print(exitCount);
  Serial.print(" | Distance: "); Serial.print(lastDistanceCm, 1);
  Serial.print(" | Cloud code: "); Serial.println(lastCloudStatusCode);
}

void setup() {
  Serial.begin(115200);
  delay(800);
  printStartupChecklist();

  pinMode(IR_ENTRY_PIN, INPUT_PULLUP);
  pinMode(IR_EXIT_PIN, INPUT_PULLUP);
  if (ENABLE_ULTRASONIC) {
    pinMode(ULTRASONIC_TRIG_PIN, OUTPUT);
    pinMode(ULTRASONIC_ECHO_PIN, INPUT);
    digitalWrite(ULTRASONIC_TRIG_PIN, LOW);
  }

  if (connectToWiFiOnce()) {
    startLocalServer();
    pushToCloud(true);
  }
}

void loop() {
  ensureWiFi();
  updateSensors();

  if (serverStarted) server.handleClient();

  if (WiFi.status() == WL_CONNECTED && millis() - lastCloudPushMs >= CLOUD_PUSH_INTERVAL_MS) {
    lastCloudPushMs = millis();
    pushToCloud(false);
  }

  printPeriodicStatus();
  delay(30);
}
`;

  function setDeviceTab(tabName) {
    const normalized = tabName || "register";
    document.querySelectorAll("[data-device-panel]").forEach(panel => {
      panel.hidden = panel.dataset.devicePanel !== normalized;
    });
    document.querySelectorAll("[data-device-tab]").forEach(button => {
      button.classList.toggle("active", button.dataset.deviceTab === normalized);
    });
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
  }

  function cppString(value) {
    return String(value ?? "")
      .replace(/\\/g, "\\\\")
      .replace(/"/g, "\\\"")
      .replace(/\r?\n/g, " ");
  }

  function numberValue(id, fallback) {
    const value = Number($(id)?.value);
    return Number.isFinite(value) ? value : fallback;
  }

  function deviceUsesUltrasonic() {
    const type = $("deviceType")?.value || "esp32-ir-only";
    return type.includes("ultrasonic");
  }

  function refreshUltrasonicFields() {
    useUltrasonic = deviceUsesUltrasonic();
    document.querySelectorAll(".ultrasonic-field").forEach(field => { field.hidden = !useUltrasonic; });
  }

  function getBuilderValues() {
    const ultrasonicEnabled = deviceUsesUltrasonic();
    return {
      wifiSsid: $("wifiSsid")?.value.trim() || "YOUR_WIFI_NAME",
      wifiPassword: $("wifiPassword")?.value || "YOUR_WIFI_PASSWORD",
      ingestUrl: $("builderIngestUrl")?.value.trim() || storage.getDeviceIngestUrl() || "https://YOUR-CLOUD-INGEST-URL",
      token: $("builderToken")?.value.trim() || lastToken || "PASTE_DEVICE_TOKEN_HERE",
      pinEntry: numberValue("pinEntry", 27),
      pinExit: numberValue("pinExit", 26),
      ultrasonicEnabled,
      pinTrig: ultrasonicEnabled ? numberValue("pinTrig", 25) : 25,
      pinEcho: ultrasonicEnabled ? numberValue("pinEcho", 34) : 34,
      irActiveLow: $("irActiveMode")?.value !== "false",
      occupiedDistance: numberValue("occupiedDistance", 90),
      cloudInterval: numberValue("cloudInterval", 3000),
      sketchFileName: ($("sketchFileName")?.value.trim() || "esp32_queue_device_configured").replace(/[^a-zA-Z0-9_-]/g, "_")
    };
  }

  function validateBuilder(values) {
    if (!values.wifiSsid || values.wifiSsid === "YOUR_WIFI_NAME") throw new Error("Enter the exact Wi‑Fi name/SSID.");
    if (values.wifiSsid.length > 32) throw new Error("Wi‑Fi SSID should be 32 characters or less.");
    if (!values.wifiPassword || values.wifiPassword === "YOUR_WIFI_PASSWORD") throw new Error("Enter the Wi‑Fi password.");
    if (values.wifiPassword.length < 8) throw new Error("Most home Wi‑Fi passwords are at least 8 characters. Check the password.");
    if (!values.ingestUrl.startsWith("https://")) throw new Error("Enter the HTTPS Supabase device-ingest URL.");
    if (!/\/functions\/v1\/device-ingest\/?$/.test(values.ingestUrl)) throw new Error("The cloud ingest URL should end with /functions/v1/device-ingest.");
    if (!values.token || values.token === "PASTE_DEVICE_TOKEN_HERE" || values.token.length < 16) throw new Error("Generate or paste a valid device token.");
    const pins = values.ultrasonicEnabled ? [values.pinEntry, values.pinExit, values.pinTrig, values.pinEcho] : [values.pinEntry, values.pinExit];
    if (pins.some(pin => pin < 0 || pin > 39)) throw new Error("ESP32 GPIO pins must be between 0 and 39.");
    if (new Set(pins).size !== pins.length) throw new Error("Each enabled sensor must use a different GPIO pin.");
    const outputCapable = pin => ![34, 35, 36, 37, 38, 39].includes(pin);
    const avoidBootPins = pin => ![0, 2, 4, 12, 15].includes(pin);
    if (values.ultrasonicEnabled && !outputCapable(values.pinTrig)) throw new Error("Ultrasonic TRIG needs an output-capable GPIO. Do not use GPIO 34-39 for TRIG.");
    if (!outputCapable(values.pinEntry) || !outputCapable(values.pinExit)) throw new Error("Use GPIO 13, 14, 16-19, 21-23, 25-27, 32 or 33 for IR sensors.");
    if (pins.some(pin => !avoidBootPins(pin))) throw new Error("Avoid boot strapping pins GPIO 0, 2, 4, 12 and 15 for this project.");
    if (values.cloudInterval < 2000) throw new Error("Cloud push interval should be at least 2000 ms for stable database updates.");
  }

  async function getSketchTemplate() {
    if (baseSketchTemplate) return baseSketchTemplate;

    // Prefer the external .ino file when the site is served correctly.
    // If the browser/server blocks .ino fetching, fall back to the full
    // embedded reliable sketch instead of generating a small/simple sketch.
    try {
      const response = await fetch("esp32_queue_device.ino", { cache: "no-store" });
      if (!response.ok) throw new Error(`template fetch failed: ${response.status}`);
      const fetchedSketch = await response.text();
      if (!fetchedSketch.includes("pushToCloud") || !fetchedSketch.includes("/api/queue-device") || !fetchedSketch.includes("connectToWiFiOnce")) {
        throw new Error("template file is not the reliable full sketch");
      }
      baseSketchTemplate = fetchedSketch;
    } catch (error) {
      console.warn("Using embedded reliable ESP32 sketch template:", error);
      baseSketchTemplate = EMBEDDED_FULL_SKETCH;
    }

    return baseSketchTemplate;
  }

  async function buildSketch() {
    const values = getBuilderValues();
    validateBuilder(values);
    let sketch = await getSketchTemplate();
    const generatedHeader = `/*\n  Generated by QueuePulse AI Device Registration.\n  Service Partner: ${cppString(partner.organizationName || "Service Partner")}\n  Generated at: ${new Date().toISOString()}\n  Do not share this file publicly because it contains Wi‑Fi and device token values.\n*/\n`;

    sketch = sketch
      .replace(/const char\* WIFI_SSID\s*=\s*"[^"]*";/, `const char* WIFI_SSID = "${cppString(values.wifiSsid)}";`)
      .replace(/const char\* WIFI_PASSWORD\s*=\s*"[^"]*";/, `const char* WIFI_PASSWORD = "${cppString(values.wifiPassword)}";`)
      .replace(/const char\* DEVICE_INGEST_URL\s*=\s*"[^"]*";/, `const char* DEVICE_INGEST_URL = "${cppString(values.ingestUrl)}";`)
      .replace(/const char\* DEVICE_TOKEN\s*=\s*"[^"]*";/, `const char* DEVICE_TOKEN = "${cppString(values.token)}";`)
      .replace(/const unsigned long CLOUD_PUSH_INTERVAL_MS\s*=\s*\d+;/, `const unsigned long CLOUD_PUSH_INTERVAL_MS = ${Math.round(values.cloudInterval)};`)
      .replace(/const int IR_ENTRY_PIN\s*=\s*\d+;/, `const int IR_ENTRY_PIN = ${Math.round(values.pinEntry)};`)
      .replace(/const int IR_EXIT_PIN\s*=\s*\d+;/, `const int IR_EXIT_PIN = ${Math.round(values.pinExit)};`)
      .replace(/const int ULTRASONIC_TRIG_PIN\s*=\s*\d+;/, `const int ULTRASONIC_TRIG_PIN = ${Math.round(values.pinTrig)};`)
      .replace(/const int ULTRASONIC_ECHO_PIN\s*=\s*\d+;/, `const int ULTRASONIC_ECHO_PIN = ${Math.round(values.pinEcho)};`)
      .replace(/const bool ENABLE_ULTRASONIC\s*=\s*(true|false);/, `const bool ENABLE_ULTRASONIC = ${values.ultrasonicEnabled ? "true" : "false"};`)
      .replace(/const bool IR_ACTIVE_LOW\s*=\s*(true|false);/, `const bool IR_ACTIVE_LOW = ${values.irActiveLow ? "true" : "false"};`)
      .replace(/const float OCCUPIED_DISTANCE_CM\s*=\s*[\d.]+;/, `const float OCCUPIED_DISTANCE_CM = ${Number(values.occupiedDistance).toFixed(1)};`);

    if (!sketch.startsWith("/*\n  Generated by QueuePulse AI Device Registration")) sketch = generatedHeader + sketch;
    generatedSketch = sketch;
    const preview = $("generatedSketchPreview");
    if (preview) {
      preview.value = generatedSketch;
      preview.style.display = "block";
    }
    setText("builderMessage", "Reliable full Arduino sketch generated. It includes Wi‑Fi reconnect, Serial diagnostics, local test URLs, IR counting, optional ultrasonic, and Supabase cloud push.");
    return { sketch, values };
  }

  function sketchConfig(token) {
    const values = getBuilderValues();
    const finalToken = token || values.token || lastToken || "PASTE_DEVICE_TOKEN_HERE";
    return [
      `const char* WIFI_SSID = "${cppString(values.wifiSsid)}";`,
      `const char* WIFI_PASSWORD = "${cppString(values.wifiPassword)}";`,
      `const char* DEVICE_INGEST_URL = "${cppString(values.ingestUrl)}";`,
      `const char* DEVICE_TOKEN = "${cppString(finalToken)}";`,
      `const int IR_ENTRY_PIN = ${Math.round(values.pinEntry)};`,
      `const int IR_EXIT_PIN = ${Math.round(values.pinExit)};`,
      values.ultrasonicEnabled ? `const int ULTRASONIC_TRIG_PIN = ${Math.round(values.pinTrig)};` : `// Ultrasonic disabled in Setup Survey`,
      values.ultrasonicEnabled ? `const int ULTRASONIC_ECHO_PIN = ${Math.round(values.pinEcho)};` : `// Ultrasonic GPIO not required`,
      `const bool ENABLE_ULTRASONIC = ${values.ultrasonicEnabled ? "true" : "false"};`,
      `const bool IR_ACTIVE_LOW = ${values.irActiveLow ? "true" : "false"};`,
      `const float OCCUPIED_DISTANCE_CM = ${Number(values.occupiedDistance).toFixed(1)};`
    ].join("\n");
  }

  function downloadTextFile(filename, content) {
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function copyText(text, message) {
    await navigator.clipboard?.writeText(text);
    storage.toast(message);
  }

  async function loadDevices() {
    setText("modeBadge", storage.getMode());
    setText("partnerName", partner.organizationName || "Service Partner");
    setText("partnerLocation", `${partner.organizationType || "Service"} · ${partner.serviceLocation || ""}`);
    const ingestUrl = storage.getDeviceIngestUrl() || "Add cloud URL in app-config.js";
    setText("ingestUrl", ingestUrl);
    const builderIngest = $("builderIngestUrl");
    if (builderIngest && !builderIngest.value) builderIngest.value = storage.getDeviceIngestUrl() || "";

    const devices = await storage.listDevices(partner.id);
    const list = $("deviceList");
    const empty = $("emptyDevices");
    if (!list || !empty) return;
    list.innerHTML = "";
    empty.style.display = devices.length ? "none" : "block";

    devices.forEach((device, index) => {
      const row = document.createElement("div");
      row.className = "step-item";
      row.innerHTML = `
        <div class="step-index">${index + 1}</div>
        <div>
          <strong>${escapeHtml(device.device_name || device.deviceName || "ESP32 Device")}</strong>
          <p class="helper">${escapeHtml(device.device_type || device.deviceType || "esp32")} · ${escapeHtml(device.device_id || device.deviceId || "no serial id")} · Last seen: ${escapeHtml(device.last_seen_at || "not yet")}</p>
        </div>
        <span class="status-pill ${device.is_active || device.isActive ? "online" : "offline"}">${device.is_active || device.isActive ? "Active" : "Inactive"}</span>
      `;
      list.appendChild(row);
    });
  }

  const deviceTypeSelect = $("deviceType");
  if (deviceTypeSelect) {
    deviceTypeSelect.value = useUltrasonic ? "esp32-ir-ultrasonic" : "esp32-ir-only";
    deviceTypeSelect.addEventListener("change", refreshUltrasonicFields);
  }
  refreshUltrasonicFields();

  document.querySelectorAll("[data-device-tab]").forEach(button => {
    button.addEventListener("click", () => setDeviceTab(button.dataset.deviceTab));
  });
  $("openBuilderPanelButton")?.addEventListener("click", () => setDeviceTab("builder"));

  $("deviceForm")?.addEventListener("submit", async event => {
    event.preventDefault();
    try {
      const result = await storage.registerDevice(partner.id, {
        deviceName: $("deviceName")?.value.trim(),
        deviceType: $("deviceType")?.value,
        deviceId: $("deviceId")?.value.trim()
      });
      lastToken = result.token;
      setText("deviceToken", lastToken);
      const tokenPanel = $("tokenPanel");
      if (tokenPanel) tokenPanel.style.display = "block";
      if ($("emptyTokenState")) $("emptyTokenState").style.display = "none";
      if ($("builderToken")) $("builderToken").value = lastToken;
      setDeviceTab("builder");
      storage.toast("Device registered. Fill Wi‑Fi details and generate the customized Arduino code.");
      await loadDevices();
    } catch (error) {
      storage.toast(error.message || "Device registration failed.");
    }
  });

  $("codeBuilderForm")?.addEventListener("submit", async event => {
    event.preventDefault();
    try {
      await buildSketch();
      storage.toast("Customized Arduino code generated.");
    } catch (error) {
      storage.toast(error.message || "Could not generate Arduino code.");
    }
  });

  $("downloadSketchButton")?.addEventListener("click", async () => {
    try {
      const result = generatedSketch ? { sketch: generatedSketch, values: getBuilderValues() } : await buildSketch();
      const fileName = `${result.values.sketchFileName || "esp32_queue_device_configured"}.ino`;
      downloadTextFile(fileName, result.sketch);
      storage.toast("Customized .ino downloaded.");
    } catch (error) {
      storage.toast(error.message || "Could not download sketch.");
    }
  });

  $("copyFullSketchButton")?.addEventListener("click", async () => {
    try {
      const result = generatedSketch ? { sketch: generatedSketch } : await buildSketch();
      await copyText(result.sketch, "Full Arduino code copied.");
    } catch (error) {
      storage.toast(error.message || "Could not copy sketch.");
    }
  });

  $("copySketchConfigButton")?.addEventListener("click", async () => {
    try {
      const values = getBuilderValues();
      validateBuilder(values);
      await copyText(sketchConfig(lastToken), "Arduino settings copied.");
    } catch (error) {
      storage.toast(error.message || "Could not copy settings.");
    }
  });

  $("refreshDevicesButton")?.addEventListener("click", () => loadDevices().then(() => storage.toast("Devices refreshed.")));
  $("logoutBtn")?.addEventListener("click", async () => { await storage.logout(); window.location.href = "service-partner.html"; });

  setDeviceTab("register");
  await loadDevices();
})();
