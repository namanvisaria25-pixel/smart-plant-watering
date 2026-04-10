const express = require("express");
const cors = require("cors");
const path = require("path");
const { getPlantNames, getPlantProfile, PLANT_PROFILES } = require("./config/plants");
const { keepRecentItems, readDb, updateDb } = require("./storage/db");

const app = express();
const PORT = process.env.PORT || 3000;
const dashboardDir = path.join(__dirname, "..", "..", "dashboard");

app.use(cors());
app.use(express.json());
app.use(express.static(dashboardDir));

function buildConfigPayload(db) {
  return {
    currentPlant: db.currentPlant,
    config: getPlantProfile(db.currentPlant),
    supportedPlants: getPlantNames(),
    settings: db.settings,
    manualWaterRequest: db.manualWaterRequest
  };
}

function buildDashboardState(db) {
  const sensorHistory = keepRecentItems(db.sensorData, 30);
  const wateringLogs  = keepRecentItems(db.wateringLogs, 20);

  return {
    currentPlant:    db.currentPlant,
    currentConfig:   getPlantProfile(db.currentPlant),
    supportedPlants: getPlantNames(),
    latestSensor:    sensorHistory[sensorHistory.length - 1] || null,
    sensorHistory,
    wateringLogs,
    pumpStatus:          db.pumpStatus,
    settings:            db.settings,
    manualWaterRequest:  db.manualWaterRequest
  };
}

function isSupportedPlant(plantType) {
  return getPlantNames().includes(plantType);
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "smart-plant-watering-backend" });
});

// ── Config (ESP32 reads this) ─────────────────────────────────────────────────
app.get("/config", async (_req, res) => {
  const db = await readDb();
  res.json(buildConfigPayload(db));
});

app.post("/config", async (req, res) => {
  const { plantType, cooldownMs, pumpDurationMs } = req.body;

  if (plantType && !isSupportedPlant(plantType)) {
    return res.status(400).json({
      error: "Unsupported plant type",
      supportedPlants: getPlantNames()
    });
  }

  const db = await updateDb((cur) => {
    const next = { ...cur };
    if (plantType) next.currentPlant = plantType;
    next.settings = {
      ...cur.settings,
      ...(Number.isFinite(cooldownMs)     ? { cooldownMs }     : {}),
      ...(Number.isFinite(pumpDurationMs) ? { pumpDurationMs } : {})
    };
    return next;
  });

  return res.json({ message: "Configuration updated", ...buildConfigPayload(db) });
});

// ── Sensor data (ESP32 posts this) ───────────────────────────────────────────
app.post("/sensor-data", async (req, res) => {
  const payload   = req.body || {};
  const timestamp = payload.timestamp || new Date().toISOString();

  const entry = {
    deviceId:              payload.deviceId              || "unknown-device",
    plantType:             isSupportedPlant(payload.plantType) ? payload.plantType : undefined,
    soilMoistureRaw:       payload.soilMoistureRaw       ?? null,
    soilMoisturePercent:   payload.soilMoisturePercent   ?? null,
    soilDryness:           payload.soilDryness           ?? null,
    temperature:           payload.temperature           ?? null,
    humidity:              payload.humidity              ?? null,
    lightRaw:              payload.lightRaw              ?? null,
    lightPercent:          payload.lightPercent          ?? null,
    waterRequirementScore: payload.waterRequirementScore ?? null,
    // ── NEW fields from updated ESP32 firmware ──
    recommendedWaterMl:    payload.recommendedWaterMl    ?? null,
    recommendedDurationMs: payload.recommendedDurationMs ?? null,
    // ───────────────────────────────────────────
    pumpState:             Boolean(payload.pumpState),
    mode:                  payload.mode || "online",
    timestamp,
    serverReceivedAt: new Date().toISOString()
  };

  await updateDb((cur) => {
    const pumpStateChanged =
      typeof payload.pumpState === "boolean" &&
      payload.pumpState !== cur.pumpStatus.isOn;

    const next = {
      ...cur,
      sensorData: keepRecentItems([...cur.sensorData, entry], 500),
      pumpStatus: {
        ...cur.pumpStatus,
        isOn: typeof payload.pumpState === "boolean" ? payload.pumpState : cur.pumpStatus.isOn,
        lastChangedAt: pumpStateChanged ? timestamp : cur.pumpStatus.lastChangedAt
      }
    };

    if (entry.plantType) next.currentPlant = entry.plantType;
    return next;
  });

  res.status(201).json({ message: "Sensor data stored" });
});

// ── Sensor history ────────────────────────────────────────────────────────────
app.get("/sensor-history", async (req, res) => {
  const limit = Number.parseInt(req.query.limit, 10) || 30;
  const db    = await readDb();
  res.json(keepRecentItems(db.sensorData, Math.min(limit, 200)));
});

// ── Watering log (ESP32 posts this) ──────────────────────────────────────────
app.post("/watering-log", async (req, res) => {
  const payload   = req.body || {};
  const timestamp = payload.timestamp || new Date().toISOString();
  const event     = payload.event || "completed";

  const logEntry = {
    deviceId:   payload.deviceId  || "unknown-device",
    event,
    reason:     payload.reason    || "automatic",
    durationMs: payload.durationMs ?? 0,
    // ── NEW field from updated ESP32 firmware ──
    volumeMl:   payload.volumeMl  ?? null,
    // ──────────────────────────────────────────
    score:      payload.score     ?? null,
    requestId:  payload.requestId || null,
    timestamp,
    serverReceivedAt: new Date().toISOString()
  };

  const db = await updateDb((cur) => {
    const next = {
      ...cur,
      wateringLogs: keepRecentItems([...cur.wateringLogs, logEntry], 300),
      pumpStatus: { ...cur.pumpStatus }
    };

    if (event === "started") {
      next.pumpStatus.isOn          = true;
      next.pumpStatus.lastChangedAt = timestamp;
      next.pumpStatus.lastReason    = logEntry.reason;
    }

    if (event === "completed") {
      next.pumpStatus.isOn           = false;
      next.pumpStatus.lastChangedAt  = timestamp;
      next.pumpStatus.lastWateredAt  = timestamp;
      next.pumpStatus.lastReason     = logEntry.reason;
    }

    if (event === "skipped_cooldown" || event === "failed") {
      next.pumpStatus.isOn          = false;
      next.pumpStatus.lastChangedAt = timestamp;
      next.pumpStatus.lastReason    = logEntry.reason;
    }

    if (
      logEntry.requestId &&
      cur.manualWaterRequest.pending &&
      cur.manualWaterRequest.id === logEntry.requestId
    ) {
      next.manualWaterRequest = {
        ...cur.manualWaterRequest,
        pending:    false,
        consumedAt: timestamp
      };
    }

    return next;
  });

  res.status(201).json({ message: "Watering event stored", pumpStatus: db.pumpStatus });
});

// ── Manual watering trigger (dashboard posts this) ────────────────────────────
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

  res.status(202).json({
    message: "Manual watering request queued",
    manualWaterRequest: db.manualWaterRequest
  });
});

// ── Plant profiles ────────────────────────────────────────────────────────────
app.get("/plant-profiles", (_req, res) => {
  res.json(PLANT_PROFILES);
});

// ── Dashboard state ───────────────────────────────────────────────────────────
app.get("/dashboard-state", async (_req, res) => {
  const db = await readDb();
  res.json(buildDashboardState(db));
});

// ── Serve dashboard ───────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.sendFile(path.join(dashboardDir, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Smart Plant Watering backend listening on http://localhost:${PORT}`);
});
