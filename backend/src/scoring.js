/**
 * scoring.js
 * Backend-side Water Requirement Score calculation.
 * ESP32 sends raw sensor values → backend normalises and scores.
 *
 * Formula:
 *   Score = W1*SoilDryness + W2*TempScore + W3*HumidityScore + W4*LightScore
 *
 * Each factor is normalised to 0–100 before weighting.
 * Higher score → plant needs more water.
 *
 * UPDATED: pot size and plant size now affect:
 *   - recommendedWaterMl   (bigger pot/plant = more water)
 *   - recommendedDurationMs (scaled accordingly)
 *   - effectiveThreshold    (bigger pot = needs higher dryness before watering)
 *   - cooldownMs            (bigger pot retains water longer = longer cooldown)
 */

const { getPlantProfile } = require("./config/plants");

// ── Size multiplier tables ────────────────────────────────────────────────────

/**
 * POT SIZE affects how much water is delivered (pot volume) and
 * how quickly soil dries out (smaller pot dries faster → lower threshold).
 */
const POT_SIZE_CONFIG = {
  small:  { waterMultiplier: 0.60, thresholdOffset: -6,  cooldownMultiplier: 0.60 },
  medium: { waterMultiplier: 1.00, thresholdOffset:  0,  cooldownMultiplier: 1.00 },
  large:  { waterMultiplier: 1.55, thresholdOffset: +8,  cooldownMultiplier: 1.50 },
};

/**
 * PLANT SIZE affects how much water the plant consumes and
 * how aggressively it should be scored.
 */
const PLANT_SIZE_CONFIG = {
  small:  { waterMultiplier: 0.70, thresholdOffset: -4,  cooldownMultiplier: 0.75 },
  medium: { waterMultiplier: 1.00, thresholdOffset:  0,  cooldownMultiplier: 1.00 },
  large:  { waterMultiplier: 1.40, thresholdOffset: +5,  cooldownMultiplier: 1.30 },
};

function getSizeConfig(potSize, plantSize) {
  const pot   = POT_SIZE_CONFIG[potSize]   || POT_SIZE_CONFIG.medium;
  const plant = PLANT_SIZE_CONFIG[plantSize] || PLANT_SIZE_CONFIG.medium;
  return {
    waterMultiplier:   pot.waterMultiplier   * plant.waterMultiplier,
    thresholdOffset:   pot.thresholdOffset   + plant.thresholdOffset,
    cooldownMultiplier: pot.cooldownMultiplier * plant.cooldownMultiplier,
  };
}

// ── Individual scoring functions ─────────────────────────────────────────────

function soilDrynessScore(moisturePercent) {
  const clamped = Math.max(0, Math.min(100, moisturePercent ?? 50));
  return 100 - clamped;
}

function digitalSoilToPercent(digitalValue) {
  return digitalValue === 1 ? 15 : 80;
}

function temperatureScore(tempC) {
  const t = Math.max(10, Math.min(45, tempC ?? 25));
  return ((t - 10) / 35) * 100;
}

function humidityScore(humidityPercent) {
  const h = Math.max(0, Math.min(100, humidityPercent ?? 50));
  return 100 - h;
}

function lightScore(lightValue, isRaw = false) {
  const pct     = isRaw ? (lightValue / 4095) * 100 : lightValue;
  const clamped = Math.max(0, Math.min(100, pct ?? 50));
  return clamped;
}

// ── Main scoring function ─────────────────────────────────────────────────────

/**
 * Calculate the full Water Requirement Score for a plant given sensor data.
 *
 * @param {object} sensorData  - fields from POST /sensor-data body
 * @param {string} plantName   - current plant name
 * @param {object} settings    - current settings (potSizeCategory, plantSizeCategory, pumpFlowMlPerSec)
 * @returns {object}
 */
function calculateWaterScore(sensorData, plantName, settings = {}) {
  const profile = getPlantProfile(plantName);

  const potSize   = settings.potSizeCategory   || "medium";
  const plantSize = settings.plantSizeCategory || "medium";
  const sizeConf  = getSizeConfig(potSize, plantSize);

  // ── Resolve soil moisture percent ──
  let moisturePercent = sensorData.soilMoisturePercent;
  if (moisturePercent == null && sensorData.soilMoistureRaw != null) {
    moisturePercent = (sensorData.soilMoistureRaw / 4095) * 100;
  }
  if (moisturePercent == null && sensorData.soilDigital != null) {
    moisturePercent = digitalSoilToPercent(sensorData.soilDigital);
  }
  moisturePercent = moisturePercent ?? 50;

  // ── Resolve light percent ──
  let lightPct = sensorData.lightPercent;
  if (lightPct == null && sensorData.lightRaw != null) {
    lightPct = (sensorData.lightRaw / 4095) * 100;
  }
  if (lightPct == null && sensorData.lightDigital != null) {
    lightPct = sensorData.lightDigital === 0 ? 80 : 20;
  }
  lightPct = lightPct ?? 50;

  // ── Raw score factors ──
  const factors = {
    soilDryness: soilDrynessScore(moisturePercent),
    temperature: temperatureScore(sensorData.temperature),
    humidity:    humidityScore(sensorData.humidity),
    light:       lightScore(lightPct),
  };

  const score =
    profile.soilDrynessWeight * factors.soilDryness +
    profile.temperatureWeight * factors.temperature +
    profile.humidityWeight    * factors.humidity    +
    profile.lightWeight       * factors.light;

  // ── Size-adjusted threshold ──
  const effectiveThreshold = Math.max(
    10,
    profile.scoreThreshold + sizeConf.thresholdOffset
  );
  const thresholdMet = score >= effectiveThreshold;

  // ── Size-adjusted water volume ──
  const pumpFlow       = settings.pumpFlowMlPerSec || 20;
  const baseWaterMl    = profile.baseWaterMl ?? 40;
  const scaleFactor    = Math.max(0.5, Math.min(2.5, score / effectiveThreshold));
  const rawWaterMl     = baseWaterMl * scaleFactor * sizeConf.waterMultiplier;

  const minWater = settings.minWaterMl || 10;
  const maxWater = settings.maxWaterMl || 200;
  const recommendedWaterMl = Math.round(
    Math.max(minWater, Math.min(maxWater, rawWaterMl)) * 10
  ) / 10;

  const recommendedDurationMs = Math.round((recommendedWaterMl / pumpFlow) * 1000);

  // ── Size-adjusted cooldown ──
  const baseCooldown            = profile.defaultCooldownMs ?? settings.cooldownMs ?? 3600000;
  const recommendedCooldownMs   = Math.round(baseCooldown * sizeConf.cooldownMultiplier);

  return {
    score:                Math.round(score * 10) / 10,
    factors,
    effectiveThreshold,
    thresholdMet,
    recommendedWaterMl,
    recommendedDurationMs,
    recommendedCooldownMs,
    moisturePercent:      Math.round(moisturePercent * 10) / 10,
    lightPercent:         Math.round(lightPct * 10) / 10,
    sizeInfo: {
      potSize,
      plantSize,
      waterMultiplier:    Math.round(sizeConf.waterMultiplier * 100) / 100,
      thresholdOffset:    sizeConf.thresholdOffset,
      cooldownMultiplier: Math.round(sizeConf.cooldownMultiplier * 100) / 100,
    },
  };
}

module.exports = {
  calculateWaterScore,
  POT_SIZE_CONFIG,
  PLANT_SIZE_CONFIG,
  getSizeConfig,
};
