// Plant profiles — must stay in sync with ESP32 firmware plantProfiles[] array
const PLANT_PROFILES = {
  "Aloe Vera": {
    description:        "Low water need and high drought tolerance.",
    moistureThreshold:  35,
    soilDrynessWeight:  0.55,
    temperatureWeight:  0.20,
    humidityWeight:     0.10,
    lightWeight:        0.15,
    scoreThreshold:     58,
    baseWaterMl:        25.0,
    defaultCooldownMs:  172800000   // 48 hours
  },
  "Money Plant": {
    description:        "Moderate watering requirement with balanced tolerance.",
    moistureThreshold:  45,
    soilDrynessWeight:  0.50,
    temperatureWeight:  0.20,
    humidityWeight:     0.12,
    lightWeight:        0.18,
    scoreThreshold:     50,
    baseWaterMl:        45.0,
    defaultCooldownMs:  86400000    // 24 hours
  },
  "Holy Basil (Tulsi)": {
    description:        "Higher water requirement and lower drought tolerance.",
    moistureThreshold:  55,
    soilDrynessWeight:  0.45,
    temperatureWeight:  0.22,
    humidityWeight:     0.08,
    lightWeight:        0.20,
    scoreThreshold:     43,
    baseWaterMl:        60.0,
    defaultCooldownMs:  43200000    // 12 hours
  },
  "Rosemary": {
    description:        "Low-to-medium watering with preference for drier soil.",
    moistureThreshold:  40,
    soilDrynessWeight:  0.52,
    temperatureWeight:  0.18,
    humidityWeight:     0.12,
    lightWeight:        0.18,
    scoreThreshold:     55,
    baseWaterMl:        35.0,
    defaultCooldownMs:  129600000   // 36 hours
  },
  "Snake Plant": {
    description:        "Very low water need and strong drought resistance.",
    moistureThreshold:  30,
    soilDrynessWeight:  0.58,
    temperatureWeight:  0.18,
    humidityWeight:     0.10,
    lightWeight:        0.14,
    scoreThreshold:     64,
    baseWaterMl:        20.0,
    defaultCooldownMs:  259200000   // 72 hours
  }
};

function getPlantNames() {
  return Object.keys(PLANT_PROFILES);
}

function getPlantProfile(name) {
  return PLANT_PROFILES[name] || PLANT_PROFILES["Money Plant"];
}

module.exports = { PLANT_PROFILES, getPlantNames, getPlantProfile };
