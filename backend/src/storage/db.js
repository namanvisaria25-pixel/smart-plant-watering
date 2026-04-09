const fs = require("fs/promises");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "..", "..", "data");

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(DATA_DIR, "db.json");

const DEFAULT_DB = {
  currentPlant: "Money Plant",
  sensorData: [],
  wateringLogs: [],
  pumpStatus: {
    isOn: false,
    lastChangedAt: null,
    lastWateredAt: null,
    lastReason: null
  },
  settings: {
    cooldownMs: 3600000,
    pumpDurationMs: 7000
  },
  manualWaterRequest: {
    pending: false,
    id: null,
    requestedAt: null,
    consumedAt: null
  }
};

async function ensureDb() {
  try {
    await fs.access(DB_PATH);
  } catch (error) {
    await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
    await fs.writeFile(DB_PATH, JSON.stringify(DEFAULT_DB, null, 2));
  }
}

async function readDb() {
  await ensureDb();
  const raw = await fs.readFile(DB_PATH, "utf8");
  return JSON.parse(raw);
}

async function writeDb(db) {
  await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2));
}

async function updateDb(updater) {
  const db = await readDb();
  const nextDb = await updater(db);
  await writeDb(nextDb);
  return nextDb;
}

function keepRecentItems(items, limit) {
  if (!Array.isArray(items)) {
    return [];
  }

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
