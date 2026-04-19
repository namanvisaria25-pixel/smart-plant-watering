/**
 * server.js — Smart Plant Watering Backend
 * CHANGES FROM ORIGINAL:
 *   1. POST /esp32-log  — ESP32 posts Serial-style logs here, visible on dashboard
 *   2. GET  /esp32-logs — Dashboard polls this to show live ESP32 activity
 *   3. Manual watering clears itself properly after ESP32 confirms via watering-log
 *   4. FIX: Manual watering now uses plant-profile duration (baseWaterMl / pumpFlowMlPerSec)
 *           instead of the hardcoded pumpDurationMs fallback (was always 7 s for every plant)
 *   (all existing endpoints unchanged)
 */

const express = require("express");
const cors    = require("cors");
const path    = require("path");

const { getPlantNames, getPlantProfile, PLANT_PROFILES } = require("./config/plants");
const { keepRecentItems, readDb, updateDb }              = require("./storage/db");
const { calculateWaterScore }                            = require("./scoring");

const app  = express();
const PORT = process.env.PORT || 3000;
const dashboardDir = path.join(__dirname, "..", "..", "dashboard");

app.use(cors());
app.use(express.json());
app.use(express.static(dashboardDir));

// ── In-memory ESP32 log ring buffer (last 200 entries) ──
let esp32Logs = [];
function addEsp32Log(level, message, source) {
  esp32Logs.push({
    ts:      new Date().toISOString(),
    level:   level || "info",
    message: String(message),
    source:  source || "esp32"
  });
  if (esp32Logs.length > 200) esp32Logs = esp32Logs.slice(-200);
}

const VALID_SIZES = ["small", "medium", "large"];

function isSupportedPlant(name) { return getPlantNames().includes(name); }

function buildConfigPayload(db) {
  return {
    currentPlant:       db.currentPlant,
    config:             getPlantProfile(db.currentPlant),
    supportedPlants:    getPlantNames(),
    settings:           db.settings,
    manualWaterRequest: db.manualWaterRequest,
    detectionActive:    db.detectionActive ?? false
  };
}

function buildDashboardState(db) {
  const sensorHistory = keepRecentItems(db.sensorData, 30);
  const wateringLogs  = keepRecentItems(db.wateringLogs, 20);
  return {
    currentPlant:       db.currentPlant,
    currentConfig:      getPlantProfile(db.currentPlant),
    supportedPlants:    getPlantNames(),
    latestSensor:       sensorHistory[sensorHistory.length - 1] || null,
    sensorHistory,
    wateringLogs,
    pumpStatus:         db.pumpStatus,
    settings:           db.settings,
    manualWaterRequest: db.manualWaterRequest,
    detectionActive:    db.detectionActive ?? false
  };
}

/**
 * Calculate the correct manual-watering duration for the current plant.
 * Uses profile.baseWaterMl clamped to [minWaterMl, maxWaterMl] divided by
 * pumpFlowMlPerSec. This is the same formula the auto-score path uses.
 */
function manualWaterDuration(settings, plantName) {
  const profile  = getPlantProfile(plantName);
  const pumpFlow = settings.pumpFlowMlPerSec || 20;
  const waterMl  = Math.max(
    settings.minWaterMl  || 15,
    Math.min(settings.maxWaterMl || 120, profile.baseWaterMl || 40)
  );
  return {
    durationMs: Math.round((waterMl / pumpFlow) * 1000),
    volumeMl:   Math.round(waterMl * 10) / 10
  };
}

function decideCommand(db, scored) {
  const now      = Date.now();
  const settings = db.settings;
  const pump     = db.pumpStatus;
  const manual   = db.manualWaterRequest;

  if (pump.isOn) {
    return { command: "IDLE", reason: "pump_already_on", score: scored.score };
  }

  // FIX: use plant-profile-based duration instead of hardcoded pumpDurationMs
  if (manual.pending) {
    const { durationMs, volumeMl } = manualWaterDuration(settings, db.currentPlant);
    return {
      command:   "WATER",
      durationMs,
      volumeMl,
      reason:    "manual",
      requestId: manual.id,
      score:     scored.score
    };
  }

  if (!db.detectionActive) {
    return { command: "IDLE", reason: "detection_off", score: scored.score };
  }

  if (pump.lastWateredAt) {
    const elapsed = now - new Date(pump.lastWateredAt).getTime();
    if (elapsed < (settings.cooldownMs || 3600000)) {
      return { command: "IDLE", reason: "cooldown", score: scored.score };
    }
  }

  if (!scored.thresholdMet) {
    return { command: "IDLE", reason: "score_below_threshold", score: scored.score };
  }

  const pumpFlow = settings.pumpFlowMlPerSec || 20;
  const waterMl  = Math.max(
    settings.minWaterMl  || 15,
    Math.min(settings.maxWaterMl || 120, scored.recommendedWaterMl)
  );
  return {
    command:    "WATER",
    durationMs: Math.round((waterMl / pumpFlow) * 1000),
    volumeMl:   waterMl,
    reason:     "auto_score",
    score:      scored.score
  };
}

// ── Health / ping ──
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/ping",   (_req, res) => res.send("pong"));

// ── POST /esp32-log ──
app.post("/esp32-log", (req, res) => {
  const { level, message } = req.body || {};
  if (!message) return res.status(400).json({ error: "message required" });
  addEsp32Log(level, message, "esp32");
  res.json({ ok: true });
});

// ── GET /esp32-logs ──
app.get("/esp32-logs", (_req, res) => {
  res.json({ logs: esp32Logs.slice(-100) });
});

// ── GET /config ──
app.get("/config", async (_req, res) => {
  const db = await readDb();
  res.json(buildConfigPayload(db));
});

// ── POST /config ──
app.post("/config", async (req, res) => {
  const {
    plantType, cooldownMs, pumpDurationMs,
    potSizeCategory, plantSizeCategory,
    pumpFlowMlPerSec, minWaterMl, maxWaterMl
  } = req.body;

  if (plantType && !isSupportedPlant(plantType)) {
    return res.status(400).json({ error: "Unsupported plant type", supportedPlants: getPlantNames() });
  }
  if (potSizeCategory   && !VALID_SIZES.includes(potSizeCategory))   return res.status(400).json({ error: "potSizeCategory must be small | medium | large" });
  if (plantSizeCategory && !VALID_SIZES.includes(plantSizeCategory)) return res.status(400).json({ error: "plantSizeCategory must be small | medium | large" });

  const db = await updateDb((cur) => {
    const next = { ...cur };
    if (plantType) next.currentPlant = plantType;
    next.settings = {
      ...cur.settings,
      ...(Number.isFinite(cooldownMs)       ? { cooldownMs }       : {}),
      ...(Number.isFinite(pumpDurationMs)   ? { pumpDurationMs }   : {}),
      ...(Number.isFinite(pumpFlowMlPerSec) ? { pumpFlowMlPerSec } : {}),
      ...(Number.isFinite(minWaterMl)       ? { minWaterMl }       : {}),
      ...(Number.isFinite(maxWaterMl)       ? { maxWaterMl }       : {}),
      ...(potSizeCategory   ? { potSizeCategory }   : {}),
      ...(plantSizeCategory ? { plantSizeCategory } : {})
    };
    return next;
  });
  return res.json({ message: "Configuration updated", ...buildConfigPayload(db) });
});

// ── POST /detection ──
app.post("/detection", async (req, res) => {
  const { active } = req.body;
  if (typeof active !== "boolean") {
    return res.status(400).json({ error: "body must be { active: true | false }" });
  }
  const db = await updateDb((cur) => ({ ...cur, detectionActive: active }));
  addEsp32Log("info", `Detection set to ${active} via dashboard`, "backend");
  res.json({ detectionActive: db.detectionActive });
});

// ── POST /sensor-data ──
app.post("/sensor-data", async (req, res) => {
  const payload   = req.body || {};
  const timestamp = payload.timestamp || new Date().toISOString();
  const db0       = await readDb();
  const scored    = calculateWaterScore(payload, db0.currentPlant);

  const entry = {
    deviceId:              payload.deviceId        || "esp32-plant-01",
    plantType:             isSupportedPlant(payload.plantType) ? payload.plantType : undefined,
    soilMoistureRaw:       payload.soilMoistureRaw     ?? null,
    soilMoisturePercent:   scored.moisturePercent,
    soilDigital:           payload.soilDigital          ?? null,
    temperature:           payload.temperature          ?? null,
    humidity:              payload.humidity             ?? null,
    lightRaw:              payload.lightRaw             ?? null,
    lightPercent:          scored.lightPercent,
    lightDigital:          payload.lightDigital         ?? null,
    waterRequirementScore: scored.score,
    scoreFactors:          scored.factors,
    thresholdMet:          scored.thresholdMet,
    recommendedWaterMl:    scored.recommendedWaterMl,
    recommendedDurationMs: scored.recommendedDurationMs,
    pumpState:             Boolean(payload.pumpState),
    mode:                  payload.mode || "online",
    timestamp,
    serverReceivedAt:      new Date().toISOString()
  };

  addEsp32Log(
    "info",
    `Sensor data received — soil=${scored.moisturePercent}% temp=${payload.temperature}°C hum=${payload.humidity}% light=${scored.lightPercent}% score=${scored.score}`,
    "esp32"
  );

  const db = await updateDb((cur) => {
    const pumpStateChanged =
      typeof payload.pumpState === "boolean" &&
      payload.pumpState !== cur.pumpStatus.isOn;
    const next = {
      ...cur,
      sensorData: keepRecentItems([...cur.sensorData, entry], 500),
      pumpStatus: {
        ...cur.pumpStatus,
        isOn:          typeof payload.pumpState === "boolean" ? payload.pumpState : cur.pumpStatus.isOn,
        lastChangedAt: pumpStateChanged ? timestamp : cur.pumpStatus.lastChangedAt
      },
      latestDecision: decideCommand(cur, scored)
    };
    if (entry.plantType) next.currentPlant = entry.plantType;
    return next;
  });

  res.status(201).json({ message: "Sensor data stored", score: scored.score, decision: db.latestDecision });
});

// ── GET /command — ESP32 polls this ──
app.get("/command", async (_req, res) => {
  const db = await readDb();

  // FIX: use plant-profile-based duration instead of hardcoded pumpDurationMs
  if (db.manualWaterRequest?.pending) {
    const { durationMs, volumeMl } = manualWaterDuration(db.settings, db.currentPlant);
    addEsp32Log("success", `Command sent to ESP32: WATER (manual) for ${durationMs}ms (${volumeMl}ml) — plant: ${db.currentPlant}`, "backend");
    return res.json({
      command:         "WATER",
      durationMs,
      volumeMl,
      reason:          "manual",
      requestId:       db.manualWaterRequest.id,
      score:           0,
      detectionActive: db.detectionActive ?? false
    });
  }

  if (!db.sensorData || db.sensorData.length === 0) {
    return res.json({ command: "IDLE", reason: "no_sensor_data", score: 0 });
  }

  if (!db.detectionActive) {
    return res.json({ command: "IDLE", reason: "detection_off", score: 0, detectionActive: false });
  }

  const latest   = db.sensorData[db.sensorData.length - 1];
  const scored   = calculateWaterScore(latest, db.currentPlant);
  const decision = decideCommand(db, scored);

  if (decision.command === "WATER") {
    addEsp32Log("success", `Command sent to ESP32: WATER (auto_score) for ${decision.durationMs}ms`, "backend");
  }

  res.json({
    command:         decision.command,
    durationMs:      decision.durationMs || 0,
    volumeMl:        decision.volumeMl   || 0,
    reason:          decision.reason,
    requestId:       decision.requestId  || null,
    score:           decision.score,
    threshold:       getPlantProfile(db.currentPlant).scoreThreshold,
    detectionActive: true
  });
});

// ── GET /sensor-history ──
app.get("/sensor-history", async (req, res) => {
  const limit = Number.parseInt(req.query.limit, 10) || 30;
  const db    = await readDb();
  res.json(keepRecentItems(db.sensorData, Math.min(limit, 200)));
});

// ── POST /watering-log ──
app.post("/watering-log", async (req, res) => {
  const payload   = req.body || {};
  const timestamp = payload.timestamp || new Date().toISOString();
  const event     = payload.event || "completed";

  const logEntry = {
    deviceId:   payload.deviceId  || "esp32-plant-01",
    event,
    reason:     payload.reason    || "automatic",
    durationMs: payload.durationMs ?? 0,
    volumeMl:   payload.volumeMl  ?? null,
    score:      payload.score     ?? null,
    requestId:  payload.requestId || null,
    timestamp,
    serverReceivedAt: new Date().toISOString()
  };

  addEsp32Log(
    event === "completed" ? "success" : event === "started" ? "info" : "warn",
    `Pump ${event} — reason=${logEntry.reason} duration=${logEntry.durationMs}ms volume=${logEntry.volumeMl ?? "?"}ml`,
    "esp32"
  );

  const db = await updateDb((cur) => {
    const next = {
      ...cur,
      wateringLogs: keepRecentItems([...cur.wateringLogs, logEntry], 300),
      pumpStatus:   { ...cur.pumpStatus }
    };
    if (event === "started")   { next.pumpStatus.isOn = true;  next.pumpStatus.lastChangedAt = timestamp; next.pumpStatus.lastReason = logEntry.reason; }
    if (event === "completed") { next.pumpStatus.isOn = false; next.pumpStatus.lastChangedAt = timestamp; next.pumpStatus.lastWateredAt = timestamp; next.pumpStatus.lastReason = logEntry.reason; }
    if (event === "skipped_cooldown" || event === "failed") { next.pumpStatus.isOn = false; next.pumpStatus.lastChangedAt = timestamp; next.pumpStatus.lastReason = logEntry.reason; }

    if (
      logEntry.requestId &&
      cur.manualWaterRequest?.pending &&
      cur.manualWaterRequest.id === logEntry.requestId
    ) {
      next.manualWaterRequest = { ...cur.manualWaterRequest, pending: false, consumedAt: timestamp };
    }
    return next;
  });

  res.status(201).json({ message: "Watering event stored", pumpStatus: db.pumpStatus });
});

// ── POST /manual-watering ──
app.post("/manual-watering", async (_req, res) => {
  const requestId = `manual-${Date.now()}`;
  addEsp32Log("info", `Manual watering queued — requestId=${requestId}`, "backend");
  const db = await updateDb((cur) => ({
    ...cur,
    manualWaterRequest: {
      pending:     true,
      id:          requestId,
      requestedAt: new Date().toISOString(),
      consumedAt:  null
    }
  }));
  res.status(202).json({ message: "Manual watering request queued", manualWaterRequest: db.manualWaterRequest });
});

// ── POST /manual-watering/cancel ──
app.post("/manual-watering/cancel", async (_req, res) => {
  addEsp32Log("warn", "Manual watering request cancelled via dashboard", "backend");
  const db = await updateDb((cur) => ({
    ...cur,
    manualWaterRequest: {
      pending:     false,
      id:          null,
      requestedAt: null,
      consumedAt:  null
    }
  }));
  res.json({ message: "Manual watering request cancelled", manualWaterRequest: db.manualWaterRequest });
});

// ── POST /clear-data ──
app.post("/clear-data", async (_req, res) => {
  addEsp32Log("warn", "All data cleared via dashboard", "backend");
  const db = await updateDb((cur) => ({
    ...cur,
    sensorData:   [],
    wateringLogs: [],
    pumpStatus: {
      isOn:          false,
      lastChangedAt: null,
      lastWateredAt: null,
      lastReason:    null
    },
    manualWaterRequest: {
      pending:     false,
      id:          null,
      requestedAt: null,
      consumedAt:  null
    }
  }));
  res.json({ message: "Data cleared", pumpStatus: db.pumpStatus });
});

app.get("/plant-profiles", (_req, res) => res.json(PLANT_PROFILES));

// ── GET /dashboard-state ──
app.get("/dashboard-state", async (_req, res) => {
  const db = await readDb();
  res.json(buildDashboardState(db));
});

app.get("/", (_req, res) => res.sendFile(path.join(dashboardDir, "index.html")));
app.listen(PORT, () => {
  console.log(`Smart Plant Watering backend → http://localhost:${PORT}`);
  addEsp32Log("info", `Backend started on port ${PORT}`, "backend");
});
