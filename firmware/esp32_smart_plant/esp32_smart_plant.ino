#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include "DHT.h"

const char* WIFI_SSID = "Chhaya";
const char* WIFI_PASSWORD = "123456789";
const char* API_BASE_URL = "https://smart-plant-watering.onrender.com";
const char* DEVICE_ID = "esp32-plant-01";

#define SOIL_PIN 34
#define LDR_PIN 35
#define DHT_PIN 4
#define RELAY_PIN 26
#define DHTTYPE DHT11

const int RELAY_ON_LEVEL = HIGH;
const int RELAY_OFF_LEVEL = LOW;

const int SOIL_DRY_RAW = 3000;
const int SOIL_WET_RAW = 1200;
const int LIGHT_DARK_RAW = 3800;
const int LIGHT_BRIGHT_RAW = 800;

unsigned long SENSOR_INTERVAL_MS = 30000;
unsigned long CONFIG_REFRESH_MS = 60000;
unsigned long WATER_COOLDOWN_MS = 3600000;
unsigned long PUMP_DURATION_MS = 7000;

struct PlantProfile {
  String name;
  float soilDrynessWeight;
  float temperatureWeight;
  float humidityWeight;
  float lightWeight;
  float scoreThreshold;
};

struct SensorSnapshot {
  int soilRaw;
  float soilMoisturePercent;
  float soilDryness;
  float temperature;
  float humidity;
  int lightRaw;
  float lightPercent;
  float temperatureNorm;
  float humidityNorm;
  float waterRequirementScore;
};

DHT dht(DHT_PIN, DHTTYPE);
WiFiClient plainClient;
WiFiClientSecure secureClient;

PlantProfile plantProfiles[] = {
  {"Aloe Vera", 0.55, 0.20, 0.10, 0.15, 58.0},
  {"Money Plant", 0.50, 0.20, 0.12, 0.18, 50.0},
  {"Holy Basil (Tulsi)", 0.45, 0.22, 0.08, 0.20, 43.0},
  {"Rosemary", 0.52, 0.18, 0.12, 0.18, 55.0},
  {"Snake Plant", 0.58, 0.18, 0.10, 0.14, 64.0}
};

String selectedPlant = "Money Plant";
String pendingManualRequestId = "";
String lastHandledManualRequestId = "";
bool cloudAvailable = false;
bool pumpIsOn = false;
float lastValidTemperature = 28.0;
float lastValidHumidity = 60.0;

unsigned long lastSensorReadMs = 0;
unsigned long lastConfigReadMs = 0;
unsigned long lastWateringMs = 0;

PlantProfile activeProfile = plantProfiles[1];

PlantProfile getProfileByName(const String& plantName) {
  for (PlantProfile profile : plantProfiles) {
    if (profile.name == plantName) {
      return profile;
    }
  }
  return plantProfiles[1];
}

float constrainPercent(float value) {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

float mapRawToPercent(int rawValue, int dryValue, int wetValue) {
  float percent = ((float)(dryValue - rawValue) * 100.0) / (float)(dryValue - wetValue);
  return constrainPercent(percent);
}

float normalizeTemperature(float temperature) {
  return constrainPercent((temperature / 45.0) * 100.0);
}

float normalizeHumidity(float humidity) {
  return constrainPercent(humidity);
}

float computeWaterRequirementScore(const SensorSnapshot& snapshot) {
  return (activeProfile.soilDrynessWeight * snapshot.soilDryness) +
         (activeProfile.temperatureWeight * snapshot.temperatureNorm) -
         (activeProfile.humidityWeight * snapshot.humidityNorm) +
         (activeProfile.lightWeight * snapshot.lightPercent);
}

bool connectToWiFi() {
  if (WiFi.status() == WL_CONNECTED) {
    return true;
  }

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to WiFi");

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi connected");
    Serial.println(WiFi.localIP());
    return true;
  }

  Serial.println("\nWiFi connection failed, local fallback enabled");
  return false;
}

SensorSnapshot readSensors() {
  SensorSnapshot snapshot;

  snapshot.soilRaw = analogRead(SOIL_PIN);
  snapshot.lightRaw = analogRead(LDR_PIN);

  float temperature = dht.readTemperature();
  float humidity = dht.readHumidity();

  if (!isnan(temperature)) {
    lastValidTemperature = temperature;
  }

  if (!isnan(humidity)) {
    lastValidHumidity = humidity;
  }

  snapshot.temperature = lastValidTemperature;
  snapshot.humidity = lastValidHumidity;
  snapshot.soilMoisturePercent = mapRawToPercent(snapshot.soilRaw, SOIL_DRY_RAW, SOIL_WET_RAW);
  snapshot.soilDryness = 100.0 - snapshot.soilMoisturePercent;
  snapshot.lightPercent = mapRawToPercent(snapshot.lightRaw, LIGHT_DARK_RAW, LIGHT_BRIGHT_RAW);
  snapshot.temperatureNorm = normalizeTemperature(snapshot.temperature);
  snapshot.humidityNorm = normalizeHumidity(snapshot.humidity);
  snapshot.waterRequirementScore = computeWaterRequirementScore(snapshot);

  return snapshot;
}

bool postJson(const String& url, JsonDocument& doc) {
  if (WiFi.status() != WL_CONNECTED) {
    return false;
  }

  HTTPClient http;

  if (url.startsWith("https://")) {
    secureClient.setInsecure();
    http.begin(secureClient, url);
  } else {
    http.begin(plainClient, url);
  }

  http.addHeader("Content-Type", "application/json");

  String requestBody;
  serializeJson(doc, requestBody);
  int responseCode = http.POST(requestBody);

  if (responseCode > 0) {
    Serial.printf("POST %s -> %d\n", url.c_str(), responseCode);
  } else {
    Serial.printf("POST failed: %s\n", http.errorToString(responseCode).c_str());
  }

  http.end();
  return responseCode > 0 && responseCode < 300;
}

bool sendSensorData(const SensorSnapshot& snapshot, const char* mode) {
  StaticJsonDocument<512> doc;
  doc["deviceId"] = DEVICE_ID;
  doc["plantType"] = selectedPlant;
  doc["soilMoistureRaw"] = snapshot.soilRaw;
  doc["soilMoisturePercent"] = snapshot.soilMoisturePercent;
  doc["soilDryness"] = snapshot.soilDryness;
  doc["temperature"] = snapshot.temperature;
  doc["humidity"] = snapshot.humidity;
  doc["lightRaw"] = snapshot.lightRaw;
  doc["lightPercent"] = snapshot.lightPercent;
  doc["waterRequirementScore"] = snapshot.waterRequirementScore;
  doc["pumpState"] = pumpIsOn;
  doc["mode"] = mode;

  return postJson(String(API_BASE_URL) + "/sensor-data", doc);
}

void sendWateringLog(const char* event, const char* reason, unsigned long durationMs, float score, const String& requestId) {
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }

  StaticJsonDocument<320> doc;
  doc["deviceId"] = DEVICE_ID;
  doc["event"] = event;
  doc["reason"] = reason;
  doc["durationMs"] = durationMs;
  doc["score"] = score;

  if (requestId.length() > 0) {
    doc["requestId"] = requestId;
  }

  postJson(String(API_BASE_URL) + "/watering-log", doc);
}

void applyCloudConfig(JsonDocument& doc) {
  selectedPlant = doc["currentPlant"] | selectedPlant;
  activeProfile = getProfileByName(selectedPlant);

  if (doc["config"].is<JsonObject>()) {
    JsonObject config = doc["config"].as<JsonObject>();
    activeProfile.soilDrynessWeight = config["soilDrynessWeight"] | activeProfile.soilDrynessWeight;
    activeProfile.temperatureWeight = config["temperatureWeight"] | activeProfile.temperatureWeight;
    activeProfile.humidityWeight = config["humidityWeight"] | activeProfile.humidityWeight;
    activeProfile.lightWeight = config["lightWeight"] | activeProfile.lightWeight;
    activeProfile.scoreThreshold = config["scoreThreshold"] | activeProfile.scoreThreshold;
  }

  if (doc["settings"].is<JsonObject>()) {
    JsonObject settings = doc["settings"].as<JsonObject>();
    WATER_COOLDOWN_MS = settings["cooldownMs"] | WATER_COOLDOWN_MS;
    PUMP_DURATION_MS = settings["pumpDurationMs"] | PUMP_DURATION_MS;
  }

  if (doc["manualWaterRequest"].is<JsonObject>()) {
    JsonObject manualRequest = doc["manualWaterRequest"].as<JsonObject>();
    bool pending = manualRequest["pending"] | false;
    String requestId = manualRequest["id"] | "";

    if (pending && requestId != lastHandledManualRequestId) {
      pendingManualRequestId = requestId;
    } else if (!pending) {
      pendingManualRequestId = "";
    }
  }
}

bool fetchConfigFromCloud() {
  if (WiFi.status() != WL_CONNECTED) {
    cloudAvailable = false;
    return false;
  }

  HTTPClient http;
  String url = String(API_BASE_URL) + "/config";

  if (url.startsWith("https://")) {
    secureClient.setInsecure();
    http.begin(secureClient, url);
  } else {
    http.begin(plainClient, url);
  }

  int responseCode = http.GET();

  if (responseCode <= 0) {
    Serial.printf("Config fetch failed: %s\n", http.errorToString(responseCode).c_str());
    cloudAvailable = false;
    http.end();
    return false;
  }

  if (responseCode != 200) {
    Serial.printf("Unexpected config status: %d\n", responseCode);
    cloudAvailable = false;
    http.end();
    return false;
  }

  String responseBody = http.getString();
  StaticJsonDocument<1024> doc;
  DeserializationError error = deserializeJson(doc, responseBody);
  http.end();

  if (error) {
    Serial.println("Could not parse config JSON");
    cloudAvailable = false;
    return false;
  }

  applyCloudConfig(doc);
  cloudAvailable = true;
  Serial.printf("Active plant: %s | Threshold: %.2f\n", selectedPlant.c_str(), activeProfile.scoreThreshold);
  return true;
}

bool cooldownComplete() {
  if (lastWateringMs == 0) {
    return true;
  }

  return millis() - lastWateringMs >= WATER_COOLDOWN_MS;
}

void setPumpState(bool shouldTurnOn) {
  pumpIsOn = shouldTurnOn;
  digitalWrite(RELAY_PIN, shouldTurnOn ? RELAY_ON_LEVEL : RELAY_OFF_LEVEL);
}

void runPump(unsigned long durationMs, const char* reason, float score, const String& requestId) {
  setPumpState(true);
  sendWateringLog("started", reason, durationMs, score, requestId);

  Serial.printf("Pump ON for %lu ms (%s)\n", durationMs, reason);
  delay(durationMs);

  setPumpState(false);
  lastWateringMs = millis();
  sendWateringLog("completed", reason, durationMs, score, requestId);
  Serial.println("Pump OFF");
}

void handleWateringDecision(const SensorSnapshot& snapshot) {
  bool manualRequestPending = pendingManualRequestId.length() > 0 &&
                              pendingManualRequestId != lastHandledManualRequestId;
  bool automaticWaterNeeded = snapshot.waterRequirementScore >= activeProfile.scoreThreshold;

  if (manualRequestPending) {
    if (cooldownComplete()) {
      runPump(PUMP_DURATION_MS, cloudAvailable ? "manual" : "manual-offline", snapshot.waterRequirementScore, pendingManualRequestId);
    } else {
      sendWateringLog("skipped_cooldown", "manual", 0, snapshot.waterRequirementScore, pendingManualRequestId);
      Serial.println("Manual watering skipped because cooldown is active");
    }

    lastHandledManualRequestId = pendingManualRequestId;
    pendingManualRequestId = "";
    return;
  }

  if (automaticWaterNeeded && cooldownComplete()) {
    runPump(PUMP_DURATION_MS, cloudAvailable ? "automatic" : "offline-fallback", snapshot.waterRequirementScore, "");
  }
}

void printSnapshot(const SensorSnapshot& snapshot) {
  Serial.println("---------------------------");
  Serial.printf("Plant: %s\n", selectedPlant.c_str());
  Serial.printf("Soil Raw: %d | Moisture: %.1f%% | Dryness: %.1f%%\n", snapshot.soilRaw, snapshot.soilMoisturePercent, snapshot.soilDryness);
  Serial.printf("Temp: %.1f C | Humidity: %.1f%%\n", snapshot.temperature, snapshot.humidity);
  Serial.printf("Light Raw: %d | Light: %.1f%%\n", snapshot.lightRaw, snapshot.lightPercent);
  Serial.printf("Water Score: %.2f | Threshold: %.2f\n", snapshot.waterRequirementScore, activeProfile.scoreThreshold);
  Serial.printf("Mode: %s\n", cloudAvailable ? "Cloud connected" : "Offline fallback");
}

void setup() {
  Serial.begin(115200);
  pinMode(RELAY_PIN, OUTPUT);
  setPumpState(false);
  dht.begin();

  analogReadResolution(12);
  activeProfile = getProfileByName(selectedPlant);

  connectToWiFi();
  fetchConfigFromCloud();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    connectToWiFi();
  }

  unsigned long now = millis();

  if (now - lastConfigReadMs >= CONFIG_REFRESH_MS) {
    fetchConfigFromCloud();
    lastConfigReadMs = now;
  }

  if (now - lastSensorReadMs >= SENSOR_INTERVAL_MS) {
    SensorSnapshot snapshot = readSensors();
    printSnapshot(snapshot);

    if (cloudAvailable) {
      sendSensorData(snapshot, "online");
    } else {
      sendSensorData(snapshot, "offline");
    }

    handleWateringDecision(snapshot);
    lastSensorReadMs = now;
  }
}
