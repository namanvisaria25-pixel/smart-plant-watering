const state = {
  soilChart: null,
  climateChart: null
};

function resolveApiBaseUrl() {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get("apiBaseUrl") || "";
  const fromConfig = window.APP_CONFIG?.API_BASE_URL || "";
  const fromStorage = window.localStorage.getItem("smartPlantApiBaseUrl") || "";
  const selected = fromQuery || fromConfig || fromStorage || "";

  if (fromQuery) {
    window.localStorage.setItem("smartPlantApiBaseUrl", fromQuery);
  }

  return selected.trim().replace(/\/+$/, "");
}

const API_BASE_URL = resolveApiBaseUrl();

const elements = {
  plantSelect: document.getElementById("plant-select"),
  saveConfigBtn: document.getElementById("save-config-btn"),
  manualWaterBtn: document.getElementById("manual-water-btn"),
  currentPlant: document.getElementById("current-plant"),
  scoreThreshold: document.getElementById("score-threshold"),
  pumpDuration: document.getElementById("pump-duration"),
  cooldownTime: document.getElementById("cooldown-time"),
  pumpPill: document.getElementById("pump-pill"),
  lastWatered: document.getElementById("last-watered"),
  waterScore: document.getElementById("water-score"),
  lastReason: document.getElementById("last-reason"),
  manualRequestState: document.getElementById("manual-request-state"),
  plantDescription: document.getElementById("plant-description"),
  soilValue: document.getElementById("soil-value"),
  soilRaw: document.getElementById("soil-raw"),
  temperatureValue: document.getElementById("temperature-value"),
  humidityValue: document.getElementById("humidity-value"),
  lightValue: document.getElementById("light-value"),
  lightRaw: document.getElementById("light-raw"),
  lastSync: document.getElementById("last-sync"),
  connectionPill: document.getElementById("connection-pill"),
  wateringLogList: document.getElementById("watering-log-list")
};

function buildApiUrl(path) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return API_BASE_URL ? `${API_BASE_URL}${normalizedPath}` : normalizedPath;
}

async function request(path, options = {}) {
  const response = await fetch(buildApiUrl(path), {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || "Request failed");
  }

  return response.json();
}

function formatDate(dateString) {
  if (!dateString) {
    return "Not available";
  }

  return new Date(dateString).toLocaleString();
}

function formatDuration(durationMs) {
  const seconds = Math.round((durationMs || 0) / 1000);
  return `${seconds}s`;
}

function setPlantOptions(plants, currentPlant) {
  elements.plantSelect.innerHTML = plants
    .map((plant) => `<option value="${plant}">${plant}</option>`)
    .join("");

  elements.plantSelect.value = currentPlant;
}

function updateSensorCards(latestSensor) {
  if (!latestSensor) {
    elements.soilValue.textContent = "-";
    elements.soilRaw.textContent = "Raw: -";
    elements.temperatureValue.textContent = "-";
    elements.humidityValue.textContent = "-";
    elements.lightValue.textContent = "-";
    elements.lightRaw.textContent = "Raw: -";
    elements.waterScore.textContent = "-";
    elements.lastSync.textContent = "No data yet";
    elements.connectionPill.textContent = "Waiting for device";
    elements.connectionPill.className = "status-pill off";
    return;
  }

  elements.soilValue.textContent = `${Number(latestSensor.soilMoisturePercent || 0).toFixed(1)}%`;
  elements.soilRaw.textContent = `Raw: ${latestSensor.soilMoistureRaw ?? "-"}`;
  elements.temperatureValue.textContent = `${Number(latestSensor.temperature || 0).toFixed(1)} deg C`;
  elements.humidityValue.textContent = `${Number(latestSensor.humidity || 0).toFixed(1)}%`;
  elements.lightValue.textContent = `${Number(latestSensor.lightPercent || 0).toFixed(1)}%`;
  elements.lightRaw.textContent = `Raw: ${latestSensor.lightRaw ?? "-"}`;
  elements.waterScore.textContent = Number(latestSensor.waterRequirementScore || 0).toFixed(1);
  elements.lastSync.textContent = formatDate(latestSensor.timestamp);
  elements.connectionPill.textContent = latestSensor.mode === "offline" ? "Offline fallback" : "Cloud synced";
  elements.connectionPill.className = `status-pill ${latestSensor.mode === "offline" ? "off" : ""}`;
}

function updateStatus(statePayload) {
  const { currentPlant, currentConfig, pumpStatus, latestSensor, settings, manualWaterRequest } = statePayload;

  elements.currentPlant.textContent = currentPlant;
  elements.scoreThreshold.textContent = currentConfig?.scoreThreshold ?? "-";
  elements.pumpDuration.textContent = formatDuration(settings?.pumpDurationMs);
  elements.cooldownTime.textContent = `${Math.round((settings?.cooldownMs || 0) / 60000)} min`;
  elements.plantDescription.textContent = currentConfig?.description || "-";
  elements.lastReason.textContent = pumpStatus?.lastReason || "No watering yet";
  elements.lastWatered.textContent = formatDate(pumpStatus?.lastWateredAt);
  elements.manualRequestState.textContent = manualWaterRequest?.pending ? "Pending on device" : "Idle";
  elements.manualWaterBtn.disabled = Boolean(manualWaterRequest?.pending);

  if (pumpStatus?.isOn) {
    elements.pumpPill.textContent = "Pump ON";
    elements.pumpPill.className = "status-pill";
  } else {
    elements.pumpPill.textContent = "Pump OFF";
    elements.pumpPill.className = "status-pill off";
  }

  updateSensorCards(latestSensor);
}

function buildChartLabels(sensorHistory) {
  return sensorHistory.map((item) =>
    new Date(item.timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    })
  );
}

function renderSoilChart(sensorHistory) {
  const labels = buildChartLabels(sensorHistory);
  const moistureData = sensorHistory.map((item) => item.soilMoisturePercent);
  const scoreData = sensorHistory.map((item) => item.waterRequirementScore);

  if (state.soilChart) {
    state.soilChart.destroy();
  }

  state.soilChart = new Chart(document.getElementById("soil-chart"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Soil Moisture %",
          data: moistureData,
          borderColor: "#2f6b3b",
          backgroundColor: "rgba(47, 107, 59, 0.12)",
          tension: 0.35,
          fill: true
        },
        {
          label: "Water Score",
          data: scoreData,
          borderColor: "#c58c45",
          backgroundColor: "rgba(197, 140, 69, 0.12)",
          tension: 0.35
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false
    }
  });
}

function renderClimateChart(sensorHistory) {
  const labels = buildChartLabels(sensorHistory);

  if (state.climateChart) {
    state.climateChart.destroy();
  }

  state.climateChart = new Chart(document.getElementById("climate-chart"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Temperature deg C",
          data: sensorHistory.map((item) => item.temperature),
          borderColor: "#a94b34",
          tension: 0.35
        },
        {
          label: "Humidity %",
          data: sensorHistory.map((item) => item.humidity),
          borderColor: "#3c7f9f",
          tension: 0.35
        },
        {
          label: "Light %",
          data: sensorHistory.map((item) => item.lightPercent),
          borderColor: "#d7a21c",
          tension: 0.35
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false
    }
  });
}

function renderWateringLogs(wateringLogs) {
  if (!wateringLogs.length) {
    elements.wateringLogList.innerHTML = '<li class="history-item"><p>No watering events yet.</p></li>';
    return;
  }

  elements.wateringLogList.innerHTML = [...wateringLogs]
    .reverse()
    .map(
      (log) => `
        <li class="history-item">
          <div>
            <p><strong>${log.event}</strong> via ${log.reason}</p>
            <p class="muted mono">${formatDate(log.timestamp)}</p>
          </div>
          <div>
            <p class="mono">Duration: ${formatDuration(log.durationMs)}</p>
            <p class="mono">Score: ${log.score ?? "-"}</p>
          </div>
        </li>
      `
    )
    .join("");
}

async function refreshDashboard() {
  const dashboardState = await request("/dashboard-state");

  setPlantOptions(dashboardState.supportedPlants, dashboardState.currentPlant);
  updateStatus(dashboardState);
  renderWateringLogs(dashboardState.wateringLogs);
  renderSoilChart(dashboardState.sensorHistory);
  renderClimateChart(dashboardState.sensorHistory);
}

async function savePlantSelection() {
  elements.saveConfigBtn.disabled = true;

  try {
    await request("/config", {
      method: "POST",
      body: JSON.stringify({
        plantType: elements.plantSelect.value
      })
    });

    await refreshDashboard();
  } catch (error) {
    alert(`Could not save plant selection: ${error.message}`);
  } finally {
    elements.saveConfigBtn.disabled = false;
  }
}

async function requestManualWatering() {
  elements.manualWaterBtn.disabled = true;

  try {
    await request("/manual-watering", {
      method: "POST"
    });

    await refreshDashboard();
  } catch (error) {
    alert(`Could not queue manual watering: ${error.message}`);
    elements.manualWaterBtn.disabled = false;
  }
}

async function init() {
  elements.saveConfigBtn.addEventListener("click", savePlantSelection);
  elements.manualWaterBtn.addEventListener("click", requestManualWatering);

  try {
    await refreshDashboard();
  } catch (error) {
    console.error(error);
    alert("Dashboard could not load. Check dashboard/config.js API URL or start backend locally.");
  }

  setInterval(async () => {
    try {
      await refreshDashboard();
    } catch (error) {
      console.error("Auto refresh failed", error);
    }
  }, 10000);
}

init();
