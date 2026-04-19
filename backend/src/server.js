/**
 * server.js — Smart Plant Watering Backend
 * Fixes:
 *   - Manual watering now works even when detection is OFF
 *   - POST /manual-watering/cancel  → clears stuck pending request
 *   - /command serves manual request regardless of detection flag
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

function decideCommand(db, scored) {
  const now      = Date.now();
  const settings = db.settings;
  const pump     = db.pumpStatus;
  const manual   = db.manualWaterRequest;

  // Never run pump if it's already on
  if (pump.isOn) {
    return { command: "IDLE", reason: "pump_already_on", score: scored.score };
  }

  // ── MANUAL REQUEST: bypasses detection gate and cooldown ──
  // Manual always works whether detection is ON or OFF
  if (manual.pending) {
    const durationMs = settings.pumpDurationMs || 7000;
    return {
      command:    "WATER",
      durationMs,
      volumeMl:   Math.round((durationMs / 1000) * (settings.pumpFlowMlPerSec || 20)),
      reason:     "manual",
      requestId:  manual.id,
      score:      scored.score
    };
  }

  // ── AUTO: detection gate applies ──
  if (!db.detectionActive) {
    return { command: "IDLE", reason: "detection_off", score: scored.score };
  }

  // Cooldown check
  if (pump.lastWateredAt) {
    const elapsed = now - new Date(pump.lastWateredAt).getTime();
    if (elapsed < (settings.cooldownMs || 3600000)) {
      return { command: "IDLE", reason: "cooldown", score: scored.score };
    }
  }

  // Score threshold
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

  // Always check for a pending manual request first (even if no sensor data)
  if (db.manualWaterRequest?.pending) {
    const settings   = db.settings;
    const durationMs = settings.pumpDurationMs || 7000;
    return res.json({
      command:    "WATER",
      durationMs,
      volumeMl:   Math.round((durationMs / 1000) * (settings.pumpFlowMlPerSec || 20)),
      reason:     "manual",
      requestId:  db.manualWaterRequest.id,
      score:      0,
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

  const db = await updateDb((cur) => {
    const next = {
      ...cur,
      wateringLogs: keepRecentItems([...cur.wateringLogs, logEntry], 300),
      pumpStatus:   { ...cur.pumpStatus }
    };
    if (event === "started")   { next.pumpStatus.isOn = true;  next.pumpStatus.lastChangedAt = timestamp; next.pumpStatus.lastReason = logEntry.reason; }
    if (event === "completed") { next.pumpStatus.isOn = false; next.pumpStatus.lastChangedAt = timestamp; next.pumpStatus.lastWateredAt = timestamp; next.pumpStatus.lastReason = logEntry.reason; }
    if (event === "skipped_cooldown" || event === "failed") { next.pumpStatus.isOn = false; next.pumpStatus.lastChangedAt = timestamp; next.pumpStatus.lastReason = logEntry.reason; }

    // Consume manual request when ESP32 confirms it acted on it
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

// ── POST /manual-watering/cancel  ← NEW ──
// Clears a stuck pending manual request so the button un-greys
app.post("/manual-watering/cancel", async (_req, res) => {
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

// ── GET /plant-profiles ──
app.get("/plant-profiles", (_req, res) => res.json(PLANT_PROFILES));

// ── GET /dashboard-state ──
app.get("/dashboard-state", async (_req, res) => {
  const db = await readDb();
  res.json(buildDashboardState(db));
});

app.get("/", (_req, res) => res.sendFile(path.join(dashboardDir, "index.html")));
app.listen(PORT, () => console.log(`Smart Plant Watering backend → http://localhost:${PORT}`));
