/**
 * server.js — Smart Plant Watering Backend
 *
 * CHANGES:
 *   1. potSizeCategory + plantSizeCategory now affect:
 *        - Water volume delivered (small pot = less water, large = more)
 *        - Score threshold (large pot = needs higher dryness score before watering)
 *        - Cooldown period (large pot retains water longer)
 *   2. calculateWaterScore() now receives `settings` so size config is applied
 *   3. manualWaterDuration() uses size multipliers for consistent manual duration
 *   4. /dashboard-state exposes effectiveThreshold so the UI can show it
 *   5. POST /esp32-log  — ESP32 posts Serial-style logs here
 *   6. GET  /esp32-logs — Dashboard polls this to show live ESP32 activity
 */

const express = require("express");
const cors    = require("cors");
const path    = require("path");

const { getPlantNames, getPlantProfile, PLANT_PROFILES } = require("./config/plants");
const { keepRecentItems, readDb, updateDb }              = require("./storage/db");
const { calculateWaterScore, getSizeConfig }             = require("./scoring");

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
  const scored = _scoredForDisplay(db);
  return {
    currentPlant:       db.currentPlant,
    config:             { ...getPlantProfile(db.currentPlant), effectiveThreshold: scored.effectiveThreshold },
    supportedPlants:    getPlantNames(),
    settings:           db.settings,
    manualWaterRequest: db.manualWaterRequest,
    detectionActive:    db.detectionActive ?? false
  };
}

/** Compute a display-only scored object from the latest sensor entry (or defaults). */
function _scoredForDisplay(db) {
  const latest = db.sensorData && db.sensorData.length > 0
    ? db.sensorData[db.sensorData.length - 1]
    : {};
  return calculateWaterScore(latest, db.currentPlant, db.settings);
}

function buildDashboardState(db) {
  const sensorHistory = keepRecentItems(db.sensorData, 30);
  const wateringLogs  = keepRecentItems(db.wateringLogs, 20);
  const latest        = sensorHistory[sensorHistory.length - 1] || null;
  const scored        = latest
    ? calculateWaterScore(latest, db.currentPlant, db.settings)
    : _scoredForDisplay(db);

  return {
    currentPlant:       db.currentPlant,
    currentConfig:      {
      ...getPlantProfile(db.currentPlant),
      effectiveThreshold:    scored.effectiveThreshold,
      recommendedCooldownMs: scored.recommendedCooldownMs,
      sizeInfo:              scored.sizeInfo,
    },
    supportedPlants:    getPlantNames(),
    latestSensor:       latest
      ? { ...latest, effectiveThreshold: scored.effectiveThreshold, sizeInfo: scored.sizeInfo }
      : null,
    sensorHistory,
    wateringLogs,
    pumpStatus:         db.pumpStatus,
    settings:           db.settings,
    manualWaterRequest: db.manualWaterRequest,
    detectionActive:    db.detectionActive ?? false
  };
}

/**
 * Calculate manual-watering duration and volume using the same size multipliers
 * as auto scoring — so pot/plant size affects manual watering too.
 */
function manualWaterDuration(settings, plantName) {
  const profile    = getPlantProfile(plantName);
  const pumpFlow   = settings.pumpFlowMlPerSec || 20;
  const sizeConf   = getSizeConfig(
    settings.potSizeCategory   || "medium",
    settings.plantSizeCategory || "medium"
  );

  const baseWater  = profile.baseWaterMl || 40;
  const scaledWater = baseWater * sizeConf.waterMultiplier;
  const waterMl    = Math.max(
    settings.minWaterMl  || 10,
    Math.min(settings.maxWaterMl || 200, scaledWater)
  );

  return {
    durationMs: Math.round((waterMl / pumpFlow) * 1000),
    volumeMl:   Math.round(waterMl * 10) / 10,
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

  // Use size-adjusted cooldown from the scored object
  const effectiveCooldown = scored.recommendedCooldownMs
    || settings.cooldownMs
    || 3600000;

  if (pump.lastWateredAt) {
    const elapsed = now - new Date(pump.lastWateredAt).getTime();
    if (elapsed < effectiveCooldown) {
      const remainMins = Math.ceil((effectiveCooldown - elapsed) / 60000);
      return {
        command: "IDLE",
        reason:  `cooldown (${remainMins}m left)`,
        score:   scored.score,
      };
    }
  }

  if (!scored.thresholdMet) {
    return {
      command: "IDLE",
      reason:  `score_below_threshold (${scored.score} < ${scored.effectiveThreshold})`,
      score:   scored.score,
    };
  }

  const pumpFlow = settings.pumpFlowMlPerSec || 20;
  const waterMl  = Math.max(
    settings.minWaterMl  || 10,
    Math.min(settings.maxWaterMl || 200, scored.recommendedWaterMl)
  );

  return {
    command:    "WATER",
    durationMs: Math.round((waterMl / pumpFlow) * 1000),
    volumeMl:   waterMl,
    reason:     "auto_score",
    score:      scored.score,
    effectiveThreshold: scored.effectiveThreshold,
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

  const scored = _scoredForDisplay(db);
  addEsp32Log(
    "info",
    `Config updated — plant=${db.currentPlant} pot=${db.settings.potSizeCategory} plantSize=${db.settings.plantSizeCategory} effectiveThreshold=${scored.effectiveThreshold} waterMult=${scored.sizeInfo?.waterMultiplier}`,
    "backend"
  );

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

  // Pass settings so pot/plant size affects the score
  const scored = calculateWaterScore(payload, db0.currentPlant, db0.settings);

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
    effectiveThreshold:    scored.effectiveThreshold,
    thresholdMet:          scored.thresholdMet,
    recommendedWaterMl:    scored.recommendedWaterMl,
    recommendedDurationMs: scored.recommendedDurationMs,
    recommendedCooldownMs: scored.recommendedCooldownMs,
    sizeInfo:              scored.sizeInfo,
    pumpState:             Boolean(payload.pumpState),
    mode:                  payload.mode || "online",
    timestamp,
    serverReceivedAt:      new Date().toISOString()
  };

  addEsp32Log(
    "info",
    `Sensor — soil=${scored.moisturePercent}% temp=${payload.temperature}°C hum=${payload.humidity}% light=${scored.lightPercent}% score=${scored.score}/${scored.effectiveThreshold} [pot=${db0.settings.potSizeCategory} plant=${db0.settings.plantSizeCategory}]`,
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

  res.status(201).json({
    message:  "Sensor data stored",
    score:    scored.score,
    threshold: scored.effectiveThreshold,
    decision: db.latestDecision,
    sizeInfo: scored.sizeInfo,
  });
});

// ── GET /command — ESP32 polls this ──
app.get("/command", async (_req, res) => {
  const db = await readDb();

  if (db.manualWaterRequest?.pending) {
    const { durationMs, volumeMl } = manualWaterDuration(db.settings, db.currentPlant);
    addEsp32Log(
      "success",
      `Command → WATER (manual) ${durationMs}ms (${volumeMl}ml) plant=${db.currentPlant} pot=${db.settings.potSizeCategory} plantSize=${db.settings.plantSizeCategory}`,
      "backend"
    );
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
  const scored   = calculateWaterScore(latest, db.currentPlant, db.settings);
  const decision = decideCommand(db, scored);

  if (decision.command === "WATER") {
    addEsp32Log(
      "success",
      `Command → WATER (auto_score) ${decision.durationMs}ms score=${scored.score}/${scored.effectiveThreshold} pot=${db.settings.potSizeCategory} plantSize=${db.settings.plantSizeCategory}`,
      "backend"
    );
  }

  res.json({
    command:           decision.command,
    durationMs:        decision.durationMs || 0,
    volumeMl:          decision.volumeMl   || 0,
    reason:            decision.reason,
    requestId:         decision.requestId  || null,
    score:             decision.score,
    threshold:         scored.effectiveThreshold,
    detectionActive:   true,
    sizeInfo:          scored.sizeInfo,
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
  const db0 = await readDb();
  const { durationMs, volumeMl } = manualWaterDuration(db0.settings, db0.currentPlant);
  addEsp32Log(
    "info",
    `Manual watering queued — requestId=${requestId} will deliver ${volumeMl}ml over ${durationMs}ms [pot=${db0.settings.potSizeCategory} plantSize=${db0.settings.plantSizeCategory}]`,
    "backend"
  );
  const db = await updateDb((cur) => ({
    ...cur,
    manualWaterRequest: {
      pending:     true,
      id:          requestId,
      requestedAt: new Date().toISOString(),
      consumedAt:  null
    }
  }));
  res.status(202).json({
    message: "Manual watering request queued",
    manualWaterRequest: db.manualWaterRequest,
    previewDurationMs: durationMs,
    previewVolumeMl:   volumeMl,
  });
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
