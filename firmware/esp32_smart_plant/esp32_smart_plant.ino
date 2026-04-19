/**
 * smart_plant_watering.ino  — FIXED + REMOTE LOGGING VERSION
 *
 * FIXES:
 *   1. postWateringLog now sends volumeMl
 *   2. currentReason tracked properly (not hardcoded "auto")
 *   3. HTTP timeout raised to 15s (Render free tier wakes slow)
 *   4. Retry logic on all HTTP calls
 *   5. remoteLog() sends Serial prints to backend → visible on dashboard
 *
 * Wiring:
 *   GPIO 13 → Soil Moisture Sensor (DO)
 *   GPIO 15 → LDR (DO)
 *   GPIO 4  → DHT11 (DATA)
 *   GPIO 14 → Relay IN
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <DHT.h>


// ──────────────────────────────────────────────
// SENSOR STRUCT  ✅ FIX FOR COMPILATION ERROR
// ──────────────────────────────────────────────
struct SensorReadings {
  int   soilDigital;
  int   lightDigital;
  float temperature;
  float humidity;
  bool  dhtOk;
};
// ──────────────────────────────────────────────
// USER CONFIG
// ──────────────────────────────────────────────
const char* WIFI_SSID     = "Chhaya";
const char* WIFI_PASSWORD = "123456789";
const char* BACKEND_URL   = "https://smart-plant-watering-kef4.onrender.com";
const char* DEVICE_ID     = "esp32-plant-01";

// ──────────────────────────────────────────────
// PIN DEFINITIONS
// ──────────────────────────────────────────────
#define SOIL_DO_PIN    13
#define LDR_DO_PIN     15
#define DHT_PIN        12
#define RELAY_PIN      14
#define RELAY_ACTIVE_HIGH true // Most blue relay boards are active-LOW

// ──────────────────────────────────────────────
// TIMING
// ──────────────────────────────────────────────
#define SENSOR_INTERVAL_MS    30000
#define COMMAND_INTERVAL_MS   10000
#define HTTP_TIMEOUT_MS       15000   // Raised from 8s — Render free tier needs this
#define HTTP_RETRY_DELAY_MS    3000
#define MAX_PUMP_DURATION_MS  60000

// ──────────────────────────────────────────────
// DHT
// ──────────────────────────────────────────────
#define DHT_TYPE DHT11
DHT dht(DHT_PIN, DHT_TYPE);

// ──────────────────────────────────────────────
// STATE
// ──────────────────────────────────────────────
unsigned long lastSensorPost  = 0;
unsigned long lastCommandPoll = 0;
unsigned long pumpStartTime   = 0;
unsigned long pumpDuration    = 0;
bool          pumpOn          = false;
String        currentRequestId = "";
String        currentReason    = "";

// ──────────────────────────────────────────────
// REMOTE LOG — sends Serial output to backend
// so you can see it in the dashboard without USB
// ──────────────────────────────────────────────
void remoteLog(const char* level, const String& message) {
  // Always print to Serial too
  Serial.printf("[%s] %s\n", level, message.c_str());

  // Fire-and-forget POST to /esp32-log (no retry, non-blocking feel)
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  http.begin(String(BACKEND_URL) + "/esp32-log");
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(4000);  // Short timeout — this is best-effort

  String body = "{\"level\":\"" + String(level) + "\",\"message\":\"" + message + "\"}";
  http.POST(body);
  http.end();
}

// Convenience wrappers
void logInfo(const String& msg)    { remoteLog("info",    msg); }
void logWarn(const String& msg)    { remoteLog("warn",    msg); }
void logError(const String& msg)   { remoteLog("error",   msg); }
void logSuccess(const String& msg) { remoteLog("success", msg); }

// ──────────────────────────────────────────────
// RELAY
// ──────────────────────────────────────────────
void relayOn() {
  digitalWrite(RELAY_PIN, RELAY_ACTIVE_HIGH ? HIGH : LOW);
  pumpOn = true;
  logInfo("Relay ON — motor starting");
}

void relayOff() {
  digitalWrite(RELAY_PIN, RELAY_ACTIVE_HIGH ? LOW : HIGH);
  pumpOn = false;
  logInfo("Relay OFF — motor stopped");
}

// ──────────────────────────────────────────────
// WIFI
// ──────────────────────────────────────────────
void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  Serial.printf("[WiFi] Connecting to %s\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 20) {
    delay(500);
    Serial.print(".");
    tries++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[WiFi] Connected — IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\n[WiFi] Failed — will retry");
  }
}

// ──────────────────────────────────────────────
// HTTP POST with retry
// ──────────────────────────────────────────────
int httpPost(const String& path, const String& body, String& responseOut, int retries = 1) {
  if (WiFi.status() != WL_CONNECTED) return -1;

  String url = String(BACKEND_URL) + path;

  for (int attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      Serial.printf("[HTTP] Retry %d for POST %s\n", attempt, path.c_str());
      delay(HTTP_RETRY_DELAY_MS);
    }

    HTTPClient http;
    http.begin(url);
    http.addHeader("Content-Type", "application/json");
    http.setTimeout(HTTP_TIMEOUT_MS);

    int code = http.POST(body);
    if (code > 0) {
      responseOut = http.getString();
      http.end();
      Serial.printf("[HTTP] POST %s → %d\n", path.c_str(), code);
      return code;
    }

    Serial.printf("[HTTP] POST %s failed (attempt %d): %s\n",
      path.c_str(), attempt + 1, http.errorToString(code).c_str());
    http.end();
  }
  return -1;
}

// ──────────────────────────────────────────────
// HTTP GET with retry
// ──────────────────────────────────────────────
int httpGet(const String& path, String& responseOut, int retries = 1) {
  if (WiFi.status() != WL_CONNECTED) return -1;

  String url = String(BACKEND_URL) + path;

  for (int attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      Serial.printf("[HTTP] Retry %d for GET %s\n", attempt, path.c_str());
      delay(HTTP_RETRY_DELAY_MS);
    }

    HTTPClient http;
    http.begin(url);
    http.setTimeout(HTTP_TIMEOUT_MS);

    int code = http.GET();
    if (code > 0) {
      responseOut = http.getString();
      http.end();
      Serial.printf("[HTTP] GET %s → %d\n", path.c_str(), code);
      return code;
    }

    Serial.printf("[HTTP] GET %s failed (attempt %d): %s\n",
      path.c_str(), attempt + 1, http.errorToString(code).c_str());
    http.end();
  }
  return -1;
}

// ──────────────────────────────────────────────
// SENSORS
/* ──────────────────────────────────────────────
struct SensorReadings {
  int   soilDigital;
  int   lightDigital;
  float temperature;
  float humidity;
  bool  dhtOk;
};*/

SensorReadings readSensors() {
  SensorReadings r;
  r.soilDigital  = digitalRead(SOIL_DO_PIN);
  r.lightDigital = digitalRead(LDR_DO_PIN);
  r.temperature  = dht.readTemperature();
  r.humidity     = dht.readHumidity();

  if (isnan(r.temperature) || isnan(r.humidity)) {
    delay(500);
    r.temperature = dht.readTemperature();
    r.humidity    = dht.readHumidity();
  }
  r.dhtOk = (!isnan(r.temperature) && !isnan(r.humidity));
  return r;
}

// ──────────────────────────────────────────────
// POST /sensor-data
// ──────────────────────────────────────────────
void postSensorData() {
  SensorReadings s = readSensors();

  String msg = "Sensors: soil_do=" + String(s.soilDigital) +
               " ldr_do=" + String(s.lightDigital) +
               " temp=" + (s.dhtOk ? String(s.temperature, 1) : "ERR") +
               " hum="  + (s.dhtOk ? String(s.humidity, 1)    : "ERR") +
               " pump=" + String(pumpOn ? "ON" : "OFF");
  logInfo(msg);

  String body = "{";
  body += "\"deviceId\":\"" + String(DEVICE_ID) + "\",";
  body += "\"soilDigital\":"  + String(s.soilDigital)  + ",";
  body += "\"lightDigital\":" + String(s.lightDigital) + ",";

  if (s.dhtOk) {
    body += "\"temperature\":"  + String(s.temperature, 1) + ",";
    body += "\"humidity\":"     + String(s.humidity,    1) + ",";
  } else {
    logWarn("DHT read failed — sending defaults temp=25 hum=50");
    body += "\"temperature\":25.0,";
    body += "\"humidity\":50.0,";
  }

  body += "\"pumpState\":" + String(pumpOn ? "true" : "false") + ",";
  body += "\"mode\":\"online\"";
  body += "}";

  String resp;
  int code = httpPost("/sensor-data", body, resp);
  if (code == 201) {
    StaticJsonDocument<256> doc;
    if (!deserializeJson(doc, resp)) {
      String scoreMsg = "Backend score=" + String((float)doc["score"], 1) +
                        " decision=" + String(doc["decision"]["command"] | "?") +
                        " reason=" + String(doc["decision"]["reason"] | "?");
      logInfo(scoreMsg);
    }
  } else {
    logError("Sensor POST failed code=" + String(code));
  }
}

// ──────────────────────────────────────────────
// POST /watering-log  — FIXED: sends volumeMl + correct reason
// ──────────────────────────────────────────────
void postWateringLog(const String& event,
                     unsigned long durationMs,
                     const String& reason,
                     const String& requestId,
                     float pumpFlowMlPerSec = 20.0) {

  float volumeMl = (durationMs / 1000.0) * pumpFlowMlPerSec;

  String body = "{";
  body += "\"deviceId\":\"" + String(DEVICE_ID) + "\",";
  body += "\"event\":\""    + event    + "\",";
  body += "\"reason\":\""   + reason   + "\",";
  body += "\"durationMs\":" + String(durationMs) + ",";
  body += "\"volumeMl\":"   + String(volumeMl, 1);
  if (requestId.length() > 0) {
    body += ",\"requestId\":\"" + requestId + "\"";
  }
  body += "}";

  String resp;
  // Retry 2 times — this is critical for watering log to show on dashboard
  int code = httpPost("/watering-log", body, resp, 2);
  if (code == 201) {
    logSuccess("Watering log '" + event + "' saved — " +
               String(durationMs) + "ms " + String(volumeMl, 1) + "ml");
  } else {
    logError("Watering log POST failed code=" + String(code));
  }
}

// ──────────────────────────────────────────────
// GET /command — FIXED: saves reason, retries
// ──────────────────────────────────────────────
void pollCommand() {
  if (pumpOn) {
    Serial.println("[Command] Skipping — pump already ON");
    return;
  }

  logInfo("Polling /command ...");

  String resp;
  int code = httpGet("/command", resp, 1);
  if (code != 200 || resp.length() == 0) {
    logError("Command poll failed code=" + String(code) + " — motor will NOT run");
    return;
  }

  StaticJsonDocument<256> doc;
  if (deserializeJson(doc, resp)) {
    logError("Command JSON parse failed");
    return;
  }

  const char* cmd    = doc["command"] | "IDLE";
  const char* reason = doc["reason"]  | "unknown";
  float       score  = doc["score"]   | 0.0f;

  logInfo("Command=" + String(cmd) + " reason=" + String(reason) + " score=" + String(score, 1));

  if (strcmp(cmd, "WATER") == 0) {
    unsigned long dur = doc["durationMs"] | 7000;
    dur = min(dur, (unsigned long)MAX_PUMP_DURATION_MS);

    currentRequestId = String(doc["requestId"] | "");
    currentReason    = String(reason);  // FIXED: was hardcoded "auto" before

    logSuccess("WATER command! Running pump for " + String(dur) + "ms requestId=" + currentRequestId);

    postWateringLog("started", 0, currentReason, currentRequestId);
    relayOn();

    pumpStartTime = millis();
    pumpDuration  = dur;

  } else {
    Serial.printf("[Command] IDLE — %s\n", reason);
  }
}

// ──────────────────────────────────────────────
// Check pump stop
// ──────────────────────────────────────────────
void checkPump() {
  if (!pumpOn) return;

  unsigned long elapsed = millis() - pumpStartTime;

  if (elapsed >= pumpDuration) {
    relayOff();
    logSuccess("Pump completed after " + String(elapsed) + "ms");
    // FIXED: uses currentReason not hardcoded "auto"
    postWateringLog("completed", elapsed, currentReason, currentRequestId);
    currentRequestId = "";
    currentReason    = "";
  } else {
    static unsigned long lastPumpLog = 0;
    if (millis() - lastPumpLog > 5000) {
      logInfo("Pump running: " + String(elapsed) + "ms / " + String(pumpDuration) + "ms");
      lastPumpLog = millis();
    }
  }
}

// ──────────────────────────────────────────────
// SETUP
// ──────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n========================================");
  Serial.println("[Boot] Smart Plant Watering — Fixed+Log");
  Serial.println("========================================");

  pinMode(SOIL_DO_PIN, INPUT);
  pinMode(LDR_DO_PIN,  INPUT);
  pinMode(RELAY_PIN,   OUTPUT);
  relayOff();

  // Quick relay test at boot — motor should spin 1s to confirm wiring
  Serial.println("[Boot] Relay test: ON for 1s ...");
  relayOn();
  delay(1000);
  relayOff();
  Serial.println("[Boot] Relay test done. If motor didn't run, check wiring on pin 14");

  dht.begin();
  delay(2000);

  connectWiFi();

  if (WiFi.status() == WL_CONNECTED) {
    logInfo("ESP32 booted — WiFi OK IP=" + WiFi.localIP().toString());
    postSensorData();
  }

  lastSensorPost  = millis();
  lastCommandPoll = millis();

  Serial.printf("[Boot] Ready. Sensor every %ds, command poll every %ds\n",
    SENSOR_INTERVAL_MS / 1000, COMMAND_INTERVAL_MS / 1000);
}

// ──────────────────────────────────────────────
// LOOP
// ──────────────────────────────────────────────
void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WiFi] Lost connection — reconnecting...");
    connectWiFi();
    delay(5000);
    return;
  }

  unsigned long now = millis();

  checkPump();

  if (now - lastSensorPost >= SENSOR_INTERVAL_MS) {
    postSensorData();
    lastSensorPost = now;
  }

  if (!pumpOn && (now - lastCommandPoll >= COMMAND_INTERVAL_MS)) {
    pollCommand();
    lastCommandPoll = now;
  }

  delay(100);
}
