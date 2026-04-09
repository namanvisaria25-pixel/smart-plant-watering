const PLANT_PROFILES = {
  "Aloe Vera": {
    description: "Low water need and high drought tolerance.",
    moistureThreshold: 35,
    soilDrynessWeight: 0.55,
    temperatureWeight: 0.2,
    humidityWeight: 0.1,
    lightWeight: 0.15,
    scoreThreshold: 58
  },
  "Money Plant": {
    description: "Moderate watering requirement with balanced tolerance.",
    moistureThreshold: 45,
    soilDrynessWeight: 0.5,
    temperatureWeight: 0.2,
    humidityWeight: 0.12,
    lightWeight: 0.18,
    scoreThreshold: 50
  },
  "Holy Basil (Tulsi)": {
    description: "Higher water requirement and lower drought tolerance.",
    moistureThreshold: 55,
    soilDrynessWeight: 0.45,
    temperatureWeight: 0.22,
    humidityWeight: 0.08,
    lightWeight: 0.2,
    scoreThreshold: 43
  },
  "Rosemary": {
    description: "Low-to-medium watering with preference for drier soil.",
    moistureThreshold: 40,
    soilDrynessWeight: 0.52,
    temperatureWeight: 0.18,
    humidityWeight: 0.12,
    lightWeight: 0.18,
    scoreThreshold: 55
  },
  "Snake Plant": {
    description: "Very low water need and strong drought resistance.",
    moistureThreshold: 30,
    soilDrynessWeight: 0.58,
    temperatureWeight: 0.18,
    humidityWeight: 0.1,
    lightWeight: 0.14,
    scoreThreshold: 64
  }
};

function getPlantNames() {
  return Object.keys(PLANT_PROFILES);
}

function getPlantProfile(name) {
  return PLANT_PROFILES[name] || PLANT_PROFILES["Money Plant"];
}

module.exports = {
  PLANT_PROFILES,
  getPlantNames,
  getPlantProfile
};
