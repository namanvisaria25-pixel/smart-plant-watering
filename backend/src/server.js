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
  const wateringLogs = keepRecentItems(db.wateringLogs, 20);

  return {
    currentPlant: db.currentPlant,
    currentConfig: getPlantProfile(db.currentPlant),
    supportedPlants: getPlantNames(),
    latestSensor: sensorHistory[sensorHistory.length - 1] || null,
    sensorHistory,
    wateringLogs,
    pumpStatus: db.pumpStatus,
    settings: db.settings,
    manualWaterRequest: db.manualWaterRequest
  };
}

function isSupportedPlant(plantType) {
  return getPlantNames().includes(plantType);
}

app.get("/health", (_request, response) => {
  response.json({ ok: true, service: "smart-plant-watering-backend" });
});

app.get("/config", async (_request, response) => {
  const db = await readDb();
  response.json(buildConfigPayload(db));
});

app.post("/config", async (request, response) => {
  const { plantType, cooldownMs, pumpDurationMs } = request.body;

  if (plantType && !isSupportedPlant(plantType)) {
    return response.status(400).json({
      error: "Unsupported plant type",
      supportedPlants: getPlantNames()
    });
  }

  const db = await updateDb((currentDb) => {
    const nextDb = { ...currentDb };

    if (plantType) {
      nextDb.currentPlant = plantType;
    }

    nextDb.settings = {
      ...currentDb.settings,
      ...(Number.isFinite(cooldownMs) ? { cooldownMs } : {}),
      ...(Number.isFinite(pumpDurationMs) ? { pumpDurationMs } : {})
    };

    return nextDb;
  });

  return response.json({
    message: "Configuration updated",
    ...buildConfigPayload(db)
  });
});

app.post("/sensor-data", async (request, response) => {
  const payload = request.body || {};
  const timestamp = payload.timestamp || new Date().toISOString();
  const entry = {
    deviceId: payload.deviceId || "unknown-device",
    plantType: isSupportedPlant(payload.plantType) ? payload.plantType : undefined,
    soilMoistureRaw: payload.soilMoistureRaw ?? null,
    soilMoisturePercent: payload.soilMoisturePercent ?? null,
    soilDryness: payload.soilDryness ?? null,
    temperature: payload.temperature ?? null,
    humidity: payload.humidity ?? null,
    lightRaw: payload.lightRaw ?? null,
    lightPercent: payload.lightPercent ?? null,
    waterRequirementScore: payload.waterRequirementScore ?? null,
    pumpState: Boolean(payload.pumpState),
    mode: payload.mode || "online",
    timestamp,
    serverReceivedAt: new Date().toISOString()
  };

  await updateDb((currentDb) => {
    const pumpStateChanged =
      typeof payload.pumpState === "boolean" &&
      payload.pumpState !== currentDb.pumpStatus.isOn;

    const nextDb = {
      ...currentDb,
      sensorData: keepRecentItems([...currentDb.sensorData, entry], 500),
      pumpStatus: {
        ...currentDb.pumpStatus,
        isOn: typeof payload.pumpState === "boolean" ? payload.pumpState : currentDb.pumpStatus.isOn,
        lastChangedAt: pumpStateChanged ? timestamp : currentDb.pumpStatus.lastChangedAt
      }
    };

    if (entry.plantType) {
      nextDb.currentPlant = entry.plantType;
    }

    return nextDb;
  });

  response.status(201).json({ message: "Sensor data stored" });
});

app.get("/sensor-history", async (request, response) => {
  const limit = Number.parseInt(request.query.limit, 10) || 30;
  const db = await readDb();
  response.json(keepRecentItems(db.sensorData, Math.min(limit, 200)));
});

app.post("/watering-log", async (request, response) => {
  const payload = request.body || {};
  const timestamp = payload.timestamp || new Date().toISOString();
  const event = payload.event || "completed";

  const logEntry = {
    deviceId: payload.deviceId || "unknown-device",
    event,
    reason: payload.reason || "automatic",
    durationMs: payload.durationMs ?? 0,
    score: payload.score ?? null,
    requestId: payload.requestId || null,
    timestamp,
    serverReceivedAt: new Date().toISOString()
  };

  const db = await updateDb((currentDb) => {
    const nextDb = {
      ...currentDb,
      wateringLogs: keepRecentItems([...currentDb.wateringLogs, logEntry], 300),
      pumpStatus: { ...currentDb.pumpStatus }
    };

    if (event === "started") {
      nextDb.pumpStatus.isOn = true;
      nextDb.pumpStatus.lastChangedAt = timestamp;
      nextDb.pumpStatus.lastReason = logEntry.reason;
    }

    if (event === "completed") {
      nextDb.pumpStatus.isOn = false;
      nextDb.pumpStatus.lastChangedAt = timestamp;
      nextDb.pumpStatus.lastWateredAt = timestamp;
      nextDb.pumpStatus.lastReason = logEntry.reason;
    }

    if (event === "skipped_cooldown" || event === "failed") {
      nextDb.pumpStatus.isOn = false;
      nextDb.pumpStatus.lastChangedAt = timestamp;
      nextDb.pumpStatus.lastReason = logEntry.reason;
    }

    if (
      logEntry.requestId &&
      currentDb.manualWaterRequest.pending &&
      currentDb.manualWaterRequest.id === logEntry.requestId
    ) {
      nextDb.manualWaterRequest = {
        ...currentDb.manualWaterRequest,
        pending: false,
        consumedAt: timestamp
      };
    }

    return nextDb;
  });

  response.status(201).json({
    message: "Watering event stored",
    pumpStatus: db.pumpStatus
  });
});

app.post("/manual-watering", async (_request, response) => {
  const requestId = `manual-${Date.now()}`;

  const db = await updateDb((currentDb) => ({
    ...currentDb,
    manualWaterRequest: {
      pending: true,
      id: requestId,
      requestedAt: new Date().toISOString(),
      consumedAt: null
    }
  }));

  response.status(202).json({
    message: "Manual watering request queued",
    manualWaterRequest: db.manualWaterRequest
  });
});

app.get("/plant-profiles", (_request, response) => {
  response.json(PLANT_PROFILES);
});

app.get("/dashboard-state", async (_request, response) => {
  const db = await readDb();
  response.json(buildDashboardState(db));
});

app.get("/", (_request, response) => {
  response.sendFile(path.join(dashboardDir, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Smart Plant Watering backend listening on http://localhost:${PORT}`);
});
