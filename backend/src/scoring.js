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
 */

const { getPlantProfile } = require("./config/plants");

/**
 * Normalise soil moisture percent (0–100%) to a dryness score (0–100).
 * Low moisture % → high dryness score (needs water).
 * Clamp to [0,100].
 */
function soilDrynessScore(moisturePercent) {
  const clamped = Math.max(0, Math.min(100, moisturePercent ?? 50));
  return 100 - clamped; // invert: 0% moisture → 100 dryness
}

/**
 * If only digital (DO) reading is available (0 = wet, 1 = dry),
 * map to a coarse moisture percent so scoring still works.
 */
function digitalSoilToPercent(digitalValue) {
  // DO = 1 (HIGH) means dry (sensor output is inverted on most modules)
  return digitalValue === 1 ? 15 : 80; // dry → 15%, wet → 80%
}

/**
 * Temperature scoring: higher temp → more evaporation → higher need.
 * Reference range: 10–45 °C → 0–100.
 */
function temperatureScore(tempC) {
  const t = Math.max(10, Math.min(45, tempC ?? 25));
  return ((t - 10) / 35) * 100;
}

/**
 * Humidity scoring: high humidity → less evaporation → lower need (invert).
 * Range: 0–100% → score 100–0.
 */
function humidityScore(humidityPercent) {
  const h = Math.max(0, Math.min(100, humidityPercent ?? 50));
  return 100 - h;
}

/**
 * Light scoring: more light → more photosynthesis + evaporation → higher need.
 * Accepts percent 0–100 OR raw 0–4095 (ADC).
 */
function lightScore(lightValue, isRaw = false) {
  const pct = isRaw ? (lightValue / 4095) * 100 : lightValue;
  const clamped = Math.max(0, Math.min(100, pct ?? 50));
  return clamped;
}

/**
 * Calculate the full Water Requirement Score for a plant given sensor data.
 *
 * @param {object} sensorData  - fields from POST /sensor-data body
 * @param {string} plantName   - current plant name
 * @returns {object} { score, factors, thresholdMet, recommendedWaterMl, recommendedDurationMs }
 */
function calculateWaterScore(sensorData, plantName) {
  const profile = getPlantProfile(plantName);

  // Resolve soil moisture percent
  let moisturePercent = sensorData.soilMoisturePercent;
  if (moisturePercent == null && sensorData.soilMoistureRaw != null) {
    // Raw ADC (0–4095) → percent
    moisturePercent = (sensorData.soilMoistureRaw / 4095) * 100;
  }
  if (moisturePercent == null && sensorData.soilDigital != null) {
    moisturePercent = digitalSoilToPercent(sensorData.soilDigital);
  }
  moisturePercent = moisturePercent ?? 50;

  // Resolve light percent
  let lightPct = sensorData.lightPercent;
  if (lightPct == null && sensorData.lightRaw != null) {
    lightPct = (sensorData.lightRaw / 4095) * 100;
  }
  if (lightPct == null && sensorData.lightDigital != null) {
    // LDR DO: 0 = bright (high light), 1 = dark — invert
    lightPct = sensorData.lightDigital === 0 ? 80 : 20;
  }
  lightPct = lightPct ?? 50;

  const factors = {
    soilDryness:  soilDrynessScore(moisturePercent),
    temperature:  temperatureScore(sensorData.temperature),
    humidity:     humidityScore(sensorData.humidity),
    light:        lightScore(lightPct),
  };

  const score =
    profile.soilDrynessWeight * factors.soilDryness +
    profile.temperatureWeight * factors.temperature +
    profile.humidityWeight    * factors.humidity    +
    profile.lightWeight       * factors.light;

  const thresholdMet = score >= profile.scoreThreshold;

  // Recommended water volume (ml)
  const baseWaterMl = profile.baseWaterMl ?? 40;
  const scaleFactor = Math.max(0.5, Math.min(2.0, score / profile.scoreThreshold));
  const recommendedWaterMl = Math.round(baseWaterMl * scaleFactor * 10) / 10;

  // Recommended pump duration (ms) based on flow rate
  const pumpFlowMlPerSec = 20; // default; overridden by settings if available
  const recommendedDurationMs = Math.round((recommendedWaterMl / pumpFlowMlPerSec) * 1000);

  return {
    score: Math.round(score * 10) / 10,
    factors,
    thresholdMet,
    recommendedWaterMl,
    recommendedDurationMs,
    moisturePercent: Math.round(moisturePercent * 10) / 10,
    lightPercent:    Math.round(lightPct * 10) / 10,
  };
}

module.exports = { calculateWaterScore };
