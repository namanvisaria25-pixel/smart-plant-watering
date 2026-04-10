const fs   = require("fs/promises");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "..", "..", "data");

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(DATA_DIR, "db.json");

// Default database — includes all new settings fields
const DEFAULT_DB = {
  currentPlant: "Money Plant",
  sensorData:   [],
  wateringLogs: [],
  pumpStatus: {
    isOn:          false,
    lastChangedAt: null,
    lastWateredAt: null,
    lastReason:    null
  },
  settings: {
    // Timing
    cooldownMs:      3600000,  // 1 hour
    pumpDurationMs:  7000,     // fallback fixed duration (ms)
    // Volume-based watering (used by ESP32 + dashboard display)
    pumpFlowMlPerSec: 20.0,
    minWaterMl:       15.0,
    maxWaterMl:       120.0,
    // Size categories  (sent to ESP32 via GET /config)
    potSizeCategory:   "medium",
    plantSizeCategory: "medium"
  },
  manualWaterRequest: {
    pending:     false,
    id:          null,
    requestedAt: null,
    consumedAt:  null
  }
};

async function ensureDb() {
  try {
    await fs.access(DB_PATH);
  } catch {
    await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
    await fs.writeFile(DB_PATH, JSON.stringify(DEFAULT_DB, null, 2));
  }
}

async function readDb() {
  await ensureDb();
  const raw = await fs.readFile(DB_PATH, "utf8");
  const db  = JSON.parse(raw);

  // Back-fill any missing settings keys so old db.json files
  // work after the upgrade without a manual reset.
  db.settings = { ...DEFAULT_DB.settings, ...db.settings };
  return db;
}

async function writeDb(db) {
  await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2));
}

async function updateDb(updater) {
  const db     = await readDb();
  const nextDb = await updater(db);
  await writeDb(nextDb);
  return nextDb;
}

function keepRecentItems(items, limit) {
  if (!Array.isArray(items)) return [];
  return items.slice(-limit);
}

module.exports = {
  DEFAULT_DB,
  DB_PATH,
  keepRecentItems,
  readDb,
  updateDb,
  writeDb
};
